/**
 * Unit tests for protocol emit handler.
 *
 * Tests the handler functions directly by capturing stdout writes.
 * Error cases are tested by catching CliError thrown by outputError().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	protocolEmitAuthor,
	protocolEmitReviewer,
} from "../../../src/commands/protocol-emit.handler.js";
import { CliError } from "../../../src/output.js";

// ---------------------------------------------------------------------------
// stdout capture
// ---------------------------------------------------------------------------

let stdoutData: string;
const originalWrite = process.stdout.write;

beforeEach(() => {
	stdoutData = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdoutData +=
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
});

function parseOutput(): Record<string, unknown> {
	return JSON.parse(stdoutData) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reviewer emit
// ---------------------------------------------------------------------------

describe("protocolEmitReviewer", () => {
	test("--ready with no items → ready", async () => {
		await protocolEmitReviewer({ ready: true });
		const result = parseOutput();
		expect(result.readiness).toBe("ready");
		expect(result.items).toEqual([]);
	});

	test("addressed prior outcomes remain separate from correction items", async () => {
		await protocolEmitReviewer({
			ready: true,
			priorFinding: [JSON.stringify({ id: "P1.1", status: "addressed" })],
		});
		const result = parseOutput();
		expect(result.readiness).toBe("ready");
		expect(result.items).toEqual([]);
		expect(result.priorFindings).toEqual([{ id: "P1.1", status: "addressed" }]);
	});

	test("--ready with items → ready_with_corrections", async () => {
		await protocolEmitReviewer({
			ready: true,
			item: ['{"title":"Fix X","action":"auto_fix","reason":"Broken"}'],
		});
		const result = parseOutput();
		expect(result.readiness).toBe("ready_with_corrections");
		const items = result.items as Array<Record<string, unknown>>;
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe("Fix X");
	});

	test("--no-ready with items → not_ready", async () => {
		await protocolEmitReviewer({
			ready: false,
			item: ['{"title":"Fix X","action":"auto_fix","reason":"Broken"}'],
		});
		const result = parseOutput();
		expect(result.readiness).toBe("not_ready");
		expect((result.items as unknown[]).length).toBe(1);
	});

	test("--no-ready without items → not_ready with empty items", async () => {
		await protocolEmitReviewer({ ready: false });
		const result = parseOutput();
		expect(result.readiness).toBe("not_ready");
		expect(result.items).toEqual([]);
	});

	test("auto-generates item ids when missing", async () => {
		await protocolEmitReviewer({
			ready: false,
			item: [
				'{"title":"A","action":"auto_fix","reason":"X"}',
				'{"title":"B","action":"auto_fix","reason":"Y"}',
			],
		});
		const result = parseOutput();
		const items = result.items as Array<Record<string, unknown>>;
		// Items already have ids from the handler (R1, R2), and normalization
		// preserves existing ids
		expect(items[0]?.id).toBe("R1");
		expect(items[1]?.id).toBe("R2");
	});

	test("defaults item action to human_required when missing", async () => {
		await protocolEmitReviewer({
			ready: false,
			item: ['{"title":"X","reason":"Y"}'],
		});
		const result = parseOutput();
		const items = result.items as Array<Record<string, unknown>>;
		expect(items[0]?.action).toBe("human_required");
	});

	test("--summary included in output", async () => {
		await protocolEmitReviewer({ ready: true, summary: "Looks good" });
		const result = parseOutput();
		expect(result.summary).toBe("Looks good");
	});

	test("budget item extras and assessments round-trip", async () => {
		await protocolEmitReviewer({
			ready: false,
			item: [
				JSON.stringify({
					id: "R1",
					title: "Reduce coupling",
					action: "auto_fix",
					reason: "Architecture",
					scopeClass: "risk_reduction",
					effortDelta: 2,
					architectureDelta: -1,
					coupling: "intrinsic",
					estimateConfidence: "high",
					creditClaim: {
						creditClaimId: "RC1",
						targetPhase: "Phase 2",
						minimalAlternativeEffortDelta: 1,
						minimalAlternativeArchitectureDelta: 0,
						before: "before",
						after: "after",
					},
				}),
			],
			baselineAssessment: JSON.stringify({
				independentEffortEstimate: 8,
				confidence: "medium",
				reason: "Independent estimate",
			}),
			creditAssessment: [
				JSON.stringify({
					creditClaimId: "DC1",
					eligibility: "eligible",
					coupling: "intrinsic",
					reason: "Necessary",
				}),
				JSON.stringify({
					creditClaimId: "DC2",
					eligibility: "ineligible",
					coupling: "adjacent",
					reason: "Optional",
				}),
			],
		});

		const result = parseOutput();
		const item = (result.items as Array<Record<string, unknown>>)[0];
		expect(item?.scopeClass).toBe("risk_reduction");
		expect(item?.effortDelta).toBe(2);
		expect(item?.creditClaim).toMatchObject({ creditClaimId: "RC1" });
		expect(result.baselineAssessment).toMatchObject({
			independentEffortEstimate: 8,
		});
		expect(result.creditAssessments).toHaveLength(2);
	});

	test("closure evidence fields round-trip in complex item JSON", async () => {
		const introducedBy = {
			commitRange: "abc..def",
			diffHunk: "@@ -1 +1 @@\n-old\n+new",
			explanation: "This edit introduced the failure.",
		};
		await protocolEmitReviewer({
			ready: false,
			item: [
				JSON.stringify({
					id: "P1.2",
					title: "New closure blocker",
					action: "auto_fix",
					reason: "The edit is unsafe.",
					failure: "A write can be lost.",
					lowestCostCorrection: "Restore the write guard.",
					introducedBy,
					requiresReviewerVerification: true,
				}),
			],
		});
		const item = (parseOutput().items as Array<Record<string, unknown>>)[0];
		expect(item).toMatchObject({
			failure: "A write can be lost.",
			lowestCostCorrection: "Restore the write guard.",
			introducedBy,
			requiresReviewerVerification: true,
		});
	});

	test("rejects CLI-owned aggregate fields from stdin and item flags", async () => {
		for (const params of [
			{
				stdinData: JSON.stringify({
					readiness: "ready",
					items: [],
					budget: { W: 1 },
				}),
			},
			{
				ready: false,
				item: [
					JSON.stringify({
						title: "X",
						action: "auto_fix",
						reason: "Y",
						budgetBand: "within_standard",
					}),
				],
			},
		]) {
			try {
				await protocolEmitReviewer(params);
				expect.unreachable("should reject CLI-owned fields");
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("INVALID_STRUCTURED_OUTPUT");
			}
		}
	});

	test("rejects null assessment flags as invalid structured output", async () => {
		for (const params of [
			{ ready: true, baselineAssessment: "null" },
			{ ready: true, creditAssessment: ["null"] },
		]) {
			try {
				await protocolEmitReviewer(params);
				expect.unreachable("should reject non-object assessment JSON");
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("INVALID_STRUCTURED_OUTPUT");
				expect((err as CliError).message).toContain("JSON object");
			}
		}
	});

	test("maps assertion failures to INVALID_STRUCTURED_OUTPUT", async () => {
		for (const params of [
			{
				ready: false,
				item: [
					JSON.stringify({
						title: "Invalid confidence",
						action: "auto_fix",
						reason: "Invalid enum",
						estimateConfidence: "certain",
					}),
				],
			},
			{
				stdinData: JSON.stringify({
					readiness: "ready",
					items: [],
					baselineAssessment: null,
				}),
			},
		]) {
			try {
				await protocolEmitReviewer(params);
				expect.unreachable("should reject invalid reviewer fields");
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("INVALID_STRUCTURED_OUTPUT");
			}
		}
	});

	test("missing --ready/--no-ready without stdin → error", async () => {
		// Pass empty string for stdinData to simulate no piped input without
		// relying on readStdinIfPiped() which is non-deterministic in test runs
		try {
			await protocolEmitReviewer({ ready: undefined, stdinData: "" });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
		}
	});

	test("stdin fallback normalizes and emits", async () => {
		await protocolEmitReviewer({
			ready: undefined,
			stdinData: JSON.stringify({
				verdict: "approved",
				items: [],
			}),
		});
		const result = parseOutput();
		expect(result.readiness).toBe("ready");
	});
});

// ---------------------------------------------------------------------------
// Author emit
// ---------------------------------------------------------------------------

describe("protocolEmitAuthor", () => {
	test("--complete --commit → complete", async () => {
		await protocolEmitAuthor({ complete: true, commit: "abc123" });
		const result = parseOutput();
		expect(result.result).toBe("complete");
		expect(result.commit).toBe("abc123");
	});

	test("--needs-human --reason → needs_human", async () => {
		await protocolEmitAuthor({
			needsHuman: true,
			reason: "Need design decision",
		});
		const result = parseOutput();
		expect(result.result).toBe("needs_human");
		expect(result.reason).toBe("Need design decision");
	});

	test("--failed --reason → failed", async () => {
		await protocolEmitAuthor({
			failed: true,
			reason: "Tests broken beyond repair",
		});
		const result = parseOutput();
		expect(result.result).toBe("failed");
		expect(result.reason).toBe("Tests broken beyond repair");
	});

	test("--complete without --commit → error (commit is required)", async () => {
		try {
			await protocolEmitAuthor({ complete: true });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
			expect((err as CliError).message).toContain("--commit");
		}
	});

	test("--needs-human without --reason → error", async () => {
		try {
			await protocolEmitAuthor({ needsHuman: true });
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
			expect((err as CliError).message).toContain("--reason");
		}
	});

	test("multiple result flags → error", async () => {
		try {
			await protocolEmitAuthor({
				complete: true,
				needsHuman: true,
				commit: "abc",
			});
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			expect((err as CliError).code).toBe("INVALID_ARGS");
		}
	});

	test("--notes included in output", async () => {
		await protocolEmitAuthor({
			complete: true,
			commit: "abc123",
			notes: "All done",
		});
		const result = parseOutput();
		expect(result.notes).toBe("All done");
	});

	test("stdin fallback normalizes legacy status", async () => {
		await protocolEmitAuthor({
			stdinData: JSON.stringify({
				status: "done",
				commit: "abc123",
			}),
		});
		const result = parseOutput();
		expect(result.result).toBe("complete");
		expect(result.commit).toBe("abc123");
	});
});
