/**
 * Operating restrictions: accepted `accept_with_restriction` implementation
 * decisions. A restriction lets work continue under an operator condition
 * (for example a release ordering) without recording it as accepted risk.
 * Restrictions are binding-wide, so later phases and run completion see them.
 */

import type { RecordStore } from "../control-plane/record-store.js";
import {
	classifyDecisionAcceptance,
	type ImplementationDecisionPayload,
	listImplementationDecisions,
} from "./decisions.js";

export interface OperatingRestriction {
	decisionId: string;
	gateId: string;
	phase: string;
	findingIds: string[];
	restriction: string;
	rationale: string;
	createdAt: string;
}

/** Restrictions from accepted, unsuperseded decisions, in decision order. */
export function operatingRestrictionsFrom(
	decisions: readonly ImplementationDecisionPayload[],
): OperatingRestriction[] {
	const superseded = new Set(
		decisions.flatMap((decision) =>
			decision.supersedesDecisionId ? [decision.supersedesDecisionId] : [],
		),
	);
	return decisions.flatMap((decision) =>
		decision.choice === "accept_with_restriction" &&
		decision.restriction !== undefined &&
		!superseded.has(decision.decisionId)
			? [
					{
						decisionId: decision.decisionId,
						gateId: decision.gateId,
						phase: decision.phase,
						findingIds: decision.findingRefs.map((ref) => ref.findingId),
						restriction: decision.restriction,
						rationale: decision.rationale,
						createdAt: decision.createdAt,
					},
				]
			: [],
	);
}

export function listOperatingRestrictions(input: {
	recordStore: RecordStore;
	runId: string;
	bindingId: string;
}): OperatingRestriction[] {
	const listed = listImplementationDecisions(input.recordStore, input.runId);
	const steps = input.recordStore.listLines(input.runId, "steps");
	const budget = input.recordStore.listLines(input.runId, "budget");
	return operatingRestrictionsFrom(
		listed.decisions.filter(
			(decision) =>
				decision.bindingId === input.bindingId &&
				classifyDecisionAcceptance({ decision, steps, budget }).accepted,
		),
	);
}
