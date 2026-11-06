/**
 * Final committed plan approval reconciliation.
 *
 * A plan review approves the ledger its reviewer saw. A one-pass
 * `final_corrections` route then lets the author apply the admitted
 * corrections without a second review. Recording a corrected finding in a
 * work item's `Addresses` is ledger bookkeeping for that route; it is not a
 * new budget, claim or scope decision. The route also admits the effort its
 * corrections were recorded with (at most one point, within the effective
 * ceiling, counted once), so a work item may carry that effort when it
 * records the funding finding in `Addresses`. This module proves that the
 * final committed ledger differs from the reviewed ledger only by that
 * bookkeeping, that attributable effort, and nonidentity parse data (line
 * numbers, titles, rationale). Every other delta is substantive and is
 * reported field by field.
 *
 * Pure: no store, Git or clock access.
 */

import type {
	DebtClaimEvidence,
	ParsedDeliveryBudget,
	ParsedWorkItem,
} from "../review-budget/types.js";
import { FINAL_CORRECTION_EFFORT_LIMIT } from "./routing.js";

export type FinalLedgerChangeField =
	| "estimateConfidence"
	| "surface"
	| "workItems"
	| "effort"
	| "architectureDelta"
	| "debtClaim"
	| "addresses";

/** One substantive difference between the reviewed and final ledgers. */
export interface FinalLedgerChange {
	field: FinalLedgerChangeField;
	workItemId?: string;
	before: unknown;
	after: unknown;
	reason: string;
}

/** Admitted finding IDs recorded on one work item's `Addresses`. */
export interface AddressAddition {
	workItemId: string;
	findingIds: string[];
}

/**
 * The recorded final-corrections route's effort evidence: each admitted
 * correction's reviewer-recorded `effortDelta` and the effective ceiling the
 * route was admitted under. Absent for a ready approval, which admits none.
 */
export interface FinalCorrectionBudget {
	corrections: Array<{ findingId: string; effortDelta: number }>;
	effectiveCeiling: number;
}

/** One work item's effort change, funded by the named admitted corrections. */
export interface EffortCorrection {
	workItemId: string;
	before: number;
	after: number;
	findingIds: string[];
}

export type FinalLedgerReconciliation =
	| {
			ok: true;
			/** The final committed ledger: the effective approved ledger. */
			ledger: ParsedDeliveryBudget;
			addressAdditions: AddressAddition[];
			effortCorrections: EffortCorrection[];
	  }
	| { ok: false; changes: FinalLedgerChange[] };

function claimIdentity(claim: DebtClaimEvidence | null): unknown {
	if (!claim) return null;
	return {
		debtClaimId: claim.debtClaimId,
		coupling: claim.coupling,
		targetPhase: claim.targetPhase,
		minimalAlternativeEffortDelta: claim.minimalAlternativeEffortDelta,
		minimalAlternativeArchitectureDelta:
			claim.minimalAlternativeArchitectureDelta,
		before: claim.before,
		after: claim.after,
	};
}

function surfaceIdentity(ledger: ParsedDeliveryBudget): unknown {
	const surface = ledger.surface;
	return {
		subsystems: surface.subsystems,
		productionFiles: surface.productionFiles,
		persistentOrExternalBoundaries: surface.persistentOrExternalBoundaries,
		newSharedAbstractions: surface.newSharedAbstractions ?? null,
		newPersistentSchemas: surface.newPersistentSchemas ?? null,
	};
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Correction effort not yet attributed to a work item. A finding funds at
 * most one item, so its effort is counted once.
 */
type UnspentCorrectionEffort = Map<string, number>;

function compareItem(
	reviewed: ParsedWorkItem,
	final: ParsedWorkItem,
	admitted: ReadonlySet<string>,
	unspent: UnspentCorrectionEffort,
	changes: FinalLedgerChange[],
	additions: AddressAddition[],
	effortCorrections: EffortCorrection[],
): void {
	const id = reviewed.id;
	if (reviewed.architectureDelta !== final.architectureDelta) {
		changes.push({
			field: "architectureDelta",
			workItemId: id,
			before: reviewed.architectureDelta,
			after: final.architectureDelta,
			reason: `${id} architecture delta changed; the final-corrections route admits no architecture change.`,
		});
	}
	if (
		!same(claimIdentity(reviewed.debtClaim), claimIdentity(final.debtClaim))
	) {
		changes.push({
			field: "debtClaim",
			workItemId: id,
			before: claimIdentity(reviewed.debtClaim),
			after: claimIdentity(final.debtClaim),
			reason: `${id} debt claim changed; claims need review or an amendment.`,
		});
	}
	const before = new Set(reviewed.addresses);
	const after = new Set(final.addresses);
	const removed = [...before].filter((entry) => !after.has(entry)).sort();
	const added = [...after].filter((entry) => !before.has(entry)).sort();
	const unadmitted = added.filter((entry) => !admitted.has(entry));
	const addressesValid = removed.length === 0 && unadmitted.length === 0;
	compareEffort(
		reviewed,
		final,
		addressesValid ? added : [],
		unspent,
		changes,
		effortCorrections,
	);
	if (!addressesValid) {
		changes.push({
			field: "addresses",
			workItemId: id,
			before: [...reviewed.addresses].sort(),
			after: [...final.addresses].sort(),
			reason: [
				removed.length > 0 ? `removes ${removed.join(", ")}` : "",
				unadmitted.length > 0
					? `adds ${unadmitted.join(", ")}, which the recorded final-corrections route did not admit`
					: "",
			]
				.filter(Boolean)
				.join("; ")
				.replace(/^/, `${id} Addresses `),
		});
		return;
	}
	if (added.length > 0) additions.push({ workItemId: id, findingIds: added });
}

/**
 * An effort change is admitted only as an increase funded by admitted
 * corrections this item newly records in `Addresses`, using their recorded
 * effort not already attributed to another item. Decreases and unfunded
 * increases are rescoring.
 */
function compareEffort(
	reviewed: ParsedWorkItem,
	final: ParsedWorkItem,
	addedAdmitted: readonly string[],
	unspent: UnspentCorrectionEffort,
	changes: FinalLedgerChange[],
	effortCorrections: EffortCorrection[],
): void {
	const id = reviewed.id;
	const delta = final.effort - reviewed.effort;
	if (delta === 0) return;
	const funding = addedAdmitted.filter(
		(findingId) => (unspent.get(findingId) ?? 0) > 0,
	);
	const available = funding.reduce(
		(total, findingId) => total + (unspent.get(findingId) ?? 0),
		0,
	);
	if (delta < 0 || delta > available) {
		changes.push({
			field: "effort",
			workItemId: id,
			before: reviewed.effort,
			after: final.effort,
			reason:
				delta < 0 || funding.length === 0
					? `${id} effort changed without an admitted correction recorded in its Addresses to fund it; final corrections do not re-score work.`
					: `${id} effort changed by ${delta}, beyond the ${available} point(s) recorded for ${funding.join(", ")}.`,
		});
		return;
	}
	for (const findingId of funding) unspent.set(findingId, 0);
	effortCorrections.push({
		workItemId: id,
		before: reviewed.effort,
		after: final.effort,
		findingIds: [...funding],
	});
}

function totalEffort(ledger: ParsedDeliveryBudget): number {
	return ledger.workItems.reduce((total, item) => total + item.effort, 0);
}

/**
 * Reconcile the final committed ledger against the reviewed ledger.
 * `admittedFindingIds` are the corrections the recorded route admitted;
 * empty for an ordinary ready approval, which must match exactly.
 * `correctionBudget` is the route's recorded effort evidence; without it no
 * effort change is admitted.
 */
export function reconcileFinalApprovalLedger(input: {
	reviewed: ParsedDeliveryBudget;
	final: ParsedDeliveryBudget;
	admittedFindingIds: readonly string[];
	correctionBudget?: FinalCorrectionBudget | null;
}): FinalLedgerReconciliation {
	const admitted = new Set(input.admittedFindingIds);
	const changes: FinalLedgerChange[] = [];
	const additions: AddressAddition[] = [];
	const effortCorrections: EffortCorrection[] = [];
	const unspent: UnspentCorrectionEffort = new Map();
	for (const correction of input.correctionBudget?.corrections ?? []) {
		if (!admitted.has(correction.findingId)) continue;
		if (!(correction.effortDelta > 0)) continue;
		unspent.set(
			correction.findingId,
			(unspent.get(correction.findingId) ?? 0) + correction.effortDelta,
		);
	}
	if (input.reviewed.estimateConfidence !== input.final.estimateConfidence) {
		changes.push({
			field: "estimateConfidence",
			before: input.reviewed.estimateConfidence,
			after: input.final.estimateConfidence,
			reason: "Estimate confidence changed.",
		});
	}
	if (!same(surfaceIdentity(input.reviewed), surfaceIdentity(input.final))) {
		changes.push({
			field: "surface",
			before: surfaceIdentity(input.reviewed),
			after: surfaceIdentity(input.final),
			reason: "Surface Snapshot changed.",
		});
	}
	const reviewedIds = input.reviewed.workItems.map((item) => item.id);
	const finalIds = input.final.workItems.map((item) => item.id);
	if (!same(reviewedIds, finalIds)) {
		changes.push({
			field: "workItems",
			before: reviewedIds,
			after: finalIds,
			reason: "Work items were added, removed or reordered.",
		});
	}
	const finalById = new Map(
		input.final.workItems.map((item) => [item.id, item] as const),
	);
	for (const reviewed of input.reviewed.workItems) {
		const final = finalById.get(reviewed.id);
		if (!final) continue;
		compareItem(
			reviewed,
			final,
			admitted,
			unspent,
			changes,
			additions,
			effortCorrections,
		);
	}
	const corrected = effortCorrections.reduce(
		(total, entry) => total + (entry.after - entry.before),
		0,
	);
	if (corrected > 0) {
		const reviewedEffort = totalEffort(input.reviewed);
		const ceiling = input.correctionBudget?.effectiveCeiling ?? reviewedEffort;
		if (corrected > FINAL_CORRECTION_EFFORT_LIMIT) {
			changes.push({
				field: "effort",
				before: reviewedEffort,
				after: reviewedEffort + corrected,
				reason: `Final corrections add ${corrected} effort point(s); the final-corrections route admits at most ${FINAL_CORRECTION_EFFORT_LIMIT}.`,
			});
		}
		if (reviewedEffort + corrected > ceiling) {
			changes.push({
				field: "effort",
				before: reviewedEffort,
				after: reviewedEffort + corrected,
				reason: `Final corrections raise committed effort to ${reviewedEffort + corrected}, above the effective ceiling ${ceiling} recorded for the route.`,
			});
		}
	}
	if (changes.length > 0) return { ok: false, changes };
	return {
		ok: true,
		ledger: structuredClone(input.final),
		addressAdditions: additions,
		effortCorrections,
	};
}

/** One line per change, for operator-facing messages. */
export function describeFinalLedgerChanges(
	changes: readonly FinalLedgerChange[],
): string {
	return changes.map((change) => change.reason).join(" ");
}

/**
 * Same-run remedy for a plan run whose committed correction exceeds the
 * recorded route: review the corrected plan on this run, or revert the
 * substantive change, then complete again. The run stays active.
 */
export function sameRunFinalizationNext(runId: string): string[] {
	return [
		`5x template render reviewer-plan --run ${runId}`,
		`5x protocol validate reviewer --run ${runId} --record --step <step_name from render> --phase plan --iteration <next>`,
		`5x run complete --run ${runId}`,
	];
}

/**
 * Exact-plan re-review for a sealed legacy source whose committed ledger
 * differs in a way its recorded evidence does not establish. The sealed
 * source is not reopened.
 */
export function legacyReReviewNext(input: {
	planPath: string;
	executionRunId: string;
}): string[] {
	return [
		`5x run init --plan ${input.planPath}`,
		"5x template render reviewer-plan --run <new-plan-review-run>",
		`5x review implementation bind --run ${input.executionRunId} --source-run <new-plan-review-run>`,
	];
}
