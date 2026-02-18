import type { Database } from "bun:sqlite";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import type { AgentAdapter, AgentResult } from "../agents/types.js";
import type { FiveXConfig } from "../config.js";
import {
	appendRunEvent,
	createRun,
	getActiveRun,
	getLatestRun,
	hasCompletedStep,
	updateRunStatus,
	upsertAgentResult,
	upsertPlan,
} from "../db/operations.js";
import type { VerdictBlock } from "../parsers/signals.js";
import { parseStatusBlock, parseVerdictBlock } from "../parsers/signals.js";
import { canonicalizePlanPath } from "../paths.js";
import { renderTemplate } from "../templates/loader.js";
import {
	buildEscalationReason,
	makeOnEvent,
} from "../utils/agent-event-helpers.js";
import { endStream } from "../utils/stream.js";

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
 */
type LoopState =
	| "REVIEW"
	| "PARSE_VERDICT"
	| "AUTO_FIX"
	| "PARSE_STATUS"
	| "ESCALATE"
	| "APPROVED"
	| "ABORTED";

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
 * State transitions:
 *   REVIEW → PARSE_VERDICT → APPROVED          (ready)
 *   REVIEW → PARSE_VERDICT → AUTO_FIX → REVIEW (ready_with_corrections, all auto_fix)
 *   REVIEW → PARSE_VERDICT → ESCALATE          (has human_required items)
 *   REVIEW → PARSE_VERDICT → ESCALATE          (missing verdict block)
 *   AUTO_FIX → PARSE_STATUS → REVIEW           (author completed)
 *   AUTO_FIX → PARSE_STATUS → ESCALATE         (author needs_human)
 *   ESCALATE → REVIEW                          (human provides guidance, continue)
 *   ESCALATE → APPROVED                        (human overrides, accepts)
 *   ESCALATE → ABORTED                         (human aborts)
 *   any → ESCALATE                             (max iterations reached)
 */
export async function runPlanReviewLoop(
	planPath: string,
	reviewPath: string,
	db: Database,
	authorAdapter: AgentAdapter,
	reviewerAdapter: AgentAdapter,
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
			// Restore state from DB
			state = (activeRun.current_state as LoopState) ?? "REVIEW";
			// Iteration is tracked via agent_results count
			const { getAgentResults } = await import("../db/operations.js");
			const results = getAgentResults(db, runId, "-1"); // phase -1 for plan-review
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

	// Tracks the most recent agent NDJSON log path across state transitions so
	// PARSE_* states can include it in escalation events.
	let lastAgentLogPath: string | undefined;

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
					)
				) {
					console.log(
						`  Skipping reviewer step ${iteration} (already completed)`,
					);
					state = "PARSE_VERDICT";
					break;
				}

				// Render reviewer prompt
				const reviewerTemplate = renderTemplate("reviewer-plan", {
					plan_path: planPath,
					review_path: reviewPath,
				});

				console.log(`  Reviewer iteration ${Math.floor(iteration / 2) + 1}...`);

				// Open log stream before invoking
				const reviewResultId = generateId();
				const reviewLogPath = join(logDir, `agent-${reviewResultId}.ndjson`);
				const reviewLogStream = createWriteStream(reviewLogPath);
				reviewLogStream.on("error", (err) =>
					console.warn(
						`[warn] agent log stream error: ${err instanceof Error ? err.message : String(err)}`,
					),
				);

				// Invoke reviewer
				let reviewResult: AgentResult;
				try {
					reviewResult = await reviewerAdapter.invoke({
						prompt: reviewerTemplate.prompt,
						model: config.reviewer.model,
						workdir,
						logStream: reviewLogStream,
						onEvent: makeOnEvent(quiet),
					});
				} finally {
					await endStream(reviewLogStream);
				}

				// Store result
				// Parse verdict from the review file (reviewer writes to it)
				let verdict: VerdictBlock | null = null;
				if (existsSync(reviewPath)) {
					const reviewContent = readFileSync(reviewPath, "utf-8");
					verdict = parseVerdictBlock(reviewContent);
				}
				// Also try parsing from output (in case reviewer emits in stdout)
				if (!verdict) {
					verdict = parseVerdictBlock(reviewResult.output);
				}

				upsertAgentResult(db, {
					id: reviewResultId,
					run_id: runId,
					role: "reviewer",
					template_name: "reviewer-plan",
					phase: "-1",
					iteration,
					exit_code: reviewResult.exitCode,
					duration_ms: reviewResult.duration,
					tokens_in: reviewResult.tokens?.input ?? null,
					tokens_out: reviewResult.tokens?.output ?? null,
					cost_usd: reviewResult.cost ?? null,
					signal_type: verdict ? "verdict" : null,
					signal_data: verdict ? JSON.stringify(verdict) : null,
				});

				appendRunEvent(db, {
					runId,
					eventType: "agent_invoke",
					iteration,
					data: {
						role: "reviewer",
						template: "reviewer-plan",
						exitCode: reviewResult.exitCode,
						duration: reviewResult.duration,
						logPath: reviewLogPath,
					},
				});

				// Record log path for PARSE_VERDICT escalations before incrementing.
				lastAgentLogPath = reviewLogPath;

				// Handle non-zero exit — escalation uses pre-increment iteration to
				// match the agent_results row for this invocation.
				if (reviewResult.exitCode !== 0) {
					const event: EscalationEvent = {
						reason: buildEscalationReason(
							`Reviewer exited with code ${reviewResult.exitCode}`,
							reviewLogPath,
							reviewResult,
							quiet,
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

				iteration++;
				state = "PARSE_VERDICT";
				break;
			}

			case "PARSE_VERDICT": {
				updateRunStatus(db, runId, "active", "PARSE_VERDICT");

				// Get the latest verdict from DB
				const { getLatestVerdict } = await import("../db/operations.js");
				const verdict = getLatestVerdict(db, runId, "-1");

				if (!verdict) {
					// Missing verdict — escalate
					const event: EscalationEvent = {
						reason:
							"Reviewer did not produce a 5x:verdict block. Manual review required.",
						iteration,
						logPath: lastAgentLogPath,
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

				// Verify reviewPath matches
				if (verdict.reviewPath !== reviewPath) {
					console.warn(
						`  Warning: verdict.reviewPath "${verdict.reviewPath}" differs from expected "${reviewPath}"`,
					);
				}

				appendRunEvent(db, {
					runId,
					eventType: "verdict",
					iteration,
					data: {
						readiness: verdict.readiness,
						itemCount: verdict.items.length,
						autoFixCount: verdict.items.filter((i) => i.action === "auto_fix")
							.length,
						humanRequiredCount: verdict.items.filter(
							(i) => i.action === "human_required",
						).length,
					},
				});

				const readiness = verdict.readiness;
				console.log(`  Verdict: ${readiness}`);

				if (readiness === "ready") {
					state = "APPROVED";
					break;
				}

				// Check for human_required items
				const humanItems = verdict.items.filter(
					(i) => i.action === "human_required",
				);
				if (humanItems.length > 0 && !options.auto) {
					const event: EscalationEvent = {
						reason: `${humanItems.length} item(s) require human review`,
						items: humanItems.map((i) => ({
							id: i.id,
							title: i.title,
							reason: i.reason,
						})),
						iteration,
						logPath: lastAgentLogPath,
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

				if (humanItems.length > 0 && options.auto) {
					// Even in auto mode, human_required items escalate
					const event: EscalationEvent = {
						reason: `${humanItems.length} item(s) require human review (auto mode cannot resolve)`,
						items: humanItems.map((i) => ({
							id: i.id,
							title: i.title,
							reason: i.reason,
						})),
						iteration,
						logPath: lastAgentLogPath,
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

				// ready_with_corrections or not_ready with all auto_fix items
				if (
					readiness === "ready_with_corrections" ||
					readiness === "not_ready"
				) {
					const autoFixItems = verdict.items.filter(
						(i) => i.action === "auto_fix",
					);
					if (autoFixItems.length > 0) {
						console.log(`  Auto-fixing ${autoFixItems.length} item(s)...`);
						state = "AUTO_FIX";
						break;
					}
					// Non-ready with no auto-fixable items — escalate
					// (covers parser-dropped items, reviewer mistakes, etc.)
					const event: EscalationEvent = {
						reason: `Reviewer returned ${readiness} with no auto-fixable items`,
						iteration,
						logPath: lastAgentLogPath,
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

				// Fallback — unexpected readiness value; escalate rather than approve
				{
					const event: EscalationEvent = {
						reason: `Unexpected readiness value "${readiness}" — escalating for manual review`,
						iteration,
						logPath: lastAgentLogPath,
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
					)
				) {
					console.log(
						`  Skipping author-fix step ${iteration} (already completed)`,
					);
					state = "PARSE_STATUS";
					break;
				}

				// Render author fix prompt
				const authorTemplate = renderTemplate("author-process-review", {
					review_path: reviewPath,
					plan_path: planPath,
				});

				// Open log stream before invoking
				const authorResultId = generateId();
				const authorLogPath = join(logDir, `agent-${authorResultId}.ndjson`);
				const authorLogStream = createWriteStream(authorLogPath);
				authorLogStream.on("error", (err) =>
					console.warn(
						`[warn] agent log stream error: ${err instanceof Error ? err.message : String(err)}`,
					),
				);

				// Invoke author
				let authorResult: AgentResult;
				try {
					authorResult = await authorAdapter.invoke({
						prompt: authorTemplate.prompt,
						model: config.author.model,
						workdir,
						logStream: authorLogStream,
						onEvent: makeOnEvent(quiet),
					});
				} finally {
					await endStream(authorLogStream);
				}

				// Parse status from author output
				const authorStatus = parseStatusBlock(authorResult.output);

				// Store result
				upsertAgentResult(db, {
					id: authorResultId,
					run_id: runId,
					role: "author",
					template_name: "author-process-review",
					phase: "-1",
					iteration,
					exit_code: authorResult.exitCode,
					duration_ms: authorResult.duration,
					tokens_in: authorResult.tokens?.input ?? null,
					tokens_out: authorResult.tokens?.output ?? null,
					cost_usd: authorResult.cost ?? null,
					signal_type: authorStatus ? "status" : null,
					signal_data: authorStatus ? JSON.stringify(authorStatus) : null,
				});

				appendRunEvent(db, {
					runId,
					eventType: "agent_invoke",
					iteration,
					data: {
						role: "author",
						template: "author-process-review",
						exitCode: authorResult.exitCode,
						duration: authorResult.duration,
						logPath: authorLogPath,
					},
				});

				// Record log path for PARSE_STATUS escalations before incrementing.
				lastAgentLogPath = authorLogPath;
				iteration++;
				state = "PARSE_STATUS";
				break;
			}

			case "PARSE_STATUS": {
				updateRunStatus(db, runId, "active", "PARSE_STATUS");

				// Get latest author status from DB
				const { getLatestStatus } = await import("../db/operations.js");
				const authorStatus = getLatestStatus(db, runId, "-1");

				if (!authorStatus) {
					// Missing status — escalate
					const event: EscalationEvent = {
						reason:
							"Author did not produce a 5x:status block after fix. Manual review required.",
						iteration,
						logPath: lastAgentLogPath,
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

				if (authorStatus.result === "needs_human") {
					const event: EscalationEvent = {
						reason:
							authorStatus.reason ?? "Author needs human input during fix",
						iteration,
						logPath: lastAgentLogPath,
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

				if (authorStatus.result === "failed") {
					const event: EscalationEvent = {
						reason: authorStatus.reason ?? "Author reported failure during fix",
						iteration,
						logPath: lastAgentLogPath,
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
