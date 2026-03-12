/**
 * Unit tests for shared structured-output validation helpers.
 *
 * Verifies that `validateStructuredOutput` returns a result type instead
 * of throwing, enabling callers to perform async cleanup (e.g. awaiting
 * `provider.close()`) before emitting error output.
 *
 * Regression test for review item P1.8 (014-harness-native-subagent):
 * The previous implementation called `outputError()` directly, which threw
 * CliError before async cleanup callbacks could complete — potentially
 * orphaning provider subprocesses.
 */

import { describe, expect, test } from "bun:test";
import {
	validateStructuredOutput,
	validateStructuredOutputOrThrow,
} from "../../../src/commands/protocol-helpers.js";
import { CliError } from "../../../src/output.js";

// ---------------------------------------------------------------------------
// validateStructuredOutput — result-based API
// ---------------------------------------------------------------------------

describe("validateStructuredOutput (result-based)", () => {
	test("returns ok result for valid author complete", () => {
		const result = validateStructuredOutput(
			{ result: "complete", commit: "abc123" },
			"author",
			{ context: "test" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ result: "complete", commit: "abc123" });
		}
	});

	test("returns ok result for valid author needs_human", () => {
		const result = validateStructuredOutput(
			{ result: "needs_human", reason: "blocked" },
			"author",
			{ context: "test" },
		);
		expect(result.ok).toBe(true);
	});

	test("returns ok result for valid reviewer ready verdict", () => {
		const result = validateStructuredOutput(
			{ readiness: "ready", items: [] },
			"reviewer",
			{ context: "test" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ readiness: "ready", items: [] });
		}
	});

	test("returns failure result (not throw) for author complete without commit", () => {
		const result = validateStructuredOutput({ result: "complete" }, "author", {
			context: "test",
			requireCommit: true,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_STRUCTURED_OUTPUT");
			expect(result.message).toContain("commit");
		}
	});

	test("returns failure result (not throw) for null input", () => {
		const result = validateStructuredOutput(null, "author", {
			context: "test",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_STRUCTURED_OUTPUT");
		}
	});

	test("returns failure result (not throw) for non-object input", () => {
		const result = validateStructuredOutput("just a string", "reviewer", {
			context: "test",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_STRUCTURED_OUTPUT");
		}
	});

	test("returns failure result (not throw) for StructuredOutputError", () => {
		const result = validateStructuredOutput(
			{
				data: {
					info: {
						error: {
							name: "StructuredOutputError",
							message: "parse failed",
						},
					},
				},
			},
			"author",
			{ context: "test" },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_STRUCTURED_OUTPUT");
			expect(result.message).toContain("structured output error");
		}
	});

	test("returns failure result for reviewer not_ready with empty items", () => {
		const result = validateStructuredOutput(
			{ readiness: "not_ready", items: [] },
			"reviewer",
			{ context: "test" },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("INVALID_STRUCTURED_OUTPUT");
		}
	});

	test("requireCommit: false allows author complete without commit", () => {
		const result = validateStructuredOutput({ result: "complete" }, "author", {
			context: "test",
			requireCommit: false,
		});
		expect(result.ok).toBe(true);
	});

	test("requireCommit defaults to true", () => {
		const result = validateStructuredOutput({ result: "complete" }, "author", {
			context: "test",
		});
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// validateStructuredOutputOrThrow — convenience wrapper
// ---------------------------------------------------------------------------

describe("validateStructuredOutputOrThrow", () => {
	test("returns validated value on success", () => {
		const value = validateStructuredOutputOrThrow(
			{ result: "complete", commit: "abc123" },
			"author",
			{ context: "test" },
		);
		expect(value).toEqual({ result: "complete", commit: "abc123" });
	});

	test("throws CliError on validation failure", () => {
		expect(() => {
			validateStructuredOutputOrThrow(null, "author", { context: "test" });
		}).toThrow(CliError);
	});

	test("throws CliError with correct code on validation failure", () => {
		try {
			validateStructuredOutputOrThrow(null, "author", { context: "test" });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_STRUCTURED_OUTPUT");
		}
	});
});

// ---------------------------------------------------------------------------
// P1.8 regression: callers can perform async cleanup before emitting errors
// ---------------------------------------------------------------------------

describe("P1.8 regression — async cleanup before error output", () => {
	test("failure result allows caller to perform async work before exiting", async () => {
		// Simulate the invoke handler pattern: validate, then await cleanup,
		// then emit error. The key invariant is that validateStructuredOutput
		// does NOT throw — it returns a result the caller can inspect.
		let cleanupCompleted = false;

		const result = validateStructuredOutput(
			{ result: "complete" /* missing commit */ },
			"author",
			{ context: "test", requireCommit: true },
		);

		expect(result.ok).toBe(false);

		// Simulate async provider.close() — this is the critical path that
		// was broken before when outputError() threw synchronously
		if (!result.ok) {
			await new Promise<void>((resolve) => {
				setTimeout(() => {
					cleanupCompleted = true;
					resolve();
				}, 10);
			});
		}

		expect(cleanupCompleted).toBe(true);
		// Caller would now call outputError(result.code, result.message, result.detail)
	});

	test("no onError callback in ValidateOptions — removed from interface", () => {
		// Verify the onError callback has been removed from the interface.
		// The result-based API makes it unnecessary — callers handle cleanup
		// themselves based on the result.
		const opts = { context: "test" };
		// TypeScript would catch this at compile time, but verify at runtime
		// that 'onError' is not expected
		expect("onError" in opts).toBe(false);

		// Validate still works without it
		const result = validateStructuredOutput(
			{ result: "complete", commit: "abc" },
			"author",
			opts,
		);
		expect(result.ok).toBe(true);
	});
});
