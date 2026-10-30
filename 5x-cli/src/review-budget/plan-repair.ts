import { readAuthoritativeBudget } from "../plan-schema/authority.js";
import { isCompleteDebtClaimEvidence } from "./types.js";

/** A plan defect is an author repair gate, not an invalid reviewer response. */
export function planReviewRepairGate(planMarkdown: string) {
	const loaded = readAuthoritativeBudget(planMarkdown, "file");
	if (!loaded.ok) {
		return {
			status: "error" as const,
			code: "PLAN_REPAIR_REQUIRED",
			message: `Author repair required before plan review [${loaded.code}]: ${loaded.message} This is not a legacy fallback.`,
			detail: {
				reviewRoute: "author_revision",
				diagnostic: {
					code: loaded.code,
					message: loaded.message,
				},
				remediation:
					"Have the author repair and commit the Delivery Budget, then render/invoke the same review again. No reviewer verdict is required for this pre-review repair gate; it records no review and preserves the existing baseline. If this gate occurred while recording, re-review the repaired plan before recording a verdict.",
			},
		};
	}
	const parsed = loaded.parsed;
	const incomplete = parsed.ok
		? parsed.value.workItems.find(
				(item) =>
					item.architectureDelta < 0 &&
					!isCompleteDebtClaimEvidence(item.debtClaim),
			)
		: undefined;
	if (parsed.ok && !incomplete) return null;
	const diagnostic = !parsed.ok
		? {
				code: parsed.code,
				message: parsed.message,
				...(parsed.line ? { line: parsed.line } : {}),
			}
		: {
				code: "BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED",
				message: `Work item '${incomplete?.id}' requires complete debt-claim evidence`,
			};
	return {
		status: "error" as const,
		code: "PLAN_REPAIR_REQUIRED",
		message: `Author repair required before plan review [${diagnostic.code}]: ${diagnostic.message}`,
		detail: {
			reviewRoute: "author_revision",
			diagnostic,
			remediation:
				"Have the author repair and commit the Delivery Budget, then render/invoke the same review again. No reviewer verdict is required for this pre-review repair gate; it records no review and preserves the existing baseline. If this gate occurred while recording, re-review the repaired plan before recording a verdict.",
		},
	};
}
