import type { ClaudeCodeConfig } from "./types.js";

/** Context for building a single `claude` CLI invocation. */
export interface CliArgContext {
	prompt: string;
	sessionId: string;
	/** When true, use `--resume`; when false, use `--session-id` for the first-invocation path. */
	isResume: boolean;
	model?: string;
	/** Streaming NDJSON vs single JSON object on stdout. */
	streaming: boolean;
	/** Serialized JSON Schema string for `--json-schema`. */
	jsonSchema?: string;
	permissionMode?: ClaudeCodeConfig["permissionMode"];
	bare?: boolean;
	tools?: string[];
	maxBudgetUsd?: number;
	systemPrompt?: string;
	appendSystemPrompt?: string;
}

/**
 * Build argv for `claude` (excluding the binary name).
 *
 * Order: prompt (`-p`), session flags, model, output format, schema, permissions, optional config.
 */
export function buildCliArgs(ctx: CliArgContext): string[] {
	const args: string[] = ["-p", ctx.prompt];

	if (ctx.isResume) {
		args.push("--resume", ctx.sessionId);
	} else {
		args.push("--session-id", ctx.sessionId);
	}

	if (ctx.model !== undefined && ctx.model !== "") {
		args.push("--model", ctx.model);
	}

	if (ctx.streaming) {
		args.push(
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
		);
	} else {
		args.push("--output-format", "json");
	}

	if (ctx.jsonSchema !== undefined && ctx.jsonSchema !== "") {
		args.push("--json-schema", ctx.jsonSchema);
	}

	const perm = ctx.permissionMode ?? "dangerously-skip";
	if (perm === "dangerously-skip") {
		args.push("--dangerously-skip-permissions");
	}

	if (ctx.bare === true) {
		args.push("--bare");
	}

	if (ctx.tools !== undefined && ctx.tools.length > 0) {
		args.push("--tools", ctx.tools.join(","));
	}

	if (ctx.maxBudgetUsd !== undefined) {
		args.push("--max-budget-usd", String(ctx.maxBudgetUsd));
	}

	if (ctx.systemPrompt !== undefined && ctx.systemPrompt !== "") {
		args.push("--system-prompt", ctx.systemPrompt);
	}

	if (ctx.appendSystemPrompt !== undefined && ctx.appendSystemPrompt !== "") {
		args.push("--append-system-prompt", ctx.appendSystemPrompt);
	}

	return args;
}
