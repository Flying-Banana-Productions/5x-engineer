import type { RecordOrigin } from "../control-plane/record-types.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import {
	type ReviewerVerdict,
	rejectCliOwnedBudgetFields,
} from "../protocol.js";
import { deriveBudget } from "./arithmetic.js";
import { ensurePlanReviewBaseline } from "./ensure-baseline.js";
import {
	type BaselineAssessment,
	type CreditAssessmentInput,
	type DebtClaimEvidence,
	type DerivedBudgetResult,
	type FindingDelta,
	isArchitectureDelta,
	isCompleteDebtClaimEvidence,
	type ParsedDeliveryBudget,
	type ParsedWorkItem,
	type ReviewBudgetConfig,
} from "./types.js";

export interface PendingBudgetSnapshot {
	runId: string;
	stepName: string;
	phase: string | undefined;
	iteration: number | undefined;
	currentLedger: ParsedDeliveryBudget;
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[];
	baselineAssessment?: BaselineAssessment;
	derived: DerivedBudgetResult;
}

export interface ApplyPlanReviewBudgetInput {
	runId: string;
	stepName: string;
	phase: string | undefined;
	iteration: number | undefined;
	planMarkdown: string;
	verdict: ReviewerVerdict;
	config: ReviewBudgetConfig;
	store: ReviewBudgetStore;
	hasPriorPlanReviewerStep: boolean;
	optInBaseline: boolean;
	origin: RecordOrigin;
	warn: (message: string) => void;
}

export type ApplyPlanReviewBudgetResult =
	| { status: "skipped"; reason: "off" | "v1_compat" }
	| {
			status: "applied";
			verdict: ReviewerVerdict & { budget: DerivedBudgetResult };
			pendingSnapshot: PendingBudgetSnapshot;
	  }
	| { status: "error"; code: string; message: string };

function error(code: string, message: string): ApplyPlanReviewBudgetResult {
	return { status: "error", code, message };
}

function claimFor(item: ParsedWorkItem): DebtClaimEvidence | null {
	return item.architectureDelta < 0 ? item.debtClaim : null;
}

function sameClaim(current: ParsedWorkItem, previous: ParsedWorkItem): boolean {
	const a = claimFor(current);
	const b = claimFor(previous);
	return Boolean(
		a &&
			b &&
			a.debtClaimId === b.debtClaimId &&
			a.coupling === b.coupling &&
			current.architectureDelta === previous.architectureDelta &&
			a.targetPhase === b.targetPhase &&
			a.minimalAlternativeEffortDelta === b.minimalAlternativeEffortDelta &&
			a.minimalAlternativeArchitectureDelta ===
				b.minimalAlternativeArchitectureDelta &&
			a.before === b.before &&
			a.after === b.after,
	);
}

export function findIncompleteDebtClaimItem(
	ledger: ParsedDeliveryBudget,
): ParsedWorkItem | undefined {
	return ledger.workItems.find(
		(item) =>
			item.architectureDelta < 0 &&
			!isCompleteDebtClaimEvidence(item.debtClaim),
	);
}

export function applyPlanReviewBudget(
	input: ApplyPlanReviewBudgetInput,
): ApplyPlanReviewBudgetResult {
	try {
		rejectCliOwnedBudgetFields(input.verdict);
	} catch (cause) {
		return error(
			"INVALID_STRUCTURED_OUTPUT",
			cause instanceof Error ? cause.message : String(cause),
		);
	}
	if (input.config.mode === "off") return { status: "skipped", reason: "off" };

	let baseline = input.store.getBaseline(input.runId);
	if (!baseline || input.optInBaseline) {
		const ensured = ensurePlanReviewBaseline({
			runId: input.runId,
			planMarkdown: input.planMarkdown,
			config: input.config,
			store: input.store,
			hasPriorPlanReviewerStep: input.hasPriorPlanReviewerStep,
			optIn: input.optInBaseline,
			origin: input.origin,
			warn: input.warn,
		});
		if (ensured.status === "error") return error(ensured.code, ensured.message);
		if (ensured.status === "skipped") {
			if (ensured.reason === "off" || ensured.reason === "v1_compat") {
				return { status: "skipped", reason: ensured.reason };
			}
			baseline = input.store.getBaseline(input.runId);
		} else {
			baseline = ensured.baseline;
		}
	}
	if (!baseline)
		return error(
			"BUDGET_BASELINE_MISSING",
			"Review budget baseline is missing",
		);

	const parsed = parseDeliveryBudget(input.planMarkdown);
	if (!parsed.ok) return error(parsed.code, parsed.message);
	const incompleteClaimItem = findIncompleteDebtClaimItem(parsed.value);
	if (incompleteClaimItem) {
		return error(
			"BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED",
			`Work item '${incompleteClaimItem.id}' requires complete debt-claim evidence`,
		);
	}

	const snapshots = input.store.listSnapshots(input.runId);
	const firstSnapshot = snapshots[0];
	const latest = snapshots.at(-1);
	const matchingSnapshot = snapshots.find(
		(snapshot) =>
			snapshot.stepName === input.stepName &&
			(snapshot.phase ?? undefined) === input.phase &&
			(snapshot.iteration ?? undefined) === input.iteration,
	);
	const isInitialRetry =
		matchingSnapshot !== undefined &&
		matchingSnapshot === firstSnapshot &&
		firstSnapshot.baselineAssessment !== undefined;
	if (!latest && !input.verdict.baselineAssessment) {
		return error(
			"BASELINE_ASSESSMENT_REQUIRED",
			"baselineAssessment is required on the first active plan review",
		);
	}
	if (latest && input.verdict.baselineAssessment && !isInitialRetry) {
		return error(
			"BASELINE_ASSESSMENT_UNEXPECTED",
			"baselineAssessment is initial-review only",
		);
	}

	const authorClaimIds = new Set<string>();
	for (const item of parsed.value.workItems) {
		if (item.debtClaim) authorClaimIds.add(item.debtClaim.debtClaimId);
	}
	const reviewerClaimIds = new Set<string>();
	const findings: FindingDelta[] = [];
	for (const item of input.verdict.items) {
		if (
			!Number.isInteger(item.effortDelta) ||
			(item.effortDelta ?? -1) < 0 ||
			!isArchitectureDelta(item.architectureDelta)
		) {
			return error(
				"BUDGET_ITEM_FIELDS_REQUIRED",
				`Reviewer item '${item.id}' requires integer effortDelta >= 0 and an allowed architectureDelta`,
			);
		}
		if ((item.architectureDelta ?? 0) < 0 && !item.coupling) {
			return error(
				"BUDGET_ITEM_FIELDS_REQUIRED",
				`Reviewer item '${item.id}' requires coupling for a negative architectureDelta`,
			);
		}
		let creditClaim: DebtClaimEvidence | undefined;
		if (item.creditClaim) {
			if (authorClaimIds.has(item.creditClaim.creditClaimId)) {
				return error(
					"CREDIT_CLAIM_ID_COLLISION",
					`Reviewer credit claim '${item.creditClaim.creditClaimId}' collides with an author claim`,
				);
			}
			creditClaim = {
				debtClaimId: item.creditClaim.creditClaimId,
				coupling: item.coupling ?? "unrelated",
				targetPhase: item.creditClaim.targetPhase,
				minimalAlternativeEffortDelta:
					item.creditClaim.minimalAlternativeEffortDelta,
				minimalAlternativeArchitectureDelta: item.creditClaim
					.minimalAlternativeArchitectureDelta as DebtClaimEvidence["minimalAlternativeArchitectureDelta"],
				before: item.creditClaim.before,
				after: item.creditClaim.after,
			};
			if (!isCompleteDebtClaimEvidence(creditClaim)) {
				return error(
					"BUDGET_ITEM_FIELDS_REQUIRED",
					`Reviewer item '${item.id}' has incomplete creditClaim evidence`,
				);
			}
			reviewerClaimIds.add(item.creditClaim.creditClaimId);
		}
		findings.push({
			id: item.id,
			effortDelta: item.effortDelta as number,
			architectureDelta: item.architectureDelta as number,
			scopeClass: item.scopeClass,
			coupling: item.coupling,
			...(creditClaim ? { creditClaim } : {}),
		});
	}

	const currentAssessments = new Map<string, CreditAssessmentInput>();
	const unknown: string[] = [];
	for (const assessment of input.verdict.creditAssessments ?? []) {
		if (
			!authorClaimIds.has(assessment.creditClaimId) &&
			!reviewerClaimIds.has(assessment.creditClaimId)
		) {
			unknown.push(assessment.creditClaimId);
		}
		currentAssessments.set(assessment.creditClaimId, {
			creditClaimId: assessment.creditClaimId,
			eligibility: assessment.eligibility,
			coupling: assessment.coupling,
		});
	}
	if (unknown.length > 0) {
		return error(
			"CREDIT_ASSESSMENT_UNKNOWN_CLAIM",
			`Credit assessments name unknown claims: ${[...new Set(unknown)].join(", ")}`,
		);
	}

	const effective = new Map(
		(latest?.assessments ?? []).map((assessment) => [
			assessment.creditClaimId,
			assessment,
		]),
	);
	for (const [id, assessment] of currentAssessments)
		effective.set(id, assessment);
	const previousClaims = new Map(
		(latest?.currentLedger.workItems ?? [])
			.filter((item) => item.debtClaim)
			.map((item) => [item.debtClaim?.debtClaimId as string, item]),
	);
	const missing: string[] = [];
	for (const item of parsed.value.workItems) {
		if (!item.debtClaim) continue;
		const previous = previousClaims.get(item.debtClaim.debtClaimId);
		if (
			(!previous || !sameClaim(item, previous)) &&
			!currentAssessments.has(item.debtClaim.debtClaimId)
		) {
			missing.push(item.debtClaim.debtClaimId);
		}
	}
	if (missing.length > 0) {
		return error(
			"CREDIT_ASSESSMENT_REQUIRED",
			`Current credit assessments are required for: ${missing.join(", ")}`,
		);
	}
	const effectiveAssessments = [...effective.values()].filter((assessment) =>
		authorClaimIds.has(assessment.creditClaimId),
	);
	const firstAssessment =
		firstSnapshot?.baselineAssessment ?? input.verdict.baselineAssessment;
	const snapshotBaselineAssessment = isInitialRetry
		? firstSnapshot.baselineAssessment
		: latest
			? undefined
			: input.verdict.baselineAssessment;
	const { mode: _mode, ...thresholds } = input.config;
	const derived = deriveBudget({
		B0: baseline.b0,
		B: baseline.b,
		I: firstAssessment?.independentEffortEstimate ?? null,
		workItems: parsed.value.workItems,
		findings,
		assessments: effectiveAssessments,
		config: thresholds,
		semanticHumanRequired: input.verdict.items.some(
			(item) => item.action === "human_required",
		),
	});
	const pendingSnapshot: PendingBudgetSnapshot = {
		runId: input.runId,
		stepName: input.stepName,
		phase: input.phase,
		iteration: input.iteration,
		currentLedger: parsed.value,
		findings,
		assessments: effectiveAssessments,
		...(snapshotBaselineAssessment
			? { baselineAssessment: snapshotBaselineAssessment }
			: {}),
		derived,
	};
	return {
		status: "applied",
		verdict: { ...input.verdict, budget: derived },
		pendingSnapshot,
	};
}
