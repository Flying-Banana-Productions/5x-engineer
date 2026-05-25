/**
 * Configuration for the Cursor Agent provider (`[cursor-agent]` in 5x.toml).
 */

export interface CursorAgentConfig {
	/** Path or name of the `agent` executable. */
	agentBinary?: string;
	/** When true (default), passes `--force` for headless file/command execution. */
	force?: boolean;
	/** When true (default), passes `--trust` in print mode. */
	trust?: boolean;
	/** Optional sandbox mode passed as `--sandbox enabled|disabled`. */
	sandbox?: "enabled" | "disabled";
	/** When true, passes `--approve-mcps`. */
	approveMcps?: boolean;
	/** Plugin directories passed as repeated `--plugin-dir <path>`. */
	pluginDir?: string[];
	/** API key forwarded to the subprocess as `CURSOR_API_KEY` (not argv). */
	apiKey?: string;
	/** Auth token forwarded as `CURSOR_AUTH_TOKEN` (not argv). */
	authToken?: string;
}
