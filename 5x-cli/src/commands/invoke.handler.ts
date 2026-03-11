/**
 * Invoke command handler — business logic for agent invocation.
 *
 * Framework-independent: no citty imports.
 *
 * Phase 2 (013-worktree-authoritative-execution-context):
 * When `--run` is present, the handler uses the run context resolver to
 * auto-resolve the effective working directory and plan path from the
 * run's worktree mapping. Artifact paths (logs, template overrides) are
 * anchored to `controlPlaneRoot/stateDir` rather than `projectRoot/.5x`.
 */

import { dirname, join, resolve } from "node:path";
import {
	applyModelOverrides,
	type FiveXConfig,
	loadConfig,
	resolveLayeredConfig,
} from "../config.js";
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
	type AuthorStatus,
	AuthorStatusSchema,
	assertAuthorStatus,
	assertReviewerVerdict,
	isStructuredOutputError,
	type ReviewerVerdict,
	ReviewerVerdictSchema,
} from "../protocol.js";
import { createProvider } from "../providers/factory.js";
import {
	appendLogLine,
	appendSessionStart,
	prepareLogPath,
} from "../providers/log-writer.js";
import type {
	AgentProvider,
	AgentSession,
	RunOptions,
	RunResult,
} from "../providers/types.js";
import { validateRunId } from "../run-id.js";
import {
	loadTemplate,
	renderTemplate,
	setTemplateOverrideDir,
} from "../templates/loader.js";
import { StreamWriter } from "../utils/stream-writer.js";
import { DB_FILENAME, resolveControlPlaneRoot } from "./control-plane.js";
import { resolveRunExecutionContext } from "./run-context.js";
import { RecordError, recordStepInternal } from "./run-v1.handler.js";
import {
	hasStdinVarFlag,
	parseVars,
	resolveInternalTemplateVariables,
} from "./template-vars.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvokeRole = "author" | "reviewer";

export interface InvokeParams {
	template: string;
	run?: string;
	vars?: string | string[];
	model?: string;
	workdir?: string;
	session?: string;
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
): Promise<RunResult> {
	const writer =
		!quiet && (forceStderr || process.stderr.isTTY)
			? new StreamWriter({ writer: (s) => process.stderr.write(s) })
			: null;

	let result: RunResult | undefined;

	try {
		for await (const event of session.runStreamed(prompt, opts)) {
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
): Promise<void> {
	// Read upstream context from stdin when --run is not provided
	// and no --var uses @- (which would consume stdin).
	let pipeContext: PipeContext | undefined;

	const hasStdinVar = hasStdinVarFlag(params.vars);

	if (!params.run && !hasStdinVar && isStdinPiped()) {
		const upstream = await readUpstreamEnvelope();
		if (upstream) {
			pipeContext = extractPipeContext(upstream.data);
			params.run ??= pipeContext.runId;
		}
	}

	// Validate --run (required) — reject path traversal
	if (!params.run) {
		outputError(
			"INVALID_ARGS",
			"--run is required (provide it or pipe from an upstream command)",
		);
	}
	validateRunId(params.run);

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

	{
		const dbRelPath = join(stateDir, DB_FILENAME);
		const db = getDb(controlPlane.controlPlaneRoot, dbRelPath);
		try {
			runMigrations(db);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Database upgrade required. Run "5x upgrade" to fix.\n\nDetails: ${msg}`,
			);
		}

		const ctxResult = resolveRunExecutionContext(db, params.run, {
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

	// 1. Resolve and render template
	// When resuming a session, prefer a "-continued" variant of the template
	// if one exists. The continued variant is shorter (saves tokens) since
	// the full instructions are already in the session context.
	let templateName = params.template;
	if (params.session) {
		const continuedName = `${templateName}-continued`;
		try {
			loadTemplate(continuedName);
			templateName = continuedName;
		} catch {
			// No continued variant — use the full template
		}
	}

	let templateMetadata: ReturnType<typeof loadTemplate>["metadata"];
	try {
		const loaded = loadTemplate(templateName);
		templateMetadata = loaded.metadata;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("Unknown template") || message.includes("not found")) {
			outputError("TEMPLATE_NOT_FOUND", message);
		}
		throw err;
	}

	const explicitVars = await parseVars(params.vars);
	const mergedVars = pipeContext
		? { ...pipeContext.templateVars, ...explicitVars } // explicit --var wins
		: explicitVars;

	// Phase 2: inject resolved plan path as default for plan_path variable.
	// Explicit --var plan_path=... wins over resolver default.
	if (
		resolvedPlanPath &&
		!mergedVars.plan_path &&
		templateMetadata.variables.includes("plan_path")
	) {
		mergedVars.plan_path = resolvedPlanPath;
	}

	const variables = resolveInternalTemplateVariables(
		templateMetadata.variables,
		mergedVars,
		config,
		projectRoot,
	);
	const rendered = renderTemplate(templateName, variables);

	// 2. Create provider
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
	const workdir = params.workdir
		? resolve(params.workdir)
		: (effectiveWorkdir ?? projectRoot);
	const roleConfig = config[role] as Record<string, unknown>;
	const model =
		params.model ??
		(typeof roleConfig?.model === "string" ? roleConfig.model : "default");

	let session: AgentSession;
	try {
		if (params.session) {
			session = await provider.resumeSession(params.session, {
				model: params.model,
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

	// 4. Prepare log path (--run is required and already validated)
	// Anchor log dir to controlPlaneRoot/stateDir.
	const logDir = join(
		controlPlane.controlPlaneRoot,
		stateDir,
		"logs",
		params.run,
	);
	const logPath = prepareLogPath(logDir);

	// 4b. Write session metadata as first NDJSON line (log-only, not an AgentEvent)
	appendSessionStart(logPath, {
		type: "session_start",
		role,
		template: templateName,
		run: params.run,
		phase_number: variables.phase_number,
	});

	// 5. Build run options
	const outputSchema =
		role === "author" ? AuthorStatusSchema : ReviewerVerdictSchema;
	const quiet = params.quiet ?? false;
	const showReasoning = params.showReasoning ?? false;
	const forceStderr = params.stderr ?? false;

	// CLI --timeout takes precedence, then config [author].timeout / [reviewer].timeout
	const configTimeout =
		typeof roleConfig?.timeout === "number" ? roleConfig.timeout : undefined;
	const runOpts: RunOptions = {
		outputSchema: outputSchema as Record<string, unknown>,
		timeout: params.timeoutSeconds ?? configTimeout,
	};

	// 6. Invoke agent
	let runResult: RunResult;
	try {
		runResult = await invokeStreamed(
			session,
			rendered.prompt,
			runOpts,
			logPath,
			quiet,
			showReasoning,
			forceStderr,
		);
	} catch (err) {
		await provider.close().catch(() => {});
		throw err;
	}

	// 7. Validate structured output
	const structured = runResult.structured;

	// Check for StructuredOutputError BEFORE the object guard — real error
	// payloads are typically objects and would fall through to assert* otherwise.
	if (isStructuredOutputError(structured)) {
		await provider.close().catch(() => {});
		outputError(
			"INVALID_STRUCTURED_OUTPUT",
			"Agent returned a structured output error",
			{ raw: structured },
		);
	}

	if (!structured || typeof structured !== "object") {
		await provider.close().catch(() => {});
		outputError(
			"INVALID_STRUCTURED_OUTPUT",
			`Agent did not return valid structured output for ${role}`,
			{ raw: structured ?? null },
		);
	}

	try {
		if (role === "author") {
			assertAuthorStatus(structured as AuthorStatus, `invoke ${role}`);
		} else {
			assertReviewerVerdict(structured as ReviewerVerdict, `invoke ${role}`);
		}
	} catch (err) {
		await provider.close().catch(() => {});
		const message = err instanceof Error ? err.message : String(err);
		outputError("INVALID_STRUCTURED_OUTPUT", message, { raw: structured });
	}

	// 8. Close provider
	await provider.close().catch(() => {});

	// 9. Return result — include worktree context for downstream pipelines
	const output: InvokeResult = {
		run_id: params.run,
		step_name: rendered.stepName,
		phase: variables.phase_number ?? null,
		model,
		result: structured,
		session_id: runResult.sessionId,
		duration_ms: runResult.durationMs,
		tokens: runResult.tokens,
		cost_usd: runResult.costUsd ?? null,
		log_path: logPath,
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
		const stepName = params.recordStep ?? rendered.stepName;
		if (!stepName) {
			console.error(
				"Warning: --record requires a step name. Provide --record-step or add step_name to the template frontmatter.",
			);
			process.exitCode = 1;
		} else {
			try {
				await recordStepInternal({
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
				});
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
