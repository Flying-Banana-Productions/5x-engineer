/**
 * Claude Code CLI session — spawns `claude` per run, maps NDJSON → AgentEvent.
 */

import type { AgentEvent, AgentSession, RunOptions, RunResult } from "@5x-ai/5x-cli";
import {
	AgentCancellationError,
	AgentTimeoutError,
} from "@5x-ai/5x-cli";

import { buildCliArgs, type CliArgContext } from "./cli-args.js";
import {
	createMapperState,
	mapNdjsonLine,
} from "./event-mapper.js";
import {
	formatPromptOverLimitMessage,
	guardPromptSize,
} from "./prompt-guard.js";
import type { ClaudeCodeConfig } from "./types.js";

/** Narrow surface from `ClaudeCodeProvider` to avoid circular imports. */
export interface ClaudeCodeExecutionHost {
	readonly isClosed: boolean;
	trackProcess(proc: ReturnType<typeof Bun.spawn>): void;
	untrackProcess(proc: ReturnType<typeof Bun.spawn>): void;
}

export type ClaudeSubprocess = ReturnType<typeof Bun.spawn>;

// ---------------------------------------------------------------------------
// NDJSON streaming
// ---------------------------------------------------------------------------

/**
 * Incrementally parse NDJSON objects from a byte stream (one JSON object per line).
 * Malformed lines are skipped.
 */
export async function* readNdjsonLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				buffer += decoder.decode(value, { stream: true });
			}
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				const trimmed = line.trim();
				if (trimmed === "") continue;
				try {
					yield JSON.parse(trimmed) as Record<string, unknown>;
				} catch {
					// skip malformed
				}
			}
		}
		buffer += decoder.decode();
		const tail = buffer.trim();
		if (tail !== "") {
			try {
				yield JSON.parse(tail) as Record<string, unknown>;
			} catch {
				// skip malformed trailing blob
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// ---------------------------------------------------------------------------
// AbortSignal fan-in (portable)
// ---------------------------------------------------------------------------

function anySignal(signals: AbortSignal[]): AbortSignal {
	if (signals.length === 0) {
		return new AbortController().signal;
	}
	if (signals.length === 1) {
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

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Best-effort SIGTERM → grace → SIGKILL for Bun subprocess handles. */
export async function forceKillSubprocess(
	proc: ReturnType<typeof Bun.spawn>,
): Promise<void> {
	try {
		proc.kill(15);
	} catch {
		// ignore
	}
	await Promise.race([
		proc.exited.then(() => {}),
		new Promise<void>((r) => setTimeout(r, 3000)),
	]);
	try {
		proc.kill(9);
	} catch {
		// ignore
	}
	try {
		await proc.exited;
	} catch {
		// ignore
	}
}

function subprocessReadable(
	stream: ReturnType<typeof Bun.spawn>["stdout"],
): ReadableStream<Uint8Array> | undefined {
	return stream instanceof ReadableStream ? stream : undefined;
}

async function readStreamFull(
	stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
	if (!stream) return "";
	return await new Response(stream).text();
}

async function drainStream(
	stream: ReadableStream<Uint8Array> | undefined,
): Promise<void> {
	if (!stream) return;
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done } = await reader.read();
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: string }).code === "ENOENT"
	);
}

function flattenMapped(
	mapped: AgentEvent | AgentEvent[] | undefined,
): AgentEvent[] {
	if (mapped === undefined) return [];
	return Array.isArray(mapped) ? mapped : [mapped];
}

function extractRunResultFromStdout(
	text: string,
	sessionId: string,
): RunResult {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error("Claude Code returned empty stdout");
	}
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		throw new Error(
			`Claude Code returned invalid JSON (first 200 chars): ${trimmed.slice(0, 200)}`,
		);
	}
	const state = createMapperState();
	const ev = mapNdjsonLine(obj, state, { sessionIdFallback: sessionId });
	const events = flattenMapped(ev);
	const doneEv = events.find(
		(e): e is AgentEvent & { type: "done" } => e.type === "done",
	);
	if (doneEv) return doneEv.result;
	const errEv = events.find(
		(e): e is AgentEvent & { type: "error" } => e.type === "error",
	);
	if (errEv) {
		throw new Error(errEv.message);
	}
	throw new Error("Claude Code JSON did not contain a terminal result event");
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface ClaudeCodeSessionOptions {
	id: string;
	firstInvocationMode: "session-id" | "resume";
	model: string;
	cwd: string;
	config: ClaudeCodeConfig;
	provider: ClaudeCodeExecutionHost;
}

export class ClaudeCodeSession implements AgentSession {
	readonly id: string;
	private firstInvocationMode: "session-id" | "resume";
	private hasRun = false;
	private model: string;
	private cwd: string;
	private config: ClaudeCodeConfig;
	private provider: ClaudeCodeExecutionHost;

	constructor(opts: ClaudeCodeSessionOptions) {
		this.id = opts.id;
		this.firstInvocationMode = opts.firstInvocationMode;
		this.model = opts.model;
		this.cwd = opts.cwd;
		this.config = opts.config;
		this.provider = opts.provider;
	}

	private assertProviderOpen(): void {
		if (this.provider.isClosed) {
			throw new Error("Provider is closed");
		}
	}

	private cliBinary(): string {
		return this.config.claudeBinary ?? "claude";
	}

	private isResumeFlagForNextRun(): boolean {
		if (!this.hasRun) {
			return this.firstInvocationMode === "resume";
		}
		return true;
	}

	private cliContext(
		prompt: string,
		streaming: boolean,
		jsonSchema?: string,
	): CliArgContext {
		return {
			prompt,
			sessionId: this.id,
			isResume: this.isResumeFlagForNextRun(),
			model: this.model,
			streaming,
			jsonSchema,
			permissionMode: this.config.permissionMode,
			bare: this.config.bare,
			tools: this.config.tools,
			maxBudgetUsd: this.config.maxBudgetUsd,
			systemPrompt: this.config.systemPrompt,
			appendSystemPrompt: this.config.appendSystemPrompt,
		};
	}

	async run(prompt: string, opts?: RunOptions): Promise<RunResult> {
		this.assertProviderOpen();
		const guard = guardPromptSize(prompt);
		if (!guard.ok) {
			throw new Error(formatPromptOverLimitMessage(guard.error));
		}

		const timeoutMs =
			opts?.timeout !== undefined ? opts.timeout * 1000 : undefined;
		const timeoutController =
			timeoutMs !== undefined ? new AbortController() : undefined;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		if (timeoutController && timeoutMs !== undefined) {
			timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
			(timeoutId as { unref?: () => void }).unref?.();
		}

		const cancelSignals: AbortSignal[] = [];
		if (timeoutController) cancelSignals.push(timeoutController.signal);
		if (opts?.signal) cancelSignals.push(opts.signal);
		const cancelSignal =
			cancelSignals.length > 0 ? anySignal(cancelSignals) : undefined;

		const jsonSchema =
			opts?.outputSchema !== undefined
				? JSON.stringify(opts.outputSchema)
				: undefined;
		const argv = [
			this.cliBinary(),
			...buildCliArgs(this.cliContext(prompt, false, jsonSchema)),
		];

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(argv, {
				cwd: this.cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(
					`Could not find Claude Code CLI binary "${this.cliBinary()}". Install Claude Code or set [claude-code].claudeBinary in 5x.toml.`,
				);
			}
			throw err;
		}

		this.provider.trackProcess(proc);
		let onAbort: (() => void) | undefined;
		if (cancelSignal) {
			onAbort = () => {
				void forceKillSubprocess(proc);
			};
			cancelSignal.addEventListener("abort", onAbort, { once: true });
			if (cancelSignal.aborted) {
				onAbort();
			}
		}

		try {
			const stdoutPromise = readStreamFull(subprocessReadable(proc.stdout));
			const stderrPromise = readStreamFull(subprocessReadable(proc.stderr));
			const [stdoutText, errText] = await Promise.all([
				stdoutPromise,
				stderrPromise,
			]);
			const exitCode = await proc.exited;

			if (cancelSignal?.aborted) {
				const isTimeout = timeoutController?.signal.aborted === true;
				const isExternal = opts?.signal?.aborted === true;
				if (isTimeout && !isExternal) {
					throw new AgentTimeoutError(
						`Agent timed out after ${timeoutMs}ms`,
					);
				}
				throw new AgentCancellationError("Agent invocation cancelled");
			}

			if (exitCode !== 0) {
				throw new Error(
					`Claude Code exited with code ${exitCode}${errText ? `: ${errText}` : ""}`,
				);
			}

			return extractRunResultFromStdout(stdoutText, this.id);
		} catch (err) {
			if (cancelSignal?.aborted) {
				const isTimeout = timeoutController?.signal.aborted === true;
				const isExternal = opts?.signal?.aborted === true;
				if (isTimeout && !isExternal) {
					throw new AgentTimeoutError(
						`Agent timed out after ${timeoutMs}ms`,
					);
				}
				throw new AgentCancellationError("Agent invocation cancelled");
			}
			throw err;
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			if (cancelSignal && onAbort) {
				cancelSignal.removeEventListener("abort", onAbort);
			}
			this.provider.untrackProcess(proc);
			this.hasRun = true;
		}
	}

	async *runStreamed(
		prompt: string,
		opts?: RunOptions,
	): AsyncIterable<AgentEvent> {
		this.assertProviderOpen();
		const guard = guardPromptSize(prompt);
		if (!guard.ok) {
			yield {
				type: "error",
				message: formatPromptOverLimitMessage(guard.error),
			};
			return;
		}

		const timeoutMs =
			opts?.timeout !== undefined ? opts.timeout * 1000 : undefined;
		const timeoutController =
			timeoutMs !== undefined ? new AbortController() : undefined;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const resetInactivityTimeout = () => {
			if (!timeoutController || timeoutMs === undefined) return;
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
			(timeoutId as { unref?: () => void }).unref?.();
		};
		if (timeoutController && timeoutMs !== undefined) {
			resetInactivityTimeout();
		}

		const cancelSignals: AbortSignal[] = [];
		if (timeoutController) cancelSignals.push(timeoutController.signal);
		if (opts?.signal) cancelSignals.push(opts.signal);
		const cancelSignal =
			cancelSignals.length > 0 ? anySignal(cancelSignals) : undefined;

		const jsonSchema =
			opts?.outputSchema !== undefined
				? JSON.stringify(opts.outputSchema)
				: undefined;
		const argv = [
			this.cliBinary(),
			...buildCliArgs(this.cliContext(prompt, true, jsonSchema)),
		];

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(argv, {
				cwd: this.cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			if (isEnoent(err)) {
				yield {
					type: "error",
					message: `Could not find Claude Code CLI binary "${this.cliBinary()}". Install Claude Code or set [claude-code].claudeBinary in 5x.toml.`,
				};
				return;
			}
			throw err;
		}

		const stdoutStream = subprocessReadable(proc.stdout);
		const stderrStream = subprocessReadable(proc.stderr);
		if (!stdoutStream) {
			yield { type: "error", message: "Claude Code subprocess has no stdout pipe" };
			return;
		}

		this.provider.trackProcess(proc);
		const onAbort = () => {
			void forceKillSubprocess(proc);
		};
		cancelSignal?.addEventListener("abort", onAbort, { once: true });
		if (cancelSignal?.aborted) {
			onAbort();
		}

		const mapperState = createMapperState();
		let sawTerminal = false;
		const stderrPromise = drainStream(stderrStream);
		try {
			for await (const line of readNdjsonLines(stdoutStream)) {
				if (cancelSignal?.aborted) break;

				resetInactivityTimeout();

				const events = flattenMapped(
					mapNdjsonLine(line, mapperState, {
						sessionIdFallback: this.id,
					}),
				);

				for (const ev of events) {
					if (ev.type === "done") {
						sawTerminal = true;
						const { result } = ev;
						yield {
							type: "usage",
							tokens: result.tokens,
							...(result.costUsd !== undefined
								? { costUsd: result.costUsd }
								: {}),
						};
						yield ev;
					} else if (ev.type === "error") {
						sawTerminal = true;
						yield ev;
					} else {
						yield ev;
					}
				}
			}

			const exitCode = await proc.exited;

			if (cancelSignal?.aborted) {
				const isTimeout = timeoutController?.signal.aborted === true;
				const isExternal = opts?.signal?.aborted === true;
				if (isTimeout && !isExternal) {
					yield {
						type: "error",
						message: `Agent timed out after ${timeoutMs}ms`,
					};
				} else if (isExternal) {
					yield { type: "error", message: "Agent invocation cancelled" };
				}
				return;
			}

			if (!sawTerminal) {
				yield {
					type: "error",
					message: `Claude Code exited with code ${exitCode} without a result line`,
				};
			}
		} finally {
			await stderrPromise.catch(() => {});
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			cancelSignal?.removeEventListener("abort", onAbort);
			this.provider.untrackProcess(proc);
			this.hasRun = true;
		}
	}
}
