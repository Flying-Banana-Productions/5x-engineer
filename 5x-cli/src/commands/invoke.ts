/**
 * v1 Agent invocation commands.
 *
 * Subcommands: author, reviewer
 *
 * Both commands resolve a prompt template, invoke an agent via the provider
 * interface, validate the structured output, write an NDJSON log, and return
 * the result in a JSON envelope.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../config.js";
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
import type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	RunOptions,
	RunResult,
} from "../providers/types.js";
import { nextLogSequence } from "../run-id.js";
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
	model: string | null;
	duration_ms: number;
	tokens: { in: number; out: number };
	cost_usd: number | null;
	log_path: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Create NDJSON log directory and return the log file path.
 * Returns null if --run is not provided (no log directory to write to).
 */
function prepareLogPath(
	projectRoot: string,
	runId: string | undefined,
): string | null {
	if (!runId) return null;

	const logDir = join(projectRoot, ".5x", "logs", runId);
	mkdirSync(logDir, { recursive: true, mode: 0o700 });

	const seq = nextLogSequence(logDir);
	return join(logDir, `agent-${seq}.ndjson`);
}

/** Write a single AgentEvent as a JSON line to an NDJSON log file. */
function appendLogLine(logPath: string, event: AgentEvent): void {
	const line = JSON.stringify({ ...event, ts: new Date().toISOString() });
	appendFileSync(logPath, `${line}\n`);
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
				switch (event.type) {
					case "text":
						writer.writeText(event.delta);
						break;
					case "reasoning":
						if (showReasoning) {
							writer.writeThinking(event.delta);
						}
						break;
					case "tool_start":
						writer.endBlock();
						writer.writeLine(`[tool] ${event.tool}: ${event.input_summary}`, {
							dim: true,
						});
						break;
					case "tool_end":
						if (event.error) {
							writer.writeLine(`[tool] ${event.tool}: ERROR`, { dim: true });
						}
						break;
					case "error":
						writer.endBlock();
						writer.writeLine(`[error] ${event.message}`, { dim: true });
						break;
					case "done":
						result = event.result;
						break;
				}
			} else if (event.type === "done") {
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
		run?: string;
		var?: string | string[];
		model?: string;
		workdir?: string;
		session?: string;
		timeout?: string;
		quiet?: boolean;
		"show-reasoning"?: boolean;
	},
): Promise<void> {
	const projectRoot = resolveProjectRoot(args.workdir);
	const { config } = await loadConfig(projectRoot);

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
			outputError((err as { code: string }).code, err.message);
		}
		throw err;
	}

	// 3. Start or resume session
	const workdir = resolve(args.workdir ?? projectRoot);
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

	// 4. Prepare log path
	const logPath = prepareLogPath(projectRoot, args.run);

	// 5. Build run options
	const outputSchema =
		role === "author" ? AuthorStatusSchema : ReviewerVerdictSchema;
	const timeout = args.timeout ? Number.parseInt(args.timeout, 10) : undefined;
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
	if (!structured || typeof structured !== "object") {
		await provider.close().catch(() => {});
		if (isStructuredOutputError(structured)) {
			outputError(
				"INVALID_STRUCTURED_OUTPUT",
				"Agent returned a structured output error",
				{ raw: structured },
			);
		}
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
		model:
			((runResult as unknown as Record<string, unknown>).model as
				| string
				| null) ?? null,
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
		description: "Run ID (for NDJSON log directory)",
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
