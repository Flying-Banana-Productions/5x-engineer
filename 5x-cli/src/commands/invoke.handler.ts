/**
 * Invoke command handler — business logic for agent invocation.
 *
 * Framework-independent: no citty imports.
 */

import { join, resolve } from "node:path";
import { applyModelOverrides, loadConfig } from "../config.js";
import { CliError, outputError, outputSuccess } from "../output.js";
import { resolveProjectRoot } from "../project-root.js";
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
import { appendLogLine, prepareLogPath } from "../providers/log-writer.js";
import type {
	AgentProvider,
	AgentSession,
	RunOptions,
	RunResult,
} from "../providers/types.js";
import {
	loadTemplate,
	renderTemplate,
	setTemplateOverrideDir,
} from "../templates/loader.js";
import { StreamWriter } from "../utils/stream-writer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvokeRole = "author" | "reviewer";

export interface InvokeParams {
	template: string;
	run: string;
	vars?: string | string[];
	model?: string;
	workdir?: string;
	session?: string;
	timeoutSeconds?: number;
	quiet?: boolean;
	showReasoning?: boolean;
	authorProvider?: string;
	reviewerProvider?: string;
	opencodeUrl?: string;
}

interface InvokeResult {
	result: unknown;
	session_id: string;
	duration_ms: number;
	tokens: { in: number; out: number };
	cost_usd: number | null;
	log_path: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe run_id pattern: alphanumeric start, then alphanumeric/underscore/hyphen, max 64 chars. */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validate that a run_id is safe for use as a filesystem path component. */
function validateRunId(runId: string): void {
	if (!SAFE_RUN_ID.test(runId)) {
		outputError(
			"INVALID_ARGS",
			`--run must match ${SAFE_RUN_ID} (alphanumeric start, alphanumeric/underscore/hyphen, 1-64 chars), got: "${runId}"`,
		);
	}
}

/**
 * Parse --var key=value flags into a record.
 * Accepts a single string or array of strings (citty may collapse repeated flags).
 */
function parseVars(
	vars: string | string[] | undefined,
): Record<string, string> {
	if (!vars) return {};
	const items = Array.isArray(vars) ? vars : [vars];
	if (items.length === 0) return {};
	const result: Record<string, string> = {};
	for (const v of items) {
		const eqIdx = v.indexOf("=");
		if (eqIdx <= 0) {
			outputError(
				"INVALID_ARGS",
				`--var must be in "key=value" format, got: "${v}"`,
			);
		}
		const key = v.slice(0, eqIdx);
		const value = v.slice(eqIdx + 1);
		result[key] = value;
	}
	return result;
}

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
): Promise<RunResult> {
	const writer =
		!quiet && process.stderr.isTTY
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
	// Validate --run (required) — reject path traversal
	if (!params.run) {
		outputError("INVALID_ARGS", "--run is required for invoke commands");
	}
	validateRunId(params.run);

	const projectRoot = resolveProjectRoot(params.workdir);

	// Collect CLI-override provider names so loadConfig can suppress
	// unknown-key warnings for matching top-level config keys.
	const cliProviderNames = new Set<string>();
	if (params.authorProvider?.trim()) {
		cliProviderNames.add(params.authorProvider.trim());
	}
	if (params.reviewerProvider?.trim()) {
		cliProviderNames.add(params.reviewerProvider.trim());
	}

	const { config: baseConfig } = await loadConfig(
		projectRoot,
		cliProviderNames.size > 0 ? cliProviderNames : undefined,
	);

	// Apply CLI overrides — these are authoritative and take precedence
	const config = applyModelOverrides(baseConfig, {
		authorModel: role === "author" ? params.model : undefined,
		reviewerModel: role === "reviewer" ? params.model : undefined,
		authorProvider: params.authorProvider,
		reviewerProvider: params.reviewerProvider,
		opencodeUrl: params.opencodeUrl,
	});

	// Set up template override directory
	const templateDir = join(projectRoot, ".5x", "templates", "prompts");
	setTemplateOverrideDir(templateDir);

	// 1. Resolve and render template
	const templateName = params.template;
	try {
		loadTemplate(templateName);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("Unknown template") || message.includes("not found")) {
			outputError("TEMPLATE_NOT_FOUND", message);
		}
		throw err;
	}

	const variables = parseVars(params.vars);
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
	// Resolve workdir relative to projectRoot (not process.cwd)
	const workdir = params.workdir
		? resolve(projectRoot, params.workdir)
		: projectRoot;
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
	const logDir = join(projectRoot, ".5x", "logs", params.run);
	const logPath = prepareLogPath(logDir);

	// 5. Build run options
	const outputSchema =
		role === "author" ? AuthorStatusSchema : ReviewerVerdictSchema;
	const quiet = params.quiet ?? false;
	const showReasoning = params.showReasoning ?? false;

	const runOpts: RunOptions = {
		outputSchema: outputSchema as Record<string, unknown>,
		timeout: params.timeoutSeconds,
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

	// 9. Return result
	const output: InvokeResult = {
		result: structured,
		session_id: runResult.sessionId,
		duration_ms: runResult.durationMs,
		tokens: runResult.tokens,
		cost_usd: runResult.costUsd ?? null,
		log_path: logPath,
	};

	outputSuccess(output);
}
