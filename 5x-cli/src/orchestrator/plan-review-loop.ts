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
import { AgentCancellationError } from "../agents/errors.js";
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
	getStepResult,
	hasCompletedStep,
	updateRunStatus,
	upsertAgentResult,
	upsertPlan,
} from "../db/operations.js";
import { canonicalizePlanPath } from "../paths.js";
import { assertAuthorStatus, assertReviewerVerdict } from "../protocol.js";
import { renderTemplate } from "../templates/loader.js";
import type { TuiController } from "../tui/controller.js";
import { buildEscalationReason } from "../utils/agent-event-helpers.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// EscalationEvent is defined once in gates/human.ts (shared with phase-execution-loop).
// Re-exported here for backward compatibility with existing consumers.
export type { EscalationEvent } from "../gates/human.js";

import type { EscalationEvent, EscalationResponse } from "../gates/human.js";

export interface PlanReviewResult {
	approved: boolean;
	iterations: number;
	reviewPath: string;
	runId: string;
	escalations: EscalationEvent[];
}

export interface ResolveReviewPathOptions {
	/** Additional directories that are valid review roots (e.g. worktree mirror dir). */
	additionalReviewDirs?: string[];
	/** Optional warning sink for testability. */
	warn?: (message: string) => void;
	/** Filter DB lookup to runs with this command (e.g. 'plan-review' or 'run'). */
	command?: string;
	/** Filename suffix before `.md` (default: 'review'). Use 'plan-review' for plan reviews. */
	reviewSuffix?: string;
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
	 * Stable canonical plan path for DB identity. When the planPath parameter
	 * has been remapped (e.g., to a worktree), DB operations must still use
	 * the primary checkout's canonical path for resume/history continuity.
	 * Falls back to `canonicalizePlanPath(planPath)` when not provided.
	 */
	canonicalPlanPath?: string;
	/**
	 * When true (or the function returns true), suppress formatted agent event
	 * output to stdout. Accepts a function so callers can re-evaluate at each
	 * invocation — e.g. `() => effectiveQuiet || tui.active` so that TUI exit
	 * mid-run is reflected in subsequent invocations (P1.4).
	 * Default: false (show output). Use !process.stdout.isTTY as the default
	 * at the command layer before passing here.
	 */
	quiet?: boolean | (() => boolean);
	/** Show reasoning/thinking tokens inline (dim). Default: false (suppressed). */
	showReasoning?: boolean;
	/** Override for testing — supply a function that prompts for human decisions. */
	humanGate?: (event: EscalationEvent) => Promise<PlanReviewHumanGateResponse>;
	/** Override for testing — supply a function that prompts for resume decisions. */
	resumeGate?: (
		runId: string,
		iteration: number,
	) => Promise<"resume" | "start-fresh" | "abort">;
	/**
	 * Injectable logger for status messages. Defaults to `console.log`.
	 * Gated on `quiet` internally. Primarily for test DI.
	 */
	_log?: (...args: unknown[]) => void;
	/**
	 * AbortSignal for external cancellation (Ctrl-C, TUI exit, parent timeout).
	 * The orchestrator checks this signal at key await points and aborts
	 * gracefully, allowing finally blocks to run for cleanup.
	 */
	signal?: AbortSignal;
	/**
	 * TUI controller for session switching and toast notifications.
	 * When provided, the orchestrator will call selectSession after each
	 * session creation and showToast at key phase boundaries.
	 */
	tui?: TuiController;
	/** Optional debug trace sink for lifecycle diagnostics. */
	trace?: (event: string, data?: unknown) => void;
}

export type PlanReviewHumanGateResponse =
	| "continue"
	| "approve"
	| "abort"
	| EscalationResponse;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a simple unique ID (UUID v4). */
function generateId(): string {
	return crypto.randomUUID();
}

/**
 * Compute review path for a plan or run. Checks DB for an existing review_path
 * from prior runs on this plan (reuse for addendum continuity); if none, compute
 * a fresh path: `<reviewsDir>/<date>-<plan-basename>-<suffix>.md`.
 *
 * Use `options.command` to scope the DB lookup to a specific command type
 * (e.g. 'plan-review' or 'run') so plan-review paths don't leak into run
 * lookups and vice versa.
 *
 * Use `options.reviewSuffix` to control the filename suffix (default: 'review').
 * For plan reviews, pass 'plan-review' to produce `-plan-review.md` filenames.
 */
export function resolveReviewPath(
	db: Database,
	planPath: string,
	reviewsDir: string,
	options: ResolveReviewPathOptions = {},
): string {
	const canonical = canonicalizePlanPath(planPath);
	const resolvedReviewsDir = resolve(reviewsDir);
	const resolvedAdditionalDirs = (options.additionalReviewDirs ?? []).map(
		(dir) => resolve(dir),
	);
	const allowedReviewDirs = [resolvedReviewsDir, ...resolvedAdditionalDirs];
	const warnedPaths = new Set<string>();
	const warn = options.warn ?? console.warn;
	const warnOutsideConfiguredDir = (reviewPath: string) => {
		if (warnedPaths.has(reviewPath)) return;
		warnedPaths.add(reviewPath);
		warn(
			`  Warning: DB review path "${reviewPath}" is outside configured reviews dir. Computing fresh path.`,
		);
	};

	/** True when `filePath` resolves to somewhere strictly inside any allowed review dir. */
	const isUnderReviewsDir = (filePath: string): boolean => {
		const resolvedFile = resolve(filePath);
		return allowedReviewDirs.some((reviewRoot) => {
			const rel = relative(reviewRoot, resolvedFile);
			// Outside if empty (same dir), starts with "..", or is absolute (Windows cross-drive)
			return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
		});
	};

	const command = options.command;

	// Check DB for existing review path — validate it's under the reviews dir
	const latestRun = getLatestRun(db, canonical, command);
	if (latestRun?.review_path) {
		if (isUnderReviewsDir(latestRun.review_path)) {
			return latestRun.review_path;
		}
		warnOutsideConfiguredDir(latestRun.review_path);
	}

	// Also check non-canonical path
	const latestRunAlt = getLatestRun(db, planPath, command);
	if (latestRunAlt?.review_path) {
		if (isUnderReviewsDir(latestRunAlt.review_path)) {
			return latestRunAlt.review_path;
		}
		warnOutsideConfiguredDir(latestRunAlt.review_path);
	}

	// Compute fresh path
	const suffix = options.reviewSuffix ?? "review";
	const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	const planBase = basename(planPath, ".md");
	return join(reviewsDir, `${date}-${planBase}-${suffix}.md`);
}

/** Default human escalation gate — prompts via stdin. */
async function defaultHumanGate(
	event: EscalationEvent,
): Promise<EscalationResponse> {
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
	console.log(
		"    f = fix with guidance (agent addresses issues, then re-review)",
	);
	console.log("    o = override and move on (force approve)");
	console.log("    q = abort (stop the review loop)");
	console.log();

	// Non-interactive detection
	if (!process.stdin.isTTY) {
		console.log("  Non-interactive mode detected — aborting.");
		return { action: "abort" };
	}

	process.stdout.write("  Choice [f/o/q]: ");
	const input = await readLine();
	const choice = input.trim().toLowerCase();
	if (choice === "f" || choice === "fix" || choice === "continue") {
		process.stdout.write("  Guidance (optional, press Enter to skip): ");
		const guidance = await readLine();
		return {
			action: "continue",
			guidance: guidance.trim() || undefined,
		};
	}
	if (choice === "o" || choice === "override" || choice === "approve")
		return { action: "approve" };
	return { action: "abort" };
}

function normalizeHumanGateResponse(
	response: PlanReviewHumanGateResponse,
): EscalationResponse {
	if (typeof response !== "string") return response;
	if (response === "continue") return { action: "continue" };
	if (response === "approve") return { action: "approve" };
	return { action: "abort" };
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
	const trace = options.trace ?? (() => {});
	const humanGate = options.humanGate ?? defaultHumanGate;
	const resumeGate = options.resumeGate ?? defaultResumeGate;
	const maxIterations = config.maxReviewIterations;
	const maxAutoRetries = config.maxAutoRetries;
	// Resolve quiet: accepts boolean or function (function form re-evaluated at
	// each adapter call so TUI exit mid-run affects subsequent invocations).
	const _quietOpt = options.quiet;
	const resolveQuiet: () => boolean =
		typeof _quietOpt === "function" ? _quietOpt : () => _quietOpt ?? false;
	const showReasoning = options.showReasoning ?? false;
	/** Quiet-gated log: suppresses stdout when TUI is active (quiet=true). */
	const _sink = options._log ?? console.log;
	const log = (...args: unknown[]) => {
		if (!resolveQuiet()) _sink(...args);
	};
	const workdir = options.projectRoot ?? dirname(resolve(planPath));

	// DB identity: use the stable canonical path provided by the command layer,
	// or fall back to canonicalizing planPath (correct for non-worktree runs).
	const dbPlanPath =
		options.canonicalPlanPath ?? canonicalizePlanPath(planPath);
	const escalations: EscalationEvent[] = [];

	// --- Resume detection ---
	let runId: string;
	let iteration = 0;
	let state: LoopState = "REVIEW";

	const activeRun = getActiveRun(db, dbPlanPath);
	if (activeRun && activeRun.command === "plan-review") {
		// In auto mode, deterministically resume without prompting — interactive
		// resume gates write to stdout and block on stdin, which is incompatible
		// with TUI mode (child owns terminal) and unattended CI flows.
		let resumeDecision: "resume" | "start-fresh" | "abort";
		if (options.auto && !options.resumeGate) {
			const savedState = activeRun.current_state ?? "REVIEW";
			// ABORTED is terminal in auto mode. Start fresh.
			if (savedState === "ABORTED") {
				resumeDecision = "start-fresh";
				log(
					`  Auto mode: run ${activeRun.id.slice(0, 8)} stuck at ${savedState} — starting fresh`,
				);
				appendRunEvent(db, {
					runId: activeRun.id,
					eventType: "auto_start_fresh",
					data: {
						reason: `Resumed state ${savedState} is terminal in auto mode`,
					},
				});
			} else {
				resumeDecision = "resume";
				log(
					`  Auto mode: resuming interrupted run ${activeRun.id.slice(0, 8)} (iteration ${iteration})`,
				);
			}
		} else {
			resumeDecision = await resumeGate(activeRun.id, iteration);
		}

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
			log(
				`  Resuming run ${runId.slice(0, 8)} at iteration ${iteration}, state ${state}`,
			);
		} else {
			// start-fresh: mark old run as aborted
			updateRunStatus(db, activeRun.id, "aborted");
			runId = generateId();
			createRun(db, {
				id: runId,
				planPath: dbPlanPath,
				command: "plan-review",
				reviewPath,
			});
		}
	} else {
		runId = generateId();
		createRun(db, {
			id: runId,
			planPath: dbPlanPath,
			command: "plan-review",
			reviewPath,
		});
	}

	// Ensure plan is recorded (use dbPlanPath for stable DB identity)
	upsertPlan(db, { planPath: dbPlanPath });

	// Create log directory for this run (user-only permissions)
	const logDir = join(workdir, ".5x", "logs", runId);
	if (!existsSync(logDir)) {
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
	}
	log(`  Logs: ${logDir}`);

	appendRunEvent(db, {
		runId,
		eventType: "plan_review_start",
		iteration,
		data: { planPath, reviewPath },
	});

	// Tracks the state before each transition to ESCALATE, so "continue"
	// resumes the correct state (REVIEW or AUTO_FIX) rather than always REVIEW.
	let preEscalateState: LoopState = "REVIEW";
	let autoEscalationAttempts = 0;
	let userGuidance: string | undefined;

	// --- State machine loop ---
	while (state !== "APPROVED" && state !== "ABORTED") {
		// Check for external cancellation (Ctrl-C, TUI exit, parent timeout)
		if (options.signal?.aborted) {
			state = "ABORTED";
			break;
		}

		if (state !== "ESCALATE") preEscalateState = state;
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
					log(`  Skipping reviewer step ${iteration} (already completed)`);
					// Route based on exact step result (not phase-wide latest)
					const stepRow = getStepResult(
						db,
						runId,
						"reviewer",
						"-1",
						iteration,
						"reviewer-plan",
						"verdict",
					);
					if (!stepRow) {
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

					let verdict: import("../protocol.js").ReviewerVerdict;
					try {
						verdict = JSON.parse(stepRow.result_json);
					} catch {
						const event: EscalationEvent = {
							reason:
								"Reviewer result stored but JSON is malformed. Manual review required.",
							iteration,
							logPath: stepRow.log_path ?? undefined,
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
							logPath: stepRow.log_path ?? undefined,
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
					log(`  Verdict: ${verdict.readiness}`);
					const routeResult = routePlanVerdict(
						verdict,
						iteration,
						stepRow.log_path ?? undefined,
						escalations,
						db,
						runId,
						options,
						log,
					);
					if (routeResult.incrementIteration) iteration++;
					state = routeResult.nextState;
					break;
				}

				// Render reviewer prompt
				const reviewerTemplate = renderTemplate("reviewer-plan", {
					plan_path: planPath,
					review_path: reviewPath,
					review_template_path: resolve(workdir, config.paths.templates.review),
				});

				log(`  Reviewer iteration ${Math.floor(iteration / 2) + 1}...`);

				const reviewResultId = generateId();
				const reviewLogPath = join(logDir, `agent-${reviewResultId}.ndjson`);

				let reviewResult: InvokeVerdict;
				try {
					// Phase 4: Pass descriptive session title for TUI
					const reviewIteration = Math.floor(iteration / 2) + 1;
					const sessionTitle = `Plan review — iteration ${reviewIteration}`;
					reviewResult = await adapter.invokeForVerdict({
						prompt: reviewerTemplate.prompt,
						model: config.reviewer.model,
						workdir,
						logPath: reviewLogPath,
						quiet: resolveQuiet,
						showReasoning,
						signal: options.signal,
						trace,
						sessionTitle,
						// Phase 4: Select session immediately after creation
						onSessionCreated: options.tui
							? (sessionId) => options.tui?.selectSession(sessionId, workdir)
							: undefined,
					});
				} catch (err) {
					// Check for cancellation first
					if (
						err instanceof AgentCancellationError ||
						options.signal?.aborted
					) {
						state = "ABORTED";
						break;
					}
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

				log(`  Verdict: ${reviewResult.verdict.readiness}`);

				// Route verdict
				const routeResult = routePlanVerdict(
					reviewResult.verdict,
					iteration,
					reviewLogPath,
					escalations,
					db,
					runId,
					options,
					log,
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
					log(`  Skipping author-fix step ${iteration} (already completed)`);
					// Route based on exact step result (not phase-wide latest)
					const stepRow = getStepResult(
						db,
						runId,
						"author",
						"-1",
						iteration,
						"author-process-review",
						"status",
					);
					if (!stepRow) {
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

					let authorStatus: import("../protocol.js").AuthorStatus;
					try {
						authorStatus = JSON.parse(stepRow.result_json);
					} catch {
						const event: EscalationEvent = {
							reason:
								"Author fix result stored but JSON is malformed. Manual review required.",
							iteration,
							logPath: stepRow.log_path ?? undefined,
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
							logPath: stepRow.log_path ?? undefined,
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

					log("  Author fix applied. Re-reviewing...");
					iteration++;
					state = "REVIEW";
					break;
				}

				// Render author fix prompt
				const authorTemplate = renderTemplate("author-process-review", {
					review_path: reviewPath,
					plan_path: planPath,
					user_notes: userGuidance ?? "(No additional notes)",
				});
				userGuidance = undefined;

				const authorResultId = generateId();
				const authorLogPath = join(logDir, `agent-${authorResultId}.ndjson`);

				let authorResult: InvokeStatus;
				try {
					// Phase 4: Pass descriptive session title for TUI
					const fixIteration = Math.floor(iteration / 2) + 1;
					const sessionTitle = `Plan revision — iteration ${fixIteration}`;
					authorResult = await adapter.invokeForStatus({
						prompt: authorTemplate.prompt,
						model: config.author.model,
						workdir,
						logPath: authorLogPath,
						quiet: resolveQuiet,
						showReasoning,
						signal: options.signal,
						trace,
						sessionTitle,
						// Phase 4: Select session immediately after creation
						onSessionCreated: options.tui
							? (sessionId) => options.tui?.selectSession(sessionId, workdir)
							: undefined,
					});
				} catch (err) {
					// Check for cancellation first
					if (
						err instanceof AgentCancellationError ||
						options.signal?.aborted
					) {
						state = "ABORTED";
						break;
					}
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
				log("  Author fix applied. Re-reviewing...");
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
					autoEscalationAttempts += 1;
					const resumeState =
						(lastEscalation.retryState as LoopState | undefined) ??
						preEscalateState;

					if (autoEscalationAttempts <= maxAutoRetries) {
						log(
							`  Auto mode: escalation — continuing without guidance (${autoEscalationAttempts}/${maxAutoRetries})`,
						);
						appendRunEvent(db, {
							runId,
							eventType: "auto_escalation_continue",
							iteration,
							data: {
								reason: lastEscalation.reason,
								attempt: autoEscalationAttempts,
								maxAttempts: maxAutoRetries,
								resumeState,
							},
						});
						state = resumeState;
						break;
					}

					log(
						`  Auto mode: escalation persisted after ${maxAutoRetries} attempt(s) — aborting.`,
					);
					appendRunEvent(db, {
						runId,
						eventType: "auto_escalation_abort",
						iteration,
						data: {
							reason: lastEscalation.reason,
							attempt: autoEscalationAttempts,
							maxAttempts: maxAutoRetries,
						},
					});
					state = "ABORTED";
					break;
				}

				const response = normalizeHumanGateResponse(
					await humanGate(lastEscalation),
				);
				appendRunEvent(db, {
					runId,
					eventType: "human_decision",
					iteration,
					data: { response, escalation: lastEscalation },
				});

				switch (response.action) {
					case "continue": {
						// Resume explicit retry state when present; otherwise return to the
						// state that triggered escalation.
						const resumeState =
							(lastEscalation.retryState as LoopState | undefined) ??
							preEscalateState;
						if (response.guidance && resumeState === "AUTO_FIX") {
							userGuidance = response.guidance;
						}
						state = resumeState;
						break;
					}
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
	log: (...args: unknown[]) => void = console.log,
): PlanVerdictRouteResult {
	if (verdict.readiness === "ready") {
		return { nextState: "APPROVED", incrementIteration: true };
	}

	// Check for human_required items
	const humanItems = verdict.items.filter((i) => i.action === "human_required");
	if (humanItems.length > 0) {
		const event: EscalationEvent = {
			reason: options.auto
				? `${humanItems.length} item(s) require human review (auto mode will attempt best-judgment fixes)`
				: `${humanItems.length} item(s) require human review`,
			retryState: "AUTO_FIX",
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
			log(`  Auto-fixing ${autoFixItems.length} item(s)...`);
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
