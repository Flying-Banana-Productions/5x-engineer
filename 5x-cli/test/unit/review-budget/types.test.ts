import { expect, test } from "bun:test";
import {
	type BaselineAssessment,
	DEFAULT_REVIEW_BUDGET_CONFIG,
	isArchitectureDelta,
	isCompleteDebtClaimEvidence,
	isEffortPoints,
} from "../../../src/review-budget/types.js";

test("exports the shared BaselineAssessment structural type", () => {
	const assessment = {
		independentEffortEstimate: 5,
		confidence: "high",
		reason: "Independent inventory",
	} as const satisfies BaselineAssessment;

	expect(assessment.independentEffortEstimate).toBe(5);
});

test("recognizes documented effort and architecture values", () => {
	expect(isEffortPoints(5)).toBe(true);
	expect(isEffortPoints(4)).toBe(false);
	expect(isArchitectureDelta(-5)).toBe(true);
	expect(isArchitectureDelta(4)).toBe(false);
});

test("freezes the shared default thresholds", () => {
	expect(Object.isFrozen(DEFAULT_REVIEW_BUDGET_CONFIG)).toBe(true);
});

test("requires complete debt-claim evidence", () => {
	const complete = {
		debtClaimId: "DC0",
		coupling: "intrinsic",
		targetPhase: "phase-2",
		minimalAlternativeEffortDelta: 0,
		minimalAlternativeArchitectureDelta: 0,
		before: "separate paths",
		after: "one path",
	};
	expect(isCompleteDebtClaimEvidence(complete)).toBe(true);
	expect(
		isCompleteDebtClaimEvidence({
			...complete,
			debtClaimId: "review-credit-1",
		}),
	).toBe(true);
	expect(isCompleteDebtClaimEvidence({ ...complete, debtClaimId: " " })).toBe(
		false,
	);
	expect(isCompleteDebtClaimEvidence({ ...complete, before: " " })).toBe(false);
	expect(isCompleteDebtClaimEvidence({ ...complete, targetPhase: "" })).toBe(
		false,
	);
	expect(
		isCompleteDebtClaimEvidence({
			...complete,
			minimalAlternativeEffortDelta: 4,
		}),
	).toBe(false);
});
