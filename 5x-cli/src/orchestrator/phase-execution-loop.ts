/**
 * Phase execution loop (Loop 2) — the core state machine for `5x run`.
 *
 * Per-phase inner loop:
 *   1. Parse plan → identify current phase
 *   2. Render author prompt → invoke adapter.invokeForStatus() → store result
 *   3. Route on typed AuthorStatus (no parsing needed)
 *   4. Run quality gates → store result
 *      - If fail: re-invoke author (up to maxQualityRetries)
 *   5. Render reviewer prompt → invoke adapter.invokeForVerdict() → store result
 *   6. Route on typed ReviewerVerdict
 *      - ready → phase gate → next phase
 *      - auto_fix → author fix → back to step 4
 *      - human_required → escalate
 *   7. Phase gate (human confirmation unless --auto)
 *   8. Next phase
 *
 * Phase 4 refactor: PARSE_* states eliminated. Structured output is returned
 * directly from the SDK — the orchestrator gets typed results immediately.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { AgentCancellationError } from "../agents/errors.js";
import type {
	AgentAdapter,
	InvokeStatus,
	InvokeVerdict,
} from "../agents/types.js";
import type { FiveXConfig } from "../config.js";
import type { QualityResultInput } from "../db/operations.js";
import {
	appendRunEvent,
	createRun,
	getActiveRun,
	getAgentResults,
	getApprovedPhaseNumbers,
	getLatestVerdict,
	getMaxIterationForPhase,
	getQualityAttemptCount,
	getStepResult,
	hasCompletedStep,
	markPhaseImplementationDone,
	setPhaseReviewApproved,
	setPhaseReviewOutcome,
	updateRunStatus,
	upsertAgentResult,
	upsertPlan,
	upsertQualityResult,
} from "../db/operations.js";
import type {
	EscalationEvent,
	EscalationResponse,
	PhaseSummary,
} from "../gates/human.js";
import type { QualityResult } from "../gates/quality.js";
import { runQualityGates } from "../gates/quality.js";
import { getCurrentBranch, getLatestCommit, isBranchRelevant } from "../git.js";
import { parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath } from "../paths.js";
import { assertAuthorStatus, assertReviewerVerdict } from "../protocol.js";
import { renderTemplate } from "../templates/loader.js";
import type { TuiController } from "../tui/controller.js";
import { buildEscalationReason } from "../utils/agent-event-helpers.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PhaseExecutionResult {
	phasesCompleted: number;
	totalPhases: number;
	complete: boolean;
	aborted: boolean;
	escalations: EscalationEvent[];
	runId: string;
}

export interface PhaseExecutionOptions {
	auto?: boolean;
	allowDirty?: boolean;
	skipQuality?: boolean;
	startPhase?: string; // phase number to start from (e.g. "3", "1.1")
	workdir: string; // agent workdir (project root or worktree path)
	projectRoot?: string; // original project root (for log/DB anchoring when using worktrees)
	/**
	 * Stable canonical plan path for DB identity. When running in a worktree,
	 * the `planPath` parameter points to the worktree copy (for file I/O),
	 * but DB operations (runs, agent_results, plans) must use the primary
	 * checkout's canonical path so resume/history continuity is preserved.
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
	/** Override for testing — phase gate prompt. */
	phaseGate?: (
		summary: PhaseSummary,
	) => Promise<"continue" | "review" | "abort">;
	/** Override for testing — escalation gate prompt. */
	escalationGate?: (event: EscalationEvent) => Promise<EscalationResponse>;
	/** Override for testing — resume gate prompt. */
	resumeGate?: (
		runId: string,
		phase: string,
		state: string,
	) => Promise<"resume" | "start-fresh" | "abort">;
	/**
	 * Injectable logger for status messages. Defaults to `console.log`.
	 * The orchestrator gates this on `quiet` internally — callers should
	 * NOT pre-gate. Primarily exists for test DI (inject a recording
	 * logger to assert output without touching the global `console`).
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
}

/**
 * Inner-phase state machine states.
 *
 * Phase 4: PARSE_AUTHOR_STATUS, PARSE_VERDICT, PARSE_FIX_STATUS eliminated.
 * Structured output is returned directly from adapter calls.
 */
type PhaseState =
	| "EXECUTE" // invoke author → get typed status directly
	| "QUALITY_CHECK" // run quality gates
	| "QUALITY_RETRY" // re-invoke author after quality failure
	| "REVIEW" // invoke reviewer → get typed verdict directly
	| "AUTO_FIX" // invoke author to fix review items
	| "ESCALATE" // human intervention needed
	| "PHASE_GATE" // human confirmation between phases
	| "PHASE_COMPLETE" // phase done, move to next
	| "ABORTED"; // run stopped

/**
 * Map deprecated PARSE_* states from old DB records to their parent states.
 * Required for backward-compatible resume from runs started before Phase 4.
 */
const LEGACY_STATE_MAP: Record<string, PhaseState> = {
	PARSE_AUTHOR_STATUS: "EXECUTE",
	PARSE_VERDICT: "REVIEW",
	PARSE_FIX_STATUS: "AUTO_FIX",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	return crypto.randomUUID();
}

/**
 * Resolve the review file path for a specific phase.
 *
 * Default behavior now uses per-phase review files to prevent one large
 * append-only document from accumulating all phase addendums.
 *
 * Backward compatibility:
 * - If `reviewPath` includes `{phase}`, that token is replaced.
 * - If `reviewPath` already exists, keep single-file behavior.
 */
export function resolvePhaseReviewPath(
	reviewPath: string,
	phaseNumber: string,
): string {
	const phaseToken = phaseNumber.replace(/[^0-9A-Za-z._-]/g, "-");

	if (reviewPath.includes("{phase}")) {
		return reviewPath.replaceAll("{phase}", phaseToken);
	}

	if (existsSync(reviewPath)) {
		return reviewPath;
	}

	const ext = extname(reviewPath);
	const base = basename(reviewPath, ext);
	if (base.endsWith("-review")) {
		return join(
			dirname(reviewPath),
			`${base.slice(0, -"-review".length)}-phase-${phaseToken}-review${ext}`,
		);
	}

	return join(dirname(reviewPath), `${base}-phase-${phaseToken}${ext}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Run the phase execution loop (Loop 2).
 *
 * Iterates through incomplete phases of the plan. For each phase:
 * author implements → quality gates → reviewer → auto-fix cycles → human gate.
 */
export async function runPhaseExecutionLoop(
	planPath: string,
	reviewPath: string,
	db: Database,
	adapter: AgentAdapter,
	config: FiveXConfig,
	options: PhaseExecutionOptions,
): Promise<PhaseExecutionResult> {
	// DB identity: use the stable canonical path provided by the command layer
	// (anchored to the primary checkout), or fall back to canonicalizing planPath
	// (correct for non-worktree runs where planPath is already the primary path).
	const dbPlanPath =
		options.canonicalPlanPath ?? canonicalizePlanPath(planPath);
	const workdir = options.workdir;
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
	const escalations: EscalationEvent[] = [];
	const maxQualityRetries = config.maxQualityRetries;
	const maxReviewIterations = config.maxReviewIterations;
	// Anchor logs to the project root (not the plan path directory), so
	// logs stay in one predictable location even when running in a worktree.
	const logRoot = options.projectRoot ?? dirname(resolve(planPath));
	const logBaseDir = join(logRoot, ".5x", "logs");

	// --- Resume detection ---
	let runId: string;
	let startPhaseNumber: string | undefined = options.startPhase;
	let resumedState: PhaseState | undefined;
	let resumedPhase: string | undefined;
	/** True when the resumed state was a legacy PARSE_* state (needs special iteration handling). */
	let resumedFromLegacyParse = false;

	const activeRun = getActiveRun(db, dbPlanPath);
	if (activeRun && activeRun.command === "run") {
		// In auto mode, deterministically resume without prompting — interactive
		// resume gates write to stdout and block on stdin, which is incompatible
		// with TUI mode (child owns terminal) and unattended CI flows.
		let resumeDecision: "resume" | "start-fresh" | "abort";
		if (options.auto && !options.resumeGate) {
			const savedState = activeRun.current_state ?? "EXECUTE";
			// ESCALATE and ABORTED are terminal in auto mode — resuming would
			// immediately re-abort, creating a no-progress loop.  Start fresh.
			if (savedState === "ESCALATE" || savedState === "ABORTED") {
				resumeDecision = "start-fresh";
				log(
					`  Auto mode: run ${activeRun.id.slice(0, 8)} stuck at ${savedState} — starting fresh`,
				);
				appendRunEvent(db, {
					runId: activeRun.id,
					eventType: "auto_start_fresh",
					phase: activeRun.current_phase ?? undefined,
					data: {
						reason: `Resumed state ${savedState} is terminal in auto mode`,
					},
				});
			} else {
				resumeDecision = "resume";
				log(
					`  Auto mode: resuming interrupted run ${activeRun.id.slice(0, 8)} (phase ${activeRun.current_phase ?? "?"}, state ${savedState})`,
				);
			}
		} else {
			const resumeGateFn = options.resumeGate ?? defaultResumeGate;
			resumeDecision = await resumeGateFn(
				activeRun.id,
				activeRun.current_phase ?? "0",
				activeRun.current_state ?? "EXECUTE",
			);
		}

		if (resumeDecision === "abort") {
			return {
				phasesCompleted: 0,
				totalPhases: 0,
				complete: false,
				aborted: true,
				escalations: [],
				runId: activeRun.id,
			};
		}

		if (resumeDecision === "resume") {
			runId = activeRun.id;
			// On resume, start from the phase the run was on and restore state
			if (activeRun.current_phase !== null) {
				startPhaseNumber = activeRun.current_phase;
				resumedPhase = activeRun.current_phase;
			}
			// Restore the state machine position, mapping legacy PARSE_* states
			const validStates: PhaseState[] = [
				"EXECUTE",
				"QUALITY_CHECK",
				"QUALITY_RETRY",
				"REVIEW",
				"AUTO_FIX",
				"ESCALATE",
				"PHASE_GATE",
			];
			const rawState = activeRun.current_state ?? "";
			if (rawState in LEGACY_STATE_MAP) {
				resumedState = LEGACY_STATE_MAP[rawState];
				resumedFromLegacyParse = true;
			} else if (validStates.includes(rawState as PhaseState)) {
				resumedState = rawState as PhaseState;
			}
			log(
				`  Resuming run ${runId.slice(0, 8)} at phase ${startPhaseNumber ?? "next"}, state ${resumedState ?? "EXECUTE"}`,
			);
		} else {
			// start-fresh
			updateRunStatus(db, activeRun.id, "aborted");
			runId = generateId();
			createRun(db, {
				id: runId,
				planPath: dbPlanPath,
				command: "run",
				reviewPath,
			});
		}
	} else {
		runId = generateId();
		createRun(db, {
			id: runId,
			planPath: dbPlanPath,
			command: "run",
			reviewPath,
		});
	}

	// Ensure plan is recorded (use dbPlanPath for stable DB identity)
	upsertPlan(db, { planPath: dbPlanPath });

	const logDir = join(logBaseDir, runId);
	if (!existsSync(logDir)) {
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
	}
	log(`  Logs: ${logDir}`);

	appendRunEvent(db, {
		runId,
		eventType: "run_start",
		data: { planPath, reviewPath, workdir, auto: options.auto },
	});

	// --- Parse plan to get phases ---
	let planContent = readFileSync(resolve(planPath), "utf-8");
	let plan = parsePlan(planContent);

	if (plan.phases.length === 0) {
		updateRunStatus(db, runId, "failed", "NO_PHASES");
		return {
			phasesCompleted: 0,
			totalPhases: 0,
			complete: false,
			aborted: false,
			escalations: [],
			runId,
		};
	}

	// Determine which phases to execute from DB-backed review approval state.
	const approvedPhaseSet = new Set(getApprovedPhaseNumbers(db, dbPlanPath));
	let phases = plan.phases.filter((p) => !approvedPhaseSet.has(p.number));
	if (startPhaseNumber) {
		const startIdx = phases.findIndex((p) => p.number === startPhaseNumber);
		if (startIdx >= 0) {
			phases = phases.slice(startIdx);
		}
	}

	let phasesCompleted = approvedPhaseSet.size;
	const totalPhases = plan.phases.length;

	// --- Outer loop: iterate through phases ---
	for (const phase of phases) {
		log();
		log(`  ── Phase ${phase.number}: ${phase.title} ──`);
		const phaseReviewPath = resolvePhaseReviewPath(reviewPath, phase.number);

		// Determine initial state for this phase: if resuming into this exact
		// phase, restore the recorded state; otherwise start fresh.
		const isResumedPhase =
			resumedPhase === phase.number && resumedState !== undefined;
		let state: PhaseState = isResumedPhase
			? (resumedState as PhaseState)
			: "EXECUTE";

		// Derive iteration from DB: max(iteration) for this phase.
		// For legacy PARSE_* resume: use max iteration directly (the invocation
		// whose result needs routing). For all other resume cases: use max + 1
		// (the next invocation slot).
		let iteration: number;
		if (isResumedPhase && resumedFromLegacyParse) {
			iteration = getMaxIterationForPhase(db, runId, phase.number);
		} else if (isResumedPhase) {
			iteration = getMaxIterationForPhase(db, runId, phase.number) + 1;
		} else {
			iteration = 0;
		}

		// Restore quality attempt counter from DB
		let qualityAttempt = isResumedPhase
			? getQualityAttemptCount(db, runId, phase.number)
			: 0;

		let lastCommit: string | undefined;
		let qualityResult: QualityResult | undefined;
		let _phaseAborted = false;
		let userGuidance: string | undefined; // plumbed from escalation "continue" into next author
		// Tracks the state that most recently transitioned to ESCALATE, so that
		// "continue" resumes the right state (REVIEW, AUTO_FIX, etc.) rather than
		// always re-running the author (EXECUTE).
		let preEscalateState: PhaseState = "EXECUTE";

		// Clear resume markers after consuming them — only the first phase
		// in the loop should get the restored state.
		if (isResumedPhase) {
			resumedState = undefined;
			resumedPhase = undefined;
			resumedFromLegacyParse = false;
		}

		updateRunStatus(db, runId, "active", state, phase.number);

		appendRunEvent(db, {
			runId,
			eventType: "phase_start",
			phase: phase.number,
			iteration,
			data: { phaseNumber: phase.number, phaseTitle: phase.title },
		});

		// Phase 4: Show toast notification for phase start
		if (options.tui) {
			await options.tui.showToast(
				`Starting Phase ${phase.number} — ${phase.title}`,
				"info",
			);
		}

		// --- Branch relevance warning ---
		try {
			const branch = await getCurrentBranch(workdir);
			if (!isBranchRelevant(branch, planPath)) {
				log(
					`  Warning: current branch "${branch}" does not appear related to this plan.`,
				);
			}
		} catch {
			// git not available or not a repo — skip check
		}

		// --- Inner loop: per-phase state machine ---
		while (state !== "PHASE_COMPLETE" && state !== "ABORTED") {
			// Check for external cancellation (Ctrl-C, TUI exit, parent timeout)
			if (options.signal?.aborted) {
				state = "ABORTED";
				break;
			}

			// Capture the state at the top of each iteration. Any transition to
			// "ESCALATE" within the switch will leave this as the originating state,
			// allowing the ESCALATE handler to resume the correct state on "continue".
			if (state !== "ESCALATE") preEscalateState = state;
			switch (state) {
				// ───────────────────────────────────────────────────────
				// EXECUTE: invoke author to implement the phase
				// ───────────────────────────────────────────────────────
				case "EXECUTE": {
					updateRunStatus(db, runId, "active", "EXECUTE", phase.number);

					// Check if step already completed (resume)
					if (
						hasCompletedStep(
							db,
							runId,
							"author",
							phase.number,
							iteration,
							"author-next-phase",
							"status",
						)
					) {
						log(`  Skipping author step ${iteration} (already completed)`);
						// Route based on exact step result (not phase-wide latest)
						const stepRow = getStepResult(
							db,
							runId,
							"author",
							phase.number,
							iteration,
							"author-next-phase",
							"status",
						);
						if (!stepRow) {
							const event: EscalationEvent = {
								reason:
									"Author result stored but cannot be read. Manual review required.",
								iteration,
							};
							escalations.push(event);
							appendRunEvent(db, {
								runId,
								eventType: "escalation",
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						let status: import("../protocol.js").AuthorStatus;
						try {
							status = JSON.parse(stepRow.result_json);
						} catch {
							const event: EscalationEvent = {
								reason:
									"Author result stored but JSON is malformed. Manual review required.",
								iteration,
								logPath: stepRow.log_path ?? undefined,
							};
							escalations.push(event);
							appendRunEvent(db, {
								runId,
								eventType: "escalation",
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						try {
							assertAuthorStatus(status, "EXECUTE", {
								requireCommit: true,
							});
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
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						if (status.result === "needs_human" || status.result === "failed") {
							const event: EscalationEvent = {
								reason: status.reason ?? `Author reported ${status.result}`,
								iteration,
								logPath: stepRow.log_path ?? undefined,
							};
							escalations.push(event);
							appendRunEvent(db, {
								runId,
								eventType: "escalation",
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						// Complete — capture commit and advance
						lastCommit = status.commit;
						if (!lastCommit) {
							try {
								lastCommit = await getLatestCommit(workdir);
							} catch {
								// Not critical
							}
						}
						log(
							`  Author completed. Commit: ${lastCommit?.slice(0, 8) ?? "unknown"}`,
						);
						markPhaseImplementationDone(db, dbPlanPath, phase.number, true);
						iteration++;
						state = options.skipQuality ? "REVIEW" : "QUALITY_CHECK";
						break;
					}

					const authorTemplate = renderTemplate("author-next-phase", {
						plan_path: planPath,
						phase_number: phase.number,
						user_notes: userGuidance ?? "(No additional notes)",
					});
					// Clear guidance after use — it applies only to the next invocation
					userGuidance = undefined;

					log(`  Author implementing phase ${phase.number}...`);

					// Compute log path before invocation
					const executeResultId = generateId();
					const executeLogPath = join(
						logDir,
						`agent-${executeResultId}.ndjson`,
					);

					let authorResult: InvokeStatus;
					try {
						// Phase 4: Pass descriptive session title for TUI
						const sessionTitle = `Phase ${phase.number} — author`;
						authorResult = await adapter.invokeForStatus({
							prompt: authorTemplate.prompt,
							model: config.author.model,
							timeout: config.author.timeout,
							workdir,
							logPath: executeLogPath,
							quiet: resolveQuiet(),
							showReasoning,
							signal: options.signal,
							sessionTitle,
							// Phase 4: Select session immediately after creation (not after invoke)
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
						// Hard failure: timeout, network, structured output error
						const errorMessage =
							err instanceof Error ? err.message : String(err);
						// Phase 4: Show toast for phase failure
						if (options.tui) {
							await options.tui.showToast(
								`Phase ${phase.number} failed — ${errorMessage}`,
								"error",
							);
						}
						const event: EscalationEvent = {
							reason: buildEscalationReason(
								`Author invocation failed: ${errorMessage}`,
								executeLogPath,
							),
							iteration,
							logPath: executeLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: event,
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					// Store result in DB
					upsertAgentResult(db, {
						id: executeResultId,
						run_id: runId,
						phase: phase.number,
						iteration,
						role: "author",
						template: "author-next-phase",
						result_type: "status",
						result_json: JSON.stringify(authorResult.status),
						duration_ms: authorResult.duration,
						log_path: executeLogPath,
						session_id: authorResult.sessionId ?? null,
						model: config.author.model ?? null,
						tokens_in: authorResult.tokensIn ?? null,
						tokens_out: authorResult.tokensOut ?? null,
						cost_usd: authorResult.costUsd ?? null,
					});

					appendRunEvent(db, {
						runId,
						eventType: "agent_invoke",
						phase: phase.number,
						iteration,
						data: {
							role: "author",
							template: "author-next-phase",
							duration: authorResult.duration,
							logPath: executeLogPath,
						},
					});

					// Validate invariants
					try {
						assertAuthorStatus(authorResult.status, "EXECUTE", {
							requireCommit: true,
						});
					} catch (err) {
						const event: EscalationEvent = {
							reason: err instanceof Error ? err.message : String(err),
							iteration,
							logPath: executeLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: event,
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					// Route on status
					if (authorResult.status.result === "needs_human") {
						const event: EscalationEvent = {
							reason: authorResult.status.reason ?? "Author needs human input",
							iteration,
							logPath: executeLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: event,
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					if (authorResult.status.result === "failed") {
						const event: EscalationEvent = {
							reason: authorResult.status.reason ?? "Author reported failure",
							iteration,
							logPath: executeLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: event,
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					// Complete — capture commit
					if (authorResult.status.commit) {
						lastCommit = authorResult.status.commit;
					} else {
						try {
							lastCommit = await getLatestCommit(workdir);
						} catch {
							// Not critical
						}
					}

					log(
						`  Author completed. Commit: ${lastCommit?.slice(0, 8) ?? "unknown"}`,
					);
					markPhaseImplementationDone(db, dbPlanPath, phase.number, true);
					iteration++;
					state = options.skipQuality ? "REVIEW" : "QUALITY_CHECK";
					break;
				}

				// ───────────────────────────────────────────────────────
				// QUALITY_CHECK: run quality gates
				// ───────────────────────────────────────────────────────
				case "QUALITY_CHECK": {
					updateRunStatus(db, runId, "active", "QUALITY_CHECK", phase.number);

					if (config.qualityGates.length === 0) {
						log("  No quality gates configured — skipping.");
						state = "REVIEW";
						break;
					}

					log(`  Running quality gates (attempt ${qualityAttempt + 1})...`);

					qualityResult = await runQualityGates(config.qualityGates, workdir, {
						runId,
						logDir,
						phase: phase.number,
						attempt: qualityAttempt,
					});

					// Store in DB
					const qrId = generateId();
					const qrInput: QualityResultInput = {
						id: qrId,
						run_id: runId,
						phase: phase.number,
						attempt: qualityAttempt,
						passed: qualityResult.passed ? 1 : 0,
						results: JSON.stringify(
							qualityResult.results.map((r) => ({
								command: r.command,
								passed: r.passed,
								duration: r.duration,
								outputPath: r.outputPath,
								output: r.output,
							})),
						),
						duration_ms: qualityResult.results.reduce(
							(sum, r) => sum + r.duration,
							0,
						),
					};
					upsertQualityResult(db, qrInput);

					appendRunEvent(db, {
						runId,
						eventType: "quality_gate",
						phase: phase.number,
						iteration,
						data: {
							attempt: qualityAttempt,
							passed: qualityResult.passed,
							commandCount: qualityResult.results.length,
							failedCommands: qualityResult.results
								.filter((r) => !r.passed)
								.map((r) => r.command),
						},
					});

					if (qualityResult.passed) {
						log("  Quality gates passed.");
						state = "REVIEW";
					} else {
						log(
							`  Quality gates failed (${qualityResult.results.filter((r) => !r.passed).length} command(s) failed).`,
						);
						if (qualityAttempt < maxQualityRetries) {
							state = "QUALITY_RETRY";
						} else {
							const event: EscalationEvent = {
								reason: `Quality gates failed after ${maxQualityRetries + 1} attempts`,
								iteration,
							};
							escalations.push(event);
							appendRunEvent(db, {
								runId,
								eventType: "escalation",
								phase: phase.number,
								iteration,
								data: event,
							});
							state = "ESCALATE";
						}
					}
					break;
				}

				// ───────────────────────────────────────────────────────
				// QUALITY_RETRY: re-invoke author to fix quality failures
				// ───────────────────────────────────────────────────────
				case "QUALITY_RETRY": {
					updateRunStatus(db, runId, "active", "QUALITY_RETRY", phase.number);

					qualityAttempt++;

					// Build a message with quality gate failure details
					const failureDetails =
						qualityResult?.results
							.filter((r) => !r.passed)
							.map((r) => `Command: ${r.command}\nOutput:\n${r.output}`)
							.join("\n\n") ?? "Quality gate failed";

					const fixPrompt = renderTemplate("author-process-review", {
						review_path: phaseReviewPath,
						plan_path: planPath,
						user_notes: userGuidance ?? "(No additional notes)",
					});
					userGuidance = undefined;

					// Prepend quality failure context
					const qualityFixPrompt = `Quality gates failed. Fix the following issues and ensure all tests pass:\n\n${failureDetails}\n\n---\n\n${fixPrompt.prompt}`;

					log(
						`  Author fixing quality failures (attempt ${qualityAttempt + 1})...`,
					);

					const qrFixResultId = generateId();
					const qrFixLogPath = join(logDir, `agent-${qrFixResultId}.ndjson`);

					let fixResult: InvokeStatus;
					try {
						// Phase 4: Pass descriptive session title for TUI (quality retry)
						const sessionTitle = `Phase ${phase.number} — revision ${qualityAttempt + 1}`;
						fixResult = await adapter.invokeForStatus({
							prompt: qualityFixPrompt,
							model: config.author.model,
							timeout: config.author.timeout,
							workdir,
							logPath: qrFixLogPath,
							quiet: resolveQuiet(),
							showReasoning,
							signal: options.signal,
							sessionTitle,
							// Phase 4: Select session immediately after creation (not after invoke)
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
						const errorMessage =
							err instanceof Error ? err.message : String(err);
						// Phase 4: Show toast for phase failure
						if (options.tui) {
							await options.tui.showToast(
								`Phase ${phase.number} failed — ${errorMessage}`,
								"error",
							);
						}
						const event: EscalationEvent = {
							reason: buildEscalationReason(
								`Author invocation failed during quality fix: ${errorMessage}`,
								qrFixLogPath,
							),
							iteration,
							logPath: qrFixLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: { reason: event.reason, trigger: "quality_retry_failure" },
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					upsertAgentResult(db, {
						id: qrFixResultId,
						run_id: runId,
						phase: phase.number,
						iteration,
						role: "author",
						template: "author-process-review",
						result_type: "status",
						result_json: JSON.stringify(fixResult.status),
						duration_ms: fixResult.duration,
						log_path: qrFixLogPath,
						session_id: fixResult.sessionId ?? null,
						model: config.author.model ?? null,
						tokens_in: fixResult.tokensIn ?? null,
						tokens_out: fixResult.tokensOut ?? null,
						cost_usd: fixResult.costUsd ?? null,
					});

					appendRunEvent(db, {
						runId,
						eventType: "agent_invoke",
						phase: phase.number,
						iteration,
						data: {
							role: "author",
							template: "author-process-review",
							reason: "quality_retry",
							duration: fixResult.duration,
							logPath: qrFixLogPath,
						},
					});

					// Route on author status
					if (
						fixResult.status.result === "needs_human" ||
						fixResult.status.result === "failed"
					) {
						const event: EscalationEvent = {
							reason:
								fixResult.status.reason ??
								`Author reported ${fixResult.status.result} during quality fix`,
							iteration,
							logPath: qrFixLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: {
								reason: event.reason,
								trigger: "quality_retry_status",
								status: fixResult.status.result,
							},
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					iteration++;
					// Back to quality check
					state = "QUALITY_CHECK";
					break;
				}

				// ───────────────────────────────────────────────────────
				// REVIEW: invoke reviewer
				// ───────────────────────────────────────────────────────
				case "REVIEW": {
					updateRunStatus(db, runId, "active", "REVIEW", phase.number);

					// Check if step already completed (resume)
					if (
						hasCompletedStep(
							db,
							runId,
							"reviewer",
							phase.number,
							iteration,
							"reviewer-commit",
							"verdict",
						)
					) {
						log(`  Skipping reviewer step ${iteration} (already completed)`);
						// Route based on exact step result (not phase-wide latest)
						const stepRow = getStepResult(
							db,
							runId,
							"reviewer",
							phase.number,
							iteration,
							"reviewer-commit",
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
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
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
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						try {
							assertReviewerVerdict(verdict, "REVIEW");
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
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						// Route verdict (shared routing logic)
						const humanRequiredCount = verdict.items.filter(
							(i) => i.action === "human_required",
						).length;
						setPhaseReviewOutcome(
							db,
							dbPlanPath,
							phase.number,
							verdict.readiness,
							verdict.readiness === "ready",
							humanRequiredCount > 0
								? `${humanRequiredCount} item(s) require human review`
								: null,
						);
						const routeResult = routeVerdict(
							verdict,
							iteration,
							stepRow.log_path ?? undefined,
							escalations,
							db,
							runId,
							phase.number,
							log,
						);
						if (routeResult.increment) iteration++;
						state = routeResult.nextState;
						break;
					}

					// Guard: max review iterations
					const reviewIterations = getAgentResults(
						db,
						runId,
						phase.number,
					).filter((r) => r.role === "reviewer").length;
					if (reviewIterations >= maxReviewIterations) {
						const event: EscalationEvent = {
							reason: `Maximum review iterations (${maxReviewIterations}) reached for phase ${phase.number}`,
							iteration,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: event,
						});
						state = "ESCALATE";
						break;
					}

					const reviewerTemplate = renderTemplate("reviewer-commit", {
						commit_hash: lastCommit ?? "HEAD",
						review_path: phaseReviewPath,
						plan_path: planPath,
					});

					log(`  Reviewer reviewing phase ${phase.number}...`);

					const reviewResultId = generateId();
					const reviewLogPath = join(logDir, `agent-${reviewResultId}.ndjson`);

					let reviewResult: InvokeVerdict;
					try {
						// Phase 4: Pass descriptive session title for TUI
						const reviewIteration = Math.floor(iteration / 2) + 1;
						const sessionTitle = `Phase ${phase.number} — review ${reviewIteration}`;
						reviewResult = await adapter.invokeForVerdict({
							prompt: reviewerTemplate.prompt,
							model: config.reviewer.model,
							// Reviewer timeout defaults to 120 seconds (2 min).
							timeout: config.reviewer.timeout ?? 120,
							workdir,
							logPath: reviewLogPath,
							quiet: resolveQuiet(),
							showReasoning,
							signal: options.signal,
							sessionTitle,
							// Phase 4: Select session immediately after creation (not after invoke)
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
						const errorMessage =
							err instanceof Error ? err.message : String(err);
						// Phase 4: Show toast for phase failure
						if (options.tui) {
							await options.tui.showToast(
								`Phase ${phase.number} failed — ${errorMessage}`,
								"error",
							);
						}
						const event: EscalationEvent = {
							reason: buildEscalationReason(
								`Reviewer invocation failed: ${errorMessage}`,
								reviewLogPath,
							),
							iteration,
							logPath: reviewLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: event,
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					upsertAgentResult(db, {
						id: reviewResultId,
						run_id: runId,
						phase: phase.number,
						iteration,
						role: "reviewer",
						template: "reviewer-commit",
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
						phase: phase.number,
						iteration,
						data: {
							role: "reviewer",
							template: "reviewer-commit",
							duration: reviewResult.duration,
							logPath: reviewLogPath,
						},
					});

					// Validate invariants
					try {
						assertReviewerVerdict(reviewResult.verdict, "REVIEW");
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
							phase: phase.number,
							iteration,
							data: event,
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					appendRunEvent(db, {
						runId,
						eventType: "verdict",
						phase: phase.number,
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

					const humanRequiredCount = reviewResult.verdict.items.filter(
						(i) => i.action === "human_required",
					).length;
					setPhaseReviewOutcome(
						db,
						dbPlanPath,
						phase.number,
						reviewResult.verdict.readiness,
						reviewResult.verdict.readiness === "ready",
						humanRequiredCount > 0
							? `${humanRequiredCount} item(s) require human review`
							: null,
					);

					// Route verdict
					const routeResult = routeVerdict(
						reviewResult.verdict,
						iteration,
						reviewLogPath,
						escalations,
						db,
						runId,
						phase.number,
						log,
					);
					if (routeResult.increment) iteration++;
					state = routeResult.nextState;
					break;
				}

				// ───────────────────────────────────────────────────────
				// AUTO_FIX: invoke author to fix review items
				// ───────────────────────────────────────────────────────
				case "AUTO_FIX": {
					updateRunStatus(db, runId, "active", "AUTO_FIX", phase.number);

					if (
						hasCompletedStep(
							db,
							runId,
							"author",
							phase.number,
							iteration,
							"author-process-review",
							"status",
						)
					) {
						userGuidance = undefined;
						log(`  Skipping auto-fix step ${iteration} (already completed)`);
						// Route based on exact step result (not phase-wide latest)
						const stepRow = getStepResult(
							db,
							runId,
							"author",
							phase.number,
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
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						let fixStatus: import("../protocol.js").AuthorStatus;
						try {
							fixStatus = JSON.parse(stepRow.result_json);
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
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						try {
							assertAuthorStatus(fixStatus, "AUTO_FIX");
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
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						if (
							fixStatus.result === "needs_human" ||
							fixStatus.result === "failed"
						) {
							const event: EscalationEvent = {
								reason:
									fixStatus.reason ??
									`Author reported ${fixStatus.result} during fix`,
								iteration,
								logPath: stepRow.log_path ?? undefined,
							};
							escalations.push(event);
							appendRunEvent(db, {
								runId,
								eventType: "escalation",
								phase: phase.number,
								iteration,
								data: event,
							});
							iteration++;
							state = "ESCALATE";
							break;
						}

						if (fixStatus.commit) lastCommit = fixStatus.commit;
						qualityAttempt = 0;
						log("  Author fix applied. Re-checking...");
						iteration++;
						state = options.skipQuality ? "REVIEW" : "QUALITY_CHECK";
						break;
					}

					const fixTemplate = renderTemplate("author-process-review", {
						review_path: phaseReviewPath,
						plan_path: planPath,
						user_notes: userGuidance ?? "(No additional notes)",
					});
					userGuidance = undefined;

					const autoFixResultId = generateId();
					const autoFixLogPath = join(
						logDir,
						`agent-${autoFixResultId}.ndjson`,
					);

					let autoFixResult: InvokeStatus;
					try {
						// Phase 4: Pass descriptive session title for TUI (auto-fix)
						const sessionTitle = `Phase ${phase.number} — revision ${Math.floor(iteration / 2) + 1}`;
						autoFixResult = await adapter.invokeForStatus({
							prompt: fixTemplate.prompt,
							model: config.author.model,
							timeout: config.author.timeout,
							workdir,
							logPath: autoFixLogPath,
							quiet: resolveQuiet(),
							showReasoning,
							signal: options.signal,
							sessionTitle,
							// Phase 4: Select session immediately after creation (not after invoke)
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
						const errorMessage =
							err instanceof Error ? err.message : String(err);
						// Phase 4: Show toast for phase failure
						if (options.tui) {
							await options.tui.showToast(
								`Phase ${phase.number} failed — ${errorMessage}`,
								"error",
							);
						}
						const event: EscalationEvent = {
							reason: buildEscalationReason(
								`Author invocation failed during auto-fix: ${errorMessage}`,
								autoFixLogPath,
							),
							iteration,
							logPath: autoFixLogPath,
						};
						escalations.push(event);
						iteration++;
						state = "ESCALATE";
						break;
					}

					upsertAgentResult(db, {
						id: autoFixResultId,
						run_id: runId,
						phase: phase.number,
						iteration,
						role: "author",
						template: "author-process-review",
						result_type: "status",
						result_json: JSON.stringify(autoFixResult.status),
						duration_ms: autoFixResult.duration,
						log_path: autoFixLogPath,
						session_id: autoFixResult.sessionId ?? null,
						model: config.author.model ?? null,
						tokens_in: autoFixResult.tokensIn ?? null,
						tokens_out: autoFixResult.tokensOut ?? null,
						cost_usd: autoFixResult.costUsd ?? null,
					});

					appendRunEvent(db, {
						runId,
						eventType: "agent_invoke",
						phase: phase.number,
						iteration,
						data: {
							role: "author",
							template: "author-process-review",
							reason: "auto_fix",
							duration: autoFixResult.duration,
							logPath: autoFixLogPath,
						},
					});

					// Validate invariants
					try {
						assertAuthorStatus(autoFixResult.status, "AUTO_FIX");
					} catch (err) {
						const event: EscalationEvent = {
							reason: err instanceof Error ? err.message : String(err),
							iteration,
							logPath: autoFixLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: {
								reason: event.reason,
								trigger: "status_invariant_violation",
							},
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					if (autoFixResult.status.result === "needs_human") {
						const event: EscalationEvent = {
							reason:
								autoFixResult.status.reason ??
								"Author needs human input during fix",
							iteration,
							logPath: autoFixLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: {
								reason: event.reason,
								trigger: "fix_needs_human",
								status: autoFixResult.status.result,
							},
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					if (autoFixResult.status.result === "failed") {
						const event: EscalationEvent = {
							reason:
								autoFixResult.status.reason ??
								"Author reported failure during fix",
							iteration,
							logPath: autoFixLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: {
								reason: event.reason,
								trigger: "fix_failed",
								status: autoFixResult.status.result,
							},
						});
						iteration++;
						state = "ESCALATE";
						break;
					}

					// Update commit if provided
					if (autoFixResult.status.commit) {
						lastCommit = autoFixResult.status.commit;
					}
					markPhaseImplementationDone(db, dbPlanPath, phase.number, true);

					// Back to quality check (or review if skipping quality)
					qualityAttempt = 0; // reset quality attempts after fix
					log("  Author fix applied. Re-checking...");
					iteration++;
					state = options.skipQuality ? "REVIEW" : "QUALITY_CHECK";
					break;
				}

				// ───────────────────────────────────────────────────────
				// ESCALATE: human intervention needed
				// ───────────────────────────────────────────────────────
				case "ESCALATE": {
					updateRunStatus(db, runId, "active", "ESCALATE", phase.number);

					const lastEscalation =
						escalations[escalations.length - 1] ??
						({
							reason: "Unknown escalation",
							iteration,
						} satisfies EscalationEvent);

					if (options.auto) {
						log(`  Auto mode: escalation — ${lastEscalation.reason}`);
						// Phase 4: Show toast for escalation
						if (options.tui) {
							await options.tui.showToast(
								`Human required — Phase ${phase.number} escalated`,
								"error",
							);
						}
						appendRunEvent(db, {
							runId,
							eventType: "auto_escalation_abort",
							phase: phase.number,
							iteration,
							data: { reason: lastEscalation.reason },
						});
						state = "ABORTED";
						break;
					}

					const escalationGateFn =
						options.escalationGate ?? defaultEscalationGate;
					const response = await escalationGateFn(lastEscalation);

					appendRunEvent(db, {
						runId,
						eventType: "human_decision",
						phase: phase.number,
						iteration,
						data: { response, escalation: lastEscalation },
					});

					switch (response.action) {
						case "continue": {
							// Resume the explicit retry state when set (e.g. review
							// escalation with human_required should route to AUTO_FIX),
							// otherwise resume the state that triggered escalation.
							const resumeState =
								(lastEscalation.retryState as PhaseState | undefined) ??
								preEscalateState;
							// Guidance can be consumed by EXECUTE, AUTO_FIX, and QUALITY_RETRY
							// prompts via template user_notes.
							if ("guidance" in response && response.guidance) {
								if (
									resumeState === "EXECUTE" ||
									resumeState === "AUTO_FIX" ||
									resumeState === "QUALITY_RETRY"
								) {
									userGuidance = response.guidance;
								}
							}
							state = resumeState;
							break;
						}
						case "approve":
							setPhaseReviewApproved(db, dbPlanPath, phase.number, true, null);
							appendRunEvent(db, {
								runId,
								eventType: "phase_force_approved",
								phase: phase.number,
								iteration,
								data: { reason: lastEscalation.reason },
							});
							state = "PHASE_COMPLETE";
							break;
						case "abort":
							state = "ABORTED";
							break;
					}
					break;
				}

				// ───────────────────────────────────────────────────────
				// PHASE_GATE: human confirmation between phases
				// ───────────────────────────────────────────────────────
				case "PHASE_GATE": {
					updateRunStatus(db, runId, "active", "PHASE_GATE", phase.number);

					if (options.auto) {
						log(`  Auto mode: phase ${phase.number} complete, proceeding.`);
						state = "PHASE_COMPLETE";
						break;
					}

					const phaseGateFn = options.phaseGate ?? defaultPhaseGate;
					const dbVerdict = getLatestVerdict(db, runId, phase.number);
					const summary: PhaseSummary = {
						phaseNumber: phase.number,
						phaseTitle: phase.title,
						commit: lastCommit,
						qualityPassed: qualityResult?.passed ?? true,
						reviewVerdict: dbVerdict?.readiness ?? "ready",
					};

					const decision = await phaseGateFn(summary);
					appendRunEvent(db, {
						runId,
						eventType: "human_decision",
						phase: phase.number,
						iteration,
						data: { decision, type: "phase_gate" },
					});

					switch (decision) {
						case "continue":
							// Phase 4: Show toast for review approved
							if (options.tui) {
								await options.tui.showToast(
									`Phase ${phase.number} approved — continuing`,
									"success",
								);
							}
							state = "PHASE_COMPLETE";
							break;
						case "review":
							log(
								"  Please review the changes. Run `5x run` again to continue.",
							);
							state = "ABORTED";
							break;
						case "abort":
							state = "ABORTED";
							break;
					}
					break;
				}

				default:
					state = "ABORTED";
					break;
			}
		}

		if (state === "ABORTED") {
			_phaseAborted = true;
			break;
		}

		// Phase complete
		setPhaseReviewApproved(db, dbPlanPath, phase.number, true, null);
		phasesCompleted++;
		appendRunEvent(db, {
			runId,
			eventType: "phase_complete",
			phase: phase.number,
			iteration,
			data: { phaseNumber: phase.number, commit: lastCommit },
		});

		// Phase 4: Show toast for phase complete (auto mode)
		if (options.tui && options.auto) {
			await options.tui.showToast(
				`Phase ${phase.number} complete — starting review`,
				"success",
			);
		}

		log(`  Phase ${phase.number} complete.`);

		// Re-parse plan for next phase (author may have updated checklist)
		try {
			planContent = readFileSync(resolve(planPath), "utf-8");
			plan = parsePlan(planContent);
		} catch {
			// Non-critical — continue with existing plan data
		}
	}

	// --- Finalize ---
	const allComplete = phasesCompleted === totalPhases;
	const finalStatus = allComplete
		? "completed"
		: escalations.length > 0
			? "failed"
			: "aborted";

	updateRunStatus(db, runId, finalStatus);
	appendRunEvent(db, {
		runId,
		eventType: allComplete ? "run_complete" : "run_abort",
		data: {
			phasesCompleted,
			totalPhases,
			escalationCount: escalations.length,
		},
	});

	return {
		phasesCompleted,
		totalPhases,
		complete: allComplete,
		aborted: !allComplete,
		escalations,
		runId,
	};
}

// ---------------------------------------------------------------------------
// Verdict routing helper
// ---------------------------------------------------------------------------

interface VerdictRouteResult {
	nextState: PhaseState;
	increment: boolean;
}

function routeVerdict(
	verdict: import("../protocol.js").ReviewerVerdict,
	iteration: number,
	logPath: string | undefined,
	escalations: EscalationEvent[],
	db: Database,
	runId: string,
	phase: string,
	log: (...args: unknown[]) => void = console.log,
): VerdictRouteResult {
	if (verdict.readiness === "ready") {
		return { nextState: "PHASE_GATE", increment: true };
	}

	// Check for human_required items — always escalate even in auto
	const humanItems = verdict.items.filter((i) => i.action === "human_required");
	if (humanItems.length > 0) {
		const event: EscalationEvent = {
			reason: `${humanItems.length} item(s) require human review`,
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
			phase,
			iteration,
			data: event,
		});
		return { nextState: "ESCALATE", increment: true };
	}

	// ready_with_corrections or not_ready with auto_fix items
	const autoFixItems = verdict.items.filter((i) => i.action === "auto_fix");
	if (autoFixItems.length > 0) {
		log(`  Auto-fixing ${autoFixItems.length} item(s)...`);
		return { nextState: "AUTO_FIX", increment: true };
	}

	// Non-ready with no actionable items — escalate
	const event: EscalationEvent = {
		reason: `Reviewer returned ${verdict.readiness} with no auto-fixable items`,
		iteration,
		logPath,
	};
	escalations.push(event);
	appendRunEvent(db, {
		runId,
		eventType: "escalation",
		phase,
		iteration,
		data: event,
	});
	return { nextState: "ESCALATE", increment: true };
}

// ---------------------------------------------------------------------------
// Default gate implementations (used when not overridden by tests/options)
// ---------------------------------------------------------------------------

async function defaultPhaseGate(
	summary: PhaseSummary,
): Promise<"continue" | "review" | "abort"> {
	// Import at call time to avoid circular dependency
	const { phaseGate } = await import("../gates/human.js");
	return phaseGate(summary);
}

async function defaultEscalationGate(
	event: EscalationEvent,
): Promise<EscalationResponse> {
	const { escalationGate } = await import("../gates/human.js");
	return escalationGate(event);
}

async function defaultResumeGate(
	runId: string,
	phase: string,
	state: string,
): Promise<"resume" | "start-fresh" | "abort"> {
	const { resumeGate } = await import("../gates/human.js");
	return resumeGate(runId, phase, state);
}
