/**
 * v1 Agent invocation commands.
 *
 * Subcommands: author, reviewer
 *
 * Both commands resolve a prompt template, invoke an agent via the provider
 * interface, validate the structured output, write an NDJSON log, and return
 * the result in a JSON envelope.
 */

import { join, resolve } from "node:path";
import { defineCommand } from "citty";
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

type Role = "author" | "reviewer";

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

/** Parse --var key=value flags into a record.
 *  Accepts a single string or array of strings (citty may collapse repeated flags). */
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
 * Validate --timeout as a positive integer.
 * Returns the validated timeout or undefined if not provided.
 */
function parseTimeout(raw: string | number | undefined): number | undefined {
	// Explicitly check for undefined or null (not just falsy, to handle numeric 0)
	if (raw === undefined || raw === null || raw === "") return undefined;

	// If it's already a number (citty may parse numeric args), convert to string for validation
	const rawStr = typeof raw === "number" ? String(raw) : raw;
	const parsed = Number.parseInt(rawStr, 10);

	// Reject NaN, zero, negative numbers, or partial parses (e.g., "10abc" where parsed=10 but rawStr!=="10")
	if (Number.isNaN(parsed) || parsed <= 0 || String(parsed) !== rawStr) {
		outputError(
			"INVALID_ARGS",
			`--timeout must be a positive integer (seconds), got: "${raw}"`,
		);
	}
	return parsed;
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

/**
 * Core invocation logic shared by both author and reviewer commands.
 */
async function invokeAgent(
	role: Role,
	args: {
		template: string;
		run: string;
		var?: string | string[];
		model?: string;
		workdir?: string;
		session?: string;
		timeout?: string | number;
		quiet?: boolean;
		"show-reasoning"?: boolean;
		"author-provider"?: string;
		"reviewer-provider"?: string;
		"opencode-url"?: string;
	},
): Promise<void> {
	// Validate --run (required) — reject path traversal
	if (!args.run) {
		outputError("INVALID_ARGS", "--run is required for invoke commands");
	}
	validateRunId(args.run);

	// Validate --timeout early
	const timeout = parseTimeout(args.timeout);

	const projectRoot = resolveProjectRoot(args.workdir);

	// Collect CLI-override provider names so loadConfig can suppress
	// unknown-key warnings for matching top-level config keys.
	const cliProviderNames = new Set<string>();
	if (args["author-provider"]?.trim()) {
		cliProviderNames.add(args["author-provider"].trim());
	}
	if (args["reviewer-provider"]?.trim()) {
		cliProviderNames.add(args["reviewer-provider"].trim());
	}

	const { config: baseConfig } = await loadConfig(
		projectRoot,
		cliProviderNames.size > 0 ? cliProviderNames : undefined,
	);

	// Apply CLI overrides — these are authoritative and take precedence
	const config = applyModelOverrides(baseConfig, {
		authorModel: role === "author" ? args.model : undefined,
		reviewerModel: role === "reviewer" ? args.model : undefined,
		authorProvider: args["author-provider"],
		reviewerProvider: args["reviewer-provider"],
		opencodeUrl: args["opencode-url"],
	});

	// Set up template override directory
	const templateDir = join(projectRoot, ".5x", "templates", "prompts");
	setTemplateOverrideDir(templateDir);

	// 1. Resolve and render template
	const templateName = args.template;
	try {
		loadTemplate(templateName);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("Unknown template") || message.includes("not found")) {
			outputError("TEMPLATE_NOT_FOUND", message);
		}
		throw err;
	}

	const variables = parseVars(args.var);
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
	const workdir = args.workdir
		? resolve(projectRoot, args.workdir)
		: projectRoot;
	const roleConfig = config[role] as Record<string, unknown>;
	const model =
		args.model ??
		(typeof roleConfig?.model === "string" ? roleConfig.model : "default");

	let session: AgentSession;
	try {
		if (args.session) {
			session = await provider.resumeSession(args.session, {
				model: args.model,
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
	const logDir = join(projectRoot, ".5x", "logs", args.run);
	const logPath = prepareLogPath(logDir);

	// 5. Build run options
	const outputSchema =
		role === "author" ? AuthorStatusSchema : ReviewerVerdictSchema;
	const quiet = args.quiet ?? false;
	const showReasoning = args["show-reasoning"] ?? false;

	const runOpts: RunOptions = {
		outputSchema: outputSchema as Record<string, unknown>,
		timeout,
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

// ---------------------------------------------------------------------------
// Shared args definition
// ---------------------------------------------------------------------------

const sharedArgs = {
	template: {
		type: "positional" as const,
		description: "Template name (e.g. author-next-phase)",
		required: true as const,
	},
	run: {
		type: "string" as const,
		description: "Run ID (required — used for NDJSON log directory)",
		required: true as const,
	},
	var: {
		type: "string" as const,
		description: "Template variable (key=value, repeatable)",
		// Note: citty handles repeated flags as arrays when type is string
	},
	model: {
		type: "string" as const,
		description: "Model override",
	},
	workdir: {
		type: "string" as const,
		description: "Working directory for agent tool execution",
	},
	session: {
		type: "string" as const,
		description: "Resume an existing session by ID",
	},
	timeout: {
		type: "string" as const,
		description: "Per-run timeout in seconds",
	},
	quiet: {
		type: "boolean" as const,
		description: "Suppress console output (stderr)",
		default: false,
	},
	"show-reasoning": {
		type: "boolean" as const,
		description: "Show agent reasoning/thinking in console output",
		default: false,
	},
	"author-provider": {
		type: "string" as const,
		description: "Override author provider (e.g. codex, @acme/provider-foo)",
	},
	"reviewer-provider": {
		type: "string" as const,
		description: "Override reviewer provider",
	},
	"opencode-url": {
		type: "string" as const,
		description: "Override OpenCode server URL (external mode)",
	},
};

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const authorCmd = defineCommand({
	meta: {
		name: "author",
		description: "Invoke an author agent with a template",
	},
	args: sharedArgs,
	async run({ args }) {
		await invokeAgent(
			"author",
			args as Record<string, unknown> as Parameters<typeof invokeAgent>[1],
		);
	},
});

const reviewerCmd = defineCommand({
	meta: {
		name: "reviewer",
		description: "Invoke a reviewer agent with a template",
	},
	args: sharedArgs,
	async run({ args }) {
		await invokeAgent(
			"reviewer",
			args as Record<string, unknown> as Parameters<typeof invokeAgent>[1],
		);
	},
});

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export default defineCommand({
	meta: {
		name: "invoke",
		description: "Invoke an agent with a prompt template",
	},
	subCommands: {
		author: () => Promise.resolve(authorCmd),
		reviewer: () => Promise.resolve(reviewerCmd),
	},
});
