import { describe, expect, test } from "bun:test";
import {
	normalizeAuthorStatus,
	normalizeReviewerVerdict,
} from "../../src/protocol-normalize.js";

// ---------------------------------------------------------------------------
// Reviewer normalization
// ---------------------------------------------------------------------------

describe("normalizeReviewerVerdict", () => {
	test("canonical input passes through unchanged", () => {
		const input = {
			readiness: "not_ready",
			items: [
				{
					id: "P0.1",
					title: "Fix X",
					action: "auto_fix",
					reason: "Broken",
					priority: "P0",
				},
			],
			summary: "Needs work",
		};

		const result = normalizeReviewerVerdict(input) as Record<string, unknown>;
		expect(result.readiness).toBe("not_ready");
		expect(result.summary).toBe("Needs work");
		const items = result.items as Array<Record<string, unknown>>;
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("P0.1");
		expect(items[0]?.action).toBe("auto_fix");
		expect(items[0]?.priority).toBe("P0");
	});

	test("verdict → readiness mapping", () => {
		expect(
			(
				normalizeReviewerVerdict({ verdict: "rejected", items: [] }) as Record<
					string,
					unknown
				>
			).readiness,
		).toBe("not_ready");

		expect(
			(
				normalizeReviewerVerdict({ verdict: "approved", items: [] }) as Record<
					string,
					unknown
				>
			).readiness,
		).toBe("ready");

		expect(
			(
				normalizeReviewerVerdict({
					verdict: "conditionally_approved",
					items: [],
				}) as Record<string, unknown>
			).readiness,
		).toBe("ready_with_corrections");
	});

	test("issues → items mapping", () => {
		const input = {
			readiness: "not_ready",
			issues: [{ id: "R1", title: "X", action: "auto_fix", reason: "Y" }],
		};

		const result = normalizeReviewerVerdict(input) as Record<string, unknown>;
		expect(result.items).toBeDefined();
		expect(result.issues).toBeUndefined();
		expect((result.items as unknown[]).length).toBe(1);
	});

	test("per-item severity → priority mapping", () => {
		const input = {
			readiness: "not_ready",
			items: [
				{
					id: "R1",
					title: "X",
					action: "auto_fix",
					reason: "Y",
					severity: "critical",
				},
				{
					id: "R2",
					title: "Z",
					action: "auto_fix",
					reason: "W",
					severity: "minor",
				},
				{
					id: "R3",
					title: "A",
					action: "auto_fix",
					reason: "B",
					severity: "moderate",
				},
				{
					id: "R4",
					title: "C",
					action: "auto_fix",
					reason: "D",
					severity: "major",
				},
			],
		};

		const result = normalizeReviewerVerdict(input) as Record<string, unknown>;
		const items = result.items as Array<Record<string, unknown>>;
		expect(items[0]?.priority).toBe("P0");
		expect(items[0]?.severity).toBeUndefined();
		expect(items[1]?.priority).toBe("P2");
		expect(items[2]?.priority).toBe("P1");
		expect(items[3]?.priority).toBe("P0");
	});

	test("auto-generates missing id fields", () => {
		const input = {
			readiness: "not_ready",
			items: [
				{ title: "X", action: "auto_fix", reason: "Y" },
				{ title: "Z", action: "auto_fix", reason: "W" },
			],
		};

		const result = normalizeReviewerVerdict(input) as Record<string, unknown>;
		const items = result.items as Array<Record<string, unknown>>;
		expect(items[0]?.id).toBe("R1");
		expect(items[1]?.id).toBe("R2");
	});

	test("defaults missing action to human_required", () => {
		const input = {
			readiness: "not_ready",
			items: [{ id: "R1", title: "X", reason: "Y" }],
		};

		const result = normalizeReviewerVerdict(input) as Record<string, unknown>;
		const items = result.items as Array<Record<string, unknown>>;
		expect(items[0]?.action).toBe("human_required");
	});

	test("mixed canonical and alternative fields (partial normalization)", () => {
		const input = {
			verdict: "rejected",
			items: [
				{
					title: "X",
					action: "auto_fix",
					reason: "Y",
					severity: "critical",
				},
				{
					id: "R2",
					title: "Z",
					action: "human_required",
					reason: "W",
					priority: "P1",
				},
			],
			summary: "Mixed",
		};

		const result = normalizeReviewerVerdict(input) as Record<string, unknown>;
		expect(result.readiness).toBe("not_ready");
		expect(result.verdict).toBeUndefined();

		const items = result.items as Array<Record<string, unknown>>;
		expect(items[0]?.id).toBe("R1");
		expect(items[0]?.priority).toBe("P0");
		expect(items[0]?.severity).toBeUndefined();

		expect(items[1]?.id).toBe("R2");
		expect(items[1]?.priority).toBe("P1");
	});
});

// ---------------------------------------------------------------------------
// Author normalization
// ---------------------------------------------------------------------------

describe("normalizeAuthorStatus", () => {
	test("canonical input passes through unchanged", () => {
		const input = {
			result: "complete",
			commit: "abc123",
			notes: "Done",
		};

		const result = normalizeAuthorStatus(input) as Record<string, unknown>;
		expect(result.result).toBe("complete");
		expect(result.commit).toBe("abc123");
		expect(result.notes).toBe("Done");
	});

	test("status → result mapping", () => {
		expect(
			(
				normalizeAuthorStatus({ status: "done", commit: "abc" }) as Record<
					string,
					unknown
				>
			).result,
		).toBe("complete");

		expect(
			(
				normalizeAuthorStatus({
					status: "blocked",
					reason: "Need help",
				}) as Record<string, unknown>
			).result,
		).toBe("needs_human");

		expect(
			(
				normalizeAuthorStatus({
					status: "error",
					reason: "Crashed",
				}) as Record<string, unknown>
			).result,
		).toBe("failed");
	});

	test("replaces legacy normalizeLegacyAuthorStatus behavior", () => {
		// Legacy: status: "done" → result: "complete"
		const legacy = { status: "done", commit: "abc123" };
		const result = normalizeAuthorStatus(legacy) as Record<string, unknown>;
		expect(result.result).toBe("complete");
		expect(result.commit).toBe("abc123");
		expect(result.status).toBeUndefined();

		// Legacy: status: "needs_human" → result: "needs_human"
		const legacy2 = { status: "needs_human", reason: "Stuck" };
		const result2 = normalizeAuthorStatus(legacy2) as Record<string, unknown>;
		expect(result2.result).toBe("needs_human");
		expect(result2.reason).toBe("Stuck");
	});

	test("falls back to notes/summary for reason when missing on non-complete", () => {
		const input = { status: "blocked", notes: "Help needed" };
		const result = normalizeAuthorStatus(input) as Record<string, unknown>;
		expect(result.result).toBe("needs_human");
		expect(result.reason).toBe("Help needed");
	});

	test("falls back to summary for notes on complete when notes missing", () => {
		const input = {
			status: "done",
			commit: "abc",
			summary: "All done",
		};
		const result = normalizeAuthorStatus(input) as Record<string, unknown>;
		expect(result.result).toBe("complete");
		expect(result.notes).toBe("All done");
	});

	test("non-object input passes through", () => {
		expect(normalizeAuthorStatus("hello") as unknown).toBe("hello");
		expect(normalizeAuthorStatus(null) as unknown).toBe(null);
		expect(normalizeAuthorStatus(42) as unknown).toBe(42);
	});
});
