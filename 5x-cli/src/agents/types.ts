/**
 * Agent adapter interface — the contract between the orchestrator and agent harnesses.
 *
 * Phase 1 new design: structured output via OpenCode SDK. No more free-text
 * signal parsing. The orchestrator receives typed results directly.
 */

import type {
	AuthorStatus,
	ReviewerVerdict,
	VerdictItem,
} from "../protocol.js";

export type { AuthorStatus, ReviewerVerdict, VerdictItem };

// ---------------------------------------------------------------------------
// Invoke options
// ---------------------------------------------------------------------------

export interface InvokeOptions {
	/** Fully rendered prompt string (from template engine). */
	prompt: string;

	/** Model override — provider/model format (e.g. "anthropic/claude-sonnet-4-6"). */
	model?: string;

	/** Working directory for tool execution (worktree-safe). Passed to session.create() as directory. */
	workdir?: string;

	/** Path to write SSE event log (always written; independent of quiet). */
	logPath: string;

	/**
	 * Suppress console output; log file still written.
	 * Can be a function so callers can toggle visibility mid-invocation
	 * (for example when TUI exits and headless output should resume).
	 */
	quiet?: boolean | (() => boolean);

	/** Show reasoning/thinking tokens inline (dim). Default: false (suppressed). */
	showReasoning?: boolean;

	/** Timeout in seconds. Default: 120 (2 min). */
	timeout?: number;

	/** AbortSignal for external cancellation (Ctrl-C, gate aborts, parent timeout). */
	signal?: AbortSignal;

	/** Optional session title for TUI display. Passed to session.create(). */
	sessionTitle?: string;

	/**
	 * Optional callback invoked immediately after session creation.
	 * Used by TUI controller to switch focus to the new session.
	 * This fires before the prompt is sent, allowing the TUI to track
	 * the active session during streaming.
	 */
	onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Invoke results
// ---------------------------------------------------------------------------

export type InvokeStatus = {
	type: "status";
	status: AuthorStatus;
	duration: number;
	sessionId: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
};

export type InvokeVerdict = {
	type: "verdict";
	verdict: ReviewerVerdict;
	duration: number;
	sessionId: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
};

export type InvokeResult = InvokeStatus | InvokeVerdict;

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface AgentAdapter {
	/** The URL of the running agent server (e.g. "http://127.0.0.1:51234"). */
	readonly serverUrl: string;

	/** Invoke agent and return structured status. Throws on hard failure. */
	invokeForStatus(opts: InvokeOptions): Promise<InvokeStatus>;

	/** Invoke agent and return structured verdict. Throws on hard failure. */
	invokeForVerdict(opts: InvokeOptions): Promise<InvokeVerdict>;

	/** Check adapter is available (server reachable, model configured). */
	verify(): Promise<void>;

	/** Shut down the underlying server (called once at end of run). */
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter config
// ---------------------------------------------------------------------------

/** Config passed to createAndVerifyAdapter(). */
export interface AdapterConfig {
	model?: string;
}
