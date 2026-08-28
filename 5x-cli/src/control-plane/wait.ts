/**
 * Bounded poll helper for waiting on a prompt row to be answered.
 *
 * Does not inspect CLI abort cause — callers classify `PromptWaitAbortedError`
 * (lifecycle vs local cancellation) themselves.
 */

import type { PromptStore } from "./store.js";
import type { PromptRecord } from "./types.js";
import { PromptStoreError } from "./types.js";

export const PROMPT_POLL_INTERVAL_MS = 250;

export class PromptAbandonedError extends Error {
	readonly prompt: PromptRecord;

	constructor(prompt: PromptRecord) {
		super(
			`prompt ${prompt.id} was abandoned (${prompt.abandonReason ?? "unknown"})`,
		);
		this.name = "PromptAbandonedError";
		this.prompt = prompt;
	}
}

export class PromptWaitAbortedError extends Error {
	constructor(message = "prompt wait aborted") {
		super(message);
		this.name = "PromptWaitAbortedError";
	}
}

export class PromptTimeoutError extends Error {
	constructor(message = "prompt wait timed out") {
		super(message);
		this.name = "PromptTimeoutError";
	}
}

export interface WaitForPromptAnswerOptions {
	pollIntervalMs?: number;
	/** null / omitted = no wall clock timeout */
	timeoutMs?: number | null;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	signal?: AbortSignal;
}

function defaultSleep(ms: number): Promise<void> {
	return Bun.sleep(ms);
}

function abortableSleep(
	ms: number,
	signal: AbortSignal | undefined,
	sleep: (ms: number) => Promise<void>,
): Promise<void> {
	if (!signal) return sleep(ms);
	if (signal.aborted) return Promise.resolve();

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => finish(() => resolve());
		signal.addEventListener("abort", onAbort, { once: true });
		void sleep(ms).then(
			() => finish(() => resolve()),
			(err) => finish(() => reject(err)),
		);
	});
}

export async function waitForPromptAnswer(
	store: PromptStore,
	id: string,
	opts: WaitForPromptAnswerOptions = {},
): Promise<PromptRecord> {
	const pollIntervalMs = opts.pollIntervalMs ?? PROMPT_POLL_INTERVAL_MS;
	const timeoutMs = opts.timeoutMs ?? null;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const signal = opts.signal;
	const startedAt = now();

	while (true) {
		const prompt = store.getPrompt(id);
		if (!prompt) {
			throw new PromptStoreError("PROMPT_NOT_FOUND", `prompt ${id} not found`);
		}
		if (prompt.answeredAt !== null) {
			return prompt;
		}
		if (prompt.abandonedAt !== null) {
			throw new PromptAbandonedError(prompt);
		}
		if (signal?.aborted) {
			throw new PromptWaitAbortedError();
		}
		if (timeoutMs !== null && now() - startedAt >= timeoutMs) {
			throw new PromptTimeoutError();
		}
		await abortableSleep(pollIntervalMs, signal, sleep);
		if (signal?.aborted) {
			throw new PromptWaitAbortedError();
		}
	}
}
