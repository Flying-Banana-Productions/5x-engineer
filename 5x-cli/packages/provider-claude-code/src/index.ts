/**
 * @5x-ai/provider-claude-code — Claude Code CLI provider (pure modules in phase 1;
 * full `ProviderPlugin` in a later phase).
 */

export { buildCliArgs, type CliArgContext } from "./cli-args.js";
export {
	type ClaudeCodeMapperState,
	createMapperState,
	mapNdjsonLine,
	summarizeToolInput,
} from "./event-mapper.js";
export { parseModelForClaudeCode } from "./model.js";
export {
	formatPromptOverLimitMessage,
	getPromptBytes,
	guardPromptSize,
	MAX_PROMPT_BYTES,
	type PromptGuardResult,
	type PromptOverLimitPayload,
} from "./prompt-guard.js";
export type { ClaudeCodeConfig, ClaudeCodePermissionMode } from "./types.js";
