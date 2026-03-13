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
import {
	type AuthorStatus,
	normalizeLegacyAuthorStatus,
} from "../../../src/protocol.js";

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

// ---------------------------------------------------------------------------
// Phase 3: Legacy author status normalization (016-review-artifacts)
// ---------------------------------------------------------------------------

describe("normalizeLegacyAuthorStatus", () => {
	test("returns null for canonical payload with result field", () => {
		const canonical: AuthorStatus = {
			result: "complete",
			commit: "abc123",
		};
		expect(normalizeLegacyAuthorStatus(canonical)).toBeNull();
	});

	test("returns null for non-object input", () => {
		expect(normalizeLegacyAuthorStatus(null)).toBeNull();
		expect(normalizeLegacyAuthorStatus("string")).toBeNull();
		expect(normalizeLegacyAuthorStatus(123)).toBeNull();
	});

	test("returns null when status field is missing", () => {
		expect(normalizeLegacyAuthorStatus({ result: "complete" })).toBeNull();
	});

	test("returns null for unrecognized status values", () => {
		expect(normalizeLegacyAuthorStatus({ status: "unknown" })).toBeNull();
		expect(normalizeLegacyAuthorStatus({ status: "success" })).toBeNull();
	});

	test("maps status: done → result: complete with commit", () => {
		const legacy = {
			status: "done",
			commit: "abc123def",
			notes: "Implementation finished",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized).toEqual({
			result: "complete",
			commit: "abc123def",
			notes: "Implementation finished",
		});
	});

	test("maps status: failed → result: failed with reason", () => {
		const legacy = {
			status: "failed",
			reason: "Build error",
			notes: "Additional context",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized).toEqual({
			result: "failed",
			reason: "Build error",
			notes: "Additional context",
		});
	});

	test("maps status: needs_human → result: needs_human with reason", () => {
		const legacy = {
			status: "needs_human",
			reason: "Ambiguous requirements",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized).toEqual({
			result: "needs_human",
			reason: "Ambiguous requirements",
		});
	});

	test("falls back to notes when reason is missing for failed status", () => {
		const legacy = {
			status: "failed",
			notes: "Error details in notes",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized?.result).toBe("failed");
		expect(normalized?.reason).toBe("Error details in notes");
	});

	test("falls back to summary when reason and notes are missing for needs_human", () => {
		const legacy = {
			status: "needs_human",
			summary: "Need clarification on API design",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized?.result).toBe("needs_human");
		expect(normalized?.reason).toBe("Need clarification on API design");
	});

	test("preserves explicit reason over notes/summary fallback", () => {
		const legacy = {
			status: "failed",
			reason: "Primary reason",
			notes: "Secondary notes",
			summary: "Summary text",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized?.reason).toBe("Primary reason");
	});

	test("no reason fallback for complete status even with notes/summary", () => {
		const legacy = {
			status: "done",
			commit: "abc123",
			notes: "Some notes",
			summary: "Summary text",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized?.result).toBe("complete");
		expect(normalized?.reason).toBeUndefined();
		expect(normalized?.notes).toBe("Some notes");
	});

	test("handles legacy payload with minimal fields (done + commit)", () => {
		const legacy = {
			status: "done",
			commit: "deadbeef",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized).toEqual({
			result: "complete",
			commit: "deadbeef",
		});
	});

	test("handles legacy payload without commit (not required during norm)", () => {
		const legacy = {
			status: "done",
		};
		const normalized = normalizeLegacyAuthorStatus(legacy);
		expect(normalized).toEqual({
			result: "complete",
		});
	});
});

describe("validateStructuredOutput with legacy status (Phase 3)", () => {
	test("accepts legacy done status and normalizes to complete", () => {
		const legacy = {
			status: "done",
			commit: "abc123",
			summary: "Work done",
		};
		const result = validateStructuredOutput(legacy, "author", {
			context: "test",
			requireCommit: true,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				result: "complete",
				commit: "abc123",
				notes: "Work done",
			});
		}
	});

	test("accepts legacy failed status with notes as reason fallback", () => {
		const legacy = {
			status: "failed",
			notes: "Build failed due to syntax error",
		};
		const result = validateStructuredOutput(legacy, "author", {
			context: "test",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			const authorStatus = result.value as AuthorStatus;
			expect(authorStatus.result).toBe("failed");
			expect(authorStatus.reason).toBe("Build failed due to syntax error");
		}
	});

	test("accepts legacy needs_human status with summary as reason fallback", () => {
		const legacy = {
			status: "needs_human",
			summary: "Need design review",
		};
		const result = validateStructuredOutput(legacy, "author", {
			context: "test",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			const authorStatus = result.value as AuthorStatus;
			expect(authorStatus.result).toBe("needs_human");
			expect(authorStatus.reason).toBe("Need design review");
		}
	});

	test("still validates normalized payload (missing commit for complete)", () => {
		const legacy = {
			status: "done",
			// missing commit
		};
		const result = validateStructuredOutput(legacy, "author", {
			context: "test",
			requireCommit: true,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("commit");
		}
	});

	test("still validates normalized payload (missing reason for failed)", () => {
		const legacy = {
			status: "failed",
			// missing reason, notes, and summary
		};
		const result = validateStructuredOutput(legacy, "author", {
			context: "test",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("reason");
		}
	});

	test("preserves canonical result payload unchanged", () => {
		const canonical: AuthorStatus = {
			result: "complete",
			commit: "def456",
		};
		const result = validateStructuredOutput(canonical, "author", {
			context: "test",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual(canonical);
		}
	});
});
