/**
 * v1 Agent Provider interface — the contract between CLI primitives and agent runtimes.
 *
 * Replaces the v0 `AgentAdapter` interface with a cleaner session-based model.
 * Each provider maps its native event format to `AgentEvent`; the CLI renders
 * and logs normalized events without provider-specific knowledge.
 *
 * See docs/v1/100-architecture.md §6.1 for the design.
 */

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface AgentProvider {
	startSession(opts: SessionOptions): Promise<AgentSession>;
	resumeSession(sessionId: string, opts?: ResumeOptions): Promise<AgentSession>;
	close(): Promise<void>;
}

export interface ResumeOptions {
	/** Model override for the resumed session. Falls back to provider default. */
	model?: string;
}

export interface AgentSession {
	readonly id: string;
	run(prompt: string, opts?: RunOptions): Promise<RunResult>;
	runStreamed(prompt: string, opts?: RunOptions): AsyncIterable<AgentEvent>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SessionOptions {
	/** Model identifier (provider-specific format, e.g. "anthropic/claude-sonnet-4-6"). */
	model: string;
	/** Working directory for tool execution (file edits, shell commands). */
	workingDirectory: string;
}

/** JSON Schema type — matches `100-architecture.md` definition. */
export type JSONSchema = Record<string, unknown>;

export interface RunOptions {
	/** Structured output extraction schema. */
	outputSchema?: JSONSchema;
	/** AbortSignal for cancellation. */
	signal?: AbortSignal;
	/** Per-run timeout in seconds. */
	timeout?: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface RunResult {
	/** Final text response. */
	text: string;
	/** Parsed JSON if outputSchema was provided. */
	structured?: unknown;
	/** Session ID used for this run. */
	sessionId: string;
	/** Token usage. */
	tokens: { in: number; out: number };
	/** Cost in USD, if available. */
	costUsd?: number;
	/** Wall-clock duration in milliseconds. */
	durationMs: number;
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

export type AgentEvent =
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "tool_start"; tool: string; input_summary: string }
	| { type: "tool_end"; tool: string; output: string; error?: boolean }
	| { type: "error"; message: string }
	| { type: "usage"; tokens: { in: number; out: number }; costUsd?: number }
	| { type: "done"; result: RunResult };

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

/**
 * Contract for external provider plugins.
 * Default export of a provider package (e.g. `@5x-ai/provider-codex`).
 */
export interface ProviderPlugin {
	readonly name: string;
	create(config?: Record<string, unknown>): Promise<AgentProvider>;
}
