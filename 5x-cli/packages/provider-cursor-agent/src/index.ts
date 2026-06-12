/**
 * @5x-ai/provider-cursor-agent — Cursor Agent CLI provider plugin.
 */

import type { AgentProvider, ProviderPlugin } from "@5x-ai/5x-cli";

import { buildCreateChatArgs, buildRunArgs, type RunArgContext } from "./cli-args.js";
import { buildSubprocessEnv } from "./env.js";
import {
	createMapperState,
	mapCursorAgentLine,
	type CursorAgentMapperOptions,
	type CursorAgentMapperState,
} from "./event-mapper.js";
import { CursorAgentProvider } from "./provider.js";
import {
	formatPromptOverLimitMessage,
	getPromptBytes,
	guardPromptSize,
	MAX_PROMPT_BYTES,
	type PromptGuardResult,
	type PromptOverLimitPayload,
} from "./prompt-guard.js";
import {
	extractStructuredOutput,
	wrapPromptForStructuredOutput,
	type StructuredExtractResult,
} from "./structured.js";
import type { CursorAgentConfig } from "./types.js";

export { buildCreateChatArgs, buildRunArgs, type RunArgContext } from "./cli-args.js";
export { buildSubprocessEnv } from "./env.js";
export {
	createMapperState,
	mapCursorAgentLine,
	summarizeCursorToolArgs,
	type CursorAgentMapperOptions,
	type CursorAgentMapperState,
} from "./event-mapper.js";
export { CursorAgentProvider } from "./provider.js";
export {
	formatPromptOverLimitMessage,
	getPromptBytes,
	guardPromptSize,
	MAX_PROMPT_BYTES,
	type PromptGuardResult,
	type PromptOverLimitPayload,
} from "./prompt-guard.js";
export {
	extractStructuredOutput,
	wrapPromptForStructuredOutput,
	type StructuredExtractResult,
} from "./structured.js";
export type { CursorAgentConfig } from "./types.js";

/**
 * Parse `[cursor-agent]` config from 5x.toml-derived plugin config.
 */
export function parseCursorAgentPluginConfig(
	raw?: Record<string, unknown>,
): CursorAgentConfig {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			agentBinary: "agent",
			force: true,
			trust: true,
		};
	}

	const agentBinary =
		typeof raw.agentBinary === "string" && raw.agentBinary !== ""
			? raw.agentBinary
			: "agent";

	const out: CursorAgentConfig = {
		agentBinary,
		force: raw.force === false ? false : true,
		trust: raw.trust === false ? false : true,
	};

	if (raw.sandbox === "enabled" || raw.sandbox === "disabled") {
		out.sandbox = raw.sandbox;
	}

	if (raw.approveMcps === true) {
		out.approveMcps = true;
	}

	if (Array.isArray(raw.pluginDir)) {
		const dirs = raw.pluginDir.filter(
			(d): d is string => typeof d === "string" && d !== "",
		);
		if (dirs.length > 0) out.pluginDir = dirs;
	}

	if (typeof raw.apiKey === "string" && raw.apiKey !== "") {
		out.apiKey = raw.apiKey;
	}

	if (typeof raw.authToken === "string" && raw.authToken !== "") {
		out.authToken = raw.authToken;
	}

	return out;
}

const cursorAgentPlugin: ProviderPlugin = {
	name: "cursor-agent",
	create(config?: Record<string, unknown>): Promise<AgentProvider> {
		return Promise.resolve(
			new CursorAgentProvider(parseCursorAgentPluginConfig(config)),
		);
	},
};

export default cursorAgentPlugin;
