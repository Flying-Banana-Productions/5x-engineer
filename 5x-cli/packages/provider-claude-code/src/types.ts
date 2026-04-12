/**
 * Configuration for the Claude Code provider (`[claude-code]` in 5x.toml).
 */

export type ClaudeCodePermissionMode = "dangerously-skip" | "default";

export type ClaudeCodeEffort = "low" | "medium" | "high" | "max";

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
	/** Reasoning effort level passed as `--effort <level>`. */
	effort?: ClaudeCodeEffort;
	/** Additional directories the agent may access; passed as `--add-dir <dirs...>`. */
	addDir?: string[];
	/** Fallback model on overload; passed as `--fallback-model <model>`. */
	fallbackModel?: string;
	/** Tool deny list; passed as `--disallowed-tools <tools...>`. */
	disallowedTools?: string[];
	/**
	 * Anthropic API key forwarded to the `claude` subprocess as
	 * `ANTHROPIC_API_KEY`. Setting this **bypasses your Claude subscription**
	 * and bills against the API. When unset, the provider scrubs ambient
	 * `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` so the user's OAuth /
	 * subscription login (from `claude /login`) is used instead.
	 */
	apiKey?: string;
}
