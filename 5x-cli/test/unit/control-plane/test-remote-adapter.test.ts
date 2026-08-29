/**
 * Unit tests for the synthetic test-remote cancellation adapter.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	_resetCancellationAdaptersForTest,
	createTestRemoteAdapter,
	getCancellationAdapter,
	registerCancellationAdapter,
} from "../../../src/control-plane/index.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
	_resetCancellationAdaptersForTest();
});

describe("createTestRemoteAdapter", () => {
	test("name is test-remote", () => {
		expect(createTestRemoteAdapter().name).toBe("test-remote");
	});

	test("allocateJob ref is job- + uuid, not a PID", () => {
		const adapter = createTestRemoteAdapter();
		const { handle } = adapter.allocateJob();
		expect(handle.adapter).toBe("test-remote");
		expect(handle.ref.startsWith("job-")).toBe(true);
		const uuid = handle.ref.slice("job-".length);
		expect(uuid).toMatch(UUID_RE);
		expect(handle.ref).not.toBe(String(process.pid));
		expect(Number.isFinite(Number(handle.ref))).toBe(false);
	});

	test("handle JSON has no pid key", () => {
		const { handle } = createTestRemoteAdapter().allocateJob();
		expect(handle).not.toHaveProperty("pid");
		const encoded = JSON.stringify(handle);
		expect(JSON.parse(encoded)).toEqual({
			adapter: "test-remote",
			ref: handle.ref,
		});
		expect(encoded).not.toContain("pid");
	});

	test("unknown handle fails", async () => {
		const adapter = createTestRemoteAdapter();
		const result = await adapter.cancel({
			adapter: "test-remote",
			ref: "job-00000000-0000-4000-8000-000000000000",
		});
		expect(result).toEqual({
			outcome: "failed",
			error: "unknown handle",
		});
		expect(adapter.cancelCalls).toBe(1);
	});

	test("wrong adapter field fails", async () => {
		const adapter = createTestRemoteAdapter();
		const { handle } = adapter.allocateJob();
		const result = await adapter.cancel({
			adapter: "other",
			ref: handle.ref,
		});
		expect(result.outcome).toBe("failed");
		expect(adapter.cancelCalls).toBe(1);
	});

	test("abort signal fires on success", async () => {
		const adapter = createTestRemoteAdapter();
		const { handle, signal } = adapter.allocateJob();
		expect(signal.aborted).toBe(false);
		const result = await adapter.cancel(handle);
		expect(result).toEqual({ outcome: "succeeded" });
		expect(signal.aborted).toBe(true);
		expect(adapter.cancelCalls).toBe(1);
	});

	test("second cancel on the same handle is safe", async () => {
		const adapter = createTestRemoteAdapter();
		const { handle, signal } = adapter.allocateJob();
		await adapter.cancel(handle);
		const second = await adapter.cancel(handle);
		expect(second).toEqual({ outcome: "succeeded" });
		expect(signal.aborted).toBe(true);
		expect(adapter.cancelCalls).toBe(2);
	});
});

describe("cancellation adapter registry", () => {
	test("register then get returns the adapter", () => {
		const adapter = createTestRemoteAdapter();
		registerCancellationAdapter(adapter);
		expect(getCancellationAdapter("test-remote")).toBe(adapter);
	});

	test("unknown name is undefined", () => {
		expect(getCancellationAdapter("missing")).toBeUndefined();
	});
});
