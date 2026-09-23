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
	test("reuses plan-208 reviewer-finding credit without a self-assessment", () => {
		const verdict = debtVerdict();
		verdict.creditAssessments = [];
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

	test("enforces complete evidence, non-empty targets, and distinct After states", () => {
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
		expect(validateDebtPolicy(incomplete)).toContainEqual(
			expect.objectContaining({ code: "DEBT_EVIDENCE_INCOMPLETE" }),
		);

		const target = debtVerdict({
			creditClaim: {
				...debtVerdict().items[0]?.creditClaim,
				targetPhase: "",
			},
		});
		expect(validateDebtPolicy(target)).toContainEqual(
			expect.objectContaining({ code: "DEBT_TARGET_PHASE_INVALID" }),
		);

		const same = debtVerdict({
			creditClaim: {
				...debtVerdict().items[0]?.creditClaim,
				before: "One writer",
				after: " one  WRITER ",
			},
		});
		expect(validateDebtPolicy(same)).toContainEqual(
			expect.objectContaining({ code: "DEBT_AFTER_NOT_SIMPLER" }),
		);
	});

	test("uses plan-208 architecture semantics without comparing the alternative delta", () => {
		const negative = debtVerdict({
			architectureDelta: -1,
			creditClaim: {
				...debtVerdict().items[0]?.creditClaim,
				minimalAlternativeArchitectureDelta: -2,
			},
		});
		negative.creditAssessments = [];
		expect(validateDebtPolicy(negative)).toEqual([]);
		const negativeItem = negative.items[0];
		if (!negativeItem) throw new Error("missing negative debt fixture");
		const negativeEligibility = assessDebtEligibility(negativeItem, negative);
		expect(negativeEligibility?.eligible).toBe(true);

		const positive = debtVerdict({ architectureDelta: 1 });
		expect(validateDebtPolicy(positive)).toEqual([]);
		const positiveItem = positive.items[0];
		if (!positiveItem) throw new Error("missing positive debt fixture");
		expect(assessDebtEligibility(positiveItem, positive)).toMatchObject({
			eligible: false,
			reason: "not_credit_eligible",
		});
	});

	test("accepts any non-empty plan-208 target label", () => {
		const verdict = debtVerdict({
			creditClaim: {
				...debtVerdict().items[0]?.creditClaim,
				targetPhase: "persistence rollout",
			},
		});
		expect(validateDebtPolicy(verdict)).toEqual([]);
	});

	test("does not turn reviewer assessment ineligibility into a governance rejection", () => {
		const ineligible = debtVerdict();
		ineligible.creditAssessments = [
			{
				creditClaimId: "DC1",
				eligibility: "ineligible",
				coupling: "intrinsic",
				reason: "Not simpler.",
			},
		];
		expect(validateDebtPolicy(ineligible)).toEqual([]);
	});

	test("handles adjacent and unrelated debt only through the coupling rule", () => {
		const adjacent = debtVerdict({
			coupling: "adjacent",
			action: "human_required",
		});
		expect(validateDebtPolicy(adjacent)).toEqual([]);

		const adjacentAuto = debtVerdict({
			coupling: "adjacent",
			action: "auto_fix",
		});
		expect(validateDebtPolicy(adjacentAuto).map((entry) => entry.code)).toEqual(
			["ADJACENT_DEBT_REQUIRES_HUMAN"],
		);

		const unrelated = debtVerdict({ coupling: "unrelated" });
		expect(validateDebtPolicy(unrelated).map((entry) => entry.code)).toContain(
			"UNRELATED_DEBT_NONBLOCKING",
		);
	});
});
