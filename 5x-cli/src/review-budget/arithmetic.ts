import {
	type BaselineDirection,
	type BudgetAlert,
	type BudgetBand,
	type CreditAssessmentInput,
	type DerivedBudgetResult,
	type FindingDelta,
	isCompleteDebtClaimEvidence,
	type ParsedWorkItem,
	type ReviewBudgetThresholds,
} from "./types.js";

function assertNonNegative(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${name} must be a finite non-negative number`);
	}
}

export function sumEffort(items: readonly { effort: number }[]): number {
	return items.reduce((total, item) => total + item.effort, 0);
}

export function computeCeilings(
	B: number,
	config: ReviewBudgetThresholds,
): {
	S: number;
	A: number;
	positiveArchitectureLimit: number;
} {
	assertNonNegative(B, "B");
	const S = Math.max(
		B + config.minimumGrowthPoints,
		Math.ceil(B * (1 + config.growthPercent / 100)),
	);
	const A = Math.max(
		S + config.minimumGrowthPoints,
		Math.ceil(B * (1 + config.absoluteGrowthPercent / 100)),
	);
	const positiveArchitectureLimit = Math.max(
		config.minimumPositiveArchitecturePoints,
		Math.ceil((B * config.maxPositiveArchitecturePercent) / 100),
	);
	return { S, A, positiveArchitectureLimit };
}

export function computeProvisionalD(
	B: number,
	N: number,
	config: ReviewBudgetThresholds,
): number {
	assertNonNegative(B, "B");
	assertNonNegative(N, "N");
	return Math.min(
		Math.ceil((B * config.maxDebtCreditPercent) / 100),
		Math.floor(N * config.debtTradeoffRatio),
	);
}

export function computeEffectiveCeiling(
	S: number,
	D: number,
	A: number,
): number {
	return Math.min(A, S + D);
}

export function computeBaselineDirection(
	I: number,
	B0: number,
	threshold: number,
): BaselineDirection {
	if (I === B0 || Math.abs(I - B0) < threshold) return "aligned";
	return I > B0 ? "understated" : "inflated";
}

export function computePendingR(
	findings: readonly FindingDelta[],
	_incorporatedIds: ReadonlySet<string>,
): number {
	// Every input finding is still listed in the current verdict, so incorporated
	// IDs re-enter R. Addresses only matter when a finding is no longer listed.
	return findings.reduce(
		(total, finding) =>
			total + (finding.scopeClass === "polish" ? 0 : finding.effortDelta),
		0,
	);
}

export function computeGrossP(
	workItems: readonly { architectureDelta: number }[],
	pendingFindings: readonly FindingDelta[],
): number {
	return [...workItems, ...pendingFindings].reduce(
		(total, item) =>
			total + (item.architectureDelta > 0 ? item.architectureDelta : 0),
		0,
	);
}

export function eligibleN(
	workItems: readonly ParsedWorkItem[],
	findings: readonly FindingDelta[],
	assessments: readonly CreditAssessmentInput[],
): number {
	const assessmentsById = new Map(
		assessments.map((assessment) => [assessment.creditClaimId, assessment]),
	);
	let total = 0;

	for (const item of workItems) {
		if (
			item.architectureDelta >= 0 ||
			!isCompleteDebtClaimEvidence(item.debtClaim)
		) {
			continue;
		}
		const assessment = assessmentsById.get(item.debtClaim.debtClaimId);
		if (
			assessment?.eligibility === "eligible" &&
			assessment.coupling === "intrinsic"
		) {
			total += Math.abs(item.architectureDelta);
		}
	}

	for (const finding of findings) {
		if (
			finding.architectureDelta < 0 &&
			finding.coupling === "intrinsic" &&
			isCompleteDebtClaimEvidence(finding.creditClaim) &&
			finding.creditClaim.coupling === "intrinsic"
		) {
			total += Math.abs(finding.architectureDelta);
		}
	}

	return total;
}

export function deriveBudget(input: {
	B0: number;
	B: number;
	I: number | null;
	workItems: readonly ParsedWorkItem[];
	findings: readonly FindingDelta[];
	assessments: readonly CreditAssessmentInput[];
	config: ReviewBudgetThresholds;
	semanticHumanRequired: boolean;
}): DerivedBudgetResult {
	assertNonNegative(input.B0, "B0");
	assertNonNegative(input.B, "B");
	if (input.I !== null) assertNonNegative(input.I, "I");

	const W = sumEffort(input.workItems);
	const incorporatedIds = new Set(
		input.workItems.flatMap((item) => item.addresses),
	);
	const R = computePendingR(input.findings, incorporatedIds);
	const projectedEffort = W + R;
	const { S, A, positiveArchitectureLimit } = computeCeilings(
		input.B,
		input.config,
	);
	const N = eligibleN(input.workItems, input.findings, input.assessments);
	const D = computeProvisionalD(input.B, N, input.config);
	const E = computeEffectiveCeiling(S, D, A);
	const pendingFindings = input.findings.filter(
		(finding) => finding.scopeClass !== "polish",
	);
	const P = computeGrossP(input.workItems, pendingFindings);
	const baselineDisagreementThreshold = Math.max(
		input.config.minimumBaselineDisagreementPoints,
		Math.ceil((input.B0 * input.config.baselineDisagreementPercent) / 100),
	);
	const baselineDirection =
		input.I === null
			? null
			: computeBaselineDirection(
					input.I,
					input.B0,
					baselineDisagreementThreshold,
				);

	let budgetBand: BudgetBand;
	if (projectedEffort <= S) budgetBand = "within_standard";
	else if (projectedEffort <= E) budgetBand = "within_debt_allowance";
	else if (projectedEffort <= A) budgetBand = "over_effective";
	else budgetBand = "over_absolute";

	const budgetAlerts: BudgetAlert[] = [];
	if (baselineDirection !== null && baselineDirection !== "aligned") {
		budgetAlerts.push("baseline_disputed");
	}
	const singleArchitectureExceeded = [
		...input.workItems,
		...pendingFindings,
	].some(
		(item) =>
			item.architectureDelta >= input.config.singleArchitectureReviewPoints,
	);
	if (P >= positiveArchitectureLimit || singleArchitectureExceeded) {
		budgetAlerts.push("positive_architecture_exceeded");
	}

	const requiresHuman =
		budgetBand === "over_effective" ||
		budgetBand === "over_absolute" ||
		budgetAlerts.length > 0 ||
		input.semanticHumanRequired;

	return {
		B0: input.B0,
		B: input.B,
		I: input.I,
		W,
		R,
		projectedEffort,
		S,
		N,
		D,
		E,
		A,
		P,
		baselineDirection,
		budgetBand,
		budgetAlerts,
		requiresHuman,
		positiveArchitectureLimit,
		baselineDisagreementThreshold,
		thresholds: input.config,
	};
}
