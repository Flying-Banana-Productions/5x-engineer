/**
 * Plan review loop (Loop 1) — automated review cycle for implementation plans.
 *
 * State transitions (Phase 4 — PARSE_* states eliminated):
 *   REVIEW → APPROVED                        (ready)
 *   REVIEW → AUTO_FIX → REVIEW               (ready_with_corrections, all auto_fix)
 *   REVIEW → ESCALATE                        (has human_required items)
 *   AUTO_FIX → REVIEW                        (author completed)
 *   AUTO_FIX → ESCALATE                      (author needs_human)
 *   ESCALATE → REVIEW                        (human provides guidance, continue)
 *   ESCALATE → APPROVED                      (human overrides, accepts)
 *   ESCALATE → ABORTED                       (human aborts)
 *   any → ESCALATE                           (max iterations reached)
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import type {
	AgentAdapter,
	InvokeStatus,
	InvokeVerdict,
} from "../agents/types.js";
import type { FiveXConfig } from "../config.js";
import {
	appendRunEvent,
	createRun,
	getActiveRun,
	getAgentResults,
	getLatestRun,
	getLatestStatus,
	getLatestVerdict,
	hasCompletedStep,
	updateRunStatus,
	upsertAgentResult,
	upsertPlan,
} from "../db/operations.js";
import { canonicalizePlanPath } from "../paths.js";
import { assertAuthorStatus, assertReviewerVerdict } from "../protocol.js";
import { renderTemplate } from "../templates/loader.js";
import { buildEscalationReason } from "../utils/agent-event-helpers.js";
import { appendStructuredAuditRecord } from "../utils/audit.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// EscalationEvent is defined once in gates/human.ts (shared with phase-execution-loop).
// Re-exported here for backward compatibility with existing consumers.
export type { EscalationEvent } from "../gates/human.js";

import type { EscalationEvent } from "../gates/human.js";

export interface PlanReviewResult {
	approved: boolean;
	iterations: number;
	reviewPath: string;
	runId: string;
	escalations: EscalationEvent[];
}

/**
 * State machine states for the plan-review loop.
 *
 * Phase 4: PARSE_VERDICT and PARSE_STATUS eliminated.
 */
type LoopState = "REVIEW" | "AUTO_FIX" | "ESCALATE" | "APPROVED" | "ABORTED";

/**
 * Map deprecated PARSE_* states from old DB records to their parent states.
 */
const LEGACY_STATE_MAP: Record<string, LoopState> = {
	PARSE_VERDICT: "REVIEW",
	PARSE_STATUS: "AUTO_FIX",
};

export interface PlanReviewLoopOptions {
	auto?: boolean;
	allowDirty?: boolean;
	/** Project root directory for agent workdir. Falls back to dirname(planPath) if unset. */
	projectRoot?: string;
	/**
	 * When true, suppress formatted agent event output to stdout.
	 * Default: false (show output). Use !process.stdout.isTTY as the default
	 * at the command layer before passing here.
	 */
	quiet?: boolean;
	/** Override for testing — supply a function that prompts for human decisions. */
	humanGate?: (
		event: EscalationEvent,
	) => Promise<"continue" | "approve" | "abort">;
	/** Override for testing — supply a function that prompts for resume decisions. */
	resumeGate?: (
		runId: string,
		iteration: number,
	) => Promise<"resume" | "start-fresh" | "abort">;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a simple unique ID (UUID v4). */
function generateId(): string {
	return crypto.randomUUID();
}

/**
 * Compute review path for a plan. Checks DB for an existing review_path from
 * prior runs on this plan (reuse for addendum continuity); if none, compute a
 * fresh path: `<reviewsDir>/<date>-<plan-basename>-review.md`.
 */
export function resolveReviewPath(
	db: Database,
	planPath: string,
	reviewsDir: string,
): string {
	const canonical = canonicalizePlanPath(planPath);
	const resolvedReviewsDir = resolve(reviewsDir);

	/** True when `filePath` resolves to somewhere strictly inside `reviewsDir`. */
	const isUnderReviewsDir = (filePath: string): boolean => {
		const rel = relative(resolvedReviewsDir, resolve(filePath));
		// Outside if empty (same dir), starts with "..", or is absolute (Windows cross-drive)
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	};

	// Check DB for existing review path — validate it's under the reviews dir
	const latestRun = getLatestRun(db, canonical);
	if (latestRun?.review_path) {
		if (isUnderReviewsDir(latestRun.review_path)) {
			return latestRun.review_path;
		}
		console.warn(
			`  Warning: DB review path "${latestRun.review_path}" is outside configured reviews dir. Computing fresh path.`,
		);
	}

	// Also check non-canonical path
	const latestRunAlt = getLatestRun(db, planPath);
	if (latestRunAlt?.review_path) {
		if (isUnderReviewsDir(latestRunAlt.review_path)) {
			return latestRunAlt.review_path;
		}
		console.warn(
			`  Warning: DB review path "${latestRunAlt.review_path}" is outside configured reviews dir. Computing fresh path.`,
		);
	}

	// Compute fresh path
	const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	const planBase = basename(planPath, ".md");
	return join(reviewsDir, `${date}-${planBase}-review.md`);
}

/** Default human escalation gate — prompts via stdin. */
async function defaultHumanGate(
	event: EscalationEvent,
): Promise<"continue" | "approve" | "abort"> {
	console.log();
	console.log("  === Human Review Required ===");
	console.log(`  Reason: ${event.reason}`);
	if (event.items && event.items.length > 0) {
		console.log("  Items requiring human review:");
		for (const item of event.items) {
			console.log(`    - [${item.id}] ${item.title}: ${item.reason}`);
		}
	}
	console.log();
	console.log("  Options:");
	console.log("    c = continue (provide guidance and re-review)");
	console.log("    a = approve (accept current state)");
	console.log("    q = abort (stop the review loop)");
	console.log();

	// Non-interactive detection
	if (!process.stdin.isTTY) {
		console.log("  Non-interactive mode detected — aborting.");
		return "abort";
	}

	process.stdout.write("  Choice [c/a/q]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();
	if (choice === "c" || choice === "continue") return "continue";
	if (choice === "a" || choice === "approve") return "approve";
	return "abort";
}

/** Default resume gate — prompts via stdin. */
async function defaultResumeGate(
	runId: string,
	iteration: number,
): Promise<"resume" | "start-fresh" | "abort"> {
	console.log();
	console.log(
		`  Found interrupted run ${runId.slice(0, 8)} at iteration ${iteration}.`,
	);
	console.log("  Options:");
	console.log("    r = resume from where it left off");
	console.log("    n = start fresh (marks old run as aborted)");
	console.log("    q = abort");
	console.log();

	if (!process.stdin.isTTY) {
		console.log("  Non-interactive mode detected — aborting.");
		return "abort";
	}

	process.stdout.write("  Choice [r/n/q]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();
	if (choice === "r" || choice === "resume") return "resume";
	if (choice === "n" || choice === "new" || choice === "start-fresh")
		return "start-fresh";
	return "abort";
}

/** Read a single line from stdin. */
function readLine(): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
			const text = Buffer.concat(chunks).toString();
			if (text.includes("\n")) {
				process.stdin.removeListener("data", onData);
				process.stdin.pause();
				resolve(text.split("\n")[0] ?? "");
			}
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
	});
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Run the plan-review loop (Loop 1).
 *
 * Uses a single AgentAdapter for both author and reviewer roles.
 * Role distinction is expressed via the prompt template and model override.
 */
export async function runPlanReviewLoop(
	planPath: string,
	reviewPath: string,
	db: Database,
	adapter: AgentAdapter,
	config: FiveXConfig,
	options: PlanReviewLoopOptions = {},
): Promise<PlanReviewResult> {
	const humanGate = options.humanGate ?? defaultHumanGate;
	const resumeGate = options.resumeGate ?? defaultResumeGate;
	const maxIterations = config.maxReviewIterations;
	const quiet = options.quiet ?? false;
	const workdir = options.projectRoot ?? dirname(resolve(planPath));

	const canonical = canonicalizePlanPath(planPath);
	const escalations: EscalationEvent[] = [];

	// --- Resume detection ---
	let runId: string;
	let iteration = 0;
	let state: LoopState = "REVIEW";

	const activeRun = getActiveRun(db, canonical);
	if (activeRun && activeRun.command === "plan-review") {
		const resumeDecision = await resumeGate(activeRun.id, iteration);

		if (resumeDecision === "abort") {
			return {
				approved: false,
				iterations: 0,
				reviewPath,
				runId: activeRun.id,
				escalations: [],
			};
		}

		if (resumeDecision === "resume") {
			runId = activeRun.id;
			// Restore state from DB, mapping legacy PARSE_* states
			const rawState = (activeRun.current_state ?? "REVIEW") as string;
			if (rawState in LEGACY_STATE_MAP) {
				state = LEGACY_STATE_MAP[rawState] as LoopState;
			} else {
				state = rawState as LoopState;
			}
			// Iteration is tracked via agent_results count
			const results = getAgentResults(db, runId, "-1");
			iteration = results.length;
			console.log(
				`  Resuming run ${runId.slice(0, 8)} at iteration ${iteration}, state ${state}`,
			);
		} else {
			// start-fresh: mark old run as aborted
			updateRunStatus(db, activeRun.id, "aborted");
			runId = generateId();
			createRun(db, {
				id: runId,
				planPath: canonical,
				command: "plan-review",
				reviewPath,
			});
		}
	} else {
		runId = generateId();
		createRun(db, {
			id: runId,
			planPath: canonical,
			command: "plan-review",
			reviewPath,
		});
	}

	// Ensure plan is recorded
	upsertPlan(db, { planPath });

	// Create log directory for this run (user-only permissions)
	const logDir = join(workdir, ".5x", "logs", runId);
	if (!existsSync(logDir)) {
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
	}
	console.log(`  Logs: ${logDir}`);

	appendRunEvent(db, {
		runId,
		eventType: "plan_review_start",
		iteration,
		data: { planPath, reviewPath },
	});

	// --- State machine loop ---
	while (state !== "APPROVED" && state !== "ABORTED") {
		// Guard: max iterations
		if (iteration >= maxIterations * 2) {
			// Each "iteration" is one agent call; a review cycle is 2 calls (reviewer + author fix)
			// So max review iterations * 2 gives the upper bound on agent calls
			const event: EscalationEvent = {
				reason: `Maximum review iterations (${maxIterations}) reached`,
				iteration,
			};
			escalations.push(event);
			appendRunEvent(db, {
				runId,
				eventType: "escalation",
				iteration,
				data: event,
			});
			state = "ESCALATE";
		}

		switch (state) {
			case "REVIEW": {
				updateRunStatus(db, runId, "active", "REVIEW");

				// Check if this step was already completed (resume)
				if (
					hasCompletedStep(
						db,
						runId,
						"reviewer",
						"-1",
						iteration,
						"reviewer-plan",
						"verdict",
					)
				) {
					console.log(
						`  Skipping reviewer step ${iteration} (already completed)`,
					);
					// Route based on stored verdict
					const verdict = getLatestVerdict(db, runId, "-1");
					if (!verdict) {
						const event: EscalationEvent = {
							reason:
								"Reviewer result stored but cannot be read. Manual review required.",
							iteration,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							iteration,
							data: event,
						});
						state = "ESCALATE";
						break;
					}

					try {
						assertReviewerVerdict(verdict, "PLAN_REVIEW/REVIEW");
					} catch (err) {
						const event: EscalationEvent = {
							reason: err instanceof Error ? err.message : String(err),
							iteration,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							iteration,
							data: event,
						});
						state = "ESCALATE";
						break;
					}

					// Route verdict using shared logic
					appendRunEvent(db, {
						runId,
						eventType: "verdict",
						iteration,
						data: {
							readiness: verdict.readiness,
							itemCount: verdict.items.length,
						},
					});
					console.log(`  Verdict: ${verdict.readiness}`);
					const routeResult = routePlanVerdict(
						verdict,
						iteration,
						undefined,
						escalations,
						db,
						runId,
						options,
					);
					if (routeResult.incrementIteration) iteration++;
					state = routeResult.nextState;
					break;
				}

				// Render reviewer prompt
				const reviewerTemplate = renderTemplate("reviewer-plan", {
					plan_path: planPath,
					review_path: reviewPath,
				});

				console.log(`  Reviewer iteration ${Math.floor(iteration / 2) + 1}...`);

				const reviewResultId = generateId();
				const reviewLogPath = join(logDir, `agent-${reviewResultId}.ndjson`);

				let reviewResult: InvokeVerdict;
				try {
					reviewResult = await adapter.invokeForVerdict({
						prompt: reviewerTemplate.prompt,
						model: config.reviewer.model,
						workdir,
						logPath: reviewLogPath,
						quiet,
					});
				} catch (err) {
					const event: EscalationEvent = {
						reason: buildEscalationReason(
							`Reviewer invocation failed: ${err instanceof Error ? err.message : String(err)}`,
							reviewLogPath,
						),
						iteration,
						logPath: reviewLogPath,
					};
					escalations.push(event);
					appendRunEvent(db, {
						runId,
						eventType: "escalation",
						iteration,
						data: event,
					});
					iteration++;
					state = "ESCALATE";
					break;
				}

				// Store result
				upsertAgentResult(db, {
					id: reviewResultId,
					run_id: runId,
					phase: "-1",
					iteration,
					role: "reviewer",
					template: "reviewer-plan",
					result_type: "verdict",
					result_json: JSON.stringify(reviewResult.verdict),
					duration_ms: reviewResult.duration,
					log_path: reviewLogPath,
					session_id: reviewResult.sessionId ?? null,
					model: config.reviewer.model ?? null,
					tokens_in: reviewResult.tokensIn ?? null,
					tokens_out: reviewResult.tokensOut ?? null,
					cost_usd: reviewResult.costUsd ?? null,
				});

				appendRunEvent(db, {
					runId,
					eventType: "agent_invoke",
					iteration,
					data: {
						role: "reviewer",
						template: "reviewer-plan",
						duration: reviewResult.duration,
						logPath: reviewLogPath,
					},
				});

				// Append audit record
				try {
					await appendStructuredAuditRecord(reviewPath, {
						schema: 1,
						type: "verdict",
						phase: "-1",
						iteration,
						data: reviewResult.verdict,
					});
				} catch {
					// Best-effort
				}

				// Validate invariants
				try {
					assertReviewerVerdict(reviewResult.verdict, "PLAN_REVIEW/REVIEW");
				} catch (err) {
					const event: EscalationEvent = {
						reason: err instanceof Error ? err.message : String(err),
						iteration,
						logPath: reviewLogPath,
					};
					escalations.push(event);
					appendRunEvent(db, {
						runId,
						eventType: "escalation",
						iteration,
						data: event,
					});
					state = "ESCALATE";
					break;
				}

				appendRunEvent(db, {
					runId,
					eventType: "verdict",
					iteration,
					data: {
						readiness: reviewResult.verdict.readiness,
						itemCount: reviewResult.verdict.items.length,
						autoFixCount: reviewResult.verdict.items.filter(
							(i) => i.action === "auto_fix",
						).length,
						humanRequiredCount: reviewResult.verdict.items.filter(
							(i) => i.action === "human_required",
						).length,
					},
				});

				console.log(`  Verdict: ${reviewResult.verdict.readiness}`);

				// Route verdict
				const routeResult = routePlanVerdict(
					reviewResult.verdict,
					iteration,
					reviewLogPath,
					escalations,
					db,
					runId,
					options,
				);
				if (routeResult.incrementIteration) iteration++;
				state = routeResult.nextState;
				break;
			}

			case "AUTO_FIX": {
				updateRunStatus(db, runId, "active", "AUTO_FIX");

				// Check if this step was already completed (resume)
				if (
					hasCompletedStep(
						db,
						runId,
						"author",
						"-1",
						iteration,
						"author-process-review",
						"status",
					)
				) {
					console.log(
						`  Skipping author-fix step ${iteration} (already completed)`,
					);
					// Route based on stored result
					const authorStatus = getLatestStatus(db, runId, "-1");
					if (!authorStatus) {
						const event: EscalationEvent = {
							reason: "Author fix result stored but cannot be read.",
							iteration,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							iteration,
							data: event,
						});
						state = "ESCALATE";
						break;
					}

					if (
						authorStatus.result === "needs_human" ||
						authorStatus.result === "failed"
					) {
						const event: EscalationEvent = {
							reason:
								authorStatus.reason ??
								`Author reported ${authorStatus.result} during fix`,
							iteration,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							iteration,
							data: event,
						});
						state = "ESCALATE";
						break;
					}

					console.log("  Author fix applied. Re-reviewing...");
					iteration++;
					state = "REVIEW";
					break;
				}

				// Render author fix prompt
				const authorTemplate = renderTemplate("author-process-review", {
					review_path: reviewPath,
					plan_path: planPath,
				});

				const authorResultId = generateId();
				const authorLogPath = join(logDir, `agent-${authorResultId}.ndjson`);

				let authorResult: InvokeStatus;
				try {
					authorResult = await adapter.invokeForStatus({
						prompt: authorTemplate.prompt,
						model: config.author.model,
						workdir,
						logPath: authorLogPath,
						quiet,
					});
				} catch (err) {
					const event: EscalationEvent = {
						reason: buildEscalationReason(
							`Author invocation failed during fix: ${err instanceof Error ? err.message : String(err)}`,
							authorLogPath,
						),
						iteration,
						logPath: authorLogPath,
					};
					escalations.push(event);
					appendRunEvent(db, {
						runId,
						eventType: "escalation",
						iteration,
						data: event,
					});
					iteration++;
					state = "ESCALATE";
					break;
				}

				// Store result
				upsertAgentResult(db, {
					id: authorResultId,
					run_id: runId,
					phase: "-1",
					iteration,
					role: "author",
					template: "author-process-review",
					result_type: "status",
					result_json: JSON.stringify(authorResult.status),
					duration_ms: authorResult.duration,
					log_path: authorLogPath,
					session_id: authorResult.sessionId ?? null,
					model: config.author.model ?? null,
					tokens_in: authorResult.tokensIn ?? null,
					tokens_out: authorResult.tokensOut ?? null,
					cost_usd: authorResult.costUsd ?? null,
				});

				appendRunEvent(db, {
					runId,
					eventType: "agent_invoke",
					iteration,
					data: {
						role: "author",
						template: "author-process-review",
						duration: authorResult.duration,
						logPath: authorLogPath,
					},
				});

				// Append audit record
				try {
					await appendStructuredAuditRecord(reviewPath, {
						schema: 1,
						type: "status",
						phase: "-1",
						iteration,
						data: authorResult.status,
					});
				} catch {
					// Best-effort
				}

				// Validate invariants
				try {
					assertAuthorStatus(authorResult.status, "PLAN_REVIEW/AUTO_FIX");
				} catch (err) {
					const event: EscalationEvent = {
						reason: err instanceof Error ? err.message : String(err),
						iteration,
						logPath: authorLogPath,
					};
					escalations.push(event);
					appendRunEvent(db, {
						runId,
						eventType: "escalation",
						iteration,
						data: event,
					});
					state = "ESCALATE";
					break;
				}

				// Route on status
				if (authorResult.status.result === "needs_human") {
					const event: EscalationEvent = {
						reason:
							authorResult.status.reason ??
							"Author needs human input during fix",
						iteration,
						logPath: authorLogPath,
					};
					escalations.push(event);
					appendRunEvent(db, {
						runId,
						eventType: "escalation",
						iteration,
						data: event,
					});
					state = "ESCALATE";
					break;
				}

				if (authorResult.status.result === "failed") {
					const event: EscalationEvent = {
						reason:
							authorResult.status.reason ??
							"Author reported failure during fix",
						iteration,
						logPath: authorLogPath,
					};
					escalations.push(event);
					appendRunEvent(db, {
						runId,
						eventType: "escalation",
						iteration,
						data: event,
					});
					state = "ESCALATE";
					break;
				}

				// Author completed — back to review
				console.log("  Author fix applied. Re-reviewing...");
				iteration++;
				state = "REVIEW";
				break;
			}

			case "ESCALATE": {
				updateRunStatus(db, runId, "active", "ESCALATE");

				const lastEscalation =
					escalations[escalations.length - 1] ??
					({
						reason: "Unknown escalation",
						iteration,
					} satisfies EscalationEvent);

				if (options.auto) {
					// In auto mode, escalation = abort
					console.log(`  Auto mode: escalation — ${lastEscalation.reason}`);
					state = "ABORTED";
					break;
				}

				const decision = await humanGate(lastEscalation);
				appendRunEvent(db, {
					runId,
					eventType: "human_decision",
					iteration,
					data: { decision, escalation: lastEscalation },
				});

				switch (decision) {
					case "continue":
						state = "REVIEW";
						break;
					case "approve":
						state = "APPROVED";
						break;
					case "abort":
						state = "ABORTED";
						break;
				}
				break;
			}

			default: {
				// Should never reach here
				const event: EscalationEvent = {
					reason: `Unknown state: ${state}`,
					iteration,
				};
				escalations.push(event);
				state = "ABORTED";
				break;
			}
		}
	}

	// --- Finalize ---
	const approved = state === "APPROVED";
	const finalStatus = approved ? "completed" : "aborted";

	updateRunStatus(db, runId, finalStatus, state);
	appendRunEvent(db, {
		runId,
		eventType: approved ? "plan_review_complete" : "plan_review_abort",
		iteration,
		data: {
			approved,
			iterations: iteration,
			escalationCount: escalations.length,
		},
	});

	return {
		approved,
		iterations: iteration,
		reviewPath,
		runId,
		escalations,
	};
}

// ---------------------------------------------------------------------------
// Verdict routing helper
// ---------------------------------------------------------------------------

interface PlanVerdictRouteResult {
	nextState: LoopState;
	incrementIteration: boolean;
}

function routePlanVerdict(
	verdict: import("../protocol.js").ReviewerVerdict,
	iteration: number,
	logPath: string | undefined,
	escalations: EscalationEvent[],
	db: Database,
	runId: string,
	options: PlanReviewLoopOptions,
): PlanVerdictRouteResult {
	if (verdict.readiness === "ready") {
		return { nextState: "APPROVED", incrementIteration: true };
	}

	// Check for human_required items
	const humanItems = verdict.items.filter((i) => i.action === "human_required");
	if (humanItems.length > 0) {
		const event: EscalationEvent = {
			reason: options.auto
				? `${humanItems.length} item(s) require human review (auto mode cannot resolve)`
				: `${humanItems.length} item(s) require human review`,
			items: humanItems.map((i) => ({
				id: i.id,
				title: i.title,
				reason: i.reason,
			})),
			iteration,
			logPath,
		};
		escalations.push(event);
		appendRunEvent(db, {
			runId,
			eventType: "escalation",
			iteration,
			data: event,
		});
		return { nextState: "ESCALATE", incrementIteration: true };
	}

	// ready_with_corrections or not_ready with all auto_fix items
	if (
		verdict.readiness === "ready_with_corrections" ||
		verdict.readiness === "not_ready"
	) {
		const autoFixItems = verdict.items.filter((i) => i.action === "auto_fix");
		if (autoFixItems.length > 0) {
			console.log(`  Auto-fixing ${autoFixItems.length} item(s)...`);
			return { nextState: "AUTO_FIX", incrementIteration: true };
		}
		// Non-ready with no auto-fixable items — escalate
		const event: EscalationEvent = {
			reason: `Reviewer returned ${verdict.readiness} with no auto-fixable items`,
			iteration,
			logPath,
		};
		escalations.push(event);
		appendRunEvent(db, {
			runId,
			eventType: "escalation",
			iteration,
			data: event,
		});
		return { nextState: "ESCALATE", incrementIteration: true };
	}

	// Fallback — unexpected readiness value; escalate rather than approve
	const event: EscalationEvent = {
		reason: `Unexpected readiness value "${verdict.readiness}" — escalating for manual review`,
		iteration,
		logPath,
	};
	escalations.push(event);
	appendRunEvent(db, {
		runId,
		eventType: "escalation",
		iteration,
		data: event,
	});
	return { nextState: "ESCALATE", incrementIteration: true };
}
