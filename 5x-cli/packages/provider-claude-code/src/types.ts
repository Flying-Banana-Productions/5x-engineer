/**
 * Configuration for the Claude Code provider (`[claude-code]` in 5x.toml).
 */

export type ClaudeCodePermissionMode = "dangerously-skip" | "default";

export interface ClaudeCodeConfig {
	/** When `"dangerously-skip"` (default), passes `--dangerously-skip-permissions`. */
	permissionMode?: ClaudeCodePermissionMode;
	/** Skip hooks/plugins/CLAUDE.md discovery when true. */
	bare?: boolean;
	/** Restrict which tools the agent may use. */
	tools?: string[];
	/** Per-invocation cost ceiling in USD. */
	maxBudgetUsd?: number;
	/** Replace the default system prompt. */
	systemPrompt?: string;
	/** Append to the system prompt. */
	appendSystemPrompt?: string;
	/** Path or name of the `claude` executable. */
	claudeBinary?: string;
}
