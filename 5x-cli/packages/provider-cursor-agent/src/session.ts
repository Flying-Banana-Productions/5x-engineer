/**
 * Cursor Agent CLI session — spawns `agent` per run, maps stream-json NDJSON → AgentEvent.
 */

import type { AgentEvent, AgentSession, RunOptions, RunResult } from "@5x-ai/5x-cli";
import {
	AgentCancellationError,
	AgentTimeoutError,
} from "@5x-ai/5x-cli";

import { buildRunArgs, type RunArgContext } from "./cli-args.js";
import { buildSubprocessEnv } from "./env.js";
import {
	createMapperState,
	mapCursorAgentLine,
	type CursorAgentMapperState,
} from "./event-mapper.js";
import {
	formatPromptOverLimitMessage,
	guardPromptSize,
} from "./prompt-guard.js";
import {
	extractStructuredOutput,
	wrapPromptForStructuredOutput,
} from "./structured.js";
import type { CursorAgentConfig } from "./types.js";

/** Narrow surface from `CursorAgentProvider` to avoid circular imports. */
export interface CursorAgentExecutionHost {
	readonly isClosed: boolean;
	trackProcess(proc: ReturnType<typeof Bun.spawn>): void;
	untrackProcess(proc: ReturnType<typeof Bun.spawn>): void;
}

export type CursorAgentSubprocess = ReturnType<typeof Bun.spawn>;

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

function installHint(binary: string): string {
	return `Could not find Cursor Agent CLI binary "${binary}". Install Cursor Agent or set [cursor-agent].agentBinary in 5x.toml.`;
}

function createChatFailureMessage(
	exitCode: number,
	stderrText: string,
): string {
	return `Cursor Agent create-chat exited with code ${exitCode}${stderrText ? `: ${stderrText.trim()}` : ""}. Ensure agent is installed and authenticated.`;
}

function emptySessionIdMessage(): string {
	return "Cursor Agent create-chat returned empty session ID. Ensure agent is installed and authenticated.";
}

function terminalResultText(line: Record<string, unknown>): string {
	return typeof line.result === "string" ? line.result : "";
}

function attachStructuredToResult(
	result: RunResult,
	mapperState: CursorAgentMapperState,
	terminalText: string,
	hasOutputSchema: boolean,
): RunResult {
	if (!hasOutputSchema) return result;
	const extracted = extractStructuredOutput(
		mapperState.finalAssistantText,
		terminalText,
	);
	if (!extracted.ok) return result;
	return { ...result, structured: extracted.value };
}

function stderrExcerpt(stderrText: string, max = 500): string {
	const trimmed = stderrText.trim();
	if (trimmed === "") return "";
	return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface CursorAgentSessionOptions {
	id: string;
	model?: string;
	cwd: string;
	config: CursorAgentConfig;
	provider: CursorAgentExecutionHost;
}

export class CursorAgentSession implements AgentSession {
	readonly id: string;
	private model?: string;
	private cwd: string;
	private config: CursorAgentConfig;
	private provider: CursorAgentExecutionHost;

	constructor(opts: CursorAgentSessionOptions) {
		this.id = opts.id;
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
		return this.config.agentBinary ?? "agent";
	}

	private runArgContext(prompt: string): RunArgContext {
		return {
			prompt,
			sessionId: this.id,
			cwd: this.cwd,
			model: this.model,
			force: this.config.force,
			trust: this.config.trust,
			sandbox: this.config.sandbox,
			approveMcps: this.config.approveMcps,
			pluginDir: this.config.pluginDir,
		};
	}

	private preparePrompt(
		prompt: string,
		opts?: RunOptions,
	): { effectivePrompt: string; hasOutputSchema: boolean } {
		const hasOutputSchema = opts?.outputSchema !== undefined;
		const effectivePrompt = hasOutputSchema
			? wrapPromptForStructuredOutput(prompt, opts!.outputSchema!)
			: prompt;
		return { effectivePrompt, hasOutputSchema };
	}

	async run(prompt: string, opts?: RunOptions): Promise<RunResult> {
		let lastResult: RunResult | undefined;
		for await (const ev of this.runStreamed(prompt, opts)) {
			if (ev.type === "done") {
				lastResult = ev.result;
			} else if (ev.type === "error") {
				throw new Error(ev.message);
			}
		}
		if (lastResult === undefined) {
			throw new Error("Cursor Agent run ended without a result");
		}
		return lastResult;
	}

	async *runStreamed(
		prompt: string,
		opts?: RunOptions,
	): AsyncIterable<AgentEvent> {
		this.assertProviderOpen();

		const { effectivePrompt, hasOutputSchema } = this.preparePrompt(prompt, opts);
		const guard = guardPromptSize(effectivePrompt);
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

		const argv = [
			this.cliBinary(),
			...buildRunArgs(this.runArgContext(effectivePrompt)),
		];

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(argv, {
				cwd: this.cwd,
				env: buildSubprocessEnv(this.config),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			if (isEnoent(err)) {
				yield { type: "error", message: installHint(this.cliBinary()) };
				return;
			}
			throw err;
		}

		const stdoutStream = subprocessReadable(proc.stdout);
		const stderrStream = subprocessReadable(proc.stderr);
		if (!stdoutStream) {
			yield {
				type: "error",
				message: "Cursor Agent subprocess has no stdout pipe",
			};
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
		const stderrPromise = readStreamFull(stderrStream);
		try {
			for await (const line of readNdjsonLines(stdoutStream)) {
				if (cancelSignal?.aborted) break;

				resetInactivityTimeout();

				const terminalText =
					line.type === "result" ? terminalResultText(line) : "";

				const events = flattenMapped(
					mapCursorAgentLine(line, mapperState, {
						sessionIdFallback: this.id,
					}),
				);

				for (const ev of events) {
					if (ev.type === "usage") {
						continue;
					}
					if (ev.type === "done") {
						sawTerminal = true;
						const result = attachStructuredToResult(
							ev.result,
							mapperState,
							terminalText,
							hasOutputSchema,
						);
						yield {
							type: "usage",
							tokens: result.tokens,
							...(result.costUsd !== undefined
								? { costUsd: result.costUsd }
								: {}),
						};
						yield { type: "done", result };
					} else if (ev.type === "error") {
						sawTerminal = true;
						yield ev;
					} else {
						yield ev;
					}
				}
			}

			const [exitCode, stderrText] = await Promise.all([
				proc.exited,
				stderrPromise,
			]);
			const stderrPart = stderrExcerpt(stderrText);

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
					message: `Cursor Agent exited with code ${exitCode}${stderrPart ? `: ${stderrPart}` : " without a terminal result"}`,
				};
				return;
			}

			if (exitCode !== 0) {
				yield {
					type: "error",
					message: `Cursor Agent exited with code ${exitCode}${stderrPart ? `: ${stderrPart}` : ""}`,
				};
			}
		} finally {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			cancelSignal?.removeEventListener("abort", onAbort);
			this.provider.untrackProcess(proc);
		}
	}
}

// ---------------------------------------------------------------------------
// create-chat helper (used by provider)
// ---------------------------------------------------------------------------

export async function createCursorChatSessionId(
	binary: string,
	cwd: string,
	config: CursorAgentConfig,
	host: CursorAgentExecutionHost,
): Promise<string> {
	if (host.isClosed) {
		throw new Error("Provider is closed");
	}

	const argv = [binary, "create-chat"];
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(argv, {
			cwd,
			env: buildSubprocessEnv(config),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(installHint(binary));
		}
		throw err;
	}

	host.trackProcess(proc);
	try {
		const [stdoutText, stderrText, exitCode] = await Promise.all([
			readStreamFull(subprocessReadable(proc.stdout)),
			readStreamFull(subprocessReadable(proc.stderr)),
			proc.exited,
		]);

		if (exitCode !== 0) {
			throw new Error(createChatFailureMessage(exitCode, stderrText));
		}

		const sessionId = stdoutText.trim();
		if (sessionId === "") {
			throw new Error(emptySessionIdMessage());
		}

		return sessionId;
	} finally {
		host.untrackProcess(proc);
	}
}
