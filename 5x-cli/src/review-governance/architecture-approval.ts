import type {
	ImplementationBindingPayload,
	InheritedBudgetGovernance,
} from "../review-budget/record-lines.js";
import type { DerivedBudgetResult } from "../review-budget/types.js";
import { decodeReviewDecisionPayload } from "./codec.js";
import type { ArchitectureApproval } from "./decisions.js";

/** Aggregate ceilings and individual threshold-crossing identities are separate. */
export function applicableArchitectureApproval(input: {
	P: number;
	approvals: readonly ArchitectureApproval[];
	itemIds: readonly string[];
	workItemIds: readonly string[];
}): string | undefined {
	for (const approval of [...input.approvals].reverse()) {
		if (input.P > approval.approvedP) continue;
		if (!input.itemIds.every((id) => approval.approvedItemIds.includes(id)))
			continue;
		if (
			!input.workItemIds.every((id) =>
				approval.approvedWorkItemIds.includes(id),
			)
		)
			continue;
		return approval.decisionId;
	}
	return undefined;
}

/** Consume the sealed binding, never later decisions from the mutable source run. */
export function deriveInheritedBudgetGovernance(
	binding: ImplementationBindingPayload,
	budget: DerivedBudgetResult,
	materialCreditShortfall = false,
): InheritedBudgetGovernance {
	const resolvedBy = applicableArchitectureApproval({
		P: budget.P,
		approvals: binding.effectiveDecisions.flatMap((raw) => {
			try {
				const decision = decodeReviewDecisionPayload(raw);
				return decision.choice === "approve_architecture_burden" &&
					decision.architectureApproval
					? [
							{
								decisionId: decision.decisionId,
								...decision.architectureApproval,
							},
						]
					: [];
			} catch {
				// Unknown legacy entries cannot authorize architecture burden.
				return [];
			}
		}),
		itemIds: [],
		workItemIds: binding.ledger.workItems
			.filter(
				(item) =>
					item.architectureDelta >=
					binding.thresholds.singleArchitectureReviewPoints,
			)
			.map((item) => item.id),
	});
	const suppressedAlerts: InheritedBudgetGovernance["suppressedAlerts"] =
		resolvedBy && budget.budgetAlerts.includes("positive_architecture_exceeded")
			? [{ alert: "positive_architecture_exceeded", resolvedBy }]
			: [];
	const effectiveAlerts = budget.budgetAlerts.filter(
		(alert) => !suppressedAlerts.some((cause) => cause.alert === alert),
	);
	return {
		bindingId: binding.id,
		sourceRunId: binding.sourceRunId,
		sourceSnapshotId: binding.sourceSnapshotId,
		P: budget.P,
		effectiveAlerts,
		suppressedAlerts,
		requiresHuman:
			materialCreditShortfall ||
			budget.budgetBand === "over_effective" ||
			budget.budgetBand === "over_absolute" ||
			effectiveAlerts.some((alert) => alert !== "credit_unrealized"),
	};
}
