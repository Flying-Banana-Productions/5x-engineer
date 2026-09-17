import { describe, expect, test } from "bun:test";
import {
	type AuthorStatus,
	assertAuthorStatus,
	assertReviewerVerdict,
	type BaselineAssessment as ProtocolBaselineAssessment,
	type ReviewerVerdict,
} from "../../src/protocol.js";
import type { BaselineAssessment } from "../../src/review-budget/types.js";

const baselineAssessment: BaselineAssessment = {
	independentEffortEstimate: 8,
	confidence: "high",
	reason: "Independent estimate",
};
const protocolBaselineAssessment: ProtocolBaselineAssessment =
	baselineAssessment;
const verdictBaselineAssessment: ReviewerVerdict["baselineAssessment"] =
	protocolBaselineAssessment;

describe("assertAuthorStatus", () => {
	test("passes for complete + commit in phase execution", () => {
		const status: AuthorStatus = {
			result: "complete",
			commit: "abc123",
		};

		expect(() =>
			assertAuthorStatus(status, "EXECUTE", { requireCommit: true }),
		).not.toThrow();
	});

	test("passes for needs_human + reason", () => {
		const status: AuthorStatus = {
			result: "needs_human",
			reason: "Ambiguous requirement",
		};

		expect(() => assertAuthorStatus(status, "EXECUTE")).not.toThrow();
	});

	test("passes for failed + reason", () => {
		const status: AuthorStatus = {
			result: "failed",
			reason: "Command failed",
		};

		expect(() => assertAuthorStatus(status, "EXECUTE")).not.toThrow();
	});

	test("throws when complete + requireCommit without commit", () => {
		const status: AuthorStatus = { result: "complete" };

		expect(() =>
			assertAuthorStatus(status, "EXECUTE", { requireCommit: true }),
		).toThrow("result is 'complete' but 'commit' is missing");
	});

	test("throws when non-complete status has no reason", () => {
		expect(() =>
			assertAuthorStatus({ result: "needs_human" }, "EXECUTE"),
		).toThrow("reason' is missing");

		expect(() => assertAuthorStatus({ result: "failed" }, "EXECUTE")).toThrow(
			"reason' is missing",
		);
	});
});

describe("assertReviewerVerdict", () => {
	test("re-exports the shared BaselineAssessment type", () => {
		expect(verdictBaselineAssessment).toEqual(baselineAssessment);
	});

	test("passes for ready + empty items", () => {
		const verdict: ReviewerVerdict = {
			readiness: "ready",
			items: [],
		};

		expect(() => assertReviewerVerdict(verdict, "REVIEW")).not.toThrow();
	});

	test("passes for not_ready + actionable item", () => {
		const verdict: ReviewerVerdict = {
			readiness: "not_ready",
			items: [
				{
					id: "P0.1",
					title: "Fix bug",
					action: "auto_fix",
					reason: "Mechanical",
				},
			],
		};

		expect(() => assertReviewerVerdict(verdict, "REVIEW")).not.toThrow();
	});

	test("warns (not throws) when non-ready has no items", () => {
		const verdict: ReviewerVerdict = {
			readiness: "not_ready",
			items: [],
		};

		const result = assertReviewerVerdict(verdict, "REVIEW");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("items");
		expect(result.warnings[0]).toContain("empty");
	});

	test("throws when item action is missing at runtime", () => {
		const verdict = {
			readiness: "ready_with_corrections",
			items: [
				{
					id: "P1.2",
					title: "Missing action",
					reason: "Incomplete payload",
				},
			],
		} as unknown as ReviewerVerdict;

		expect(() => assertReviewerVerdict(verdict, "REVIEW")).toThrow(
			"missing 'action'",
		);
	});

	test("validates present plan-review budget fields", () => {
		const verdict: ReviewerVerdict = {
			readiness: "ready_with_corrections",
			items: [
				{
					id: "R1",
					title: "Reduce coupling",
					action: "auto_fix",
					reason: "Avoid a boundary",
					scopeClass: "risk_reduction",
					effortDelta: 2,
					architectureDelta: -2,
					coupling: "intrinsic",
					estimateConfidence: "medium",
					creditClaim: {
						creditClaimId: "RC1",
						targetPhase: "Phase 2",
						minimalAlternativeEffortDelta: 1,
						minimalAlternativeArchitectureDelta: 0,
						before: "One boundary",
						after: "Two boundaries",
					},
				},
			],
			baselineAssessment,
			creditAssessments: [
				{
					creditClaimId: "DC1",
					eligibility: "eligible",
					coupling: "intrinsic",
					reason: "Required by the delivery path",
				},
			],
		};

		expect(() => assertReviewerVerdict(verdict, "REVIEW")).not.toThrow();
	});

	test("requires coupling for negative architecture delta", () => {
		const verdict = {
			readiness: "not_ready",
			items: [
				{
					id: "R1",
					title: "Claim",
					action: "auto_fix",
					reason: "Reason",
					architectureDelta: -1,
				},
			],
		} as ReviewerVerdict;
		expect(() => assertReviewerVerdict(verdict, "REVIEW")).toThrow(
			"requires 'coupling'",
		);
	});

	test("requires complete credit claim evidence", () => {
		const verdict = {
			readiness: "not_ready",
			items: [
				{
					id: "R1",
					title: "Claim",
					action: "auto_fix",
					reason: "Reason",
					creditClaim: {
						creditClaimId: "RC1",
						targetPhase: "",
						minimalAlternativeEffortDelta: 4,
						minimalAlternativeArchitectureDelta: 0,
						before: "before",
						after: "after",
					},
				},
			],
		} as ReviewerVerdict;
		expect(() => assertReviewerVerdict(verdict, "REVIEW")).toThrow(
			"targetPhase",
		);
	});

	test("validates baseline independent effort as a non-negative integer", () => {
		const verdict = {
			readiness: "ready",
			items: [],
			baselineAssessment: {
				independentEffortEstimate: 1.5,
				confidence: "high",
				reason: "estimate",
			},
		} as ReviewerVerdict;
		expect(() => assertReviewerVerdict(verdict, "REVIEW")).toThrow(
			"independentEffortEstimate",
		);
	});
});
