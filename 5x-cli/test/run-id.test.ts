/**
 * Unit tests for run ID generation and validation.
 */

import { describe, expect, test } from "bun:test";
import { CliError } from "../src/output.js";
import { generateRunId, SAFE_RUN_ID, validateRunId } from "../src/run-id.js";

// ---------------------------------------------------------------------------
// generateRunId
// ---------------------------------------------------------------------------

describe("generateRunId", () => {
	test("produces run_ prefix + 12 hex chars", () => {
		const id = generateRunId();
		expect(id).toMatch(/^run_[0-9a-f]{12}$/);
	});

	test("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
		expect(ids.size).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// SAFE_RUN_ID regex
// ---------------------------------------------------------------------------

describe("SAFE_RUN_ID", () => {
	test("matches single alphanumeric char (length 1)", () => {
		expect(SAFE_RUN_ID.test("a")).toBe(true);
		expect(SAFE_RUN_ID.test("Z")).toBe(true);
		expect(SAFE_RUN_ID.test("0")).toBe(true);
	});

	test("matches 64-char string (max length)", () => {
		const id = "a".repeat(64);
		expect(SAFE_RUN_ID.test(id)).toBe(true);
	});

	test("rejects 65-char string (exceeds max)", () => {
		const id = "a".repeat(65);
		expect(SAFE_RUN_ID.test(id)).toBe(false);
	});

	test("allows underscores and hyphens after first char", () => {
		expect(SAFE_RUN_ID.test("run_abc123")).toBe(true);
		expect(SAFE_RUN_ID.test("run-abc-123")).toBe(true);
		expect(SAFE_RUN_ID.test("a_-_-_b")).toBe(true);
	});

	test("rejects empty string", () => {
		expect(SAFE_RUN_ID.test("")).toBe(false);
	});

	test("rejects leading hyphen", () => {
		expect(SAFE_RUN_ID.test("-abc")).toBe(false);
	});

	test("rejects leading underscore", () => {
		expect(SAFE_RUN_ID.test("_abc")).toBe(false);
	});

	test("rejects dots", () => {
		expect(SAFE_RUN_ID.test("run.123")).toBe(false);
		expect(SAFE_RUN_ID.test("a.b")).toBe(false);
	});

	test("rejects slashes (path traversal)", () => {
		expect(SAFE_RUN_ID.test("../etc")).toBe(false);
		expect(SAFE_RUN_ID.test("a/b")).toBe(false);
		expect(SAFE_RUN_ID.test("foo/bar")).toBe(false);
	});

	test("rejects spaces", () => {
		expect(SAFE_RUN_ID.test("run 123")).toBe(false);
	});

	test("rejects special characters", () => {
		expect(SAFE_RUN_ID.test("run@123")).toBe(false);
		expect(SAFE_RUN_ID.test("run!abc")).toBe(false);
		expect(SAFE_RUN_ID.test("run#xyz")).toBe(false);
	});

	test("accepts typical generated run IDs", () => {
		// Pattern: run_ + 12 hex chars
		expect(SAFE_RUN_ID.test("run_abcdef012345")).toBe(true);
		expect(SAFE_RUN_ID.test("run_000000000000")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validateRunId
// ---------------------------------------------------------------------------

describe("validateRunId", () => {
	test("accepts valid run IDs without throwing", () => {
		expect(() => validateRunId("run_abc123")).not.toThrow();
		expect(() => validateRunId("a")).not.toThrow();
		expect(() => validateRunId("A")).not.toThrow();
		expect(() => validateRunId("0")).not.toThrow();
		expect(() => validateRunId("a".repeat(64))).not.toThrow();
		expect(() => validateRunId("run-test-123")).not.toThrow();
	});

	test("throws CliError with INVALID_ARGS for empty string", () => {
		expect(() => validateRunId("")).toThrow(CliError);
		try {
			validateRunId("");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
		}
	});

	test("throws CliError for path traversal attempts", () => {
		expect(() => validateRunId("../../../etc/passwd")).toThrow(CliError);
		expect(() => validateRunId("foo/bar")).toThrow(CliError);
	});

	test("throws CliError for leading hyphen", () => {
		expect(() => validateRunId("-abc")).toThrow(CliError);
	});

	test("throws CliError for dots", () => {
		expect(() => validateRunId("run.123")).toThrow(CliError);
	});

	test("throws CliError for exceeding max length", () => {
		expect(() => validateRunId("a".repeat(65))).toThrow(CliError);
	});

	test("error message includes the invalid value", () => {
		try {
			validateRunId("bad/id");
		} catch (err) {
			expect((err as CliError).message).toContain("bad/id");
		}
	});
});
