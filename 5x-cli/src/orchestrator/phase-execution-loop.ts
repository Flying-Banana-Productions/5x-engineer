/**
 * Phase execution loop (Loop 2) — the core state machine for `5x run`.
 *
 * Per-phase inner loop:
 *   1. Parse plan → identify current phase
 *   2. Render author prompt → invoke author → store result
 *   3. Parse 5x:status → handle needs_human / failed
 *   4. Run quality gates → store result
 *      - If fail: re-invoke author (up to maxQualityRetries)
 *   5. Render reviewer prompt → invoke reviewer → store result
 *   6. Parse 5x:verdict
 *      - ready → phase gate → next phase
 *      - auto_fix → author fix → back to step 4
 *      - human_required → escalate
 *   7. Phase gate (human confirmation unless --auto)
 *   8. Next phase
 */

import type { Database } from "bun:sqlite";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentAdapter, AgentResult } from "../agents/types.js";
import type { FiveXConfig } from "../config.js";
import type { QualityResultInput } from "../db/operations.js";
import {
	appendRunEvent,
	createRun,
	getActiveRun,
	getAgentResults,
	getMaxIterationForPhase,
	getQualityAttemptCount,
	hasCompletedStep,
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
	 * When true, suppress formatted agent event output to stdout.
	 * Default: false (show output). Use !process.stdout.isTTY as the default
	 * at the command layer before passing here.
	 */
	quiet?: boolean;
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
}

/**
 * Inner-phase state machine states.
 */
type PhaseState =
	| "EXECUTE" // invoke author
	| "PARSE_AUTHOR_STATUS" // parse 5x:status from author output
	| "QUALITY_CHECK" // run quality gates
	| "QUALITY_RETRY" // re-invoke author after quality failure
	| "REVIEW" // invoke reviewer
	| "PARSE_VERDICT" // parse 5x:verdict from review
	| "AUTO_FIX" // invoke author to fix review items
	| "PARSE_FIX_STATUS" // parse 5x:status after auto-fix
	| "ESCALATE" // human intervention needed
	| "PHASE_GATE" // human confirmation between phases
	| "PHASE_COMPLETE" // phase done, move to next
	| "ABORTED"; // run stopped

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	return crypto.randomUUID();
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
	authorAdapter: AgentAdapter,
	reviewerAdapter: AgentAdapter,
	config: FiveXConfig,
	options: PhaseExecutionOptions,
): Promise<PhaseExecutionResult> {
	const canonical = canonicalizePlanPath(planPath);
	const workdir = options.workdir;
	const quiet = options.quiet ?? false;
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

	const activeRun = getActiveRun(db, canonical);
	if (activeRun && activeRun.command === "run") {
		const resumeGateFn = options.resumeGate ?? defaultResumeGate;
		const resumeDecision = await resumeGateFn(
			activeRun.id,
			activeRun.current_phase ?? "0",
			activeRun.current_state ?? "EXECUTE",
		);

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
			// Restore the state machine position
			const validStates: PhaseState[] = [
				"EXECUTE",
				"PARSE_AUTHOR_STATUS",
				"QUALITY_CHECK",
				"QUALITY_RETRY",
				"REVIEW",
				"PARSE_VERDICT",
				"AUTO_FIX",
				"PARSE_FIX_STATUS",
				"ESCALATE",
				"PHASE_GATE",
			];
			if (
				activeRun.current_state &&
				validStates.includes(activeRun.current_state as PhaseState)
			) {
				resumedState = activeRun.current_state as PhaseState;
			}
			console.log(
				`  Resuming run ${runId.slice(0, 8)} at phase ${startPhaseNumber ?? "next"}, state ${resumedState ?? "EXECUTE"}`,
			);
		} else {
			// start-fresh
			updateRunStatus(db, activeRun.id, "aborted");
			runId = generateId();
			createRun(db, {
				id: runId,
				planPath: canonical,
				command: "run",
				reviewPath,
			});
		}
	} else {
		runId = generateId();
		createRun(db, {
			id: runId,
			planPath: canonical,
			command: "run",
			reviewPath,
		});
	}

	// Ensure plan is recorded
	upsertPlan(db, { planPath });

	const logDir = join(logBaseDir, runId);
	if (!existsSync(logDir)) {
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
	}
	console.log(`  Logs: ${logDir}`);

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

	// Determine which phases to execute
	let phases = plan.phases.filter((p) => !p.isComplete);
	if (startPhaseNumber) {
		const startIdx = phases.findIndex((p) => p.number === startPhaseNumber);
		if (startIdx >= 0) {
			phases = phases.slice(startIdx);
		}
	}

	let phasesCompleted = plan.phases.filter((p) => p.isComplete).length;
	const totalPhases = plan.phases.length;

	// --- Outer loop: iterate through phases ---
	for (const phase of phases) {
		console.log();
		console.log(`  ── Phase ${phase.number}: ${phase.title} ──`);

		// Determine initial state for this phase: if resuming into this exact
		// phase, restore the recorded state; otherwise start fresh.
		const isResumedPhase =
			resumedPhase === phase.number && resumedState !== undefined;
		let state: PhaseState = isResumedPhase
			? (resumedState as PhaseState)
			: "EXECUTE";

		// Derive iteration from DB: max(iteration) + 1 for this phase, so the
		// next agent invocation gets a deterministic, non-colliding identity.
		let iteration = isResumedPhase
			? getMaxIterationForPhase(db, runId, phase.number) + 1
			: 0;

		// Restore quality attempt counter from DB
		let qualityAttempt = isResumedPhase
			? getQualityAttemptCount(db, runId, phase.number)
			: 0;

		let lastCommit: string | undefined;
		let qualityResult: QualityResult | undefined;
		let _phaseAborted = false;
		let userGuidance: string | undefined; // plumbed from escalation "continue" into next author
		// Tracks the most recent agent NDJSON log path across state transitions so
		// PARSE_* states can include it in escalation events without re-derivation.
		let lastAgentLogPath: string | undefined;

		// Clear resume markers after consuming them — only the first phase
		// in the loop should get the restored state.
		if (isResumedPhase) {
			resumedState = undefined;
			resumedPhase = undefined;
		}

		updateRunStatus(db, runId, "active", state, phase.number);

		appendRunEvent(db, {
			runId,
			eventType: "phase_start",
			phase: phase.number,
			iteration,
			data: { phaseNumber: phase.number, phaseTitle: phase.title },
		});

		// --- Branch relevance warning ---
		try {
			const branch = await getCurrentBranch(workdir);
			if (!isBranchRelevant(branch, planPath)) {
				console.log(
					`  Warning: current branch "${branch}" does not appear related to this plan.`,
				);
			}
		} catch {
			// git not available or not a repo — skip check
		}

		// --- Inner loop: per-phase state machine ---
		while (state !== "PHASE_COMPLETE" && state !== "ABORTED") {
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
						)
					) {
						console.log(
							`  Skipping author step ${iteration} (already completed)`,
						);
						state = "PARSE_AUTHOR_STATUS";
						break;
					}

					const authorTemplate = renderTemplate("author-next-phase", {
						plan_path: planPath,
						phase_number: phase.number,
						user_notes: userGuidance ?? "(No additional notes)",
					});
					// Clear guidance after use — it applies only to the next invocation
					userGuidance = undefined;

					console.log(`  Author implementing phase ${phase.number}...`);

					// Open log stream before invoking
					const executeResultId = generateId();
					const executeLogPath = join(
						logDir,
						`agent-${executeResultId}.ndjson`,
					);
					const executeLogStream = createWriteStream(executeLogPath);
					executeLogStream.on("error", (err) =>
						console.warn(
							`[warn] agent log stream error: ${err instanceof Error ? err.message : String(err)}`,
						),
					);

					let authorResult: AgentResult;
					try {
						authorResult = await authorAdapter.invoke({
							prompt: authorTemplate.prompt,
							model: config.author.model,
							workdir,
							logStream: executeLogStream,
							onEvent: makeOnEvent(quiet),
						});
					} finally {
						await endStream(executeLogStream);
					}

					// Parse status from author output
					const authorStatus = parseStatusBlock(authorResult.output);

					upsertAgentResult(db, {
						id: executeResultId,
						run_id: runId,
						role: "author",
						template_name: "author-next-phase",
						phase: phase.number,
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
						phase: phase.number,
						iteration,
						data: {
							role: "author",
							template: "author-next-phase",
							exitCode: authorResult.exitCode,
							duration: authorResult.duration,
							logPath: executeLogPath,
						},
					});

					// Record log path for PARSE_AUTHOR_STATUS escalations before incrementing.
					lastAgentLogPath = executeLogPath;

					// Handle non-zero exit — escalation uses pre-increment iteration to
					// match the agent_results row for this invocation.
					if (authorResult.exitCode !== 0) {
						const event: EscalationEvent = {
							reason: buildEscalationReason(
								`Author exited with code ${authorResult.exitCode}`,
								executeLogPath,
								authorResult,
								quiet,
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

					iteration++;
					state = "PARSE_AUTHOR_STATUS";
					break;
				}

				// ───────────────────────────────────────────────────────
				// PARSE_AUTHOR_STATUS: handle 5x:status from author
				// ───────────────────────────────────────────────────────
				case "PARSE_AUTHOR_STATUS": {
					updateRunStatus(
						db,
						runId,
						"active",
						"PARSE_AUTHOR_STATUS",
						phase.number,
					);

					const { getLatestStatus } = await import("../db/operations.js");
					const status = getLatestStatus(db, runId, phase.number);

					if (!status) {
						const event: EscalationEvent = {
							reason:
								"Author did not produce a 5x:status block. Manual review required.",
							iteration,
							logPath: lastAgentLogPath,
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

					if (status.result === "needs_human") {
						const event: EscalationEvent = {
							reason: status.reason ?? "Author needs human input",
							iteration,
							logPath: lastAgentLogPath,
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

					if (status.result === "failed") {
						const event: EscalationEvent = {
							reason: status.reason ?? "Author reported failure",
							iteration,
							logPath: lastAgentLogPath,
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

					// Capture commit hash from status
					if (status.commit) {
						lastCommit = status.commit;
					} else {
						// Fallback: get latest commit from git
						try {
							lastCommit = await getLatestCommit(workdir);
						} catch {
							// Not critical — reviewer can work without commit hash
						}
					}

					console.log(
						`  Author completed. Commit: ${lastCommit?.slice(0, 8) ?? "unknown"}`,
					);
					state = options.skipQuality ? "REVIEW" : "QUALITY_CHECK";
					break;
				}

				// ───────────────────────────────────────────────────────
				// QUALITY_CHECK: run quality gates
				// ───────────────────────────────────────────────────────
				case "QUALITY_CHECK": {
					updateRunStatus(db, runId, "active", "QUALITY_CHECK", phase.number);

					if (config.qualityGates.length === 0) {
						console.log("  No quality gates configured — skipping.");
						state = "REVIEW";
						break;
					}

					console.log(
						`  Running quality gates (attempt ${qualityAttempt + 1})...`,
					);

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
						console.log("  Quality gates passed.");
						state = "REVIEW";
					} else {
						console.log(
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
						review_path: reviewPath,
						plan_path: planPath,
					});

					// Prepend quality failure context
					const qualityFixPrompt = `Quality gates failed. Fix the following issues and ensure all tests pass:\n\n${failureDetails}\n\n---\n\n${fixPrompt.prompt}`;

					console.log(
						`  Author fixing quality failures (attempt ${qualityAttempt + 1})...`,
					);

					// Open log stream for quality retry
					const qrFixResultId = generateId();
					const qrFixLogPath = join(logDir, `agent-${qrFixResultId}.ndjson`);
					const qrFixLogStream = createWriteStream(qrFixLogPath);
					qrFixLogStream.on("error", (err) =>
						console.warn(
							`[warn] agent log stream error: ${err instanceof Error ? err.message : String(err)}`,
						),
					);

					let fixResult: AgentResult;
					try {
						fixResult = await authorAdapter.invoke({
							prompt: qualityFixPrompt,
							model: config.author.model,
							workdir,
							logStream: qrFixLogStream,
							onEvent: makeOnEvent(quiet),
						});
					} finally {
						await endStream(qrFixLogStream);
					}

					const fixStatus = parseStatusBlock(fixResult.output);
					upsertAgentResult(db, {
						id: qrFixResultId,
						run_id: runId,
						role: "author",
						template_name: "author-process-review",
						phase: phase.number,
						iteration,
						exit_code: fixResult.exitCode,
						duration_ms: fixResult.duration,
						tokens_in: fixResult.tokens?.input ?? null,
						tokens_out: fixResult.tokens?.output ?? null,
						cost_usd: fixResult.cost ?? null,
						signal_type: fixStatus ? "status" : null,
						signal_data: fixStatus ? JSON.stringify(fixStatus) : null,
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
							exitCode: fixResult.exitCode,
							logPath: qrFixLogPath,
						},
					});

					lastAgentLogPath = qrFixLogPath;

					if (fixResult.exitCode !== 0) {
						const event: EscalationEvent = {
							reason: buildEscalationReason(
								`Author exited with code ${fixResult.exitCode} during quality fix`,
								qrFixLogPath,
								fixResult,
								quiet,
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
						)
					) {
						console.log(
							`  Skipping reviewer step ${iteration} (already completed)`,
						);
						state = "PARSE_VERDICT";
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
						review_path: reviewPath,
						plan_path: planPath,
					});

					console.log(`  Reviewer reviewing phase ${phase.number}...`);

					// Open log stream for review
					const reviewResultId = generateId();
					const reviewLogPath = join(logDir, `agent-${reviewResultId}.ndjson`);
					const reviewLogStream = createWriteStream(reviewLogPath);
					reviewLogStream.on("error", (err) =>
						console.warn(
							`[warn] agent log stream error: ${err instanceof Error ? err.message : String(err)}`,
						),
					);

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

					// Parse verdict from the review file first, then from output
					let verdict: VerdictBlock | null = null;
					if (existsSync(resolve(reviewPath))) {
						const reviewContent = readFileSync(resolve(reviewPath), "utf-8");
						verdict = parseVerdictBlock(reviewContent);
					}
					if (!verdict) {
						verdict = parseVerdictBlock(reviewResult.output);
					}

					upsertAgentResult(db, {
						id: reviewResultId,
						run_id: runId,
						role: "reviewer",
						template_name: "reviewer-commit",
						phase: phase.number,
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
						phase: phase.number,
						iteration,
						data: {
							role: "reviewer",
							template: "reviewer-commit",
							exitCode: reviewResult.exitCode,
							duration: reviewResult.duration,
							logPath: reviewLogPath,
						},
					});

					// Record log path for PARSE_VERDICT escalations before incrementing.
					lastAgentLogPath = reviewLogPath;

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
							phase: phase.number,
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

				// ───────────────────────────────────────────────────────
				// PARSE_VERDICT: route based on reviewer verdict
				// ───────────────────────────────────────────────────────
				case "PARSE_VERDICT": {
					updateRunStatus(db, runId, "active", "PARSE_VERDICT", phase.number);

					const { getLatestVerdict } = await import("../db/operations.js");
					const verdict = getLatestVerdict(db, runId, phase.number);

					if (!verdict) {
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
							phase: phase.number,
							iteration,
							data: event,
						});
						state = "ESCALATE";
						break;
					}

					appendRunEvent(db, {
						runId,
						eventType: "verdict",
						phase: phase.number,
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

					console.log(`  Verdict: ${verdict.readiness}`);

					if (verdict.readiness === "ready") {
						state = "PHASE_GATE";
						break;
					}

					// Check for human_required items — always escalate even in auto
					const humanItems = verdict.items.filter(
						(i) => i.action === "human_required",
					);
					if (humanItems.length > 0) {
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
							phase: phase.number,
							iteration,
							data: event,
						});
						state = "ESCALATE";
						break;
					}

					// ready_with_corrections or not_ready with auto_fix items
					const autoFixItems = verdict.items.filter(
						(i) => i.action === "auto_fix",
					);
					if (autoFixItems.length > 0) {
						console.log(`  Auto-fixing ${autoFixItems.length} item(s)...`);
						state = "AUTO_FIX";
						break;
					}

					// Non-ready with no actionable items — escalate
					{
						const event: EscalationEvent = {
							reason: `Reviewer returned ${verdict.readiness} with no auto-fixable items`,
							iteration,
							logPath: lastAgentLogPath,
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
						)
					) {
						console.log(
							`  Skipping auto-fix step ${iteration} (already completed)`,
						);
						state = "PARSE_FIX_STATUS";
						break;
					}

					const fixTemplate = renderTemplate("author-process-review", {
						review_path: reviewPath,
						plan_path: planPath,
					});

					// Open log stream for auto-fix
					const autoFixResultId = generateId();
					const autoFixLogPath = join(
						logDir,
						`agent-${autoFixResultId}.ndjson`,
					);
					const autoFixLogStream = createWriteStream(autoFixLogPath);
					autoFixLogStream.on("error", (err) =>
						console.warn(
							`[warn] agent log stream error: ${err instanceof Error ? err.message : String(err)}`,
						),
					);

					let autoFixResult: AgentResult;
					try {
						autoFixResult = await authorAdapter.invoke({
							prompt: fixTemplate.prompt,
							model: config.author.model,
							workdir,
							logStream: autoFixLogStream,
							onEvent: makeOnEvent(quiet),
						});
					} finally {
						await endStream(autoFixLogStream);
					}

					const fixStatus = parseStatusBlock(autoFixResult.output);
					upsertAgentResult(db, {
						id: autoFixResultId,
						run_id: runId,
						role: "author",
						template_name: "author-process-review",
						phase: phase.number,
						iteration,
						exit_code: autoFixResult.exitCode,
						duration_ms: autoFixResult.duration,
						tokens_in: autoFixResult.tokens?.input ?? null,
						tokens_out: autoFixResult.tokens?.output ?? null,
						cost_usd: autoFixResult.cost ?? null,
						signal_type: fixStatus ? "status" : null,
						signal_data: fixStatus ? JSON.stringify(fixStatus) : null,
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
							exitCode: autoFixResult.exitCode,
							logPath: autoFixLogPath,
						},
					});

					// Record log path for PARSE_FIX_STATUS escalations before incrementing.
					lastAgentLogPath = autoFixLogPath;

					if (autoFixResult.exitCode !== 0) {
						const event: EscalationEvent = {
							reason: buildEscalationReason(
								`Author exited with code ${autoFixResult.exitCode} during auto-fix`,
								autoFixLogPath,
								autoFixResult,
								quiet,
							),
							iteration,
							logPath: autoFixLogPath,
						};
						escalations.push(event);
						iteration++;
						state = "ESCALATE";
						break;
					}

					iteration++;
					state = "PARSE_FIX_STATUS";
					break;
				}

				// ───────────────────────────────────────────────────────
				// PARSE_FIX_STATUS: handle 5x:status after auto-fix
				// ───────────────────────────────────────────────────────
				case "PARSE_FIX_STATUS": {
					updateRunStatus(
						db,
						runId,
						"active",
						"PARSE_FIX_STATUS",
						phase.number,
					);

					const { getLatestStatus } = await import("../db/operations.js");
					const fixStatus = getLatestStatus(db, runId, phase.number);

					if (!fixStatus) {
						const event: EscalationEvent = {
							reason: "Author did not produce a 5x:status block after fix.",
							iteration,
							logPath: lastAgentLogPath,
						};
						escalations.push(event);
						appendRunEvent(db, {
							runId,
							eventType: "escalation",
							phase: phase.number,
							iteration,
							data: { reason: event.reason, trigger: "missing_fix_status" },
						});
						state = "ESCALATE";
						break;
					}

					if (fixStatus.result === "needs_human") {
						const event: EscalationEvent = {
							reason: fixStatus.reason ?? "Author needs human input during fix",
							iteration,
							logPath: lastAgentLogPath,
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
								status: fixStatus.result,
							},
						});
						state = "ESCALATE";
						break;
					}

					if (fixStatus.result === "failed") {
						const event: EscalationEvent = {
							reason: fixStatus.reason ?? "Author reported failure during fix",
							iteration,
							logPath: lastAgentLogPath,
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
								status: fixStatus.result,
							},
						});
						state = "ESCALATE";
						break;
					}

					// Update commit if provided
					if (fixStatus.commit) {
						lastCommit = fixStatus.commit;
					}

					// Back to quality check (or review if skipping quality)
					qualityAttempt = 0; // reset quality attempts after fix
					console.log("  Author fix applied. Re-checking...");
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
						console.log(`  Auto mode: escalation — ${lastEscalation.reason}`);
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
						case "continue":
							// Re-run author with the same phase; plumb guidance if provided
							if ("guidance" in response && response.guidance) {
								userGuidance = response.guidance;
							}
							state = "EXECUTE";
							break;
						case "approve":
							state = "PHASE_GATE";
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
						console.log(
							`  Auto mode: phase ${phase.number} complete, proceeding.`,
						);
						state = "PHASE_COMPLETE";
						break;
					}

					const phaseGateFn = options.phaseGate ?? defaultPhaseGate;
					// Compute actual verdict from DB (not hard-coded "ready")
					const { getLatestVerdict: getVerdictForSummary } = await import(
						"../db/operations.js"
					);
					const dbVerdict = getVerdictForSummary(db, runId, phase.number);
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
							state = "PHASE_COMPLETE";
							break;
						case "review":
							// Let user review, then continue
							console.log(
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
		phasesCompleted++;
		appendRunEvent(db, {
			runId,
			eventType: "phase_complete",
			phase: phase.number,
			iteration,
			data: { phaseNumber: phase.number, commit: lastCommit },
		});

		console.log(`  Phase ${phase.number} complete.`);

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
