/**
 * Unit tests for waitForPromptAnswer — poll, timeout, abort, abandon.
 */

import { describe, expect, test } from "bun:test";
import {
	PROMPT_POLL_INTERVAL_MS,
	PromptAbandonedError,
	PromptTimeoutError,
	PromptWaitAbortedError,
	waitForPromptAnswer,
} from "../../../src/control-plane/index.js";
import type { PromptStore } from "../../../src/control-plane/store.js";
import type { PromptRecord } from "../../../src/control-plane/types.js";

function openRecord(overrides: Partial<PromptRecord> = {}): PromptRecord {
	return {
		id: "p1",
		runId: null,
		kind: "choose",
		message: "pick",
		options: ["a"],
		defaultValue: null,
		createdAt: "2026-01-01 00:00:00",
		answeredAt: null,
		answer: null,
		answeredBy: null,
		abandonedAt: null,
		abandonReason: null,
		...overrides,
	};
}

function fakeStore(getPrompt: PromptStore["getPrompt"]): PromptStore {
	return {
		createPrompt: () => {
			throw new Error("unused");
		},
		getPrompt,
		listOpenPrompts: () => [],
		answerPrompt: () => {
			throw new Error("unused");
		},
		abandonPrompt: () => {
			throw new Error("unused");
		},
	};
}

describe("waitForPromptAnswer", () => {
	test("answers on Nth poll", async () => {
		const polls: PromptRecord[] = [
			openRecord(),
			openRecord(),
			openRecord({
				answeredAt: "2026-01-01 00:00:01",
				answer: "a",
				answeredBy: "control-plane",
			}),
		];
		let i = 0;
		const store = fakeStore(() => {
			const row = polls[Math.min(i, polls.length - 1)];
			i++;
			if (!row) throw new Error("missing poll row");
			return row;
		});
		const sleeps: number[] = [];
		const result = await waitForPromptAnswer(store, "p1", {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(result.answer).toBe("a");
		expect(i).toBe(3);
		expect(sleeps).toEqual([PROMPT_POLL_INTERVAL_MS, PROMPT_POLL_INTERVAL_MS]);
	});

	test("timeout throws PromptTimeoutError", async () => {
		let t = 0;
		const store = fakeStore(() => openRecord());
		await expect(
			waitForPromptAnswer(store, "p1", {
				timeoutMs: 500,
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			}),
		).rejects.toBeInstanceOf(PromptTimeoutError);
	});

	test("abort throws PromptWaitAbortedError", async () => {
		const ac = new AbortController();
		ac.abort();
		const store = fakeStore(() => openRecord());
		await expect(
			waitForPromptAnswer(store, "p1", {
				signal: ac.signal,
				sleep: async () => {},
			}),
		).rejects.toBeInstanceOf(PromptWaitAbortedError);
	});

	test("abandoned row throws PromptAbandonedError", async () => {
		const abandoned = openRecord({
			abandonedAt: "2026-01-01 00:00:01",
			abandonReason: "timeout",
		});
		const store = fakeStore(() => abandoned);
		try {
			await waitForPromptAnswer(store, "p1", { sleep: async () => {} });
			throw new Error("expected PromptAbandonedError");
		} catch (err) {
			expect(err).toBeInstanceOf(PromptAbandonedError);
			expect((err as PromptAbandonedError).prompt).toEqual(abandoned);
		}
	});

	test("does not busy-spin (fake sleep records interval 250)", async () => {
		let n = 0;
		const store = fakeStore(() => {
			n++;
			if (n >= 3) {
				return openRecord({
					answeredAt: "2026-01-01 00:00:01",
					answer: "a",
					answeredBy: "terminal",
				});
			}
			return openRecord();
		});
		const sleeps: number[] = [];
		await waitForPromptAnswer(store, "p1", {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(sleeps.length).toBeGreaterThan(0);
		expect(sleeps.every((ms) => ms === 250)).toBe(true);
		expect(PROMPT_POLL_INTERVAL_MS).toBe(250);
	});

	test("abort mid-poll throws and does not schedule another sleep or getPrompt", async () => {
		let getCount = 0;
		const store = fakeStore(() => {
			getCount++;
			return openRecord();
		});
		let sleepStarted!: () => void;
		const sawSleep = new Promise<void>((resolve) => {
			sleepStarted = resolve;
		});
		let sleepCalls = 0;
		const sleep = () => {
			sleepCalls++;
			sleepStarted();
			return new Promise<void>(() => {});
		};
		const ac = new AbortController();
		const pending = waitForPromptAnswer(store, "p1", {
			sleep,
			signal: ac.signal,
		});
		await sawSleep;
		expect(getCount).toBe(1);
		expect(sleepCalls).toBe(1);
		ac.abort();
		await expect(pending).rejects.toBeInstanceOf(PromptWaitAbortedError);
		expect(getCount).toBe(1);
		expect(sleepCalls).toBe(1);
	});
});
