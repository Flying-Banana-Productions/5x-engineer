/**
 * OpenCode SDK adapter — managed (local) mode only.
 *
 * Spawns a local OpenCode server, creates per-invocation sessions,
 * sends execution prompts, then structured summary prompts, streams SSE events
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
import { AgentCancellationError, AgentTimeoutError } from "./errors.js";

export { AgentCancellationError, AgentTimeoutError } from "./errors.js";

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

function resolveQuiet(quiet: InvokeOptions["quiet"] | undefined): boolean {
	if (typeof quiet === "function") return quiet();
	return quiet ?? false;
}

function traceInvoke(
	trace: InvokeOptions["trace"] | undefined,
	event: string,
	data?: unknown,
): void {
	try {
		trace?.(event, data);
	} catch {
		// Never break invocation on debug tracing errors.
	}
}

function buildStructuredSummaryPrompt(
	resultType: "status" | "verdict",
): string {
	if (resultType === "status") {
		return [
			"Summarize the current session outcome using the required JSON schema.",
			"Do not call tools. Base your answer only on work already completed in this session.",
			"If result is complete, include commit when known.",
			"If result is needs_human or failed, include a concise reason.",
		].join("\n");
	}

	return [
		"Summarize the current review outcome using the required JSON schema.",
		"Do not call tools. Base your answer only on evidence already gathered in this session.",
		"If readiness is not_ready or ready_with_corrections, include concrete items.",
	].join("\n");
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
	const ev = event as Record<string, unknown>;
	const type = typeof ev.type === "string" ? ev.type : undefined;

	// Access properties generically — event is a discriminated union
	const props = ev.properties as Record<string, unknown> | undefined;
	if (!props) return undefined;

	// Direct sessionID on properties (session.status, session.idle, message.part.delta, etc.)
	if (typeof props.sessionID === "string") return props.sessionID;
	if (typeof props.sessionId === "string") return props.sessionId;

	// Message events: properties.info.sessionID
	const info = props.info as Record<string, unknown> | undefined;
	if (info && typeof info.sessionID === "string") return info.sessionID;
	if (info && typeof info.sessionId === "string") return info.sessionId;

	// Session events: properties.info.id (Session objects use 'id', not 'sessionID').
	// Guard by event type so message IDs are never mistaken for session IDs.
	if (type?.startsWith("session.") && info && typeof info.id === "string") {
		return info.id;
	}

	// Part events: properties.part.sessionID
	const part = props.part as Record<string, unknown> | undefined;
	if (part && typeof part.sessionID === "string") return part.sessionID;
	if (part && typeof part.sessionId === "string") return part.sessionId;

	// Defensive fallback for unknown/wrapped event shapes.
	const deepSessionId = findSessionIdDeep(props);
	if (deepSessionId) return deepSessionId;

	return undefined;
}

function getStringProp(
	obj: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = obj?.[key];
	return typeof value === "string" ? value : undefined;
}

function getStringPropAny(
	obj: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = getStringProp(obj, key);
		if (value) return value;
	}
	return undefined;
}

function findSessionIdDeep(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): string | undefined {
	if (depth > 4 || value == null || typeof value !== "object") return undefined;
	if (seen.has(value)) return undefined;
	seen.add(value);

	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findSessionIdDeep(item, depth + 1, seen);
			if (found) return found;
		}
		return undefined;
	}

	const obj = value as Record<string, unknown>;
	const direct = getStringPropAny(obj, ["sessionID", "sessionId"]);
	if (direct) return direct;

	for (const nested of Object.values(obj)) {
		const found = findSessionIdDeep(nested, depth + 1, seen);
		if (found) return found;
	}

	return undefined;
}

function resolveSessionIdWithContext(
	event: OpenCodeEvent,
	ctx: {
		partToSession: Map<string, string>;
		messageToSession: Map<string, string>;
	},
): string | undefined {
	const direct = getEventSessionId(event);
	const ev = event as Record<string, unknown>;
	const type = ev.type as string | undefined;
	const props = ev.properties as Record<string, unknown> | undefined;
	const info = props?.info as Record<string, unknown> | undefined;
	const part = props?.part as Record<string, unknown> | undefined;

	if (direct) {
		const messageId =
			getStringProp(info, "id") ??
			getStringPropAny(part, ["messageID", "messageId"]);
		if (messageId) ctx.messageToSession.set(messageId, direct);

		const partId = getStringProp(part, "id");
		if (partId) ctx.partToSession.set(partId, direct);
		return direct;
	}

	if (type === "message.part.delta" && props) {
		const partId = getStringPropAny(props, ["partID", "partId"]);
		if (partId) {
			const fromPart = ctx.partToSession.get(partId);
			if (fromPart) return fromPart;
		}

		const messageId = getStringPropAny(props, ["messageID", "messageId"]);
		if (messageId) {
			const fromMessage = ctx.messageToSession.get(messageId);
			if (fromMessage) return fromMessage;
		}
	}

	if (type === "message.part.updated" && part) {
		const messageId = getStringPropAny(part, ["messageID", "messageId"]);
		if (messageId) {
			const fromMessage = ctx.messageToSession.get(messageId);
			if (fromMessage) {
				const partId = getStringProp(part, "id");
				if (partId) ctx.partToSession.set(partId, fromMessage);
				return fromMessage;
			}
		}
	}

	return undefined;
}

function isAbortLikeError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === "AbortError") return true;
	return err.message.toLowerCase().includes("aborted");
}

async function sleepWithSignal(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}

	if (signal.aborted)
		throw new AgentCancellationError("Agent invocation cancelled");

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();

		const onAbort = () => {
			clearTimeout(timer);
			reject(new AgentCancellationError("Agent invocation cancelled"));
		};

		signal.addEventListener("abort", onAbort, { once: true });
	});
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
	opts: {
		quiet?: InvokeOptions["quiet"];
		showReasoning?: boolean;
		directory?: string;
	},
	onActivity?: () => void,
	onTrace?: InvokeOptions["trace"],
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
	traceInvoke(onTrace, "sse.log.open", { logPath, sessionId });
	logStream.on("error", (err) => {
		traceInvoke(onTrace, "sse.log.error", { message: err.message });
		if (!resolveQuiet(opts.quiet)) {
			console.error(`Warning: log file write error: ${err.message}`);
		}
	});

	// Create StreamWriter lazily so quiet can flip mid-invocation.
	let writer: StreamWriter | undefined;
	const ensureWriter = () => {
		if (writer) return writer;
		writer = new StreamWriter({
			width: process.stdout.columns || 80,
		});
		return writer;
	};
	if (!resolveQuiet(opts.quiet)) {
		ensureWriter();
	}

	try {
		// P0.1: pass signal to subscribe so the SSE connection terminates on abort
		const subscribeParams = opts.directory
			? { directory: opts.directory }
			: undefined;
		traceInvoke(onTrace, "sse.subscribe.start", {
			sessionId,
			directory: opts.directory,
		});
		const { stream } = await client.event.subscribe(subscribeParams, {
			signal: abortSignal,
		});
		traceInvoke(onTrace, "sse.subscribe.ok", { sessionId });

		const countByType = new Map<string, number>();
		const acceptedByType = new Map<string, number>();
		const droppedNoSessionByType = new Map<string, number>();
		const droppedOtherSessionByType = new Map<string, number>();
		const bump = (map: Map<string, number>, key: string) => {
			map.set(key, (map.get(key) ?? 0) + 1);
		};
		const topCounts = (map: Map<string, number>) =>
			Array.from(map.entries())
				.sort((a, b) => b[1] - a[1])
				.slice(0, 8)
				.map(([type, count]) => ({ type, count }));

		const routerState = createEventRouterState();
		const eventCtx = {
			partToSession: new Map<string, string>(),
			messageToSession: new Map<string, string>(),
		};
		let totalEventCount = 0;
		let acceptedCount = 0;
		let droppedNoSessionCount = 0;
		let droppedOtherSessionCount = 0;

		for await (const event of stream) {
			if (abortSignal.aborted) break;
			totalEventCount += 1;
			const type = (event as { type?: string }).type ?? "unknown";
			bump(countByType, type);

			// P1.2: skip events without a session ID (no cross-session leakage)
			const eventSessionId = resolveSessionIdWithContext(event, eventCtx);
			if (!eventSessionId) {
				droppedNoSessionCount += 1;
				bump(droppedNoSessionByType, type);
				if (droppedNoSessionCount <= 5) {
					const ev = event as Record<string, unknown>;
					const props = ev.properties as Record<string, unknown> | undefined;
					traceInvoke(onTrace, "sse.drop.no_session", {
						totalEventCount,
						type,
						propertyKeys: props ? Object.keys(props).slice(0, 10) : [],
					});
				}
				continue;
			}

			// Filter for this session's events
			if (eventSessionId !== sessionId) {
				droppedOtherSessionCount += 1;
				bump(droppedOtherSessionByType, type);
				if (droppedOtherSessionCount <= 5) {
					traceInvoke(onTrace, "sse.drop.other_session", {
						totalEventCount,
						type,
						eventSessionId,
						sessionId,
					});
				}
				continue;
			}

			acceptedCount += 1;
			bump(acceptedByType, type);

			// Reset inactivity timeout only for this session's events.
			// Unrelated traffic must not mask a stalled invocation.
			onActivity?.();

			if (acceptedCount <= 20 || acceptedCount % 100 === 0) {
				traceInvoke(onTrace, "sse.event", {
					acceptedCount,
					totalEventCount,
					type,
				});
			}

			// Write to log file (NDJSON: one JSON object per line)
			const line = JSON.stringify(event);
			logStream.write(`${line}\n`);

			// Console output (quiet can toggle mid-invocation)
			if (!resolveQuiet(opts.quiet)) {
				const streamWriter = ensureWriter();
				routeEventToWriter(event, streamWriter, routerState, {
					showReasoning: opts.showReasoning,
				});
			}
		}
		traceInvoke(onTrace, "sse.stream.end", {
			totalEventCount,
			acceptedCount,
			droppedNoSessionCount,
			droppedOtherSessionCount,
			sessionId,
			acceptedTypes: topCounts(acceptedByType),
			droppedNoSessionTypes: topCounts(droppedNoSessionByType),
			droppedOtherSessionTypes: topCounts(droppedOtherSessionByType),
			totalTypes: topCounts(countByType),
		});
	} catch (err) {
		traceInvoke(onTrace, "sse.stream.error", {
			aborted: abortSignal.aborted,
			error: err instanceof Error ? err.message : String(err),
		});
		// Stream errors are expected on abort — suppress them
		if (!abortSignal.aborted && !resolveQuiet(opts.quiet)) {
			console.error(
				`Warning: SSE stream error: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} finally {
		writer?.destroy();
		await endStream(logStream);
		traceInvoke(onTrace, "sse.log.closed", { logPath, sessionId });
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

	private async waitForRecoveredPromptResult(
		sessionId: string,
		workdir: string | undefined,
		signal: AbortSignal | undefined,
		trace: InvokeOptions["trace"],
		recoverOpts?: { requireStructured?: boolean },
	): Promise<{
		data: { info: Record<string, unknown>; parts: Array<unknown> };
		error: undefined;
	}> {
		const requireStructured = recoverOpts?.requireStructured ?? true;
		let lastUnstructuredCompletedId: string | undefined;
		let repeatedUnstructuredCompletions = 0;
		let stalledPolls = 0;

		while (true) {
			if (signal?.aborted) {
				throw new AgentCancellationError("Agent invocation cancelled");
			}

			const messages = await this.client.session.messages(
				{
					sessionID: sessionId,
					...(workdir && { directory: workdir }),
					limit: 50,
				},
				signal ? { signal } : undefined,
			);

			if (!messages.error && Array.isArray(messages.data)) {
				const latestFirst = [...messages.data].reverse();
				let latestCompletedAssistant:
					| { info: Record<string, unknown>; parts: Array<unknown> }
					| undefined;
				let hasInFlightAssistant = false;

				for (const row of latestFirst) {
					const rowObj = row as Record<string, unknown>;
					const info = rowObj.info as Record<string, unknown> | undefined;
					if (!info || info.role !== "assistant") continue;

					const time = info.time as Record<string, unknown> | undefined;
					const completed = typeof time?.completed === "number";
					if (!completed) {
						hasInFlightAssistant = true;
						continue;
					}

					const structured = info.structured;
					if (!requireStructured) {
						traceInvoke(trace, "prompt.recover.completed_message", {
							sessionId,
							messageId:
								typeof info.id === "string" ? (info.id as string) : undefined,
						});
						return {
							data: {
								info,
								parts: Array.isArray(rowObj.parts)
									? (rowObj.parts as Array<unknown>)
									: [],
							},
							error: undefined,
						};
					}

					if (structured == null) {
						if (!latestCompletedAssistant) {
							latestCompletedAssistant = {
								info,
								parts: Array.isArray(rowObj.parts)
									? (rowObj.parts as Array<unknown>)
									: [],
							};
						}

						const infoError = info.error;
						if (
							infoError &&
							isStructuredOutputError({ error: infoError as unknown })
						) {
							traceInvoke(trace, "prompt.recover.structured_error", {
								sessionId,
								messageId:
									typeof info.id === "string" ? (info.id as string) : undefined,
							});
							return {
								data: {
									info,
									parts: Array.isArray(rowObj.parts)
										? (rowObj.parts as Array<unknown>)
										: [],
								},
								error: undefined,
							};
						}
						continue;
					}

					traceInvoke(trace, "prompt.recover.completed_message", {
						sessionId,
						messageId:
							typeof info.id === "string" ? (info.id as string) : undefined,
					});

					return {
						data: {
							info,
							parts: Array.isArray(rowObj.parts)
								? (rowObj.parts as Array<unknown>)
								: [],
						},
						error: undefined,
					};
				}

				if (!requireStructured && !hasInFlightAssistant) {
					stalledPolls += 1;
					if (stalledPolls >= 3) {
						throw new Error(
							"Agent did not return a completed assistant message while recovering prompt result.",
						);
					}
				} else if (latestCompletedAssistant && !hasInFlightAssistant) {
					const messageIdRaw = latestCompletedAssistant.info.id;
					const messageId =
						typeof messageIdRaw === "string" ? messageIdRaw : undefined;

					if (messageId && messageId === lastUnstructuredCompletedId) {
						repeatedUnstructuredCompletions += 1;
					} else {
						lastUnstructuredCompletedId = messageId;
						repeatedUnstructuredCompletions = 1;
					}

					if (repeatedUnstructuredCompletions >= 3) {
						throw new Error(
							"Agent did not return structured output — expected JSON schema response. This may indicate the model does not support structured output.",
						);
					}
					stalledPolls += 1;
				} else if (!hasInFlightAssistant) {
					stalledPolls += 1;
					if (stalledPolls >= 3) {
						throw new Error(
							"Agent did not return structured output — expected JSON schema response. This may indicate the model does not support structured output.",
						);
					}
				} else {
					lastUnstructuredCompletedId = undefined;
					repeatedUnstructuredCompletions = 0;
					stalledPolls = 0;
				}
			}

			await sleepWithSignal(500, signal);
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
		// Timeouts are opt-in only. If opts.timeout is omitted, invocation runs
		// until completion or explicit cancellation.
		const timeoutSeconds = opts.timeout;
		const timeoutMs =
			timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined;
		const model = opts.model ?? this.defaultModel;
		const modelObj = model ? parseModel(model) : undefined;
		const schema =
			resultType === "status" ? AuthorStatusSchema : ReviewerVerdictSchema;
		const summaryFormat: OutputFormat = {
			type: "json_schema",
			schema: schema as Record<string, unknown>,
			retryCount: 2,
		};

		const start = Date.now();
		traceInvoke(opts.trace, "invoke.start", {
			resultType,
			workdir: opts.workdir,
			model,
			logPath: opts.logPath,
			timeoutMs: timeoutMs ?? null,
		});

		// 1. Create session (P0.3: pass workdir as directory)
		// Phase 4: Use descriptive session title if provided, otherwise fallback to generic
		const sessionTitle = opts.sessionTitle ?? `5x-${resultType}-${Date.now()}`;
		traceInvoke(opts.trace, "session.create.start", {
			title: sessionTitle,
			directory: opts.workdir,
		});
		const sessionResult = await this.client.session.create({
			title: sessionTitle,
			...(opts.workdir && { directory: opts.workdir }),
		});
		if (sessionResult.error) {
			traceInvoke(opts.trace, "session.create.error", {
				error: JSON.stringify(sessionResult.error),
			});
			throw new Error(
				`Failed to create session: ${JSON.stringify(sessionResult.error)}`,
			);
		}
		const sessionId = sessionResult.data.id;
		traceInvoke(opts.trace, "session.create.ok", { sessionId });

		// Invoke onSessionCreated callback immediately so TUI can track the session
		// during streaming (not after the prompt completes).
		//
		// Important: do NOT await this callback. TUI/session-focus APIs are
		// best-effort and may block/hang transiently. Invocation must continue
		// even if callback work is slow or stuck.
		if (opts.onSessionCreated) {
			traceInvoke(opts.trace, "session.on_created.start", { sessionId });
			const onCallbackError = (err: unknown) => {
				traceInvoke(opts.trace, "session.on_created.error", {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
				if (!resolveQuiet(opts.quiet)) {
					console.warn(
						`Warning: onSessionCreated callback failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			};

			try {
				const callbackResult = opts.onSessionCreated(sessionId);
				if (
					callbackResult &&
					typeof (callbackResult as Promise<void>).then === "function"
				) {
					void (callbackResult as Promise<void>)
						.then(() => {
							traceInvoke(opts.trace, "session.on_created.ok", { sessionId });
						})
						.catch(onCallbackError);
				} else {
					traceInvoke(opts.trace, "session.on_created.ok", { sessionId });
				}
			} catch (err) {
				onCallbackError(err);
			}
		}

		// 2. Cancellation infrastructure (P0.2: wire opts.signal + timeout)
		// Inactivity timeout: resets whenever new SSE events are received
		const timeoutController =
			timeoutMs !== undefined ? new AbortController() : undefined;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const resetInactivityTimeout = () => {
			if (!timeoutController || timeoutMs === undefined) return;
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
		};
		if (timeoutController && timeoutMs !== undefined) {
			resetInactivityTimeout();
		}
		if (
			timeoutId !== undefined &&
			typeof timeoutId === "object" &&
			"unref" in timeoutId
		)
			timeoutId.unref();

		// Combined signal: timeout + external cancellation
		const cancelSignals: AbortSignal[] = [];
		if (timeoutController) cancelSignals.push(timeoutController.signal);
		if (opts.signal) cancelSignals.push(opts.signal);
		const cancelSignal =
			cancelSignals.length > 0 ? AbortSignal.any(cancelSignals) : undefined;

		// SSE controller: aborted on prompt completion OR on cancellation
		const sseController = new AbortController();
		const propagateCancel = () => sseController.abort();
		cancelSignal?.addEventListener("abort", propagateCancel, { once: true });

		// 3. Start SSE event stream in background (P0.1: signal passed through)
		// Pass resetInactivityTimeout to reset timeout on every event
		const streamPromise = writeEventsToLog(
			this.client,
			sessionId,
			opts.logPath,
			sseController.signal,
			{
				quiet: opts.quiet,
				showReasoning: opts.showReasoning,
				directory: opts.workdir,
			},
			resetInactivityTimeout,
			opts.trace,
		);

		try {
			const runPrompt = async ({
				phase,
				promptText,
				format,
				recoverRequireStructured,
			}: {
				phase: "prompt.execute" | "prompt.summary";
				promptText: string;
				format?: OutputFormat;
				recoverRequireStructured: boolean;
			}) => {
				const phaseStart = Date.now();
				traceInvoke(opts.trace, `${phase}.start`, {
					sessionId,
					resultType,
					directory: opts.workdir,
				});

				const promptPromise = this.client.session.prompt(
					{
						sessionID: sessionId,
						parts: [{ type: "text", text: promptText }],
						...(format && { format }),
						...(modelObj && { model: modelObj }),
						...(opts.workdir && { directory: opts.workdir }),
					},
					cancelSignal ? { signal: cancelSignal } : undefined,
				);

				let result: Awaited<typeof promptPromise> | undefined;

				try {
					result =
						cancelSignal !== undefined
							? await Promise.race([
									promptPromise,
									new Promise<never>((_, reject) => {
										if (cancelSignal.aborted) {
											reject(cancelSignal.reason ?? new Error("aborted"));
											return;
										}
										cancelSignal.addEventListener(
											"abort",
											() => reject(cancelSignal.reason ?? new Error("aborted")),
											{ once: true },
										);
									}),
								])
							: await promptPromise;
				} catch (err) {
					const isTimeout = timeoutController?.signal.aborted === true;
					const isExternalCancel = opts.signal?.aborted === true;

					if (!isTimeout && !isExternalCancel && isAbortLikeError(err)) {
						traceInvoke(opts.trace, `${phase}.recover.start`, {
							sessionId,
							error: err instanceof Error ? err.message : String(err),
						});
						result = (await this.waitForRecoveredPromptResult(
							sessionId,
							opts.workdir,
							opts.signal,
							opts.trace,
							{ requireStructured: recoverRequireStructured },
						)) as Awaited<typeof promptPromise>;
						traceInvoke(opts.trace, `${phase}.recover.done`, { sessionId });
					} else {
						throw err;
					}
				}

				if (!result) {
					throw new Error("Prompt result missing after recovery");
				}

				traceInvoke(opts.trace, `${phase}.done`, {
					sessionId,
					durationMs: Date.now() - phaseStart,
					hasError: Boolean(result.error),
				});

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

				return result;
			};

			await runPrompt({
				phase: "prompt.execute",
				promptText: opts.prompt,
				recoverRequireStructured: false,
			});

			const summaryResult = await runPrompt({
				phase: "prompt.summary",
				promptText: buildStructuredSummaryPrompt(resultType),
				format: summaryFormat,
				recoverRequireStructured: true,
			});

			if (timeoutId !== undefined) clearTimeout(timeoutId);
			const duration = Date.now() - start;

			let info = summaryResult.data.info;

			// 5. Extract structured output from summary prompt
			let structured = info.structured;
			if (structured == null) {
				if (info.error && isStructuredOutputError({ error: info.error })) {
					throw new Error(
						`Structured output validation failed after retries: ${JSON.stringify(info.error)}`,
					);
				}

				traceInvoke(opts.trace, "prompt.summary.recover.start", {
					sessionId,
					reason: "missing_structured_output",
				});

				const recovered = await this.waitForRecoveredPromptResult(
					sessionId,
					opts.workdir,
					opts.signal,
					opts.trace,
					{ requireStructured: true },
				);
				info = recovered.data.info as typeof info;
				structured = info.structured;

				traceInvoke(opts.trace, "prompt.summary.recover.done", {
					sessionId,
					reason: "missing_structured_output",
				});

				if (structured == null) {
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
			}

			// 6. Extract token/cost info from structured summary prompt
			const tokensIn = info.tokens?.input;
			const tokensOut = info.tokens?.output;
			const costUsd = info.cost ?? undefined;

			// 7. Build and validate result
			if (resultType === "status") {
				const status = structured as AuthorStatus;
				assertAuthorStatus(status, "invokeForStatus");
				traceInvoke(opts.trace, "invoke.result.status", {
					sessionId,
					statusResult: status.result,
					durationMs: duration,
				});
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
			traceInvoke(opts.trace, "invoke.result.verdict", {
				sessionId,
				readiness: verdict.readiness,
				durationMs: duration,
			});
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
			traceInvoke(opts.trace, "invoke.error", {
				sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
			if (timeoutId !== undefined) clearTimeout(timeoutId);

			// On timeout or external cancel, abort the session
			const isTimeout = timeoutController?.signal.aborted === true;
			const isExternalCancel = opts.signal?.aborted;

			if (isTimeout || isExternalCancel) {
				try {
					traceInvoke(opts.trace, "session.abort.start", {
						sessionId,
						isTimeout,
						isExternalCancel,
					});
					await this.client.session.abort({ sessionID: sessionId });
					traceInvoke(opts.trace, "session.abort.ok", { sessionId });
				} catch {
					traceInvoke(opts.trace, "session.abort.error", { sessionId });
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
			traceInvoke(opts.trace, "invoke.finally", { sessionId });
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			sseController.abort();
			cancelSignal?.removeEventListener("abort", propagateCancel);
			await streamPromise;
			traceInvoke(opts.trace, "invoke.end", { sessionId });
		}
	}
}
