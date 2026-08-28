/**
 * Unit tests for invocation IDs, actor validation, and opaque handle parsing.
 */

import { describe, expect, test } from "bun:test";
import {
	createInvocationId,
	InvocationStoreError,
	isCancellationActor,
	parseOpaqueCancellationHandle,
} from "../../../src/control-plane/index.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createInvocationId", () => {
	test("returns an RFC 4122 UUID", () => {
		expect(createInvocationId()).toMatch(UUID_RE);
	});

	test("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 50 }, () => createInvocationId()));
		expect(ids.size).toBe(50);
	});
});

describe("isCancellationActor", () => {
	test("accepts cli and control-plane", () => {
		expect(isCancellationActor("cli")).toBe(true);
		expect(isCancellationActor("control-plane")).toBe(true);
	});

	test("rejects other values", () => {
		expect(isCancellationActor("dashboard")).toBe(false);
		expect(isCancellationActor("CLI")).toBe(false);
		expect(isCancellationActor("")).toBe(false);
		expect(isCancellationActor(null)).toBe(false);
		expect(isCancellationActor(undefined)).toBe(false);
	});
});

describe("parseOpaqueCancellationHandle", () => {
	test("parses adapter and ref from an object", () => {
		expect(
			parseOpaqueCancellationHandle({ adapter: "test-remote", ref: "job-1" }),
		).toEqual({ adapter: "test-remote", ref: "job-1" });
	});

	test("parses adapter and ref from JSON", () => {
		expect(
			parseOpaqueCancellationHandle(
				JSON.stringify({ adapter: "test-remote", ref: "job-abc" }),
			),
		).toEqual({ adapter: "test-remote", ref: "job-abc" });
	});

	test("result has no pid key", () => {
		const handle = parseOpaqueCancellationHandle({
			adapter: "test-remote",
			ref: "job-1",
		});
		expect(handle).not.toHaveProperty("pid");
		expect(JSON.stringify(handle)).not.toContain("pid");
	});

	test("rejects a pid key", () => {
		expect(() =>
			parseOpaqueCancellationHandle({
				adapter: "test-remote",
				ref: "job-1",
				pid: 1234,
			}),
		).toThrow(InvocationStoreError);
		try {
			parseOpaqueCancellationHandle({
				adapter: "local",
				ref: "job-1",
				pid: process.pid,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(InvocationStoreError);
			expect((err as InvocationStoreError).code).toBe(
				"INVOCATION_INVALID_HANDLE",
			);
		}
	});

	test("rejects missing adapter or ref", () => {
		expect(() => parseOpaqueCancellationHandle({ adapter: "x" })).toThrow(
			InvocationStoreError,
		);
		expect(() => parseOpaqueCancellationHandle({ ref: "job-1" })).toThrow(
			InvocationStoreError,
		);
		expect(() =>
			parseOpaqueCancellationHandle({ adapter: "", ref: "a" }),
		).toThrow(InvocationStoreError);
	});

	test("rejects invalid JSON and non-objects", () => {
		expect(() => parseOpaqueCancellationHandle("{")).toThrow(
			InvocationStoreError,
		);
		expect(() => parseOpaqueCancellationHandle(null)).toThrow(
			InvocationStoreError,
		);
		expect(() => parseOpaqueCancellationHandle(["test-remote"])).toThrow(
			InvocationStoreError,
		);
	});
});
