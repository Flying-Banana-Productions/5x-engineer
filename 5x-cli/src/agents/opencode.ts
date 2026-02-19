/**
 * OpenCode SDK adapter — managed (local) mode only.
 *
 * Spawns a local OpenCode server, creates per-invocation sessions,
 * sends prompts with structured output schemas, streams SSE events
 * to log files, and handles timeout/abort.
 *
 * Phase 3 of 003-impl-5x-cli-opencode.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	createOpencode,
	type Event as OpenCodeEvent,
	type OpencodeClient,
	type OutputFormat,
} from "@opencode-ai/sdk/v2";
import {
	type AuthorStatus,
	AuthorStatusSchema,
	assertAuthorStatus,
	assertReviewerVerdict,
	isStructuredOutputError,
	type ReviewerVerdict,
	ReviewerVerdictSchema,
} from "../protocol.js";
import { formatSseEvent } from "../utils/sse-formatter.js";
import { endStream } from "../utils/stream.js";
import type {
	AgentAdapter,
	InvokeOptions,
	InvokeStatus,
	InvokeVerdict,
} from "./types.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AgentTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentTimeoutError";
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a "provider/model" string into the SDK's model object.
 * Throws if the format is invalid.
 */
export function parseModel(model: string): {
	providerID: string;
	modelID: string;
} {
	const slashIdx = model.indexOf("/");
	if (slashIdx < 1) {
		throw new Error(
			`Invalid model format "${model}" — expected "provider/model" (e.g. "anthropic/claude-sonnet-4-6")`,
		);
	}
	return {
		providerID: model.slice(0, slashIdx),
		modelID: model.slice(slashIdx + 1),
	};
}

/**
 * Extract session ID from an SSE event (best-effort).
 * Returns undefined if the event doesn't carry session info.
 */
function getEventSessionId(event: OpenCodeEvent): string | undefined {
	// Access properties generically — event is a discriminated union
	const props = (event as Record<string, unknown>).properties as
		| Record<string, unknown>
		| undefined;
	if (!props) return undefined;

	// Direct sessionID on properties (session.status, session.idle, message.part.delta, etc.)
	if (typeof props.sessionID === "string") return props.sessionID;

	// Message events: properties.info.sessionID
	const info = props.info as Record<string, unknown> | undefined;
	if (info && typeof info.sessionID === "string") return info.sessionID;

	// Session events: properties.info.id (Session objects use 'id', not 'sessionID')
	if (info && typeof info.id === "string") return info.id;

	// Part events: properties.part.sessionID
	const part = props.part as Record<string, unknown> | undefined;
	if (part && typeof part.sessionID === "string") return part.sessionID;

	return undefined;
}

// ---------------------------------------------------------------------------
// SSE event log streaming
// ---------------------------------------------------------------------------

/**
 * Subscribe to SSE events, write them to a log file (NDJSON), and optionally
 * format them for console display. Runs until the abort signal fires.
 */
async function writeEventsToLog(
	client: OpencodeClient,
	sessionId: string,
	logPath: string,
	abortSignal: AbortSignal,
	opts: { quiet?: boolean },
): Promise<void> {
	// Ensure log directory exists
	const logDir = path.dirname(logPath);
	fs.mkdirSync(logDir, { recursive: true });

	const logStream = fs.createWriteStream(logPath, {
		flags: "a",
		encoding: "utf8",
	});
	logStream.on("error", (err) => {
		console.error(`Warning: log file write error: ${err.message}`);
	});

	try {
		const { stream } = await client.event.subscribe();
		for await (const event of stream) {
			if (abortSignal.aborted) break;

			// Filter for this session's events
			const eventSessionId = getEventSessionId(event);
			if (eventSessionId && eventSessionId !== sessionId) continue;

			// Write to log file (NDJSON: one JSON object per line)
			const line = JSON.stringify(event);
			logStream.write(`${line}\n`);

			// Console output (when not quiet)
			if (!opts.quiet) {
				const formatted = formatSseEvent(event);
				if (formatted != null) {
					process.stdout.write(`${formatted}\n`);
				}
			}
		}
	} catch (err) {
		// Stream errors are expected on abort — suppress them
		if (!abortSignal.aborted) {
			console.error(
				`Warning: SSE stream error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} finally {
		await endStream(logStream);
	}
}

// ---------------------------------------------------------------------------
// OpenCode Adapter
// ---------------------------------------------------------------------------

export class OpenCodeAdapter implements AgentAdapter {
	private client: OpencodeClient;
	private server: { url: string; close(): void };
	private defaultModel?: string;
	private closed = false;

	/** @internal Use OpenCodeAdapter.create() instead. */
	constructor(
		client: OpencodeClient,
		server: { url: string; close(): void },
		defaultModel?: string,
	) {
		this.client = client;
		this.server = server;
		this.defaultModel = defaultModel;
	}

	/**
	 * Spawn a local OpenCode server and return a ready adapter.
	 * Throws with an actionable message if the server fails to start.
	 */
	static async create(opts: { model?: string } = {}): Promise<OpenCodeAdapter> {
		try {
			const { client, server } = await createOpencode({ timeout: 15_000 });
			return new OpenCodeAdapter(client, server, opts.model);
		} catch (err) {
			throw new Error(
				"OpenCode server failed to start — check that opencode is installed and on PATH. " +
					`Details: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * Shut down the spawned local server. Idempotent — safe to call multiple times.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			this.server.close();
		} catch {
			// Ignore close errors — server may already be gone
		}
	}

	/**
	 * Health check — verify the server is reachable.
	 */
	async verify(): Promise<void> {
		try {
			const result = await this.client.session.list();
			if (result.error) {
				throw new Error(
					typeof result.error === "object"
						? JSON.stringify(result.error)
						: String(result.error),
				);
			}
		} catch (err) {
			throw new Error(
				"OpenCode server health check failed — server did not start correctly. " +
					`Details: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * Invoke agent with AuthorStatus structured output.
	 */
	async invokeForStatus(opts: InvokeOptions): Promise<InvokeStatus> {
		return this._invoke(opts, "status") as Promise<InvokeStatus>;
	}

	/**
	 * Invoke agent with ReviewerVerdict structured output.
	 */
	async invokeForVerdict(opts: InvokeOptions): Promise<InvokeVerdict> {
		return this._invoke(opts, "verdict") as Promise<InvokeVerdict>;
	}

	// ---------------------------------------------------------------------------
	// Core invocation
	// ---------------------------------------------------------------------------

	private async _invoke(
		opts: InvokeOptions,
		resultType: "status" | "verdict",
	): Promise<InvokeStatus | InvokeVerdict> {
		const timeoutMs = opts.timeout ?? 300_000;
		const model = opts.model ?? this.defaultModel;
		const modelObj = model ? parseModel(model) : undefined;
		const schema =
			resultType === "status" ? AuthorStatusSchema : ReviewerVerdictSchema;
		const format: OutputFormat = {
			type: "json_schema",
			schema: schema as Record<string, unknown>,
			retryCount: 2,
		};

		const start = Date.now();

		// 1. Create session
		const sessionResult = await this.client.session.create({
			title: `5x-${resultType}-${Date.now()}`,
		});
		if (sessionResult.error) {
			throw new Error(
				`Failed to create session: ${JSON.stringify(sessionResult.error)}`,
			);
		}
		const sessionId = sessionResult.data.id;

		// 2. Start SSE event stream in background
		const eventController = new AbortController();
		const streamPromise = writeEventsToLog(
			this.client,
			sessionId,
			opts.logPath,
			eventController.signal,
			{ quiet: opts.quiet },
		);

		try {
			// 3. Send prompt with timeout race
			const promptPromise = this.client.session.prompt({
				sessionID: sessionId,
				parts: [{ type: "text", text: opts.prompt }],
				format,
				...(modelObj && { model: modelObj }),
			});

			const timeoutPromise = new Promise<never>((_, reject) => {
				const id = setTimeout(() => {
					reject(new AgentTimeoutError(`Agent timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				// Unref so it doesn't keep the process alive
				if (typeof id === "object" && "unref" in id) id.unref();
			});

			const result = await Promise.race([promptPromise, timeoutPromise]);
			const duration = Date.now() - start;

			// 4. Check for errors
			if (result.error) {
				if (isStructuredOutputError(result)) {
					throw new Error(
						`Structured output validation failed: ${JSON.stringify(result.error)}`,
					);
				}
				throw new Error(
					`Agent invocation failed: ${JSON.stringify(result.error)}`,
				);
			}

			const info = result.data.info;

			// 5. Extract structured output
			const structured = info.structured;
			if (structured == null) {
				// Check if there's a structured output error on the message
				if (info.error && isStructuredOutputError({ error: info.error })) {
					throw new Error(
						`Structured output validation failed after retries: ${JSON.stringify(info.error)}`,
					);
				}
				throw new Error(
					"Agent did not return structured output — expected JSON schema response. " +
						"This may indicate the model does not support structured output.",
				);
			}

			// 6. Extract token/cost info
			const tokensIn = info.tokens?.input;
			const tokensOut = info.tokens?.output;
			const costUsd = info.cost || undefined;

			// 7. Build and validate result
			if (resultType === "status") {
				const status = structured as AuthorStatus;
				assertAuthorStatus(status, "invokeForStatus");
				return {
					type: "status",
					status,
					duration,
					sessionId,
					tokensIn,
					tokensOut,
					costUsd,
				};
			}

			const verdict = structured as ReviewerVerdict;
			assertReviewerVerdict(verdict, "invokeForVerdict");
			return {
				type: "verdict",
				verdict,
				duration,
				sessionId,
				tokensIn,
				tokensOut,
				costUsd,
			};
		} catch (err) {
			// On timeout, abort the session
			if (err instanceof AgentTimeoutError) {
				try {
					await this.client.session.abort({ sessionID: sessionId });
				} catch {
					// Ignore abort errors
				}
			}
			throw err;
		} finally {
			// 8. Stop SSE stream and flush log
			eventController.abort();
			await streamPromise;
		}
	}
}
