/**
 * Unit tests for withInvocationLifecycle — terminal status, heartbeat
 * rate-limit, independent timer liveness, and timer cleanup.
 */

import { describe, expect, test } from "bun:test";
import {
	createMemoryInvocationStore,
	INVOCATION_HEARTBEAT_MIN_INTERVAL_MS,
	INVOCATION_STALE_MS,
	type InvocationStore,
	type RegisterInvocationInput,
	withInvocationLifecycle,
} from "../../../src/control-plane/index.js";

function registerInput(
	overrides: Partial<RegisterInvocationInput> = {},
): RegisterInvocationInput {
	return {
		runId: "run_lifecycle",
		sessionId: "sess-1",
		role: "author",
		providerName: "sample",
		templateName: "author-next-phase",
		handle: { adapter: "none", ref: "sess-1" },
		cancellationSupported: false,
		...overrides,
	};
}

function sqliteUtc(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function createFakeInterval(): {
	handles: Array<{ cb: () => void; cleared: boolean }>;
	setIntervalFn: typeof setInterval;
	clearIntervalFn: typeof clearInterval;
	clearedCount: () => number;
} {
	const handles: Array<{ cb: () => void; cleared: boolean }> = [];
	const setIntervalFn = ((cb: () => void) => {
		const handle = { cb, cleared: false };
		handles.push(handle);
		return handle as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	const clearIntervalFn = ((timer: ReturnType<typeof setInterval>) => {
		const handle = timer as unknown as {
			cb: () => void;
			cleared: boolean;
		};
		handle.cleared = true;
	}) as typeof clearInterval;
	return {
		handles,
		setIntervalFn,
		clearIntervalFn,
		clearedCount: () => handles.filter((h) => h.cleared).length,
	};
}

function wrapHeartbeatSpy(inner: InvocationStore): {
	store: InvocationStore;
	calls: string[];
} {
	const calls: string[] = [];
	const store: InvocationStore = {
		register: (input) => inner.register(input),
		get: (id) => inner.get(id),
		list: (filter) => inner.list(filter),
		heartbeat: (id) => {
			calls.push(id);
			return inner.heartbeat(id);
		},
		markCancellationRequested: (id, actor) =>
			inner.markCancellationRequested(id, actor),
		recordCancellationOutcome: (id, outcome) =>
			inner.recordCancellationOutcome(id, outcome),
		markTerminal: (id, status) => inner.markTerminal(id, status),
		markAbandoned: (id, reason) => inner.markAbandoned(id, reason),
		markAbandonedIfStale: (opts) => inner.markAbandonedIfStale(opts),
		listStale: (opts) => inner.listStale(opts),
	};
	return { store, calls };
}

describe("withInvocationLifecycle", () => {
	test("fn returns → completed", async () => {
		const store = createMemoryInvocationStore();
		const result = await withInvocationLifecycle({
			store,
			input: registerInput(),
			fn: async ({ invocation }) => {
				expect(invocation.status).toBe("running");
				return 42;
			},
		});
		expect(result).toBe(42);
		const rows = store.list({ runId: "run_lifecycle" });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("completed");
		expect(rows[0]?.terminalAt).not.toBeNull();
	});

	test("fn throws Error → failed and error propagates", async () => {
		const store = createMemoryInvocationStore();
		await expect(
			withInvocationLifecycle({
				store,
				input: registerInput(),
				fn: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");
		expect(store.list()[0]?.status).toBe("failed");
	});

	test("fn throws AgentCancellationError → cancelled", async () => {
		const store = createMemoryInvocationStore();
		await expect(
			withInvocationLifecycle({
				store,
				input: registerInput(),
				fn: async () => {
					throw { name: "AgentCancellationError" };
				},
			}),
		).rejects.toEqual({ name: "AgentCancellationError" });
		expect(store.list()[0]?.status).toBe("cancelled");
	});

	test("fn throws after markAbandoned → status stays abandoned", async () => {
		const store = createMemoryInvocationStore();
		await expect(
			withInvocationLifecycle({
				store,
				input: registerInput(),
				fn: async ({ invocation }) => {
					const cas = store.markAbandoned(invocation.id, "stale-metadata");
					expect(cas.ok).toBe(true);
					throw new Error("still running work exploded");
				},
			}),
		).rejects.toThrow("still running work exploded");
		expect(store.list()[0]?.status).toBe("abandoned");
		expect(store.list()[0]?.abandonReason).toBe("stale-metadata");
	});

	test("finally marks failed when try/catch left the row running", async () => {
		const inner = createMemoryInvocationStore();
		let skipNextCompleted = true;
		const store: InvocationStore = {
			register: (input) => inner.register(input),
			get: (id) => inner.get(id),
			list: (filter) => inner.list(filter),
			heartbeat: (id) => inner.heartbeat(id),
			markCancellationRequested: (id, actor) =>
				inner.markCancellationRequested(id, actor),
			recordCancellationOutcome: (id, outcome) =>
				inner.recordCancellationOutcome(id, outcome),
			markTerminal: (id, status) => {
				if (skipNextCompleted && status === "completed") {
					skipNextCompleted = false;
					const current = inner.get(id);
					if (!current) throw new Error("missing");
					return { ok: true, invocation: current };
				}
				return inner.markTerminal(id, status);
			},
			markAbandoned: (id, reason) => inner.markAbandoned(id, reason),
			markAbandonedIfStale: (opts) => inner.markAbandonedIfStale(opts),
			listStale: (opts) => inner.listStale(opts),
		};
		await withInvocationLifecycle({
			store,
			input: registerInput(),
			fn: async () => "ok",
		});
		expect(store.list()[0]?.status).toBe("failed");
	});

	test("fn throws before any heartbeat → failed not running", async () => {
		const { store, calls } = wrapHeartbeatSpy(createMemoryInvocationStore());
		const timers = createFakeInterval();
		await expect(
			withInvocationLifecycle({
				store,
				input: registerInput(),
				setIntervalFn: timers.setIntervalFn,
				clearIntervalFn: timers.clearIntervalFn,
				fn: async () => {
					throw new Error("pre-stream");
				},
			}),
		).rejects.toThrow("pre-stream");
		expect(calls).toHaveLength(0);
		expect(store.list()[0]?.status).toBe("failed");
		expect(store.list()[0]?.status).not.toBe("running");
	});

	test("heartbeat rate-limit: three calls within 5s → one store.heartbeat", async () => {
		const { store, calls } = wrapHeartbeatSpy(createMemoryInvocationStore());
		const t = 1_000_000;
		const timers = createFakeInterval();
		await withInvocationLifecycle({
			store,
			input: registerInput(),
			now: () => t,
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			fn: async ({ heartbeat }) => {
				heartbeat();
				heartbeat();
				heartbeat();
			},
		});
		expect(calls).toHaveLength(1);
	});

	test("heartbeat rate-limit allows a second beat after the min interval", async () => {
		const { store, calls } = wrapHeartbeatSpy(createMemoryInvocationStore());
		let t = 1_000_000;
		const timers = createFakeInterval();
		await withInvocationLifecycle({
			store,
			input: registerInput(),
			now: () => t,
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			fn: async ({ heartbeat }) => {
				heartbeat();
				t += INVOCATION_HEARTBEAT_MIN_INTERVAL_MS;
				heartbeat();
			},
		});
		expect(calls).toHaveLength(2);
	});

	test("silent invocation stays non-stale past INVOCATION_STALE_MS via timer", async () => {
		let nowMs = Date.parse("2026-08-28T12:00:00.000Z");
		const store = createMemoryInvocationStore({
			now: () => sqliteUtc(nowMs),
		});
		const control = store.register(
			registerInput({
				id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				sessionId: "control",
				handle: { adapter: "none", ref: "control" },
			}),
		);
		const timers = createFakeInterval();
		let resolveFn!: () => void;
		const gate = new Promise<void>((resolve) => {
			resolveFn = resolve;
		});
		const done = withInvocationLifecycle({
			store,
			input: registerInput({
				id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				sessionId: "live",
				handle: { adapter: "none", ref: "live" },
			}),
			now: () => nowMs,
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			fn: async () => {
				await gate;
				return "ok";
			},
		});

		nowMs += INVOCATION_STALE_MS + 1;
		expect(timers.handles).toHaveLength(1);
		timers.handles[0]?.cb();

		const stale = store.listStale({
			olderThanMs: INVOCATION_STALE_MS,
			nowMs,
		});
		expect(stale.map((row) => row.id)).toEqual([control.id]);
		expect(stale.some((row) => row.sessionId === "live")).toBe(false);

		resolveFn();
		await done;
		expect(store.get("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")?.status).toBe(
			"completed",
		);
		expect(timers.clearedCount()).toBe(1);
	});

	test("timer cleared on error; further ticks do not heartbeat", async () => {
		let nowMs = Date.parse("2026-08-28T12:00:00.000Z");
		const { store, calls } = wrapHeartbeatSpy(
			createMemoryInvocationStore({ now: () => sqliteUtc(nowMs) }),
		);
		const timers = createFakeInterval();
		let rejectFn!: (err: Error) => void;
		const gate = new Promise<void>((_resolve, reject) => {
			rejectFn = reject;
		});
		const done = withInvocationLifecycle({
			store,
			input: registerInput(),
			now: () => nowMs,
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
			fn: async () => {
				await gate;
			},
		});

		rejectFn(new Error("stream died"));
		await expect(done).rejects.toThrow("stream died");
		expect(store.list()[0]?.status).toBe("failed");
		expect(timers.clearedCount()).toBe(1);

		const beatsBefore = calls.length;
		nowMs += INVOCATION_HEARTBEAT_MIN_INTERVAL_MS;
		timers.handles[0]?.cb();
		expect(calls.length).toBe(beatsBefore);
	});
});
