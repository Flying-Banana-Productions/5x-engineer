import type { CursorAgentConfig } from "./types.js";

/** Context for building a single `agent` run invocation (excluding the binary). */
export interface RunArgContext {
	prompt: string;
	sessionId: string;
	cwd: string;
	model?: string;
	force?: CursorAgentConfig["force"];
	trust?: CursorAgentConfig["trust"];
	sandbox?: CursorAgentConfig["sandbox"];
	approveMcps?: CursorAgentConfig["approveMcps"];
	pluginDir?: CursorAgentConfig["pluginDir"];
}

/** Build argv for `agent create-chat`. */
export function buildCreateChatArgs(): string[] {
	return ["create-chat"];
}

/**
 * Build argv for `agent -p` with stream-json output (excluding the binary name).
 *
 * Order: print flags, resume/workspace, model, force/trust/sandbox/mcps/plugin dirs, prompt.
 */
export function buildRunArgs(ctx: RunArgContext): string[] {
	const args: string[] = [
		"-p",
		"--output-format",
		"stream-json",
		"--stream-partial-output",
		"--resume",
		ctx.sessionId,
		"--workspace",
		ctx.cwd,
	];

	if (ctx.model !== undefined && ctx.model !== "") {
		args.push("--model", ctx.model);
	}

	const force = ctx.force !== false;
	if (force) {
		args.push("--force");
	}

	const trust = ctx.trust !== false;
	if (trust) {
		args.push("--trust");
	}

	if (ctx.sandbox === "enabled" || ctx.sandbox === "disabled") {
		args.push("--sandbox", ctx.sandbox);
	}

	if (ctx.approveMcps === true) {
		args.push("--approve-mcps");
	}

	if (ctx.pluginDir !== undefined) {
		for (const dir of ctx.pluginDir) {
			if (dir !== "") {
				args.push("--plugin-dir", dir);
			}
		}
	}

	args.push(ctx.prompt);
	return args;
}
