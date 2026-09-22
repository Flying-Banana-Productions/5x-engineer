export const EFFORT_POINTS = [1, 2, 3, 5, 8] as const;
export type EffortPoints = (typeof EFFORT_POINTS)[number];

export const ARCHITECTURE_DELTAS = [-5, -3, -2, -1, 0, 1, 2, 3, 5] as const;
export type ArchitectureDelta = (typeof ARCHITECTURE_DELTAS)[number];

export type ReviewBudgetMode = "off" | "advisory" | "enforced";

export type BaselineDirection = "aligned" | "understated" | "inflated";

export type BudgetBand =
	| "within_standard"
	| "within_debt_allowance"
	| "over_effective"
	| "over_absolute";

export type BudgetAlert =
	| "baseline_disputed"
	| "positive_architecture_exceeded"
	| "credit_unrealized";

export type EstimateConfidence = "low" | "medium" | "high";

export interface BaselineAssessment {
	independentEffortEstimate: number;
	confidence: EstimateConfidence;
	reason: string;
}

export type PlanScopeClass =
	| "acceptance_required"
	| "risk_reduction"
	| "polish";

export type CouplingClass = "intrinsic" | "adjacent" | "unrelated";

export type CreditEligibility = "eligible" | "ineligible";

export interface ReviewBudgetConfig {
	mode: ReviewBudgetMode;
	growthPercent: number;
	minimumGrowthPoints: number;
	debtTradeoffRatio: number;
	maxDebtCreditPercent: number;
	absoluteGrowthPercent: number;
	baselineDisagreementPercent: number;
	minimumBaselineDisagreementPoints: number;
	maxPositiveArchitecturePercent: number;
	minimumPositiveArchitecturePoints: number;
	singleArchitectureReviewPoints: number;
}

export type ReviewBudgetThresholds = Omit<ReviewBudgetConfig, "mode">;

export const DEFAULT_REVIEW_BUDGET_CONFIG: Readonly<ReviewBudgetThresholds> =
	Object.freeze({
		growthPercent: 25,
		minimumGrowthPoints: 2,
		debtTradeoffRatio: 1,
		maxDebtCreditPercent: 25,
		absoluteGrowthPercent: 50,
		baselineDisagreementPercent: 25,
		minimumBaselineDisagreementPoints: 2,
		maxPositiveArchitecturePercent: 25,
		minimumPositiveArchitecturePoints: 2,
		singleArchitectureReviewPoints: 5,
	});

export interface DebtClaimEvidence {
	debtClaimId: string;
	coupling: CouplingClass;
	targetPhase: string;
	minimalAlternativeEffortDelta: number;
	minimalAlternativeArchitectureDelta: ArchitectureDelta;
	before: string;
	after: string;
}

export interface ParsedWorkItem {
	id: string;
	title: string;
	effort: EffortPoints;
	architectureDelta: ArchitectureDelta;
	debtClaim: DebtClaimEvidence | null;
	addresses: string[];
	rationale: string;
	line: number;
}

export interface SurfaceSnapshot {
	subsystems: number;
	productionFiles: number;
	persistentOrExternalBoundaries: number;
	newSharedAbstractions?: number;
	newPersistentSchemas?: number;
}

export interface ParsedDeliveryBudget {
	estimateConfidence: EstimateConfidence;
	workItems: ParsedWorkItem[];
	surface: SurfaceSnapshot;
}

export interface FindingDelta {
	id: string;
	effortDelta: number;
	architectureDelta: number;
	scopeClass: PlanScopeClass | undefined;
	coupling: CouplingClass | undefined;
	creditClaim?: DebtClaimEvidence;
	creditNContribution?: number;
}

export interface CreditAssessmentInput {
	creditClaimId: string;
	eligibility: CreditEligibility;
	coupling: CouplingClass;
}

export interface DerivedBudgetResult {
	B0: number;
	B: number;
	I: number | null;
	W: number;
	R: number;
	projectedEffort: number;
	S: number;
	N: number;
	D: number;
	E: number;
	A: number;
	P: number;
	baselineDirection: BaselineDirection | null;
	budgetBand: BudgetBand;
	budgetAlerts: BudgetAlert[];
	requiresHuman: boolean;
	positiveArchitectureLimit: number;
	baselineDisagreementThreshold: number;
	thresholds: ReviewBudgetThresholds;
}

export function isEffortPoints(value: unknown): value is EffortPoints {
	return (
		typeof value === "number" && EFFORT_POINTS.includes(value as EffortPoints)
	);
}

export function isArchitectureDelta(
	value: unknown,
): value is ArchitectureDelta {
	return (
		typeof value === "number" &&
		ARCHITECTURE_DELTAS.includes(value as ArchitectureDelta)
	);
}

export function isCompleteDebtClaimEvidence(
	value: unknown,
): value is DebtClaimEvidence {
	if (typeof value !== "object" || value === null) return false;

	const claim = value as Record<string, unknown>;
	return (
		typeof claim.debtClaimId === "string" &&
		claim.debtClaimId.trim().length > 0 &&
		(claim.coupling === "intrinsic" ||
			claim.coupling === "adjacent" ||
			claim.coupling === "unrelated") &&
		typeof claim.targetPhase === "string" &&
		claim.targetPhase.trim().length > 0 &&
		typeof claim.minimalAlternativeEffortDelta === "number" &&
		Number.isInteger(claim.minimalAlternativeEffortDelta) &&
		(claim.minimalAlternativeEffortDelta === 0 ||
			isEffortPoints(claim.minimalAlternativeEffortDelta)) &&
		isArchitectureDelta(claim.minimalAlternativeArchitectureDelta) &&
		typeof claim.before === "string" &&
		claim.before.trim().length > 0 &&
		typeof claim.after === "string" &&
		claim.after.trim().length > 0
	);
}
