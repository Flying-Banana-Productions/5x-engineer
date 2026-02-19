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
 *
 * P0.1 fix: passes abortSignal to client.event.subscribe() so the underlying
 * SSE HTTP connection is torn down when the signal fires, preventing hangs.
 *
 * P1.2 fix: events without a session ID are skipped (no cross-session leakage).
 */
async function writeEventsToLog(
	client: OpencodeClient,
	sessionId: string,
	logPath: string,
	abortSignal: AbortSignal,
	opts: { quiet?: boolean },
): Promise<void> {
	// Ensure log directory exists with restricted permissions (logs may contain
	// sensitive content — enforce 0700 so they are not group/world-readable).
	// If the directory already exists (e.g. from an older version that used
	// default umask), best-effort chmod it to 0700 so inherited broad perms
	// from prior runs are corrected.
	const logDir = path.dirname(logPath);
	fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(logDir, 0o700);
	} catch {
		// Best-effort — ignore if chmod fails (e.g. foreign ownership)
	}

	const logStream = fs.createWriteStream(logPath, {
		flags: "a",
		encoding: "utf8",
	});
	logStream.on("error", (err) => {
		if (!opts.quiet) {
			console.error(`Warning: log file write error: ${err.message}`);
		}
	});

	try {
		// P0.1: pass signal to subscribe so the SSE connection terminates on abort
		const { stream } = await client.event.subscribe(undefined, {
			signal: abortSignal,
		});

		// Track which part IDs are text parts so we only stream deltas for text,
		// not reasoning tokens or other part types (which arrive as delta events
		// but should not be printed inline).
		const textPartIds = new Set<string>();
		// Whether we are currently mid-stream (a delta was written without a
		// trailing newline yet). Used to terminate the line before the next
		// formatted event.
		let streamingLine = false;

		for await (const event of stream) {
			if (abortSignal.aborted) break;

			// P1.2: skip events without a session ID (no cross-session leakage)
			const eventSessionId = getEventSessionId(event);
			if (!eventSessionId) continue;

			// Filter for this session's events
			if (eventSessionId !== sessionId) continue;

			// Write to log file (NDJSON: one JSON object per line)
			const line = JSON.stringify(event);
			logStream.write(`${line}\n`);

			// Console output (when not quiet)
			if (!opts.quiet) {
				const ev = event as Record<string, unknown>;
				const type = ev.type as string | undefined;
				const props = ev.properties as Record<string, unknown> | undefined;

				// Register text parts so we know which delta events to stream.
				if (type === "message.part.updated" && props) {
					const part = props.part as Record<string, unknown> | undefined;
					if (part?.type === "text") {
						const pid = part.id as string | undefined;
						if (pid) textPartIds.add(pid);
					}
				}

				// Delta events: write inline (no newline) to build up a continuous
				// line of streaming text. Only emit for known text parts — reasoning
				// tokens and other part types are suppressed.
				if (type === "message.part.delta" && props) {
					const partId = props.partID as string | undefined;
					const delta = props.delta as string | undefined;
					if (partId && textPartIds.has(partId) && delta) {
						if (!streamingLine) {
							// Indent the first token of a new streaming line
							process.stdout.write("  ");
						}
						process.stdout.write(delta);
						streamingLine = true;
						continue;
					}
					// Non-text delta (reasoning etc.) — suppress, skip formatted path
					continue;
				}

				// Any non-delta event: terminate the current streaming line first
				if (streamingLine) {
					process.stdout.write("\n");
					streamingLine = false;
				}

				const formatted = formatSseEvent(event);
				if (formatted != null) {
					process.stdout.write(`${formatted}\n`);
				}
			}
		}

		// Terminate any trailing streaming line
		if (!opts.quiet && streamingLine) {
			process.stdout.write("\n");
		}
	} catch (err) {
		// Stream errors are expected on abort — suppress them
		if (!abortSignal.aborted && !opts.quiet) {
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

		// 1. Create session (P0.3: pass workdir as directory)
		const sessionResult = await this.client.session.create({
			title: `5x-${resultType}-${Date.now()}`,
			...(opts.workdir && { directory: opts.workdir }),
		});
		if (sessionResult.error) {
			throw new Error(
				`Failed to create session: ${JSON.stringify(sessionResult.error)}`,
			);
		}
		const sessionId = sessionResult.data.id;

		// 2. Cancellation infrastructure (P0.2: wire opts.signal + timeout)
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
		if (typeof timeoutId === "object" && "unref" in timeoutId)
			timeoutId.unref();

		// Combined signal: timeout + external cancellation
		const cancelSignals: AbortSignal[] = [timeoutController.signal];
		if (opts.signal) cancelSignals.push(opts.signal);
		const cancelSignal = AbortSignal.any(cancelSignals);

		// SSE controller: aborted on prompt completion OR on cancellation
		const sseController = new AbortController();
		const propagateCancel = () => sseController.abort();
		cancelSignal.addEventListener("abort", propagateCancel, { once: true });

		// 3. Start SSE event stream in background (P0.1: signal passed through)
		const streamPromise = writeEventsToLog(
			this.client,
			sessionId,
			opts.logPath,
			sseController.signal,
			{ quiet: opts.quiet },
		);

		try {
			// 4. Send prompt (P0.2: pass cancelSignal to prompt request)
			// Belt-and-suspenders: signal tears down the HTTP connection, but
			// Promise.race ensures deterministic timeout behavior regardless
			// of SDK signal handling quality.
			const promptPromise = this.client.session.prompt(
				{
					sessionID: sessionId,
					parts: [{ type: "text", text: opts.prompt }],
					format,
					...(modelObj && { model: modelObj }),
					...(opts.workdir && { directory: opts.workdir }),
				},
				{ signal: cancelSignal },
			);

			const cancelPromise = new Promise<never>((_, reject) => {
				if (cancelSignal.aborted) {
					reject(cancelSignal.reason ?? new Error("aborted"));
					return;
				}
				cancelSignal.addEventListener(
					"abort",
					() => reject(cancelSignal.reason ?? new Error("aborted")),
					{ once: true },
				);
			});

			const result = await Promise.race([promptPromise, cancelPromise]);
			clearTimeout(timeoutId);
			const duration = Date.now() - start;

			// 5. Check for errors
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

			// 6. Extract structured output
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

			// 7. Extract token/cost info (P1.1: use ?? to preserve cost=0)
			const tokensIn = info.tokens?.input;
			const tokensOut = info.tokens?.output;
			const costUsd = info.cost ?? undefined;

			// 8. Build and validate result
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
			clearTimeout(timeoutId);

			// On timeout or external cancel, abort the session
			const isTimeout = timeoutController.signal.aborted;
			const isExternalCancel = opts.signal?.aborted;

			if (isTimeout || isExternalCancel) {
				try {
					await this.client.session.abort({ sessionID: sessionId });
				} catch {
					// Ignore abort errors
				}
				if (isTimeout && !isExternalCancel) {
					throw new AgentTimeoutError(`Agent timed out after ${timeoutMs}ms`);
				}
				throw new Error("Agent invocation cancelled");
			}
			throw err;
		} finally {
			// 9. Stop SSE stream and flush log
			clearTimeout(timeoutId);
			sseController.abort();
			cancelSignal.removeEventListener("abort", propagateCancel);
			await streamPromise;
		}
	}
}
