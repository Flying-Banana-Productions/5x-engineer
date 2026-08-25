/**
 * Handler unit tests for persist-then-wait prompt commands.
 *
 * Injects MemoryPromptStore + fake TTY/sleep/abort. Does not spawn the CLI.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CliAbortCause } from "../../../src/cli-lifecycle.js";
import {
	promptChoose,
	promptConfirm,
	promptInput,
} from "../../../src/commands/prompt.handler.js";
import { createMemoryPromptStore } from "../../../src/control-plane/index.js";
import type { PromptStore } from "../../../src/control-plane/store.js";
import { CliError } from "../../../src/output.js";
import {
	ABORTED,
	EOF,
	type readAll,
	type readLine,
	type readStdinPipe,
	SIGINT,
} from "../../../src/utils/stdin.js";

const ENV_TIMEOUT = "FIVEX_PROMPT_TIMEOUT_MS";

afterEach(() => {
	delete process.env[ENV_TIMEOUT];
});

async function invoke(fn: () => Promise<void>): Promise<{
	ok: boolean;
	error?: CliError;
}> {
	try {
		await fn();
		return { ok: true };
	} catch (err) {
		if (err instanceof CliError) return { ok: false, error: err };
		throw err;
	}
}

async function waitUntil(fn: () => boolean, ms = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (fn()) return;
		await Bun.sleep(5);
	}
	throw new Error("timed out waiting for condition");
}

function wrapStore(
	inner: PromptStore,
	hooks?: { onGet?: () => void; onCreate?: () => void },
): PromptStore {
	return {
		createPrompt: (input) => {
			hooks?.onCreate?.();
			return inner.createPrompt(input);
		},
		getPrompt: (id) => {
			hooks?.onGet?.();
			return inner.getPrompt(id);
		},
		listOpenPrompts: (runId) => inner.listOpenPrompts(runId),
		answerPrompt: (id, answer, by) => inner.answerPrompt(id, answer, by),
		abandonPrompt: (id, reason) => inner.abandonPrompt(id, reason),
	};
}

function hangingRead(observed: { signal?: AbortSignal }): typeof readLine {
	return (signal) => {
		observed.signal = signal;
		return new Promise((resolve) => {
			if (signal?.aborted) {
				resolve(ABORTED);
				return;
			}
			signal?.addEventListener("abort", () => resolve(ABORTED), { once: true });
		});
	};
}

function hangingPipe(observed: { signal?: AbortSignal }): typeof readStdinPipe {
	return (signal) => {
		observed.signal = signal;
		return new Promise((resolve) => {
			if (signal?.aborted) {
				resolve(ABORTED);
				return;
			}
			signal?.addEventListener("abort", () => resolve(ABORTED), { once: true });
		});
	};
}

function lastRecord(store: PromptStore) {
	const records = (
		store as unknown as {
			records: Map<string, NonNullable<ReturnType<PromptStore["getPrompt"]>>>;
		}
	).records;
	return [...records.values()].at(-1) ?? null;
}

describe("promptChoose persist + CAS", () => {
	test("choose --default no-TTY: answeredBy default, stdout { choice }", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "red,green,blue", default: "green" },
				{ store, isTTY: () => false },
			),
		);
		expect(result.ok).toBe(true);
		expect(store.listOpenPrompts()).toEqual([]);
		const record = lastRecord(store);
		expect(record?.answeredBy).toBe("default");
		expect(record?.answer).toBe("green");
		expect(record?.abandonedAt).toBeNull();
	});

	test("choose no-TTY no default: abandoned non-interactive, NON_INTERACTIVE", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "red,green" },
				{ store, isTTY: () => false },
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("NON_INTERACTIVE");
		const record = lastRecord(store);
		expect(record?.abandonReason).toBe("non-interactive");
		expect(record?.answeredAt).toBeNull();
		expect(store.listOpenPrompts()).toEqual([]);
	});

	test("invalid default: no row created", async () => {
		const store = createMemoryPromptStore();
		let created = 0;
		const wrapped = wrapStore(store, { onCreate: () => created++ });
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "red,green", default: "purple" },
				{ store: wrapped, isTTY: () => false },
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("INVALID_DEFAULT");
		expect(created).toBe(0);
		expect(store.listOpenPrompts()).toEqual([]);
	});
});

describe("promptChoose TTY race", () => {
	test("parallel control-plane writer wins; stdin and poll aborted", async () => {
		const inner = createMemoryPromptStore();
		let gets = 0;
		const store = wrapStore(inner, { onGet: () => gets++ });
		const observed: { signal?: AbortSignal } = {};
		const result = await invoke(async () => {
			const pending = promptChoose(
				{ message: "Pick", options: "a,b" },
				{
					store,
					isTTY: () => true,
					readLine: hangingRead(observed),
					pollIntervalMs: 10,
					sleep: () => Bun.sleep(5),
				},
			);
			await waitUntil(() => inner.listOpenPrompts().length === 1);
			const open = inner.listOpenPrompts()[0];
			if (!open) throw new Error("expected open prompt");
			inner.answerPrompt(open.id, "b", "control-plane");
			await pending;
		});
		expect(result.ok).toBe(true);
		expect(lastRecord(inner)?.answer).toBe("b");
		expect(lastRecord(inner)?.answeredBy).toBe("control-plane");
		expect(observed.signal?.aborted).toBe(true);
		const n = gets;
		await Bun.sleep(40);
		expect(gets).toBe(n);
	});

	test("timeout win: stdin aborted, poll stopped, row abandoned timeout", async () => {
		const inner = createMemoryPromptStore();
		let gets = 0;
		const store = wrapStore(inner, { onGet: () => gets++ });
		const observed: { signal?: AbortSignal } = {};
		let t = 0;
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b", timeout: 50 },
				{
					store,
					isTTY: () => true,
					readLine: hangingRead(observed),
					now: () => t,
					sleep: async () => {
						t += 100;
					},
				},
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("PROMPT_TIMEOUT");
		expect(result.error?.exitCode).toBe(3);
		expect(observed.signal?.aborted).toBe(true);
		const record = lastRecord(inner);
		expect(record?.abandonReason).toBe("timeout");
		const n = gets;
		await Bun.sleep(40);
		expect(gets).toBe(n);
	});

	test("TTY/EOF win: poll signal aborted (no further getPrompt)", async () => {
		const inner = createMemoryPromptStore();
		let gets = 0;
		const store = wrapStore(inner, { onGet: () => gets++ });
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b", default: "a" },
				{
					store,
					isTTY: () => true,
					readLine: (async () => EOF) as typeof readLine,
					pollIntervalMs: 10,
					sleep: () => Bun.sleep(5),
				},
			),
		);
		expect(result.ok).toBe(true);
		expect(lastRecord(inner)?.answeredBy).toBe("default");
		expect(lastRecord(inner)?.answer).toBe("a");
		const n = gets;
		await Bun.sleep(40);
		expect(gets).toBe(n);
	});

	test("choose readLine EOF without default: abandoned eof, envelope EOF", async () => {
		const store = createMemoryPromptStore();
		let gets = 0;
		const wrapped = wrapStore(store, { onGet: () => gets++ });
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b" },
				{
					store: wrapped,
					isTTY: () => true,
					readLine: (async () => EOF) as typeof readLine,
					pollIntervalMs: 10,
					sleep: () => Bun.sleep(5),
				},
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("EOF");
		expect(lastRecord(store)?.abandonReason).toBe("eof");
		const n = gets;
		await Bun.sleep(40);
		expect(gets).toBe(n);
	});

	test("choose readLine EOF with --default: answered default, success envelope", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b", default: "b" },
				{
					store,
					isTTY: () => true,
					readLine: (async () => EOF) as typeof readLine,
				},
			),
		);
		expect(result.ok).toBe(true);
		const record = lastRecord(store);
		expect(record?.answeredBy).toBe("default");
		expect(record?.answer).toBe("b");
		expect(record?.abandonedAt).toBeNull();
	});
});

describe("promptInput kind-aware EOF", () => {
	test("single-line readLine EOF: terminal empty answer, not abandoned", async () => {
		const store = createMemoryPromptStore();
		let gets = 0;
		const wrapped = wrapStore(store, { onGet: () => gets++ });
		const result = await invoke(() =>
			promptInput(
				{ message: "Enter" },
				{
					store: wrapped,
					isTTY: () => true,
					readLine: (async () => EOF) as typeof readLine,
					pollIntervalMs: 10,
					sleep: () => Bun.sleep(5),
				},
			),
		);
		expect(result.ok).toBe(true);
		const record = lastRecord(store);
		expect(record?.answeredBy).toBe("terminal");
		expect(record?.answer).toBe("");
		expect(record?.abandonedAt).toBeNull();
		const n = gets;
		await Bun.sleep(40);
		expect(gets).toBe(n);
	});

	test("multiline readAll stream-end with text: terminal answer, not abandoned", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptInput(
				{ message: "Enter", multiline: true },
				{
					store,
					isTTY: () => true,
					readAll: (async () => "line one\n") as typeof readAll,
				},
			),
		);
		expect(result.ok).toBe(true);
		const record = lastRecord(store);
		expect(record?.answeredBy).toBe("terminal");
		expect(record?.answer).toBe("line one\n");
		expect(record?.abandonedAt).toBeNull();
	});

	test("multiline readAll empty stream-end: { input: '' }, not EOF", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptInput(
				{ message: "Enter", multiline: true },
				{
					store,
					isTTY: () => true,
					readAll: (async () => "") as typeof readAll,
				},
			),
		);
		expect(result.ok).toBe(true);
		const record = lastRecord(store);
		expect(record?.answeredBy).toBe("terminal");
		expect(record?.abandonedAt).toBeNull();
		expect(result.error).toBeUndefined();
	});

	test("multiline readAll SIGINT: abandoned interrupted, no partial success", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptInput(
				{ message: "Enter", multiline: true },
				{
					store,
					isTTY: () => true,
					readAll: (async () => SIGINT) as typeof readAll,
				},
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("INTERRUPTED");
		expect(lastRecord(store)?.abandonReason).toBe("interrupted");
	});
});

describe("lifecycle abort during TTY wait", () => {
	test("SIGTERM: abandoned interrupted, envelope TERMINATED", async () => {
		const store = createMemoryPromptStore();
		const ac = new AbortController();
		let cause: CliAbortCause | undefined;
		const observed: { signal?: AbortSignal } = {};
		let inSleep!: () => void;
		const started = new Promise<void>((resolve) => {
			inSleep = resolve;
		});
		const pending = invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b" },
				{
					store,
					isTTY: () => true,
					readLine: hangingRead(observed),
					getAbortSignal: () => ac.signal,
					getAbortCause: () => cause,
					sleep: async () => {
						inSleep();
						await new Promise(() => {});
					},
				},
			),
		);
		await started;
		cause = "SIGTERM";
		ac.abort();
		const result = await pending;
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("TERMINATED");
		expect(result.error?.exitCode).toBe(143);
		expect(result.error?.code).not.toBe("INTERRUPTED");
		expect(observed.signal?.aborted).toBe(true);
		expect(lastRecord(store)?.abandonReason).toBe("interrupted");
	});

	test("SIGINT: abandoned interrupted, envelope INTERRUPTED", async () => {
		const store = createMemoryPromptStore();
		const ac = new AbortController();
		let cause: CliAbortCause | undefined;
		const observed: { signal?: AbortSignal } = {};
		let inSleep!: () => void;
		const started = new Promise<void>((resolve) => {
			inSleep = resolve;
		});
		const pending = invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b" },
				{
					store,
					isTTY: () => true,
					readLine: hangingRead(observed),
					getAbortSignal: () => ac.signal,
					getAbortCause: () => cause,
					sleep: async () => {
						inSleep();
						await new Promise(() => {});
					},
				},
			),
		);
		await started;
		cause = "SIGINT";
		ac.abort();
		const result = await pending;
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("INTERRUPTED");
		expect(result.error?.exitCode).toBe(130);
		expect(observed.signal?.aborted).toBe(true);
		expect(lastRecord(store)?.abandonReason).toBe("interrupted");
	});
});

describe("poll-only wait (no-TTY choose, no default, positive timeout)", () => {
	test("SIGINT maps PromptWaitAbortedError to interrupted + INTERRUPTED", async () => {
		const store = createMemoryPromptStore();
		const ac = new AbortController();
		let cause: CliAbortCause | undefined;
		let inSleep!: () => void;
		const started = new Promise<void>((resolve) => {
			inSleep = resolve;
		});
		const pending = invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b", timeout: 10_000 },
				{
					store,
					isTTY: () => false,
					getAbortSignal: () => ac.signal,
					getAbortCause: () => cause,
					sleep: async () => {
						inSleep();
						await new Promise(() => {});
					},
				},
			),
		);
		await started;
		cause = "SIGINT";
		ac.abort();
		const result = await pending;
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("INTERRUPTED");
		expect(lastRecord(store)?.abandonReason).toBe("interrupted");
		expect(store.listOpenPrompts()).toEqual([]);
	});

	test("SIGTERM maps to interrupted + TERMINATED", async () => {
		const store = createMemoryPromptStore();
		const ac = new AbortController();
		let cause: CliAbortCause | undefined;
		let inSleep!: () => void;
		const started = new Promise<void>((resolve) => {
			inSleep = resolve;
		});
		const pending = invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b", timeout: 10_000 },
				{
					store,
					isTTY: () => false,
					getAbortSignal: () => ac.signal,
					getAbortCause: () => cause,
					sleep: async () => {
						inSleep();
						await new Promise(() => {});
					},
				},
			),
		);
		await started;
		cause = "SIGTERM";
		ac.abort();
		const result = await pending;
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("TERMINATED");
		expect(result.error?.code).not.toBe("INTERRUPTED");
		expect(lastRecord(store)?.abandonReason).toBe("interrupted");
	});

	test("store writer: poll abort has no lifecycle cause → stored { choice }", async () => {
		const inner = createMemoryPromptStore();
		const result = await invoke(async () => {
			const pending = promptChoose(
				{ message: "Pick", options: "a,b", timeout: 10_000 },
				{
					store: inner,
					isTTY: () => false,
					pollIntervalMs: 10,
					sleep: () => Bun.sleep(5),
				},
			);
			await waitUntil(() => inner.listOpenPrompts().length === 1);
			const open = inner.listOpenPrompts()[0];
			if (!open) throw new Error("expected open prompt");
			inner.answerPrompt(open.id, "a", "control-plane");
			await pending;
		});
		expect(result.ok).toBe(true);
		expect(lastRecord(inner)?.answer).toBe("a");
		expect(lastRecord(inner)?.answeredBy).toBe("control-plane");
		expect(result.error).toBeUndefined();
	});
});

describe("no-TTY input pipe race", () => {
	test("hanging pipe + --timeout: pipe aborted, abandoned timeout, PROMPT_TIMEOUT", async () => {
		const store = createMemoryPromptStore();
		const observed: { signal?: AbortSignal } = {};
		let t = 0;
		const result = await invoke(() =>
			promptInput(
				{ message: "Enter", timeout: 50 },
				{
					store,
					isTTY: () => false,
					readStdinPipe: hangingPipe(observed),
					now: () => t,
					sleep: async () => {
						t += 100;
					},
				},
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("PROMPT_TIMEOUT");
		expect(observed.signal?.aborted).toBe(true);
		expect(lastRecord(store)?.abandonReason).toBe("timeout");
	});

	test("hanging pipe + store writer: pipe aborted, stored { input }", async () => {
		const inner = createMemoryPromptStore();
		const observed: { signal?: AbortSignal } = {};
		const result = await invoke(async () => {
			const pending = promptInput(
				{ message: "Enter" },
				{
					store: inner,
					isTTY: () => false,
					readStdinPipe: hangingPipe(observed),
					pollIntervalMs: 10,
					sleep: () => Bun.sleep(5),
				},
			);
			await waitUntil(() => inner.listOpenPrompts().length === 1);
			const open = inner.listOpenPrompts()[0];
			if (!open) throw new Error("expected open prompt");
			inner.answerPrompt(open.id, "from-store", "control-plane");
			await pending;
		});
		expect(result.ok).toBe(true);
		expect(lastRecord(inner)?.answer).toBe("from-store");
		expect(lastRecord(inner)?.answeredBy).toBe("control-plane");
		expect(observed.signal?.aborted).toBe(true);
	});
});

describe("timeout validation before createPrompt", () => {
	test.each([
		[-1, "--timeout -1"],
		[Number.NaN, "NaN"],
		[Number.POSITIVE_INFINITY, "Infinity"],
	])("timeout %s: INVALID_ARGS, no row", async (timeout) => {
		const store = createMemoryPromptStore();
		let created = 0;
		const wrapped = wrapStore(store, { onCreate: () => created++ });
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b", timeout },
				{ store: wrapped, isTTY: () => false },
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("INVALID_ARGS");
		expect(created).toBe(0);
	});

	test.each(["nope", "abc", "10ms"])(
		"FIVEX_PROMPT_TIMEOUT_MS=%s: INVALID_ARGS, no row",
		async (value) => {
			process.env[ENV_TIMEOUT] = value;
			const store = createMemoryPromptStore();
			let created = 0;
			const wrapped = wrapStore(store, { onCreate: () => created++ });
			const result = await invoke(() =>
				promptChoose(
					{ message: "Pick", options: "a,b" },
					{ store: wrapped, isTTY: () => false },
				),
			);
			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe("INVALID_ARGS");
			expect(created).toBe(0);
		},
	);
});

describe("--run via runExists", () => {
	test("unknown run: RUN_NOT_FOUND, no row", async () => {
		const store = createMemoryPromptStore();
		let created = 0;
		const wrapped = wrapStore(store, { onCreate: () => created++ });
		const result = await invoke(() =>
			promptChoose(
				{ message: "Pick", options: "a,b", run: "run_missing000" },
				{ store: wrapped, runExists: () => false, isTTY: () => false },
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("RUN_NOT_FOUND");
		expect(created).toBe(0);
	});

	test("known run: row created with that runId", async () => {
		const store = createMemoryPromptStore();
		const runId = "run_known000001";
		await invoke(() =>
			promptChoose(
				{
					message: "Pick",
					options: "a,b",
					default: "a",
					run: runId,
				},
				{ store, runExists: (id) => id === runId, isTTY: () => false },
			),
		);
		const record = lastRecord(store);
		expect(record?.runId).toBe(runId);
	});
});

describe("confirm/input equivalent persist+CAS", () => {
	test("confirm --default no-TTY: answeredBy default, { confirmed }", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptConfirm(
				{ message: "OK?", default: "yes" },
				{ store, isTTY: () => false },
			),
		);
		expect(result.ok).toBe(true);
		const record = lastRecord(store);
		expect(record?.answeredBy).toBe("default");
		expect(record?.answer).toBe("true");
		expect(record?.defaultValue).toBe("yes");
	});

	test("confirm no-TTY no default: abandoned non-interactive", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptConfirm({ message: "OK?" }, { store, isTTY: () => false }),
		);
		expect(result.error?.code).toBe("NON_INTERACTIVE");
		expect(lastRecord(store)?.abandonReason).toBe("non-interactive");
	});

	test("confirm TTY EOF without default: abandoned eof", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptConfirm(
				{ message: "OK?" },
				{
					store,
					isTTY: () => true,
					readLine: (async () => EOF) as typeof readLine,
				},
			),
		);
		expect(result.error?.code).toBe("EOF");
		expect(lastRecord(store)?.abandonReason).toBe("eof");
	});

	test("input no-TTY pipe value persists as terminal", async () => {
		const store = createMemoryPromptStore();
		const result = await invoke(() =>
			promptInput(
				{ message: "Enter" },
				{
					store,
					isTTY: () => false,
					readStdinPipe: (async () => "hello world\n") as typeof readStdinPipe,
				},
			),
		);
		expect(result.ok).toBe(true);
		const record = lastRecord(store);
		expect(record?.answeredBy).toBe("terminal");
		expect(record?.answer).toBe("hello world\n");
	});
});

describe("handler source isolation", () => {
	test("prompt.handler.ts does not import bun:sqlite, getRunV1, resolveDbContext, or prompt-context", async () => {
		const source = await Bun.file(
			join(import.meta.dir, "../../../src/commands/prompt.handler.ts"),
		).text();
		const importBlock = source
			.split("\n")
			.filter((line) => line.startsWith("import "))
			.join("\n");
		expect(importBlock).not.toContain("bun:sqlite");
		expect(importBlock).not.toMatch(/\bgetRunV1\b/);
		expect(importBlock).not.toMatch(/\bresolveDbContext\b/);
		expect(importBlock).not.toContain("prompt-context");
		expect(source).not.toMatch(/^import .*getRunV1/m);
		expect(source).not.toMatch(/^import .*resolveDbContext/m);
		expect(source).not.toMatch(/^import .*prompt-context/m);
		expect(source).not.toMatch(/^import .*bun:sqlite/m);
	});
});
