/**
 * OpenCode provider — AgentProvider implementation over the OpenCode 2.x HTTP
 * client (`@opencode/client`, Promise root).
 *
 * Two modes:
 * - Managed: spawns a private `opencode serve` per provider instance, with a
 *   random password only this provider holds. It never starts, reuses, or
 *   restarts the operator's OpenCode background service.
 * - External: connects to an already-running server, authenticating with
 *   `OPENCODE_PASSWORD` (or `OPENCODE_SERVER_PASSWORD`) when set.
 *
 * In 2.x `session.prompt` only enqueues an inbox item, and a terminal
 * `session.execution.*` event names the session, not the prompt. Each turn
 * therefore owns exactly one prompt, identified by a caller-assigned
 * `msg_5x…` id: it settles only after that item was delivered, reads text and
 * usage only from its own transcript window, and fails closed (never with
 * success) on overlapping input or an unresolved prompt state. Cleanup acts
 * only on what the turn owns: it cancels its own inbox item by exact id, and
 * interrupts the session only on a managed provider's private server.
 */

import {
	ClientError,
	isSessionNotFoundError,
	isUnauthorizedError,
	OpenCode,
	type OpenCodeClient,
	type OpenCodeEvent,
	type SessionMessageInfo,
} from "@opencode/client";

import {
	createEventMapperState,
	eventSessionId,
	mapOpenCodeEvent,
} from "./event-mapper.js";
import {
	buildCorrectivePrompt,
	buildStructuredOutputPrompt,
	extractStructuredJson,
} from "./structured-output.js";
import type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	JSONSchema,
	ResumeOptions,
	RunOptions,
	RunResult,
	SessionOptions,
} from "./types.js";

// ---------------------------------------------------------------------------
// Error classes
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
// Constants
// ---------------------------------------------------------------------------

/**
 * Oldest OpenCode release on which both live provider cases (managed and
 * authenticated external) have passed.
 */
export const MIN_OPENCODE_VERSION = "2.4.2";

/** Headless session rules: allow everything, never ask interactive questions. */
export const HEADLESS_PERMISSIONS = [
	{ action: "*", resource: "*", effect: "allow" },
	{ action: "question", resource: "*", effect: "deny" },
] as const;

/** Event types the turn loop subscribes to. */
export const SUBSCRIBED_EVENT_TYPES = [
	"session.text.delta",
	"session.reasoning.delta",
	"session.tool.input.started",
	"session.tool.called",
	"session.tool.success",
	"session.tool.failed",
	"session.step.failed",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.inbox.enqueued",
	"session.inbox.delivered",
	"session.inbox.cancelled",
	"form.created",
	"permission.asked",
] as const;

const INSTALL_HINT = "check that opencode 2.x is installed and on PATH";
const PASSWORD_ERROR =
	"the OpenCode server requires a password — set OPENCODE_PASSWORD";

/** Timing bounds used by the provider. Overridable only through the internal test seam. */
export interface OpenCodeTimings {
	/** Wait for the `server.connected` marker after subscribing. */
	connectMs: number;
	/** Bound for each ordinary request (precheck, admission, polling reads). */
	requestMs: number;
	/** Bound for reconciling an indeterminate admission. */
	admissionMs: number;
	/** Polling interval while the stream is down, and window re-read interval. */
	pollMs: number;
	/** Bound for a polled `unknown` state, and for re-reading a window's end. */
	reconcileMs: number;
	/** Bound for each cleanup request. */
	cleanupRequestMs: number;
	/** Bound for all cleanup work. */
	cleanupTotalMs: number;
	/** Consecutive failed polls tolerated before the turn fails. */
	maxPollFailures: number;
}

export const DEFAULT_OPENCODE_TIMINGS: OpenCodeTimings = {
	connectMs: 5_000,
	requestMs: 10_000,
	admissionMs: 10_000,
	pollMs: 500,
	reconcileMs: 10_000,
	cleanupRequestMs: 5_000,
	cleanupTotalMs: 15_000,
	maxPollFailures: 3,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse the URL from accumulated `opencode serve` stdout. Only complete lines
 * are considered, so a URL split across chunks is not returned truncated.
 * Returns undefined until the listen line has been seen.
 */
export function parseServeListenUrl(stdout: string): string | undefined {
	const lastNewline = stdout.lastIndexOf("\n");
	if (lastNewline < 0) return undefined;
	const complete = stdout.slice(0, lastNewline + 1);
	const match = /listening on (https?:\/\/\S+)/i.exec(complete);
	return match?.[1];
}

/** Parse "provider/model" or "provider/model#variant". */
export function parseModel(model: string): {
	providerID: string;
	id: string;
	variant?: string;
} {
	const slashIdx = model.indexOf("/");
	const hashIdx = model.indexOf("#", slashIdx + 1);
	const id =
		slashIdx < 1
			? ""
			: model.slice(slashIdx + 1, hashIdx < 0 ? undefined : hashIdx);
	const variant = hashIdx < 0 ? undefined : model.slice(hashIdx + 1);
	if (slashIdx < 1 || id === "" || variant === "") {
		throw new Error(
			`Invalid model format "${model}" — expected "provider/model" or "provider/model#variant" (e.g. "anthropic/claude-sonnet-4-6")`,
		);
	}
	return {
		providerID: model.slice(0, slashIdx),
		id,
		...(variant !== undefined && { variant }),
	};
}

/** Parse major.minor.patch, ignoring any `v` prefix and prerelease/build suffix. */
export function parseOpenCodeVersion(
	version: string,
): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare two parsed versions: negative, zero, or positive. */
export function compareVersions(
	a: [number, number, number],
	b: [number, number, number],
): number {
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function oneXMessage(): string {
	return `5x 2.x requires OpenCode ≥ ${MIN_OPENCODE_VERSION} (found 1.x) — run \`opencode upgrade --major\``;
}

function outdatedMessage(found: string): string {
	return `5x 2.x requires OpenCode ≥ ${MIN_OPENCODE_VERSION} (found ${found}) — run \`opencode upgrade\``;
}

/**
 * Portable fallback for `AbortSignal.any()`.
 * Uses native `AbortSignal.any` when available, otherwise fans-in manually.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
	if (signals.length === 0) {
		return new AbortController().signal; // never-aborted signal
	}
	if (signals.length === 1) {
		// biome-ignore lint/style/noNonNullAssertion: length check guarantees element exists
		return signals[0]!;
	}
	if (typeof AbortSignal.any === "function") {
		return AbortSignal.any(signals);
	}
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			return controller.signal;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	}
	return controller.signal;
}

function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object" && "message" in err) {
		return String((err as { message: unknown }).message);
	}
	return String(err);
}

/** A declared (tagged) server error: the server definitively answered. */
function isDeclaredError(err: unknown): boolean {
	return (
		err !== null &&
		typeof err === "object" &&
		typeof (err as { _tag?: unknown })._tag === "string"
	);
}

class RequestTimeoutError extends Error {
	constructor(ms: number) {
		super(`OpenCode request timed out after ${ms}ms`);
		this.name = "RequestTimeoutError";
	}
}

/**
 * Run a request with its own bound. The request gets an abort signal that
 * fires at the bound (or when `extra` aborts), and the wait is also raced
 * against the bound so a request that ignores its signal is abandoned.
 * An `extra` abort rejects with `AgentCancellationError`.
 */
async function bounded<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	ms: number,
	extra?: AbortSignal,
): Promise<T> {
	if (extra?.aborted) {
		throw new AgentCancellationError("Agent invocation cancelled");
	}
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onExtra: (() => void) | undefined;
	try {
		return await Promise.race([
			fn(controller.signal),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new RequestTimeoutError(ms));
				}, ms);
				if (extra) {
					onExtra = () => {
						controller.abort();
						reject(new AgentCancellationError("Agent invocation cancelled"));
					};
					extra.addEventListener("abort", onExtra, { once: true });
				}
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onExtra) extra?.removeEventListener("abort", onExtra);
	}
}

/** Resolve with `promise`'s value, or `undefined` after `ms`; the timer is always cleared. */
async function withinMs<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Resolves on notify(), or after an optional timeout. */
class Notifier {
	private waiter: (() => void) | undefined;
	private pending = false;

	notify(): void {
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = undefined;
			waiter();
		} else {
			this.pending = true;
		}
	}

	wait(ms: number): Promise<void> {
		if (this.pending) {
			this.pending = false;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const timer = setTimeout(
				() => {
					if (this.waiter === done) this.waiter = undefined;
					resolve();
				},
				Math.max(0, ms),
			);
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			this.waiter = done;
		});
	}
}

/** Reads a subscription into a queue so the turn loop can mix it with timers. */
class EventPump {
	readonly queue: OpenCodeEvent[] = [];
	connected = false;
	ended = false;

	constructor(
		iterable: AsyncIterable<OpenCodeEvent>,
		private readonly notifier: Notifier,
	) {
		void this.run(iterable);
	}

	private async run(iterable: AsyncIterable<OpenCodeEvent>): Promise<void> {
		try {
			for await (const event of iterable) {
				if ((event as { type?: unknown }).type === "server.connected") {
					this.connected = true;
				} else {
					this.queue.push(event);
				}
				this.notifier.notify();
			}
		} catch {
			// A stream error is handled as the stream ending: the turn polls.
		} finally {
			this.ended = true;
			this.notifier.notify();
		}
	}
}

// ---------------------------------------------------------------------------
// Managed server
// ---------------------------------------------------------------------------

/** The subset of a Bun subprocess the managed server uses. */
export interface ManagedChildProcess {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

export interface ManagedSpawnOptions {
	stdin: "ignore";
	stdout: "pipe";
	stderr: "pipe";
	env: Record<string, string | undefined>;
}

export type SpawnFn = (
	cmd: string[],
	opts: ManagedSpawnOptions,
) => ManagedChildProcess;

export interface ManagedServer {
	readonly url: string;
	readonly password: string;
	/** Bounded tail of the server's stderr. */
	stderrTail(): string;
	close(): Promise<void>;
}

const STDERR_TAIL_LIMIT = 8 * 1024;
const STDOUT_SCAN_LIMIT = 64 * 1024;

const defaultSpawn: SpawnFn = (cmd, opts) =>
	Bun.spawn(cmd, opts) as unknown as ManagedChildProcess;

async function drain(
	stream: ReadableStream<Uint8Array>,
	onText: (text: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			onText(decoder.decode(value, { stream: true }));
		}
	} catch {
		// Pipe closed — nothing left to read.
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// ignore
		}
	}
}

/**
 * Spawn a private `opencode serve` and wait for its listen line.
 * stdout and stderr are drained for the life of the process.
 */
export async function startManagedServer(opts?: {
	spawn?: SpawnFn;
	startupTimeoutMs?: number;
	closeTimeoutMs?: number;
}): Promise<ManagedServer> {
	const spawn = opts?.spawn ?? defaultSpawn;
	const startupTimeoutMs = opts?.startupTimeoutMs ?? 15_000;
	const closeTimeoutMs = opts?.closeTimeoutMs ?? 5_000;
	const password = crypto.randomUUID();

	let child: ManagedChildProcess;
	try {
		child = spawn(["opencode", "serve", "--hostname=127.0.0.1", "--port=0"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OPENCODE_PASSWORD: password },
		});
	} catch (err) {
		throw new Error(
			`OpenCode server failed to start — ${INSTALL_HINT}. Details: ${errorText(err)}`,
		);
	}

	let stderr = "";
	let stdout = "";
	let url: string | undefined;
	let exited = false;
	let onReady: (() => void) | undefined;

	void drain(child.stderr, (text) => {
		stderr = (stderr + text).slice(-STDERR_TAIL_LIMIT);
	});
	void drain(child.stdout, (text) => {
		if (url !== undefined) return;
		stdout = (stdout + text).slice(-STDOUT_SCAN_LIMIT);
		url = parseServeListenUrl(stdout);
		if (url !== undefined) {
			stdout = "";
			onReady?.();
		}
	});
	const exitPromise = child.exited.then(
		(code) => {
			exited = true;
			return code;
		},
		() => {
			exited = true;
			return -1;
		},
	);

	let startupTimer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await new Promise<"ready" | "exited" | "timeout">(
		(resolve) => {
			if (url !== undefined) return resolve("ready");
			onReady = () => resolve("ready");
			void exitPromise.then(() => {
				// Give the stdout drain a chance to deliver a final listen line.
				setTimeout(() => resolve(url !== undefined ? "ready" : "exited"), 20);
			});
			startupTimer = setTimeout(() => resolve("timeout"), startupTimeoutMs);
		},
	);
	clearTimeout(startupTimer);

	if (outcome !== "ready" || url === undefined) {
		if (outcome === "timeout") {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
			await withinMs(exitPromise, closeTimeoutMs);
			throw new Error(
				`Timeout waiting for OpenCode server to start after ${startupTimeoutMs}ms — ${INSTALL_HINT}.` +
					(stderr.trim() ? ` stderr: ${stderr.trim()}` : ""),
			);
		}
		const code = await exitPromise;
		throw new Error(
			`OpenCode server exited before listening (exit code ${code}) — ${INSTALL_HINT}.` +
				(stderr.trim() ? ` stderr: ${stderr.trim()}` : ""),
		);
	}

	const serverUrl = url;
	let closing: Promise<void> | undefined;
	return {
		url: serverUrl,
		password,
		stderrTail: () => stderr,
		close: () => {
			closing ??= (async () => {
				if (exited) return;
				try {
					child.kill("SIGTERM");
				} catch {
					return;
				}
				const code = await withinMs(exitPromise, closeTimeoutMs);
				if (code === undefined) {
					try {
						child.kill("SIGKILL");
					} catch {
						// already gone
					}
					await withinMs(exitPromise, closeTimeoutMs);
				}
			})();
			return closing;
		},
	};
}

function basicAuth(password: string): string {
	return `Basic ${btoa(`opencode:${password}`)}`;
}

// ---------------------------------------------------------------------------
// Structured summary prompt
// ---------------------------------------------------------------------------

function buildStructuredSummaryPrompt(schema: JSONSchema): string {
	// Detect if this is a status or verdict schema from the presence of key fields
	const props = schema.properties as Record<string, unknown> | undefined;
	const isStatus = props && "result" in props && "commit" in props;

	if (isStatus) {
		return [
			"Do not call any other tools. Base your answer only on work already completed in this session.",
			"If result is complete, you MUST include the commit hash.",
			"If result is needs_human or failed, include a concise reason.",
		].join("\n");
	}

	return [
		"Summarize the current review outcome using the required JSON schema.",
		"Do not call tools. Base your answer only on evidence already gathered in this session.",
		"If readiness is not_ready or ready_with_corrections, include concrete items.",
	].join("\n");
}

/** Corrective turns allowed after the first structured summary turn. */
const MAX_CORRECTIVE_TURNS = 2;

// ---------------------------------------------------------------------------
// Turn types
// ---------------------------------------------------------------------------

type TurnState = "admitting" | "pending" | "delivered" | "unknown" | "removed";

interface TurnOutcome {
	outcome: "succeeded" | "failed" | "interrupted";
	error?: string;
	reason?: string;
}

interface TurnUsage {
	tokens: { in: number; out: number };
	costUsd: number | undefined;
}

interface TurnResult extends TurnUsage {
	text: string;
}

interface TurnOptions {
	stream: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}

type LocalCause = "timeout" | "cancel" | "overlap" | "admission";

/** Shared context a session needs from its provider. */
interface ProviderContext {
	readonly client: OpenCodeClient;
	/** True only for a provider that spawned its own private server. */
	readonly exclusive: boolean;
	/** Sessions with a turn in progress on this provider. */
	readonly inFlight: Set<string>;
	readonly timings: OpenCodeTimings;
}

/** Map from a yielded error event to the typed error behind it, for run(). */
const errorCauses = new WeakMap<AgentEvent, unknown>();

// ---------------------------------------------------------------------------
// OpenCode Session
// ---------------------------------------------------------------------------

class OpenCodeSession implements AgentSession {
	readonly id: string;
	/** The session's working directory (its OpenCode location). */
	readonly directory: string | undefined;

	constructor(
		private readonly ctx: ProviderContext,
		sessionId: string,
		directory: string | undefined,
	) {
		this.id = sessionId;
		this.directory = directory;
	}

	async run(prompt: string, opts?: RunOptions): Promise<RunResult> {
		let result: RunResult | undefined;
		let firstError: AgentEvent | undefined;
		let lastCause: unknown;
		for await (const event of this.runStreamed(prompt, opts)) {
			if (event.type === "done") result = event.result;
			else if (event.type === "error") {
				firstError ??= event;
				if (errorCauses.has(event)) lastCause = errorCauses.get(event);
			}
		}
		if (lastCause !== undefined) throw lastCause;
		if (firstError?.type === "error") throw new Error(firstError.message);
		if (!result) throw new Error("OpenCode run ended without a result");
		return result;
	}

	async *runStreamed(
		prompt: string,
		opts?: RunOptions,
	): AsyncIterable<AgentEvent> {
		const start = Date.now();
		const timeoutMs =
			opts?.timeout !== undefined ? opts.timeout * 1000 : undefined;
		const turnOpts = { signal: opts?.signal, timeoutMs };

		try {
			const execute = yield* this.runTurn(prompt, {
				...turnOpts,
				stream: true,
			});
			const usages: TurnUsage[] = [execute];
			let structured: unknown;

			if (opts?.outputSchema) {
				const schema = opts.outputSchema;
				let summaryPrompt = buildStructuredOutputPrompt(
					buildStructuredSummaryPrompt(schema),
					schema,
				);
				let found = false;
				for (let attempt = 0; attempt <= MAX_CORRECTIVE_TURNS; attempt++) {
					const summary = yield* this.runTurn(summaryPrompt, {
						...turnOpts,
						stream: false,
					});
					usages.push(summary);
					const extracted = extractStructuredJson(summary.text);
					if (extracted.ok) {
						structured = extracted.value;
						found = true;
						break;
					}
					summaryPrompt = buildCorrectivePrompt(schema);
				}
				if (!found) {
					throw new Error(
						"Agent did not return structured output — expected JSON schema response.",
					);
				}
			}

			const tokens = {
				in: usages.reduce((sum, u) => sum + u.tokens.in, 0),
				out: usages.reduce((sum, u) => sum + u.tokens.out, 0),
			};
			const costUsd = usages.every((u) => u.costUsd !== undefined)
				? usages.reduce((sum, u) => sum + (u.costUsd ?? 0), 0)
				: undefined;

			const result: RunResult = {
				text: execute.text,
				structured,
				sessionId: this.id,
				tokens,
				costUsd,
				durationMs: Date.now() - start,
			};
			yield { type: "usage", tokens, costUsd };
			yield { type: "done", result };
		} catch (err) {
			const event: AgentEvent = { type: "error", message: errorText(err) };
			errorCauses.set(event, err);
			yield event;
		}
	}

	// -----------------------------------------------------------------------
	// Turn loop
	// -----------------------------------------------------------------------

	private busyError(): Error {
		return new Error(
			`OpenCode session ${this.id} is busy (running or has queued input); 5x cannot attribute a turn on it`,
		);
	}

	private overlapMessage(): string {
		return `OpenCode session ${this.id} received other input during this turn; the result is ambiguous`;
	}

	/**
	 * Run one turn that owns exactly one prompt. Yields mapped content events
	 * when `stream` is set, and returns the turn window's text and usage.
	 */
	private async *runTurn(
		text: string,
		opts: TurnOptions,
	): AsyncGenerator<AgentEvent, TurnResult> {
		const { client, timings } = this.ctx;
		const sid = this.id;
		const callerSignal = opts.signal;

		// 1. Pre-aborted short-circuit: no request of any kind.
		if (callerSignal?.aborted) {
			throw new AgentCancellationError("Agent invocation cancelled");
		}
		// In-process guard: one provider never drives two turns on one session.
		if (this.ctx.inFlight.has(sid)) throw this.busyError();
		this.ctx.inFlight.add(sid);

		const notifier = new Notifier();
		const streamAbort = new AbortController();
		const onCallerAbort = () => notifier.notify();
		callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

		try {
			// 2. Subscribe before prompting: the 2.x stream has no replay.
			const iterable = client.event.subscribe({
				types: [...SUBSCRIBED_EVENT_TYPES],
				signal: streamAbort.signal,
			}) as AsyncIterable<OpenCodeEvent>;
			const pump = new EventPump(iterable, notifier);
			const connectDeadline = Date.now() + timings.connectMs;
			while (!pump.connected) {
				if (callerSignal?.aborted) {
					throw new AgentCancellationError("Agent invocation cancelled");
				}
				if (pump.ended) {
					throw new Error(
						`OpenCode event stream closed before connecting (session ${sid})`,
					);
				}
				const remaining = connectDeadline - Date.now();
				if (remaining <= 0) {
					throw new Error(
						`OpenCode event stream did not connect within ${timings.connectMs}ms (session ${sid})`,
					);
				}
				await notifier.wait(remaining);
			}

			// 3. Ownership precheck (a snapshot, not a lock).
			const active = await bounded(
				(signal) => client.session.active({ signal }),
				timings.requestMs,
				callerSignal,
			);
			if (active && Object.hasOwn(active, sid)) throw this.busyError();
			const inbox = await bounded(
				(signal) => client.session.inbox.list({ sessionID: sid }, { signal }),
				timings.requestMs,
				callerSignal,
			);
			if (inbox.length > 0) throw this.busyError();
			const tailEntries = await bounded(
				(signal) => client.session.context({ sessionID: sid }, { signal }),
				timings.requestMs,
				callerSignal,
			);
			const tailId = tailEntries.at(-1)?.id;

			// 4..7. Admission, ownership tracking, settlement.
			const turn = new TurnRun(this.ctx, sid, text, opts, notifier, pump, {
				tailId,
			});
			const outcome = yield* turn.drive();

			// 8..9. Read the turn window (text and usage).
			return await this.readTurnWindow(turn.requestId, outcome, callerSignal);
		} finally {
			streamAbort.abort();
			callerSignal?.removeEventListener("abort", onCallerAbort);
			this.ctx.inFlight.delete(sid);
		}
	}

	/**
	 * Read the entries after `promptId` up to and including its closing `idle`
	 * entry, and return their text and usage. Re-reads until the closing entry
	 * is readable, within the reconciliation bound.
	 */
	private async readTurnWindow(
		promptId: string,
		_outcome: TurnOutcome,
		signal: AbortSignal | undefined,
	): Promise<TurnResult> {
		const { timings } = this.ctx;
		const deadline = Date.now() + timings.reconcileMs;
		while (true) {
			const scan = await scanTranscript(this.ctx, this.id, promptId, {
				signal,
			});
			if (!scan.found) {
				throw new Error(
					`OpenCode turn reply not found: prompt ${promptId} is missing from session ${this.id}`,
				);
			}
			if (scan.foreignUserInWindow) throw new Error(this.overlapMessage());
			if (scan.idle) {
				return windowResult(scan.window, promptId, this.id);
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`OpenCode turn window for prompt ${promptId} on session ${this.id} has no end`,
				);
			}
			await sleepUnlessAborted(timings.pollMs, signal);
		}
	}
}

async function sleepUnlessAborted(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (signal?.aborted) {
		throw new AgentCancellationError("Agent invocation cancelled");
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new AgentCancellationError("Agent invocation cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

type Entry = SessionMessageInfo & { id: string; type: string };

interface TranscriptScan {
	found: boolean;
	/** Entries after the prompt, through its first `idle` entry if present. */
	window: Entry[];
	/** The window's closing `idle` entry. */
	idle?: Entry & { outcome?: string; error?: { message?: string } };
	/** A `user` entry other than the prompt inside the window. */
	foreignUserInWindow: boolean;
	/** A `user` entry other than the prompt between the recorded tail and the prompt. */
	foreignUserBefore: boolean;
	/** Signature of the readable transcript, for progress detection. */
	signature: string;
}

const MESSAGE_PAGE_LIMIT = 100;

async function readAllMessages(
	ctx: ProviderContext,
	sessionID: string,
	signal: AbortSignal | undefined,
): Promise<Entry[]> {
	const entries: Entry[] = [];
	let cursor: string | undefined;
	const seenCursors = new Set<string>();
	while (true) {
		const page = await bounded(
			(s) =>
				ctx.client.message.list(
					{
						sessionID,
						order: "asc",
						limit: MESSAGE_PAGE_LIMIT,
						...(cursor !== undefined && { cursor }),
					},
					{ signal: s },
				),
			ctx.timings.requestMs,
			signal,
		);
		entries.push(...(page.data as Entry[]));
		const next = page.cursor?.next ?? undefined;
		if (!next || page.data.length === 0 || seenCursors.has(next)) break;
		seenCursors.add(next);
		cursor = next;
	}
	return entries;
}

/**
 * Locate `promptId` in the transcript: the `session.context` fast path, then
 * the durable paginated `session.message.list` when compaction has removed
 * it (or the recorded tail) from context.
 */
async function scanTranscript(
	ctx: ProviderContext,
	sessionID: string,
	promptId: string,
	opts: { signal?: AbortSignal; tailId?: string },
): Promise<TranscriptScan> {
	const context = (await bounded(
		(s) => ctx.client.session.context({ sessionID }, { signal: s }),
		ctx.timings.requestMs,
		opts.signal,
	)) as Entry[];

	let entries = context;
	let promptIdx = entries.findIndex((e) => e.id === promptId);
	if (promptIdx < 0) {
		// Context is complete since the tail only if it still holds the tail
		// (or, with no tail, holds no compaction). Otherwise read durably.
		const contextComplete =
			opts.tailId !== undefined
				? context.some((e) => e.id === opts.tailId)
				: !context.some((e) => e.type === "compaction");
		if (!contextComplete || opts.tailId === undefined) {
			const all = await readAllMessages(ctx, sessionID, opts.signal);
			const idx = all.findIndex((e) => e.id === promptId);
			if (idx >= 0 || !contextComplete) {
				entries = all;
				promptIdx = idx;
			}
		}
	}

	const last = entries.at(-1);
	const signature = `${entries.length}:${last?.id ?? ""}:${last ? JSON.stringify(last).length : 0}`;

	if (promptIdx < 0) {
		return {
			found: false,
			window: [],
			foreignUserInWindow: false,
			foreignUserBefore: false,
			signature,
		};
	}

	const tailIdx =
		opts.tailId !== undefined
			? entries.findIndex((e) => e.id === opts.tailId)
			: -1;
	let foreignUserBefore = false;
	for (let i = Math.max(tailIdx + 1, 0); i < promptIdx; i++) {
		if (entries[i]?.type === "user") foreignUserBefore = true;
	}

	const window: Entry[] = [];
	let idle: TranscriptScan["idle"];
	let foreignUserInWindow = false;
	for (let i = promptIdx + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		window.push(entry);
		if (entry.type === "user") foreignUserInWindow = true;
		if (entry.type === "idle") {
			idle = entry as TranscriptScan["idle"];
			break;
		}
	}
	return {
		found: true,
		window,
		idle,
		foreignUserInWindow,
		foreignUserBefore,
		signature,
	};
}

/** Text and usage from a closed turn window; usage attribution fails closed. */
function windowResult(
	window: Entry[],
	promptId: string,
	sessionID: string,
): TurnResult {
	const texts: string[] = [];
	let tokensIn = 0;
	let tokensOut = 0;
	let cost = 0;
	let costKnown = true;

	for (const raw of window) {
		const entry = raw as Record<string, unknown>;
		const isAssistant = entry.type === "assistant";
		const isCompaction =
			entry.type === "compaction" &&
			(entry.status === "completed" || entry.status === "failed");
		if (!isAssistant && !isCompaction) continue;

		if (isAssistant && Array.isArray(entry.content)) {
			for (const item of entry.content as Array<Record<string, unknown>>) {
				if (item?.type === "text" && typeof item.text === "string") {
					if (item.text.length > 0) texts.push(item.text);
				}
			}
		}

		const tokens = entry.tokens as
			| { input?: unknown; output?: unknown }
			| undefined;
		if (
			!tokens ||
			typeof tokens.input !== "number" ||
			typeof tokens.output !== "number"
		) {
			throw new Error(
				`OpenCode usage for prompt ${promptId} on session ${sessionID} cannot be attributed to its turn`,
			);
		}
		tokensIn += tokens.input;
		tokensOut += tokens.output;
		if (typeof entry.cost === "number") cost += entry.cost;
		else costKnown = false;
	}

	return {
		text: texts.join("\n"),
		tokens: { in: tokensIn, out: tokensOut },
		costUsd: costKnown ? cost : undefined,
	};
}

// ---------------------------------------------------------------------------
// One turn's admission, ownership, settlement, and owned cleanup
// ---------------------------------------------------------------------------

class TurnRun {
	readonly requestId = `msg_5x${crypto.randomUUID().replace(/-/g, "")}`;

	private state: TurnState = "admitting";
	private overlap = false;
	private cancelRequested = false;
	/** Another item was delivered after ours: stop mapping content. */
	private contentClosed = false;
	private mode: "stream" | "poll" = "stream";
	private lastProgress = Date.now();
	private unknownSince: number | undefined;
	private pollFailures = 0;
	private lastSignature: string | undefined;
	private nextPollAt = 0;
	private admitReply: "waiting" | "ok" | "indeterminate" = "waiting";
	private admitError: unknown;
	private admitDeadline: number | undefined;
	private terminal: TurnOutcome | undefined;
	private readonly mapperState = createEventMapperState();
	private readonly localAbort = new AbortController();

	constructor(
		private readonly ctx: ProviderContext,
		private readonly sid: string,
		private readonly text: string,
		private readonly opts: TurnOptions,
		private readonly notifier: Notifier,
		private readonly pump: EventPump,
		private readonly anchors: { tailId: string | undefined },
	) {}

	private get timings(): OpenCodeTimings {
		return this.ctx.timings;
	}

	/** Drive the turn to its terminal outcome, yielding mapped content events. */
	async *drive(): AsyncGenerator<AgentEvent, TurnOutcome> {
		this.admit();

		while (true) {
			// Caller cancellation wins over anything else observed.
			if (this.opts.signal?.aborted) {
				return await this.failWithCleanup("cancel");
			}

			// Streamed events, in order.
			while (this.pump.queue.length > 0) {
				const event = this.pump.queue.shift();
				if (!event) break;
				const mapped = this.onStreamEvent(event);
				if (mapped && this.opts.stream) yield mapped;
				if (this.terminal) break;
			}

			if (this.state === "removed" && !this.cancelRequested) {
				throw new Error(
					`OpenCode prompt ${this.requestId} was cancelled by another client`,
				);
			}
			if (
				this.overlap &&
				(this.state === "admitting" || this.state === "pending")
			) {
				return await this.failWithCleanup("overlap");
			}
			if (this.terminal) return this.settleTurn(this.terminal);

			if (
				this.opts.timeoutMs !== undefined &&
				Date.now() - this.lastProgress >= this.opts.timeoutMs
			) {
				return await this.failWithCleanup("timeout");
			}

			// Admission reply.
			if (this.admitReply === "ok" && this.state === "admitting") {
				this.state = "pending";
			}
			if (this.admitError !== undefined && this.state === "admitting") {
				throw new Error(
					`OpenCode rejected the prompt on session ${this.sid}: ${errorText(this.admitError)}`,
				);
			}
			if (
				this.admitReply === "indeterminate" &&
				this.state === "admitting" &&
				this.admitDeadline !== undefined &&
				Date.now() >= this.admitDeadline
			) {
				return await this.failWithCleanup("admission");
			}

			if (this.pump.ended && this.mode === "stream") {
				this.mode = "poll";
				this.nextPollAt = 0;
			}

			// Polled settlement on durable evidence.
			const needsPoll =
				this.mode === "poll" ||
				(this.admitReply === "indeterminate" && this.state === "admitting");
			if (needsPoll && Date.now() >= this.nextPollAt) {
				await this.poll();
				this.nextPollAt = Date.now() + this.timings.pollMs;
				if (this.state === "removed" && !this.cancelRequested) {
					throw new Error(
						`OpenCode prompt ${this.requestId} was cancelled by another client`,
					);
				}
				if (
					this.overlap &&
					(this.state === "admitting" || this.state === "pending")
				) {
					return await this.failWithCleanup("overlap");
				}
				if (this.terminal) return this.settleTurn(this.terminal);
				if (
					this.state === "unknown" &&
					this.unknownSince !== undefined &&
					Date.now() - this.unknownSince >= this.timings.reconcileMs
				) {
					throw new Error(
						`OpenCode prompt ${this.requestId} left the inbox of session ${this.sid} but is not in its transcript; its outcome is unknown`,
					);
				}
			}

			await this.notifier.wait(this.nextWakeDelay(needsPoll));
		}
	}

	private nextWakeDelay(polling: boolean): number {
		const now = Date.now();
		const candidates: number[] = [this.timings.pollMs];
		if (polling) candidates.push(this.nextPollAt - now);
		if (this.opts.timeoutMs !== undefined) {
			candidates.push(this.lastProgress + this.opts.timeoutMs - now);
		}
		if (this.admitDeadline !== undefined) {
			candidates.push(this.admitDeadline - now);
		}
		return Math.max(0, Math.min(...candidates));
	}

	/** 4. Send `session.prompt` once with a stable id; never resend. */
	private admit(): void {
		const { client } = this.ctx;
		const requestMs = this.timings.requestMs;
		void bounded(
			(signal) =>
				client.session.prompt(
					{
						sessionID: this.sid,
						id: this.requestId,
						text: this.text,
						delivery: "queue",
					},
					{ signal },
				),
			requestMs,
			this.localAbort.signal,
		).then(
			() => {
				this.admitReply = "ok";
				this.notifier.notify();
			},
			(err) => {
				if (isDeclaredError(err)) {
					// The server answered: the prompt was rejected, not lost.
					this.admitError = err;
				} else {
					this.admitReply = "indeterminate";
					this.admitDeadline = Date.now() + this.timings.admissionMs;
				}
				this.notifier.notify();
			},
		);
	}

	/** 5. Streamed ownership tracking. Returns a mapped content event, if any. */
	private onStreamEvent(event: OpenCodeEvent): AgentEvent | undefined {
		if (eventSessionId(event) !== this.sid) return undefined;
		this.lastProgress = Date.now();

		const ev = event as { type: string; data?: Record<string, unknown> };
		const data = ev.data ?? {};
		const inboxID = typeof data.inboxID === "string" ? data.inboxID : undefined;

		switch (ev.type) {
			case "session.inbox.enqueued":
				if (inboxID === this.requestId) {
					if (this.state === "admitting" || this.state === "unknown") {
						this.state = "pending";
					}
				} else {
					this.overlap = true;
				}
				return undefined;
			case "session.inbox.delivered":
				if (inboxID === this.requestId) {
					if (this.state !== "removed") this.state = "delivered";
				} else {
					this.overlap = true;
					if (this.state === "delivered") this.contentClosed = true;
				}
				return undefined;
			case "session.inbox.cancelled":
				if (inboxID === this.requestId) this.state = "removed";
				return undefined;
			case "session.execution.succeeded":
			case "session.execution.failed":
			case "session.execution.interrupted": {
				if (this.state !== "delivered") {
					// An earlier or foreign execution's end: never ours.
					this.overlap = true;
					return undefined;
				}
				const outcome = ev.type.slice("session.execution.".length) as
					| "succeeded"
					| "failed"
					| "interrupted";
				const error = data.error as { message?: unknown } | undefined;
				this.terminal = {
					outcome,
					...(typeof error?.message === "string" && { error: error.message }),
					...(typeof data.reason === "string" && { reason: data.reason }),
				};
				return undefined;
			}
			case "permission.asked":
				return {
					type: "error",
					message: `OpenCode asked for permission (${String(data.action ?? "unknown")}) in a headless session`,
				};
			default:
				if (this.state !== "delivered" || this.contentClosed) return undefined;
				return mapOpenCodeEvent(event, this.mapperState);
		}
	}

	/** 6. One poll: inbox before transcript until delivered, then transcript only. */
	private async poll(): Promise<void> {
		const { client } = this.ctx;
		const signal = this.opts.signal;
		try {
			let inInbox = false;
			let inboxSignature = "";
			if (this.state !== "delivered") {
				const inbox = await bounded(
					(s) =>
						client.session.inbox.list({ sessionID: this.sid }, { signal: s }),
					this.timings.requestMs,
					signal,
				);
				inboxSignature = inbox.map((item) => item.id).join(",");
				for (const item of inbox) {
					if (item.id === this.requestId) inInbox = true;
					else this.overlap = true;
				}
			}

			const scan = await scanTranscript(this.ctx, this.sid, this.requestId, {
				signal,
				tailId: this.anchors.tailId,
			});
			this.pollFailures = 0;

			const signature = `${inboxSignature}|${scan.signature}`;
			if (
				this.lastSignature !== undefined &&
				signature !== this.lastSignature
			) {
				this.lastProgress = Date.now();
			}
			this.lastSignature = signature;

			if (scan.found) {
				// Delivered outranks every other observation.
				if (this.state !== "removed") this.state = "delivered";
				this.unknownSince = undefined;
				if (scan.foreignUserBefore || scan.foreignUserInWindow) {
					this.overlap = true;
				}
				if (scan.idle) {
					const outcome = scan.idle.outcome as TurnOutcome["outcome"];
					this.terminal = {
						outcome,
						...(typeof scan.idle.error?.message === "string" && {
							error: scan.idle.error.message,
						}),
					};
				}
				return;
			}

			if (inInbox) {
				if (this.state === "admitting" || this.state === "unknown") {
					this.state = "pending";
				}
				this.unknownSince = undefined;
				return;
			}

			// In neither: unknown, never removal. Delivery can land between reads.
			if (this.state === "pending" || this.state === "unknown") {
				if (this.state !== "unknown") this.state = "unknown";
				this.unknownSince ??= Date.now();
			}
		} catch (err) {
			if (err instanceof AgentCancellationError) return;
			this.pollFailures++;
			if (this.pollFailures >= this.timings.maxPollFailures) {
				throw new Error(
					`OpenCode polling failed for session ${this.sid}: ${errorText(err)}`,
				);
			}
		}
	}

	/** 7. The single terminal handler for the streamed and polled paths. */
	private settleTurn(outcome: TurnOutcome): TurnOutcome {
		switch (outcome.outcome) {
			case "succeeded":
				if (this.overlap) {
					throw new Error(
						`OpenCode session ${this.sid} received other input during this turn; the result is ambiguous`,
					);
				}
				return outcome;
			case "failed":
				throw new Error(outcome.error ?? "OpenCode execution failed");
			default:
				throw new Error(
					`OpenCode execution on session ${this.sid} was interrupted` +
						(outcome.reason ? ` (${outcome.reason})` : ""),
				);
		}
	}

	// -----------------------------------------------------------------------
	// Owned cleanup
	// -----------------------------------------------------------------------

	private async failWithCleanup(cause: LocalCause): Promise<never> {
		this.localAbort.abort();
		const note = await this.ownedCleanup();
		const base = this.causeMessage(cause);
		const message = note ? `${base}; ${note}` : base;
		switch (cause) {
			case "timeout":
				throw new AgentTimeoutError(message);
			case "cancel":
				throw new AgentCancellationError(message);
			default:
				throw new Error(message);
		}
	}

	private causeMessage(cause: LocalCause): string {
		switch (cause) {
			case "timeout":
				return `Agent timed out after ${this.opts.timeoutMs}ms`;
			case "cancel":
				return "Agent invocation cancelled";
			case "overlap":
				return `OpenCode session ${this.sid} received other input during this turn; the result is ambiguous`;
			case "admission":
				return `OpenCode prompt ${this.requestId} admission is unresolved on session ${this.sid}; it may still be queued or run`;
		}
	}

	/**
	 * Act only on what this turn owns. Returns a note for the raised error
	 * (left running, or unresolved), or undefined.
	 */
	private async ownedCleanup(): Promise<string | undefined> {
		const cleanupDeadline = Date.now() + this.timings.cleanupTotalMs;
		const remaining = () => cleanupDeadline - Date.now();
		const request = async <T>(fn: (signal: AbortSignal) => Promise<T>) => {
			const ms = Math.min(this.timings.cleanupRequestMs, remaining());
			if (ms <= 0) return undefined;
			try {
				return await bounded(fn, ms);
			} catch {
				return undefined; // no evidence
			}
		};
		const { client } = this.ctx;

		let resolution: "removed" | "delivered" | "unresolved" | undefined;
		if (this.state === "delivered") resolution = "delivered";
		else if (this.state === "removed") resolution = "removed";
		else {
			// 1. Exact-id cancellation with bounded reconciliation.
			this.cancelRequested = true;
			const cancel = () =>
				request((signal) =>
					client.session.inbox.cancel(
						{ sessionID: this.sid, inboxID: this.requestId },
						{ signal },
					),
				);
			await cancel();
			const reconcileDeadline = Math.min(
				Date.now() + this.timings.reconcileMs,
				cleanupDeadline,
			);
			while (resolution === undefined) {
				// Stream evidence, while the stream is up.
				let recancel = false;
				while (this.pump.queue.length > 0) {
					const event = this.pump.queue.shift() as
						| { type: string; data?: Record<string, unknown> }
						| undefined;
					if (!event || eventSessionId(event as OpenCodeEvent) !== this.sid) {
						continue;
					}
					if (event.data?.inboxID !== this.requestId) continue;
					if (event.type === "session.inbox.cancelled") resolution = "removed";
					else if (event.type === "session.inbox.delivered") {
						resolution = "delivered";
					} else if (event.type === "session.inbox.enqueued") recancel = true;
					if (resolution) break;
				}
				if (resolution) break;

				// Durable evidence.
				const inbox = await request((signal) =>
					client.session.inbox.list({ sessionID: this.sid }, { signal }),
				);
				if (inbox?.some((item) => item.id === this.requestId)) recancel = true;
				const scan = await request((signal) =>
					scanTranscript(this.ctx, this.sid, this.requestId, {
						signal,
						tailId: this.anchors.tailId,
					}),
				);
				if (scan?.found) {
					resolution = "delivered";
					break;
				}
				// Removal from the stream may have arrived during the reads.
				if (
					this.pump.queue.some(
						(e) =>
							(e as { type?: string }).type === "session.inbox.cancelled" &&
							(e as { data?: { inboxID?: unknown } }).data?.inboxID ===
								this.requestId,
					)
				) {
					continue;
				}
				if (recancel) await cancel();

				if (Date.now() >= reconcileDeadline) {
					resolution = "unresolved";
					break;
				}
				await sleepFor(
					Math.min(this.timings.pollMs, reconcileDeadline - Date.now()),
				);
			}
		}

		if (resolution === "delivered") {
			this.state = "delivered";
			// 2. Interrupt only on a managed provider's private server.
			if (this.ctx.exclusive) {
				await request((signal) =>
					client.session.interrupt({ sessionID: this.sid }, { signal }),
				);
				return undefined;
			}
			return `the OpenCode execution on session ${this.sid} was left running on the external server`;
		}
		if (resolution === "removed") {
			this.state = "removed";
			return undefined;
		}
		// 3. Unresolved: no interrupt in either mode.
		const unresolved = `OpenCode prompt ${this.requestId} may still be queued or run on session ${this.sid}`;
		return this.ctx.exclusive
			? `${unresolved}; the private OpenCode server is stopped when the provider closes`
			: unresolved;
	}
}

function sleepFor(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, ms));
	});
}

// ---------------------------------------------------------------------------
// OpenCode Provider
// ---------------------------------------------------------------------------

export interface OpenCodeProviderInternals {
	/** External server URL (managed providers use the server's URL). */
	baseUrl?: string;
	/** Timing overrides, for tests. */
	timings?: Partial<OpenCodeTimings>;
}

export class OpenCodeProvider implements AgentProvider {
	private readonly client: OpenCodeClient;
	private readonly server: ManagedServer | null;
	private readonly defaultModel?: string;
	private readonly baseUrl?: string;
	private readonly ctx: ProviderContext;
	private closed = false;

	/** @internal test seam; use the static factory methods instead. */
	constructor(
		client: OpenCodeClient,
		server: ManagedServer | null,
		defaultModel?: string,
		internals?: OpenCodeProviderInternals,
	) {
		this.client = client;
		this.server = server;
		this.defaultModel = defaultModel;
		this.baseUrl = internals?.baseUrl;
		this.ctx = {
			client,
			exclusive: server !== null,
			inFlight: new Set(),
			timings: { ...DEFAULT_OPENCODE_TIMINGS, ...internals?.timings },
		};
	}

	/**
	 * Create a managed provider — spawns a private `opencode serve`.
	 */
	static async createManaged(opts?: {
		model?: string;
		/** @internal spawn seam for unit tests. */
		spawn?: SpawnFn;
		/** @internal startup bound override for unit tests. */
		startupTimeoutMs?: number;
		/** @internal fetch seam for unit tests. */
		fetch?: typeof globalThis.fetch;
	}): Promise<OpenCodeProvider> {
		const server = await startManagedServer({
			spawn: opts?.spawn,
			startupTimeoutMs: opts?.startupTimeoutMs,
		});
		const client = OpenCode.make({
			baseUrl: server.url,
			headers: { authorization: basicAuth(server.password) },
			...(opts?.fetch && { fetch: opts.fetch }),
		});
		return new OpenCodeProvider(client, server, opts?.model, {
			baseUrl: server.url,
		});
	}

	/**
	 * Create an external provider — connects to an already-running server.
	 * Construction sends no request.
	 */
	static createExternal(
		baseUrl: string,
		opts?: {
			model?: string;
			password?: string;
			/** @internal fetch seam for unit tests. */
			fetch?: typeof globalThis.fetch;
			/** @internal environment seam for unit tests; defaults to `process.env`. */
			env?: Record<string, string | undefined>;
		},
	): OpenCodeProvider {
		const env = opts?.env ?? process.env;
		const password =
			opts?.password ?? env.OPENCODE_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD;
		const client = OpenCode.make({
			baseUrl,
			...(password && { headers: { authorization: basicAuth(password) } }),
			...(opts?.fetch && { fetch: opts.fetch }),
		});
		return new OpenCodeProvider(client, null, opts?.model, { baseUrl });
	}

	/** The URL of the OpenCode server this provider talks to. */
	get serverUrl(): string {
		return this.server?.url ?? this.baseUrl ?? "(external)";
	}

	/** Version gate: `server.info()` must report OpenCode ≥ MIN_OPENCODE_VERSION. */
	async verify(): Promise<void> {
		let version: string;
		try {
			const info = await bounded(
				(signal) => this.client.server.info({ signal }),
				this.ctx.timings.requestMs,
			);
			version = String((info as { version?: unknown })?.version ?? "");
		} catch (err) {
			if (isUnauthorizedError(err)) throw new Error(PASSWORD_ERROR);
			if (err instanceof ClientError && err.reason !== "Transport") {
				// 1.x has no /api/info route (404, or its web UI's HTML).
				throw new Error(oneXMessage());
			}
			throw new Error(
				`OpenCode server health check failed at ${this.serverUrl} — ${errorText(err)}`,
			);
		}

		const parsed = parseOpenCodeVersion(version);
		if (!parsed) {
			throw new Error(
				`OpenCode server reported an unparseable version "${version}"; 5x 2.x requires OpenCode ≥ ${MIN_OPENCODE_VERSION}`,
			);
		}
		if (parsed[0] < 2) throw new Error(oneXMessage());
		// biome-ignore lint/style/noNonNullAssertion: constant is a valid version
		const min = parseOpenCodeVersion(MIN_OPENCODE_VERSION)!;
		if (compareVersions(parsed, min) < 0) {
			throw new Error(outdatedMessage(version));
		}
	}

	async startSession(opts: SessionOptions): Promise<AgentSession> {
		const model = opts.model ?? this.defaultModel;
		const session = await this.client.session.create({
			title: `5x-session-${Date.now()}`,
			...(opts.workingDirectory && {
				location: { directory: opts.workingDirectory },
			}),
			...(model && { model: parseModel(model) }),
			permissions: HEADLESS_PERMISSIONS.map((rule) => ({ ...rule })),
		});
		return new OpenCodeSession(
			this.ctx,
			session.id,
			session.location?.directory ?? opts.workingDirectory,
		);
	}

	async resumeSession(
		sessionId: string,
		opts?: ResumeOptions,
	): Promise<AgentSession> {
		let directory: string | undefined;
		try {
			const info = await this.client.session.get({ sessionID: sessionId });
			directory = info.location?.directory;
		} catch (err) {
			if (isSessionNotFoundError(err)) {
				throw new Error(
					`Failed to resume session "${sessionId}": session not found`,
				);
			}
			throw new Error(
				`Failed to resume session "${sessionId}": ${errorText(err)}`,
			);
		}
		if (opts?.model) {
			await this.client.session.switchModel({
				sessionID: sessionId,
				model: parseModel(opts.model),
			});
		}
		return new OpenCodeSession(this.ctx, sessionId, directory);
	}

	/** Idempotent. Stops a managed server; never stops an external one. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await this.server?.close();
		} catch {
			// Ignore close errors — server may already be gone
		}
	}
}
