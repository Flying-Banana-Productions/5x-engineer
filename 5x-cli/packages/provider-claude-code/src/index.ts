/**
 * @5x-ai/provider-claude-code — Claude Code CLI provider plugin.
 */

import type { AgentProvider, ProviderPlugin } from "@5x-ai/5x-cli";

import { ClaudeCodeProvider } from "./provider.js";
import type {
	ClaudeCodeConfig,
	ClaudeCodeEffort,
	ClaudeCodePermissionMode,
} from "./types.js";

export { buildCliArgs, type CliArgContext } from "./cli-args.js";
export { buildSubprocessEnv } from "./env.js";
export {
	type ClaudeCodeMapperState,
	createMapperState,
	mapNdjsonLine,
	summarizeToolInput,
} from "./event-mapper.js";
export { parseModelForClaudeCode } from "./model.js";
export { ClaudeCodeProvider } from "./provider.js";
export {
	ClaudeCodeSession,
	forceKillSubprocess,
	readNdjsonLines,
	type ClaudeCodeExecutionHost,
	type ClaudeCodeSessionOptions,
	type ClaudeSubprocess,
} from "./session.js";
export {
	formatPromptOverLimitMessage,
	getPromptBytes,
	guardPromptSize,
	MAX_PROMPT_BYTES,
	type PromptGuardResult,
	type PromptOverLimitPayload,
} from "./prompt-guard.js";
export type {
	ClaudeCodeConfig,
	ClaudeCodeEffort,
	ClaudeCodePermissionMode,
} from "./types.js";

/**
 * Parse `[claude-code]` config from 5x.toml-derived plugin config.
 */
export function parseClaudePluginConfig(
	raw?: Record<string, unknown>,
): ClaudeCodeConfig {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			permissionMode: "dangerously-skip",
			claudeBinary: "claude",
		};
	}

	const permissionMode: ClaudeCodePermissionMode =
		raw.permissionMode === "default" ? "default" : "dangerously-skip";

	const claudeBinary =
		typeof raw.claudeBinary === "string" && raw.claudeBinary !== ""
			? raw.claudeBinary
			: "claude";

	const out: ClaudeCodeConfig = {
		permissionMode,
		claudeBinary,
	};

	if (raw.bare === true) out.bare = true;

	if (Array.isArray(raw.tools)) {
		const tools = raw.tools.filter((t): t is string => typeof t === "string");
		if (tools.length > 0) out.tools = tools;
	}

	if (typeof raw.maxBudgetUsd === "number") out.maxBudgetUsd = raw.maxBudgetUsd;
	if (typeof raw.systemPrompt === "string") out.systemPrompt = raw.systemPrompt;
	if (typeof raw.appendSystemPrompt === "string") {
		out.appendSystemPrompt = raw.appendSystemPrompt;
	}

	if (
		raw.effort === "low" ||
		raw.effort === "medium" ||
		raw.effort === "high" ||
		raw.effort === "max"
	) {
		out.effort = raw.effort satisfies ClaudeCodeEffort;
	}

	if (Array.isArray(raw.addDir)) {
		const dirs = raw.addDir.filter(
			(d): d is string => typeof d === "string" && d !== "",
		);
		if (dirs.length > 0) out.addDir = dirs;
	}

	if (typeof raw.fallbackModel === "string" && raw.fallbackModel !== "") {
		out.fallbackModel = raw.fallbackModel;
	}

	if (Array.isArray(raw.disallowedTools)) {
		const tools = raw.disallowedTools.filter(
			(t): t is string => typeof t === "string" && t !== "",
		);
		if (tools.length > 0) out.disallowedTools = tools;
	}

	if (typeof raw.apiKey === "string" && raw.apiKey !== "") {
		out.apiKey = raw.apiKey;
	}

	return out;
}

const claudeCodePlugin: ProviderPlugin = {
	name: "claude-code",
	create(config?: Record<string, unknown>): Promise<AgentProvider> {
		return Promise.resolve(
			new ClaudeCodeProvider(parseClaudePluginConfig(config)),
		);
	},
};

export default claudeCodePlugin;
