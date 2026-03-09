/**
 * Sample provider plugin — implements the ProviderPlugin contract for testing.
 *
 * This is a minimal echo/noop provider that validates the external plugin
 * architecture without requiring real SDK dependencies.
 *
 * Usage in 5x.config.yaml:
 *   author:
 *     provider: "sample"
 *   sample:
 *     echo: true       # optional — echo prompt back as text (default true)
 *     structured: {}   # optional — JSON object returned as structured output
 */

import type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	ProviderPlugin,
	ResumeOptions,
	RunOptions,
	RunResult,
	SessionOptions,
} from "@5x-ai/5x-cli";

// ---------------------------------------------------------------------------
// SampleSession implementation
// ---------------------------------------------------------------------------

class SampleSession implements AgentSession {
	readonly id: string;
	private model: string;
	private workingDirectory: string;
	private echoMode: boolean;
	private structuredOutput: unknown;

	constructor(
		id: string,
		model: string,
		workingDirectory: string,
		echoMode: boolean,
		structuredOutput?: unknown,
	) {
		this.id = id;
		this.model = model;
		this.workingDirectory = workingDirectory;
		this.echoMode = echoMode;
		this.structuredOutput = structuredOutput;
	}

	run(prompt: string, _opts?: RunOptions): Promise<RunResult> {
		const text = this.echoMode
			? `[SampleProvider echo] ${prompt}`
			: "Sample provider response";
		const durationMs = 0;

		return Promise.resolve({
			text,
			structured: this.structuredOutput,
			sessionId: this.id,
			tokens: { in: 0, out: 0 },
			durationMs,
		});
	}

	async *runStreamed(
		prompt: string,
		_opts?: RunOptions,
	): AsyncIterable<AgentEvent> {
		const text = this.echoMode
			? `[SampleProvider echo] ${prompt}`
			: "Sample provider response";

		// Yield text event
		yield { type: "text", delta: text };

		// Yield usage event
		yield { type: "usage", tokens: { in: 0, out: 0 } };

		// Yield done event with full result
		const result: RunResult = {
			text,
			structured: this.structuredOutput,
			sessionId: this.id,
			tokens: { in: 0, out: 0 },
			durationMs: 0,
		};
		yield { type: "done", result };
	}
}

// ---------------------------------------------------------------------------
// SampleProvider implementation
// ---------------------------------------------------------------------------

class SampleProvider implements AgentProvider {
	private model: string;
	private echoMode: boolean;
	private structuredOutput: unknown;
	private sessions: Map<string, SampleSession> = new Map();

	constructor(model?: string, echoMode = true, structuredOutput?: unknown) {
		this.model = model ?? "sample/default";
		this.echoMode = echoMode;
		this.structuredOutput = structuredOutput;
	}

	async startSession(opts: SessionOptions): Promise<AgentSession> {
		const id = `sample_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
		const session = new SampleSession(
			id,
			opts.model ?? this.model,
			opts.workingDirectory,
			this.echoMode,
			this.structuredOutput,
		);
		this.sessions.set(id, session);
		return session;
	}

	async resumeSession(
		sessionId: string,
		opts?: ResumeOptions,
	): Promise<AgentSession> {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			// Return existing session (model override is ignored for simplicity)
			return existing;
		}

		// Create a new session with the given ID
		const session = new SampleSession(
			sessionId,
			opts?.model ?? this.model,
			"/tmp", // Default working directory for resumed sessions
			this.echoMode,
			this.structuredOutput,
		);
		this.sessions.set(sessionId, session);
		return session;
	}

	async close(): Promise<void> {
		// No-op for sample provider
		this.sessions.clear();
	}
}

// ---------------------------------------------------------------------------
// ProviderPlugin export
// ---------------------------------------------------------------------------

const samplePlugin: ProviderPlugin = {
	name: "sample",
	async create(config?: Record<string, unknown>): Promise<AgentProvider> {
		const model = typeof config?.model === "string" ? config.model : undefined;
		const echoMode = config?.echo !== false; // default true
		// structured: JSON object to return as structured output (for testing invoke enrichment)
		const structured = config?.structured;
		return new SampleProvider(model, echoMode, structured);
	},
};

export default samplePlugin;
