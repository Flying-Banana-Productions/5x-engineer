/**
 * Unit tests for requestInvocationCancellation and invocation view helpers.
 *
 * Action tests do not open `runs`; invoke-registry handler tests and
 * integration tests assert that unsupported cancel leaves
 * `getRunV1().status === "active"`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { CancellationAdapter } from "../../../src/control-plane/cancellation-adapter.js";
import {
	_resetCancellationAdaptersForTest,
	CANCELLATION_UNSUPPORTED,
	createMemoryInvocationStore,
	createTestRemoteAdapter,
	getInvocationView,
	INVOCATION_INVALID_ACTOR,
	INVOCATION_NOT_FOUND,
	listInvocationViews,
	type RegisterInvocationInput,
	requestInvocationCancellation,
} from "../../../src/control-plane/index.js";
import type { CancellationActor } from "../../../src/control-plane/invocation-types.js";

const RUN_A = "run_aaaaaaaaaaaa";
const RUN_B = "run_bbbbbbbbbbbb";

function register(
	store: ReturnType<typeof createMemoryInvocationStore>,
	overrides: Partial<RegisterInvocationInput> = {},
) {
	return store.register({
		runId: RUN_A,
		sessionId: "sess-1",
		role: "author",
		providerName: "sample",
		templateName: "author-next-phase",
		handle: { adapter: "none", ref: "sess-1" },
		cancellationSupported: false,
		...overrides,
	});
}

afterEach(() => {
	_resetCancellationAdaptersForTest();
});

describe("requestInvocationCancellation", () => {
	test("invalid actor rejected; requested_at unchanged", async () => {
		const store = createMemoryInvocationStore();
		const row = register(store, {
			cancellationSupported: true,
			handle: { adapter: "test-remote", ref: "job-1" },
		});
		const result = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "dashboard" as CancellationActor,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe(INVOCATION_INVALID_ACTOR);
		const current = store.get(row.id);
		expect(current?.cancellationRequestedAt).toBeNull();
		expect(current?.status).toBe("running");
	});

	test("unsupported capability: CANCELLATION_UNSUPPORTED; running; requested_at null", async () => {
		const store = createMemoryInvocationStore();
		const row = register(store, { cancellationSupported: false });
		const result = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "cli",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe(CANCELLATION_UNSUPPORTED);
		expect(result.view?.status).toBe("running");
		const current = store.get(row.id);
		expect(current?.status).toBe("running");
		expect(current?.cancellationRequestedAt).toBeNull();
		expect(current?.cancellationRequestedBy).toBeNull();
	});

	test("synthetic adapter: first cancel calls adapter once; clientState cancellation-requested", async () => {
		const store = createMemoryInvocationStore();
		const adapter = createTestRemoteAdapter();
		const { handle } = adapter.allocateJob();
		const row = register(store, {
			cancellationSupported: true,
			handle,
		});
		const result = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "cli",
			getAdapter: () => adapter,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.adapterCalled).toBe(true);
		expect(result.view.cancellation.outcome).toBe("succeeded");
		expect(result.view.clientState).toBe("cancellation-requested");
		expect(result.view.status).toBe("running");
		expect(adapter.cancelCalls).toBe(1);
		expect(store.get(row.id)?.cancellationRequestedBy).toBe("cli");
	});

	test("second cancel is idempotent: adapterCalled false; cancelCalls stays 1", async () => {
		const store = createMemoryInvocationStore();
		const adapter = createTestRemoteAdapter();
		const { handle } = adapter.allocateJob();
		const row = register(store, {
			cancellationSupported: true,
			handle,
		});
		await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "cli",
			getAdapter: () => adapter,
		});
		const second = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "cli",
			getAdapter: () => adapter,
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.adapterCalled).toBe(false);
		expect(adapter.cancelCalls).toBe(1);
		expect(second.view.clientState).toBe("cancellation-requested");
	});

	test("adapter returns failed: outcome failed; still running; adapterCalled true", async () => {
		const store = createMemoryInvocationStore();
		const adapter: CancellationAdapter = {
			name: "fail-return",
			cancel: async () => ({ outcome: "failed", error: "remote refused" }),
		};
		const row = register(store, {
			cancellationSupported: true,
			handle: { adapter: "fail-return", ref: "job-fail" },
		});
		const result = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "control-plane",
			getAdapter: () => adapter,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.adapterCalled).toBe(true);
		expect(result.view.cancellation.outcome).toBe("failed");
		expect(result.view.status).toBe("running");
		expect(result.view.clientState).toBe("cancellation-requested");
		expect(store.get(row.id)?.cancellationRequestedBy).toBe("control-plane");
	});

	test("adapter throws: ok true; outcome failed; requested_at set; exception does not propagate", async () => {
		const store = createMemoryInvocationStore();
		let cancelCalls = 0;
		const adapter: CancellationAdapter = {
			name: "thrower",
			cancel: async () => {
				cancelCalls++;
				throw new Error("adapter exploded");
			},
		};
		const row = register(store, {
			cancellationSupported: true,
			handle: { adapter: "thrower", ref: "job-throw" },
		});
		const result = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "cli",
			getAdapter: () => adapter,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.adapterCalled).toBe(true);
		expect(result.view.cancellation.outcome).toBe("failed");
		expect(result.view.status).toBe("running");
		expect(store.get(row.id)?.cancellationRequestedAt).not.toBeNull();
		expect(cancelCalls).toBe(1);
	});

	test("missing adapter on supported row: outcome unsupported; adapterCalled false", async () => {
		const store = createMemoryInvocationStore();
		const row = register(store, {
			cancellationSupported: true,
			handle: { adapter: "missing-adapter", ref: "job-x" },
		});
		const result = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "cli",
			getAdapter: () => undefined,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.adapterCalled).toBe(false);
		expect(result.view.cancellation.outcome).toBe("unsupported");
		expect(result.view.status).toBe("running");
		expect(result.view.clientState).toBe("cancellation-requested");
		expect(store.get(row.id)?.cancellationRequestedAt).not.toBeNull();
	});

	test("terminal completed: ok true, adapter not called", async () => {
		const store = createMemoryInvocationStore();
		const adapter = createTestRemoteAdapter();
		const { handle } = adapter.allocateJob();
		const row = register(store, {
			cancellationSupported: true,
			handle,
		});
		store.markTerminal(row.id, "completed");
		const result = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "cli",
			getAdapter: () => adapter,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.adapterCalled).toBe(false);
		expect(result.view.status).toBe("completed");
		expect(adapter.cancelCalls).toBe(0);
	});

	test("terminal completed with unsupported capability is idempotent success", async () => {
		const store = createMemoryInvocationStore();
		const row = register(store, { cancellationSupported: false });
		store.markTerminal(row.id, "completed");
		const result = await requestInvocationCancellation({
			store,
			id: row.id,
			actor: "cli",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.adapterCalled).toBe(false);
		expect(result.view.status).toBe("completed");
		expect(store.get(row.id)?.cancellationRequestedAt).toBeNull();
	});

	test("missing id: INVOCATION_NOT_FOUND", async () => {
		const store = createMemoryInvocationStore();
		const result = await requestInvocationCancellation({
			store,
			id: "00000000-0000-4000-8000-000000000000",
			actor: "cli",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe(INVOCATION_NOT_FOUND);
	});
});

describe("getInvocationView / listInvocationViews", () => {
	test("get maps a record and omits handle", () => {
		const store = createMemoryInvocationStore();
		const row = register(store);
		const view = getInvocationView(store, row.id);
		expect(view?.id).toBe(row.id);
		expect(view?.runId).toBe(RUN_A);
		expect(view?.clientState).toBe("unsupported");
		expect(view).not.toHaveProperty("handle");
		expect(view).not.toHaveProperty("pid");
		expect(getInvocationView(store, "missing")).toBeNull();
	});

	test("list filters by runId", () => {
		const store = createMemoryInvocationStore();
		const a = register(store, { runId: RUN_A });
		register(store, {
			runId: RUN_B,
			handle: { adapter: "none", ref: "sess-b" },
		});
		const views = listInvocationViews(store, { runId: RUN_A });
		expect(views).toHaveLength(1);
		expect(views[0]?.id).toBe(a.id);
	});
});
