/**
 * Invoke command handler — business logic for agent invocation.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Phase 2 (013-worktree-authoritative-execution-context):
 * When `--run` is present, the handler uses the run context resolver to
 * auto-resolve the effective working directory and plan path from the
 * run's worktree mapping. Artifact paths (logs, template overrides) are
 * anchored to `controlPlaneRoot/stateDir` rather than `projectRoot/.5x`.
 *
 * Deliberately NOT a harness-freshness fire point (201-harness-freshness §2.4,
 * D5): `invoke` runs dozens of times per run, so a check here would repeat the
 * same warning per step, and acting on it mid-run would change agent behavior
 * mid-run. The fire points are `run init`, `config set`, and `harness list`. If
 * a mid-run reminder ever proves necessary, the path is a `staleAtInit` stamp on
 * the run row surfaced once — not a check in this file.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	applyModelOverrides,
	type FiveXConfig,
	loadConfig,
	resolveLayeredConfig,
} from "../config.js";
import {
	createSqliteInvocationStore,
	type InvocationStore,
	type StepRecordPayload,
	withInvocationLifecycle,
} from "../control-plane/index.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { CliError, outputError, outputSuccess } from "../output.js";
import {
	extractPipeContext,
	isStdinPiped,
	type PipeContext,
	readUpstreamEnvelope,
} from "../pipe.js";
import {
	AuthorStatusSchema,
	type ReviewerVerdict,
	ReviewerVerdictSchema,
} from "../protocol.js";
import { createProvider as defaultCreateProvider } from "../providers/factory.js";
import {
	appendLogLine,
	appendSessionStart as defaultAppendSessionStart,
	prepareLogPath as defaultPrepareLogPath,
} from "../providers/log-writer.js";
import type {
	AgentProvider,
	AgentSession,
	RunOptions,
	RunResult,
} from "../providers/types.js";
import {
	applyPlanReviewBudget,
	type PendingBudgetSnapshot,
} from "../review-budget/apply.js";
import { applyPlanReviewGovernance } from "../review-governance/apply.js";
import {
	buildPlanReviewPromptContext,
	formatAuthorGoverningDecisions,
	formatReviewerGovernanceContext,
} from "../review-governance/context.js";
import {
	buildPlanReviewDiffContext,
	PlanDiffError,
	type PlanDiffFailure,
} from "../review-governance/plan-diff.js";
import { createReviewGovernanceStore } from "../review-governance/store.js";
import type { PlanDiffContext } from "../review-governance/types.js";
import { validateRunId } from "../run-id.js";
import { setTemplateOverrideDir } from "../templates/loader.js";
import { StreamWriter } from "../utils/stream-writer.js";
import {
	controlPlaneDbPath,
	resolveControlPlaneRoot,
} from "./control-plane.js";
import { validateStructuredOutput } from "./protocol-helpers.js";
import { RecordContextError } from "./record-context.js";
import {
	createReviewBudgetContext,
	ensurePlanReviewBaselineForContext,
	hasPriorPlanReviewerStep,
	type ReviewBudgetCommandContext,
	recordPlanReviewerStepWithSnapshot,
} from "./review-budget-context.js";
import { resolveRunExecutionContext } from "./run-context.js";
import { requireAmbientRunId } from "./run-identity.js";
import {
	prepareRecordStepAppend,
	RecordError,
	recordStepInternal,
} from "./run-v1.handler.js";
import { validateSessionContinuity } from "./session-check.js";
import {
	hasStdinVarFlag,
	isPlanReviewTemplate,
	needsReviewDelta,
	parseVars,
	resolveAndRenderTemplate,
	resolveReviewDelta,
} from "./template-vars.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvokeRole = "author" | "reviewer";

export interface InvokeAgentDeps {
	invocationStore?: InvocationStore;
	prepareLogPath?: typeof defaultPrepareLogPath;
	appendSessionStart?: typeof defaultAppendSessionStart;
	createProvider?: typeof defaultCreateProvider;
	createReviewBudgetContext?: typeof createReviewBudgetContext;
	warn?: (message: string) => void;
}

export interface InvokeParams {
	template: string;
	run?: string;
	vars?: string | string[];
	allowPlanPathOverride?: boolean;
	model?: string;
	workdir?: string;
	session?: string;
	newSession?: boolean;
	timeoutSeconds?: number;
	quiet?: boolean;
	showReasoning?: boolean;
	stderr?: boolean;
	authorProvider?: string;
	reviewerProvider?: string;
	opencodeUrl?: string;
	record?: boolean;
	recordStep?: string;
	phase?: string;
	iteration?: number;
	env?: NodeJS.Dict<string>;
	optInBudgetBaseline?: boolean;
}

interface InvokeResult {
	run_id: string;
	step_name: string | null;
	phase: string | null;
	model: string;
	result: unknown;
	session_id: string;
	duration_ms: number;
	tokens: { in: number; out: number };
	cost_usd: number | null;
	log_path: string;
	/** Warnings from template resolution (e.g. review_path mismatch). */
	warnings?: string[];
	/** Mapped worktree path (if run is mapped to a worktree). */
	worktree_path?: string;
	/** Effective plan path in the worktree (if resolved). */
	worktree_plan_path?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the agent invocation with streaming, writing events to the NDJSON log
 * and optionally rendering console output.
 */
async function invokeStreamed(
	session: AgentSession,
	prompt: string,
	opts: RunOptions,
	logPath: string | null,
	quiet: boolean,
	showReasoning: boolean,
	forceStderr: boolean,
	onEvent?: () => void,
): Promise<RunResult> {
	const writer =
		!quiet && (forceStderr || process.stderr.isTTY)
			? new StreamWriter({ writer: (s) => process.stderr.write(s) })
			: null;

	let result: RunResult | undefined;

	try {
		for await (const event of session.runStreamed(prompt, opts)) {
			onEvent?.();
			// Write to NDJSON log
			if (logPath) {
				appendLogLine(logPath, event);
			}

			// Console rendering (stderr, so stdout is reserved for JSON envelope)
			if (writer) {
				writer.writeEvent(event, { showReasoning });
			}

			// Capture result from done event
			if (event.type === "done") {
				result = event.result;
			}
		}
	} finally {
		writer?.destroy();
	}

	if (!result) {
		outputError("AGENT_ERROR", "Agent stream ended without a done event");
	}

	return result;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function invokeAgent(
	role: InvokeRole,
	params: InvokeParams,
	deps?: InvokeAgentDeps,
): Promise<void> {
	// Preserve INVALID_ARGS for an explicit malformed --run (path traversal, etc.).
	if (params.run) validateRunId(params.run);

	// Read upstream context from stdin when --run is not provided
	// and no --var uses @- (which would consume stdin).
	let pipeContext: PipeContext | undefined;
	let pipeRunId: string | undefined;

	const hasStdinVar = hasStdinVarFlag(params.vars);

	if (!params.run && !hasStdinVar && isStdinPiped()) {
		const upstream = await readUpstreamEnvelope();
		if (upstream) {
			pipeContext = extractPipeContext(upstream.data);
			pipeRunId = pipeContext.runId;
		}
	}

	// -----------------------------------------------------------------------
	// Phase 2: Resolve control-plane root and run execution context.
	//
	// When --run is present and --workdir is absent, use the run context
	// resolver to auto-resolve the effective working directory and plan path
	// from the run's worktree mapping.
	//
	// Context precedence (strict):
	//   1. Explicit --workdir wins over mapping.
	//   2. If run has mapped worktree, use mapped worktree.
	//   3. Fallback to controlPlaneRoot.
	// -----------------------------------------------------------------------

	const controlPlane = resolveControlPlaneRoot(params.workdir);

	if (controlPlane.mode === "none") {
		// --run is always required for invoke, and without a control-plane DB
		// the run can never be validated. Fail closed — consistent with
		// quality/diff handlers.
		outputError(
			"NO_CONTROL_PLANE",
			`No 5x control-plane DB found. Initialize with "5x init" first.`,
		);
	}

	const projectRoot = controlPlane.controlPlaneRoot;
	const stateDir = controlPlane.stateDir;

	// Run context resolution — resolves worktree mapping + effective plan path.
	let resolvedWorktreePath: string | null = null;
	let resolvedPlanPath: string | null = null;
	let effectiveWorkdir: string | null = null;
	let planPathInWorktreeExists = false;
	let runDb: ReturnType<typeof getDb> | undefined;

	{
		const db = getDb(
			controlPlane.controlPlaneRoot,
			controlPlaneDbPath(controlPlane.controlPlaneRoot, stateDir),
		);
		runDb = db;
		try {
			runMigrations(db);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Database upgrade required. Run "5x upgrade" to fix.\n\nDetails: ${msg}`,
			);
		}

		const runId = requireAmbientRunId({
			explicitRun: params.run,
			pipeRunId,
			startDir: params.workdir,
			env: params.env,
			db,
			controlPlane,
		});
		validateRunId(runId);
		params.run = runId;

		const ctxResult = resolveRunExecutionContext(db, runId, {
			controlPlaneRoot: controlPlane.controlPlaneRoot,
			explicitWorkdir: params.workdir ? resolve(params.workdir) : undefined,
		});

		if (!ctxResult.ok) {
			// All run-context errors are hard errors, including RUN_NOT_FOUND.
			// Consistent with quality/diff/run handlers: a typo or stale run ID
			// should not silently execute against the wrong context.
			outputError(ctxResult.error.code, ctxResult.error.message, {
				detail: ctxResult.error.detail,
			});
		} else {
			const ctx = ctxResult.context;
			resolvedWorktreePath = ctx.mappedWorktreePath;
			effectiveWorkdir = ctx.effectiveWorkingDirectory;

			// Effective plan path — resolver already handles worktree re-rooting.
			// Only use if no explicit --var plan_path=... was provided (checked later).
			resolvedPlanPath = ctx.effectivePlanPath;
			planPathInWorktreeExists = ctx.planPathInWorktreeExists;
		}
	}

	// Collect CLI-override provider names so loadConfig can suppress
	// unknown-key warnings for matching top-level config keys.
	const cliProviderNames = new Set<string>();
	if (params.authorProvider?.trim()) {
		cliProviderNames.add(params.authorProvider.trim());
	}
	if (params.reviewerProvider?.trim()) {
		cliProviderNames.add(params.reviewerProvider.trim());
	}

	// Config resolution: use plan-path-anchored layering (Phase 1c) when
	// we have a resolved plan path, so config is scoped to the plan's
	// sub-project (e.g. monorepo sub-directory with its own 5x.toml).
	const configContextDir = resolvedPlanPath
		? dirname(resolvedPlanPath)
		: undefined;

	let baseConfig: FiveXConfig;
	if (configContextDir) {
		const result = await resolveLayeredConfig(
			controlPlane.controlPlaneRoot,
			configContextDir,
		);
		baseConfig = result.config;
	} else {
		const result = await loadConfig(
			projectRoot,
			cliProviderNames.size > 0 ? cliProviderNames : undefined,
			undefined,
			projectRoot,
		);
		baseConfig = result.config;
	}

	// Apply CLI overrides — these are authoritative and take precedence
	const config = applyModelOverrides(baseConfig, {
		authorModel: role === "author" ? params.model : undefined,
		reviewerModel: role === "reviewer" ? params.model : undefined,
		authorProvider: params.authorProvider,
		reviewerProvider: params.reviewerProvider,
		opencodeUrl: params.opencodeUrl,
	});

	// Set up template override directory — anchored to controlPlaneRoot/stateDir
	const templateDir = join(
		controlPlane.controlPlaneRoot,
		stateDir,
		"templates",
		"prompts",
	);
	setTemplateOverrideDir(templateDir);

	// 1. Resolve and render template (shared helper)
	const explicitVars = await parseVars(params.vars);
	let mergedVars = pipeContext
		? { ...pipeContext.templateVars, ...explicitVars } // explicit --var wins
		: explicitVars;

	// Session continuity validation (before template rendering)
	validateSessionContinuity({
		templateName: params.template,
		session: params.session,
		newSession: params.newSession,
		runId: params.run,
		db: runDb,
		config,
		explicitVars: mergedVars,
	});

	// Compute review-delta variables when a prior reviewer step exists and
	// the caller is continuing via provider session. Invoke-mode doesn't
	// support --continue-native (that's for the native-subagent path).
	// Scalar vars (commits) merge into mergedVars; the multi-line diff is
	// appended to the rendered prompt after rendering.
	const wantContinued = params.session && !params.newSession;
	let reviewDiffAppend: string | null = null;
	if (
		wantContinued &&
		runDb &&
		params.run &&
		resolvedPlanPath &&
		needsReviewDelta(params.template)
	) {
		const delta = await resolveReviewDelta({
			db: runDb,
			runId: params.run,
			phase: isPlanReviewTemplate(params.template)
				? (mergedVars.phase_number ?? params.phase ?? "plan")
				: (mergedVars.phase_number ?? params.phase ?? "1"),
			planPath: resolvedPlanPath,
			workdir: resolvedWorktreePath ?? projectRoot,
			stepName: "reviewer:review",
		});
		if (Object.keys(delta.vars).length > 0) {
			mergedVars = { ...delta.vars, ...mergedVars };
		}
		reviewDiffAppend = isPlanReviewTemplate(params.template)
			? delta.diffAppend
			: null;
	}

	// When --new-session is set, pass session: undefined to ensure full
	// template is selected (not the -continued variant)
	const effectiveSession = params.newSession ? undefined : params.session;
	const resolved = resolveAndRenderTemplate({
		templateName: params.template,
		session: effectiveSession,
		newSession: params.newSession,
		explicitVars: mergedVars,
		allowPlanPathOverride: params.allowPlanPathOverride,
		resolvedPlanPath,
		config,
		projectRoot,
		// Pass run context for review_path auto-generation
		runId: params.run,
		phase: params.phase ?? mergedVars.phase_number,
		// Re-root review_path into the worktree when a worktree is mapped
		worktreeRoot: resolvedWorktreePath ?? undefined,
	});
	const { variables } = resolved;
	if (
		params.optInBudgetBaseline &&
		(role !== "reviewer" ||
			!isPlanReviewTemplate(resolved.selectedTemplateName))
	) {
		outputError(
			"BUDGET_BASELINE_OPT_IN_INVALID",
			"--opt-in-budget-baseline is valid only for a plan-reviewer invocation",
		);
	}
	const invocationWorkdir = params.workdir
		? resolve(params.workdir)
		: (effectiveWorkdir ?? projectRoot);
	const roleConfig = config[role] as Record<string, unknown>;
	const providerName =
		typeof roleConfig?.provider === "string" ? roleConfig.provider : "opencode";
	let budgetContext: ReviewBudgetCommandContext | undefined;
	let optInCapturedBeforeInvoke = false;

	// Fail closed before provider/session creation so an unbudgeted initial
	// plan review spends no tokens. Continued templates remain v1-compatible.
	if (
		role === "reviewer" &&
		(resolved.selectedTemplateName === "reviewer-plan" ||
			(params.optInBudgetBaseline &&
				isPlanReviewTemplate(resolved.selectedTemplateName))) &&
		params.run &&
		resolvedPlanPath
	) {
		try {
			budgetContext = await (
				deps?.createReviewBudgetContext ?? createReviewBudgetContext
			)({ runId: params.run, startDir: invocationWorkdir });
		} catch (err) {
			if (err instanceof RecordContextError) {
				outputError(err.code, err.message, err.detail);
			}
			throw err;
		}
		let planMarkdown: string;
		try {
			planMarkdown = readFileSync(
				budgetContext.executionContext.effectivePlanPath,
				"utf-8",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			outputError("PLAN_NOT_FOUND", `Failed to read plan: ${message}`);
		}
		let existingBaseline = null;
		try {
			if (budgetContext.recordStore.getRun(params.run))
				existingBaseline = budgetContext.store.getBaseline(params.run);
		} catch {
			// A mode-off legacy run may not have an authoritative records directory.
		}
		const ensured =
			existingBaseline || budgetContext.config.reviewBudget.mode !== "off"
				? ensurePlanReviewBaselineForContext({
						ctx: budgetContext,
						runId: params.run,
						planMarkdown,
						optIn: params.optInBudgetBaseline ?? false,
						performer: {
							kind: "agent",
							role: "reviewer",
							provider: providerName,
						},
						warn:
							deps?.warn ?? ((message) => console.error(`Warning: ${message}`)),
					})
				: ({ status: "skipped", reason: "off" } as const);
		if (ensured.status === "error") {
			outputError(ensured.code, ensured.message);
		}
		optInCapturedBeforeInvoke =
			Boolean(params.optInBudgetBaseline) && ensured.status === "captured";
	}

	// Append the review diff block (continued plan reviews only). The diff
	// can't be a template variable (multi-line), so it's added post-render.
	let governanceAppend: string | null = null;
	if (params.run && isPlanReviewTemplate(resolved.selectedTemplateName)) {
		try {
			budgetContext ??= await (
				deps?.createReviewBudgetContext ?? createReviewBudgetContext
			)({ runId: params.run, startDir: invocationWorkdir });
			const governanceContext = buildPlanReviewPromptContext({
				runId: params.run,
				configuredMode: config.reviewBudget.mode,
				store: budgetContext.store,
				recordStore: budgetContext.recordStore,
			});
			if (governanceContext) {
				governanceAppend =
					resolved.selectedTemplateName.replace(/-continued$/, "") ===
					"author-process-plan-review"
						? formatAuthorGoverningDecisions(governanceContext)
						: formatReviewerGovernanceContext(governanceContext);
			}
		} catch (err) {
			if (!(err instanceof RecordContextError)) throw err;
		}
	}
	const renderedPromptBase = reviewDiffAppend
		? `${resolved.prompt}\n${reviewDiffAppend}`
		: resolved.prompt;
	const renderedPrompt = governanceAppend
		? `${renderedPromptBase}\n\n${governanceAppend}`
		: renderedPromptBase;

	// Surface warnings (stderr for human visibility)
	if (resolved.warnings.length > 0) {
		for (const warning of resolved.warnings) {
			console.error(`Warning: ${warning}`);
		}
	}

	// 2. Create provider
	const createProvider = deps?.createProvider ?? defaultCreateProvider;
	let provider: AgentProvider;
	try {
		provider = await createProvider(role, config);
	} catch (err) {
		if (err instanceof CliError) throw err;
		// ProviderNotFoundError / InvalidProviderError from factory
		if (err instanceof Error && "code" in err && "exitCode" in err) {
			const exitCode = (err as { exitCode: number }).exitCode;
			outputError(
				(err as { code: string }).code,
				err.message,
				undefined,
				exitCode,
			);
		}
		throw err;
	}

	// 3. Start or resume session
	// Phase 2: use resolved worktree workdir when available.
	// Explicit --workdir wins, then mapped worktree, then projectRoot.
	const workdir = invocationWorkdir;
	const model =
		params.model ??
		(typeof roleConfig?.model === "string" ? roleConfig.model : "default");

	let session: AgentSession;
	try {
		if (params.session && !params.newSession) {
			session = await provider.resumeSession(params.session, {
				model: params.model,
				workingDirectory: workdir,
			});
		} else {
			session = await provider.startSession({
				model,
				workingDirectory: workdir,
			});
		}
	} catch (err) {
		await provider.close().catch(() => {});
		throw err;
	}

	if (!runDb) {
		await provider.close().catch(() => {});
		outputError(
			"NO_CONTROL_PLANE",
			`No 5x control-plane DB found. Initialize with "5x init" first.`,
		);
	}

	const runId = params.run;
	if (!runId) {
		await provider.close().catch(() => {});
		outputError("INVALID_ARGS", "--run is required");
	}

	const store = deps?.invocationStore ?? createSqliteInvocationStore(runDb);
	const prepareLog = deps?.prepareLogPath ?? defaultPrepareLogPath;
	const appendStart = deps?.appendSessionStart ?? defaultAppendSessionStart;

	const logDir = join(controlPlane.controlPlaneRoot, stateDir, "logs", runId);
	const outputSchema =
		role === "author" ? AuthorStatusSchema : ReviewerVerdictSchema;
	const quiet = params.quiet ?? false;
	const showReasoning = params.showReasoning ?? false;
	const forceStderr = params.stderr ?? false;

	const configTimeout =
		typeof roleConfig?.timeout === "number" ? roleConfig.timeout : undefined;
	const runOpts: RunOptions = {
		outputSchema: outputSchema as Record<string, unknown>,
		timeout: params.timeoutSeconds ?? configTimeout,
	};

	let logPath!: string;
	let runResult!: RunResult;
	let structured!: unknown;

	try {
		await withInvocationLifecycle({
			store,
			input: {
				runId,
				sessionId: session.id,
				role,
				providerName,
				templateName: resolved.selectedTemplateName,
				handle: { adapter: "none", ref: session.id },
				cancellationSupported: false,
			},
			fn: async ({ heartbeat }) => {
				logPath = prepareLog(logDir);
				appendStart(logPath, {
					type: "session_start",
					role,
					template: resolved.selectedTemplateName,
					run: runId,
					phase_number: variables.phase_number,
					provider: providerName,
					model,
				});
				runResult = await invokeStreamed(
					session,
					renderedPrompt,
					runOpts,
					logPath,
					quiet,
					showReasoning,
					forceStderr,
					heartbeat,
				);

				const validation = validateStructuredOutput(
					runResult.structured,
					role,
					{ context: `invoke ${role}` },
				);

				if (!validation.ok) {
					const rawDetail =
						validation.detail && typeof validation.detail === "object"
							? (validation.detail as Record<string, unknown>)
							: {};
					const enrichedDetail: Record<string, unknown> = {
						...rawDetail,
						session_id: runResult.sessionId,
						log_path: logPath,
						template: resolved.selectedTemplateName,
						provider: providerName,
						model,
						...(runResult.text
							? { provider_text: runResult.text.slice(0, 4000) }
							: {}),
						...(rawDetail.raw == null ? { raw: null } : {}),
					};

					if (params.record) {
						const stepName = params.recordStep ?? resolved.stepName;
						if (stepName) {
							try {
								await recordStepInternal({
									run: runId,
									stepName,
									result: JSON.stringify({
										result: "failed",
										reason: validation.message,
										invoke_error: validation.code,
										session_id: runResult.sessionId,
										log_path: logPath,
										template: resolved.selectedTemplateName,
										provider: providerName,
										model,
									}),
									phase: params.phase ?? variables.phase_number,
									iteration: params.iteration,
									sessionId: runResult.sessionId,
									model,
									durationMs: runResult.durationMs,
									tokensIn: runResult.tokens.in,
									tokensOut: runResult.tokens.out,
									costUsd: runResult.costUsd ?? undefined,
									logPath: logPath ?? undefined,
									performer: {
										kind: "agent",
										role,
										provider: providerName,
									},
								});
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								console.error(
									`Warning: failed to record invoke failure step: ${msg}`,
								);
							}
						}
					}

					outputError(validation.code, validation.message, enrichedDetail);
				}

				structured = validation.value;
			},
		});
	} finally {
		await provider.close().catch(() => {});
	}

	let pendingSnapshot: PendingBudgetSnapshot | undefined;
	const recordPhase = params.phase ?? variables.phase_number;
	if (role === "reviewer" && recordPhase === "plan" && params.run) {
		try {
			budgetContext ??= await (
				deps?.createReviewBudgetContext ?? createReviewBudgetContext
			)({ runId, startDir: workdir });
		} catch (err) {
			if (!params.record && err instanceof RecordContextError) {
				budgetContext = undefined;
			} else if (err instanceof RecordContextError) {
				outputError(err.code, err.message, err.detail);
			} else throw err;
		}
	}
	if (role === "reviewer" && recordPhase === "plan" && budgetContext) {
		const baseline = budgetContext.store.getBaseline(runId);
		const pinnedMode = baseline?.mode ?? budgetContext.config.reviewBudget.mode;
		if (pinnedMode !== "off") {
			let admissionEligible = true;
			const budgetStepName =
				params.recordStep ?? resolved.stepName ?? "reviewer:review";
			if (params.record && !baseline) {
				try {
					await prepareRecordStepAppend(
						{
							run: runId,
							stepName: budgetStepName,
							result: JSON.stringify(structured),
							phase: recordPhase,
							iteration: params.iteration,
							performer: {
								kind: "agent",
								role,
								provider: providerName,
							},
						},
						budgetContext,
					);
				} catch (err) {
					if (err instanceof RecordError) admissionEligible = false;
					else throw err;
				}
			}
			if ((params.record || baseline) && admissionEligible) {
				const stepName = budgetStepName;
				const performer = {
					kind: "agent",
					role: "reviewer",
					provider: providerName,
				} as const;
				let planMarkdown = "";
				let planReadFailed = false;
				try {
					planMarkdown = readFileSync(
						budgetContext.executionContext.effectivePlanPath,
						"utf-8",
					);
				} catch (err) {
					planReadFailed = true;
					if (params.record) {
						const message = err instanceof Error ? err.message : String(err);
						outputError("PLAN_NOT_FOUND", `Failed to read plan: ${message}`);
					}
				}
				if (!planReadFailed) {
					const governanceStore = createReviewGovernanceStore(
						budgetContext.recordStore,
					);
					const governingState = baseline
						? governanceStore.deriveGoverningState(runId, baseline.b0)
						: undefined;
					const applied = applyPlanReviewBudget({
						runId,
						stepName,
						phase: recordPhase,
						iteration: params.iteration,
						planMarkdown,
						verdict: structured as ReviewerVerdict,
						config: budgetContext.config.reviewBudget,
						store: budgetContext.store,
						hasPriorPlanReviewerStep: hasPriorPlanReviewerStep(
							budgetContext,
							runId,
						),
						optInBaseline:
							(params.optInBudgetBaseline ?? false) &&
							!optInCapturedBeforeInvoke,
						origin: budgetContext.originFor(performer),
						warn:
							deps?.warn ?? ((message) => console.error(`Warning: ${message}`)),
						...(governingState
							? { governingBaseline: governingState.governingBaseline }
							: {}),
					});
					if (applied.status === "error")
						outputError(applied.code, applied.message);
					if (applied.status === "applied") {
						const activeBaseline = budgetContext.store.getBaseline(runId);
						if (!activeBaseline)
							outputError(
								"BUDGET_BASELINE_MISSING",
								"Review budget baseline is missing",
							);
						const snapshots = budgetContext.store.listSnapshots(runId);
						const priorSnapshot = snapshots
							.filter((snapshot) => snapshot.id !== applied.pendingSnapshot.id)
							.at(-1);
						let diffContext: PlanDiffContext | undefined;
						let diffContextFailure: PlanDiffFailure | undefined;
						if (priorSnapshot?.stepName) {
							const priorStep = budgetContext.recordStore
								.listLines(runId, "steps")
								.find((line) => {
									const payload = line.payload as Partial<StepRecordPayload>;
									return (
										payload.step_name === priorSnapshot.stepName &&
										(payload.phase ?? null) === priorSnapshot.phase &&
										payload.iteration === priorSnapshot.iteration
									);
								});
							const head = (
								priorStep?.payload as Partial<StepRecordPayload> | undefined
							)?.head_commit;
							if (head) {
								try {
									diffContext = await buildPlanReviewDiffContext({
										workdir:
											budgetContext.executionContext.effectiveWorkingDirectory,
										planPath: budgetContext.executionContext.effectivePlanPath,
										previousReviewCommit: head,
									});
								} catch (error) {
									diffContextFailure =
										error instanceof PlanDiffError
											? { code: error.code, message: error.message }
											: {
													code: "PLAN_DIFF_GIT_ERROR",
													message:
														error instanceof Error
															? error.message
															: String(error),
												};
								}
							}
						}
						const composed = applyPlanReviewGovernance({
							verdict: structured as ReviewerVerdict,
							budgetResult: applied,
							snapshots,
							decisions: governanceStore.listDecisions(runId),
							governingState: governanceStore.deriveGoverningState(
								runId,
								activeBaseline.b0,
							),
							mode: activeBaseline.mode,
							...(diffContext ? { diffContext } : {}),
							...(diffContextFailure ? { diffContextFailure } : {}),
						});
						if (composed.status === "error")
							outputError(composed.code, composed.message, {
								diagnostics: composed.diagnostics,
							});
						structured = composed.verdict;
						pendingSnapshot = composed.pendingSnapshot;
					}
				}
			}
		}
	}

	const output: InvokeResult = {
		run_id: params.run,
		step_name: resolved.stepName,
		phase: variables.phase_number ?? null,
		model,
		result: structured,
		session_id: runResult.sessionId,
		duration_ms: runResult.durationMs,
		tokens: runResult.tokens,
		cost_usd: runResult.costUsd ?? null,
		log_path: logPath,
		// Warnings from template resolution
		...(resolved.warnings.length > 0 ? { warnings: resolved.warnings } : {}),
		// Phase 2: optional execution context fields for downstream pipelines
		...(resolvedWorktreePath ? { worktree_path: resolvedWorktreePath } : {}),
		...(resolvedPlanPath && resolvedWorktreePath && planPathInWorktreeExists
			? { worktree_plan_path: resolvedPlanPath }
			: {}),
	};

	outputSuccess(output);

	// Auto-record the step if --record is set.
	// IMPORTANT: outputSuccess() has already written the primary envelope above.
	// All errors from here must go to stderr — never outputError() (which would
	// write a second JSON envelope to stdout, corrupting the stream).
	if (params.record) {
		const stepName = params.recordStep ?? resolved.stepName;
		if (!stepName) {
			console.error(
				"Warning: --record requires a step name. Provide --record-step or add step_name to the template frontmatter.",
			);
			process.exitCode = 1;
		} else {
			try {
				const recordParams = {
					run: params.run,
					stepName,
					result: JSON.stringify(structured),
					phase: params.phase ?? variables.phase_number,
					iteration: params.iteration,
					sessionId: runResult.sessionId,
					model,
					durationMs: runResult.durationMs,
					tokensIn: runResult.tokens.in,
					tokensOut: runResult.tokens.out,
					costUsd: runResult.costUsd ?? undefined,
					logPath: logPath ?? undefined,
					performer: {
						kind: "agent",
						role,
						provider: providerName,
					} as const,
				};
				if (pendingSnapshot && budgetContext) {
					await recordPlanReviewerStepWithSnapshot(
						recordParams,
						pendingSnapshot,
						budgetContext,
					);
				} else {
					await recordStepInternal(recordParams, budgetContext);
				}
			} catch (err) {
				// Recording is a side effect — primary envelope already written.
				// Warn on stderr with structured code, set non-zero exit via process.exitCode.
				if (err instanceof RecordError) {
					console.error(
						`Warning: failed to record step [${err.code}]: ${err.message}`,
					);
				} else {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`Warning: failed to record step: ${msg}`);
				}
				process.exitCode = 1;
			}
		}
	}
}
