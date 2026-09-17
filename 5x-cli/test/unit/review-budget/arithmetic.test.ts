import { describe, expect, test } from "bun:test";
import {
	computeBaselineDirection,
	computeCeilings,
	computeGrossP,
	computePendingR,
	computeProvisionalD,
	deriveBudget,
	eligibleN,
} from "../../../src/review-budget/arithmetic.js";
import {
	DEFAULT_REVIEW_BUDGET_CONFIG,
	type FindingDelta,
	type ParsedWorkItem,
} from "../../../src/review-budget/types.js";

const config = DEFAULT_REVIEW_BUDGET_CONFIG;

function workItem(overrides: Partial<ParsedWorkItem> = {}): ParsedWorkItem {
	return {
		id: "W1",
		title: "Work",
		effort: 3,
		architectureDelta: 0,
		debtClaim: null,
		addresses: [],
		rationale: "Required",
		line: 1,
		...overrides,
	};
}

function finding(overrides: Partial<FindingDelta> = {}): FindingDelta {
	return {
		id: "F1",
		effortDelta: 2,
		architectureDelta: 0,
		scopeClass: "acceptance_required",
		coupling: undefined,
		...overrides,
	};
}

describe("ceiling arithmetic", () => {
	test("matches the B = 4 worked example", () => {
		const { S, A } = computeCeilings(4, config);
		const D = computeProvisionalD(4, 3, config);
		expect({ S, A, D, E: Math.min(A, S + D) }).toEqual({
			S: 6,
			A: 8,
			D: 1,
			E: 7,
		});
	});

	test("is defined at zero and rejects a negative baseline", () => {
		expect(computeCeilings(0, config)).toEqual({
			S: 2,
			A: 4,
			positiveArchitectureLimit: 2,
		});
		expect(() => computeCeilings(-1, config)).toThrow("B must");
	});

	test("caps debt credit by baseline percent and tradeoff ratio", () => {
		expect(computeProvisionalD(20, 20, config)).toBe(5);
		expect(
			computeProvisionalD(20, 3, { ...config, debtTradeoffRatio: 0.5 }),
		).toBe(1);
	});
});

test("computes baseline direction at the strict threshold boundary", () => {
	expect(computeBaselineDirection(6, 4, 2)).toBe("understated");
	expect(computeBaselineDirection(1, 4, 2)).toBe("inflated");
	expect(computeBaselineDirection(5, 4, 2)).toBe("aligned");
	expect(computeBaselineDirection(4, 4, 0)).toBe("aligned");
});

test("counts current still-listed findings once and excludes polish from R", () => {
	const findings = [
		finding({ id: "F1", effortDelta: 2 }),
		finding({ id: "F2", effortDelta: 3 }),
		finding({ id: "F3", effortDelta: 8, scopeClass: "polish" }),
	];
	const incorporated = new Set(["F1", "F1"]);
	expect(computePendingR(findings, incorporated)).toBe(5);
});

test("gross P ignores negative architecture deltas", () => {
	expect(
		computeGrossP(
			[{ architectureDelta: 3 }, { architectureDelta: -5 }],
			[finding({ architectureDelta: 2 }), finding({ architectureDelta: -3 })],
		),
	).toBe(5);
});

describe("eligible N", () => {
	const evidence = {
		debtClaimId: "DC0",
		coupling: "intrinsic" as const,
		targetPhase: "phase-2",
		minimalAlternativeEffortDelta: 2,
		minimalAlternativeArchitectureDelta: 0 as const,
		before: "many paths",
		after: "one path",
	};

	test("includes only eligible intrinsic author claims", () => {
		const item = workItem({ architectureDelta: -3, debtClaim: evidence });
		expect(
			eligibleN(
				[item],
				[],
				[
					{
						creditClaimId: "DC0",
						eligibility: "eligible",
						coupling: "intrinsic",
					},
				],
			),
		).toBe(3);
		expect(
			eligibleN(
				[item],
				[],
				[
					{
						creditClaimId: "DC0",
						eligibility: "ineligible",
						coupling: "intrinsic",
					},
				],
			),
		).toBe(0);
	});

	test("defensively excludes incomplete claim evidence", () => {
		const incomplete = { ...evidence, before: "" } as typeof evidence;
		expect(
			eligibleN(
				[workItem({ architectureDelta: -3, debtClaim: incomplete })],
				[],
				[
					{
						creditClaimId: "DC0",
						eligibility: "eligible",
						coupling: "intrinsic",
					},
				],
			),
		).toBe(0);
	});

	test("provisionally includes complete intrinsic reviewer claims", () => {
		expect(
			eligibleN(
				[],
				[
					finding({
						architectureDelta: -2,
						coupling: "intrinsic",
						creditClaim: evidence,
					}),
				],
				[],
			),
		).toBe(2);
	});
});

test("derives bands, thresholds, alerts, and semantic escalation", () => {
	const result = deriveBudget({
		B0: 4,
		B: 4,
		I: 6,
		workItems: [workItem({ effort: 5, architectureDelta: 3 })],
		findings: [finding({ effortDelta: 2 })],
		assessments: [],
		config,
		semanticHumanRequired: false,
	});

	expect(result).toMatchObject({
		W: 5,
		R: 2,
		projectedEffort: 7,
		S: 6,
		A: 8,
		E: 6,
		budgetBand: "over_effective",
		baselineDisagreementThreshold: 2,
		baselineDirection: "understated",
		P: 3,
		requiresHuman: true,
	});
	expect(result.budgetAlerts).toEqual([
		"baseline_disputed",
		"positive_architecture_exceeded",
	]);
	expect(result.budgetAlerts).not.toContain("credit_unrealized");
});
