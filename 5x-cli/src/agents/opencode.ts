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
import {
	createEventRouterState,
	routeEventToWriter,
} from "../utils/event-router.js";
import { endStream } from "../utils/stream.js";
import { StreamWriter } from "../utils/stream-writer.js";
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

export class AgentCancellationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentCancellationError";
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
	opts: { quiet?: boolean; showReasoning?: boolean },
	onActivity?: () => void,
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

	// Create StreamWriter for console output when not quiet
	let writer: StreamWriter | undefined;
	if (!opts.quiet) {
		writer = new StreamWriter({
			width: process.stdout.columns || 80,
		});
	}

	try {
		// P0.1: pass signal to subscribe so the SSE connection terminates on abort
		const { stream } = await client.event.subscribe(undefined, {
			signal: abortSignal,
		});

		const routerState = writer ? createEventRouterState() : undefined;

		for await (const event of stream) {
			if (abortSignal.aborted) break;

			// Reset inactivity timeout on every event received
			onActivity?.();

			// P1.2: skip events without a session ID (no cross-session leakage)
			const eventSessionId = getEventSessionId(event);
			if (!eventSessionId) continue;

			// Filter for this session's events
			if (eventSessionId !== sessionId) continue;

			// Write to log file (NDJSON: one JSON object per line)
			const line = JSON.stringify(event);
			logStream.write(`${line}\n`);

			// Console output (when not quiet)
			if (writer && routerState) {
				routeEventToWriter(event, writer, routerState, {
					showReasoning: opts.showReasoning,
				});
			}
		}
	} catch (err) {
		// Stream errors are expected on abort — suppress them
		if (!abortSignal.aborted && !opts.quiet) {
			console.error(
				`Warning: SSE stream error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} finally {
		writer?.destroy();
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
			const { client, server } = await createOpencode({
				hostname: "127.0.0.1",
				port: 0,
				timeout: 15_000,
			});
			return new OpenCodeAdapter(client, server, opts.model);
		} catch (err) {
			throw new Error(
				"OpenCode server failed to start — check that opencode is installed and on PATH. " +
					`Details: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * The URL of the running OpenCode server (e.g. "http://127.0.0.1:51234").
	 * Available after construction — the server is already listening.
	 */
	get serverUrl(): string {
		return this.server.url;
	}

	/**
	 * Expose the SDK client for TUI controller use (selectSession, showToast).
	 * @internal Used by command layer to pass to createTuiController().
	 */
	get _clientForTui(): OpencodeClient {
		return this.client;
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
		// Default timeout is 120 seconds (2 min). Callers can pass an explicit
		// opts.timeout (in seconds) to override. Configured via author.timeout /
		// reviewer.timeout in 5x.config.js (values in seconds).
		const timeoutSeconds = opts.timeout ?? 120;
		const timeoutMs = timeoutSeconds * 1000;
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
		// Phase 4: Use descriptive session title if provided, otherwise fallback to generic
		const sessionTitle = opts.sessionTitle ?? `5x-${resultType}-${Date.now()}`;
		const sessionResult = await this.client.session.create({
			title: sessionTitle,
			...(opts.workdir && { directory: opts.workdir }),
		});
		if (sessionResult.error) {
			throw new Error(
				`Failed to create session: ${JSON.stringify(sessionResult.error)}`,
			);
		}
		const sessionId = sessionResult.data.id;

		// Invoke onSessionCreated callback immediately so TUI can track the session
		// during streaming (not after the prompt completes).
		if (opts.onSessionCreated) {
			try {
				await opts.onSessionCreated(sessionId);
			} catch (err) {
				if (!opts.quiet) {
					console.warn(
						`Warning: onSessionCreated callback failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}

		// 2. Cancellation infrastructure (P0.2: wire opts.signal + timeout)
		// Inactivity timeout: resets whenever new SSE events are received
		const timeoutController = new AbortController();
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const resetInactivityTimeout = () => {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
		};
		resetInactivityTimeout();
		if (
			timeoutId !== undefined &&
			typeof timeoutId === "object" &&
			"unref" in timeoutId
		)
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
		// Pass resetInactivityTimeout to reset timeout on every event
		const streamPromise = writeEventsToLog(
			this.client,
			sessionId,
			opts.logPath,
			sseController.signal,
			{ quiet: opts.quiet, showReasoning: opts.showReasoning },
			resetInactivityTimeout,
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
			if (timeoutId !== undefined) clearTimeout(timeoutId);
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
			if (timeoutId !== undefined) clearTimeout(timeoutId);

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
				throw new AgentCancellationError("Agent invocation cancelled");
			}
			throw err;
		} finally {
			// 9. Stop SSE stream and flush log
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			sseController.abort();
			cancelSignal.removeEventListener("abort", propagateCancel);
			await streamPromise;
		}
	}
}
