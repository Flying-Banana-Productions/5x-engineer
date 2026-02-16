/**
 * Agent adapter interface — the contract between the orchestrator and agent harnesses.
 *
 * Design: intentionally minimal. The orchestrator depends on `exitCode`, `output` (full text),
 * and `duration` for correctness decisions. All routing logic uses parsed `5x:*` signals
 * from `output` and git observations (e.g., new commits). Optional fields like `tokens`
 * and `cost` are for display/logging only — never for routing.
 */

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface AgentAdapter {
	/** Human-readable adapter name (e.g. "claude-code", "opencode") */
	readonly name: string;

	/** Invoke the agent with a rendered prompt string. */
	invoke(opts: InvokeOptions): Promise<AgentResult>;

	/** Check if the adapter's underlying tool is installed and reachable. */
	isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Invoke options
// ---------------------------------------------------------------------------

export interface InvokeOptions {
	/** Fully rendered prompt string (from template engine). */
	prompt: string;

	/** Model override — adapter-specific format. */
	model?: string;

	/** Working directory for the agent subprocess. */
	workdir: string;

	/** Timeout in milliseconds. Default: 300_000 (5 min). */
	timeout?: number;

	/** Max conversation turns. Default: 50. */
	maxTurns?: number;

	/** Allowed tools filter (adapter-specific). */
	allowedTools?: string[];
}

// ---------------------------------------------------------------------------
// Agent result
// ---------------------------------------------------------------------------

export interface AgentResult {
	// --- Required (orchestration depends on these) ---

	/** Full text output from the agent — 5x:* signal blocks are parsed from this. */
	output: string;

	/** Process exit code. Non-zero → assume failed. */
	exitCode: number;

	/** Wall-clock duration in milliseconds. */
	duration: number;

	// --- Optional (display/logging only, never used for routing) ---

	/** Token usage if the adapter reports it. */
	tokens?: { input: number; output: number };

	/** Total cost in USD if the adapter reports it. */
	cost?: number;

	/** stderr or error message on failure. */
	error?: string;

	/** Session ID for reference/debugging. */
	sessionId?: string;
}

// ---------------------------------------------------------------------------
// Adapter factory config
// ---------------------------------------------------------------------------

export interface AdapterConfig {
	adapter: "claude-code" | "opencode";
	model?: string;
}
