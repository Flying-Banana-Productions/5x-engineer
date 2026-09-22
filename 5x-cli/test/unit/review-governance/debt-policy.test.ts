import { describe, expect, test } from "bun:test";
import {
	assessDebtEligibility,
	validateDebtPolicy,
} from "../../../src/review-governance/closure.js";
import type { GovernanceReviewerVerdict } from "../../../src/review-governance/types.js";

function debtVerdict(
	overrides: Record<string, unknown> = {},
): GovernanceReviewerVerdict {
	return {
		readiness: "not_ready",
		items: [
			{
				id: "P1.4",
				title: "Consolidate writers",
				action: "auto_fix",
				reason: "Avoid divergent write behavior.",
				scopeClass: "risk_reduction",
				effortDelta: 2,
				architectureDelta: -2,
				coupling: "intrinsic",
				estimateConfidence: "high",
				failure: "Divergent writers corrupt retry state.",
				lowestCostCorrection: "Use the existing shared writer.",
				creditClaim: {
					creditClaimId: "DC1",
					targetPhase: "phase-2",
					minimalAlternativeEffortDelta: 1,
					minimalAlternativeArchitectureDelta: 0,
					before: "three independent write paths",
					after: "one invariant-enforcing writer",
				},
				...overrides,
			},
		],
		creditAssessments: [
			{
				creditClaimId: "DC1",
				eligibility: "eligible",
				coupling: "intrinsic",
				reason: "Directly consolidates the changed paths.",
			},
		],
	};
}

describe("closure debt policy", () => {
	test("accepts complete, intrinsic, reviewer-approved simplification evidence", () => {
		const verdict = debtVerdict();
		const item = verdict.items[0];
		if (!item) throw new Error("missing debt fixture item");
		expect(assessDebtEligibility(item, verdict)).toEqual({
			eligible: true,
			creditClaimId: "DC1",
			coupling: "intrinsic",
			targetPhase: "phase-2",
		});
		expect(validateDebtPolicy(verdict)).toEqual([]);
	});

	test("rejects incomplete evidence, invalid targets, and non-simpler After states", () => {
		const incomplete = debtVerdict({
			creditClaim: {
				creditClaimId: "DC1",
				targetPhase: "phase-2",
				minimalAlternativeEffortDelta: 1,
				minimalAlternativeArchitectureDelta: 0,
				before: "",
				after: "one writer",
			},
		});
		expect(validateDebtPolicy(incomplete)[0]?.code).toBe(
			"DEBT_EVIDENCE_INCOMPLETE",
		);

		const target = debtVerdict({
			creditClaim: {
				...debtVerdict().items[0]?.creditClaim,
				targetPhase: "eventually",
			},
		});
		expect(validateDebtPolicy(target)[0]?.code).toBe(
			"DEBT_TARGET_PHASE_INVALID",
		);

		const same = debtVerdict({
			creditClaim: {
				...debtVerdict().items[0]?.creditClaim,
				before: "One writer",
				after: " one  WRITER ",
			},
		});
		expect(validateDebtPolicy(same)[0]?.code).toBe("DEBT_AFTER_NOT_SIMPLER");
	});

	test("requires reviewer eligibility and intrinsic coupling", () => {
		const ineligible = debtVerdict();
		ineligible.creditAssessments = [
			{
				creditClaimId: "DC1",
				eligibility: "ineligible",
				coupling: "intrinsic",
				reason: "Not simpler.",
			},
		];
		expect(validateDebtPolicy(ineligible)[0]?.code).toBe(
			"DEBT_REVIEWER_INELIGIBLE",
		);

		const adjacent = debtVerdict({
			coupling: "adjacent",
			action: "auto_fix",
		});
		expect(validateDebtPolicy(adjacent).map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"ADJACENT_DEBT_REQUIRES_HUMAN",
				"DEBT_COUPLING_INELIGIBLE",
			]),
		);

		const unrelated = debtVerdict({ coupling: "unrelated" });
		expect(validateDebtPolicy(unrelated).map((entry) => entry.code)).toContain(
			"UNRELATED_DEBT_NONBLOCKING",
		);
	});
});
