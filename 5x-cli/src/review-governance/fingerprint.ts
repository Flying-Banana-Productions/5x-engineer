import { createHash } from "node:crypto";
import {
	type ImplementationScopeClass,
	isImplementationScopeClass,
	type VerdictItem,
} from "../protocol.js";
import type { PlanScopeClass } from "../review-budget/types.js";
import type { PersistedFinding } from "./types.js";

function normalizeText(value: string, caseInsensitive = false): string {
	const normalized = value
		.normalize("NFKC")
		.replace(/\r\n?/g, "\n")
		.replace(/[\t\n\f\r ]+/g, " ")
		.trim();
	return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function canonicalJson(values: Record<string, string>): string {
	const sorted = Object.keys(values)
		.sort()
		.reduce<Record<string, string>>((result, key) => {
			result[key] = values[key] ?? "";
			return result;
		}, {});
	return JSON.stringify(sorted);
}

/** Canonical numeric phase id. Labels such as `phase-2` are not admitted. */
function admittedNumericPhase(phase: string | undefined): string | null {
	const trimmed = phase?.trim() ?? "";
	return /^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : null;
}

export function canonicalFindingFingerprint(input: {
	title: string;
	scopeClass: PlanScopeClass | ImplementationScopeClass;
	failure: string;
	lowestCostCorrection: string;
	/** Included only for implementation identities so plan hashes stay stable. */
	phase?: string;
	planWorkItemIds?: readonly string[];
}): string {
	const values: Record<string, string> = {
		failure: normalizeText(input.failure),
		lowestCostCorrection: normalizeText(input.lowestCostCorrection),
		scopeClass: normalizeText(input.scopeClass, true),
		title: normalizeText(input.title, true),
	};
	if (isImplementationScopeClass(input.scopeClass)) {
		const phase = admittedNumericPhase(input.phase);
		if (!phase) {
			throw new TypeError(
				"Implementation fingerprints require an admitted numeric phase.",
			);
		}
		values.phase = normalizeText(phase);
		values.planWorkItemIds = (input.planWorkItemIds ?? [])
			.map((id) => normalizeText(id))
			.sort()
			.join(",");
	}
	const canonical = canonicalJson(values);
	const hash = createHash("sha256").update(canonical).digest("hex");
	return `sha256:${hash}`;
}

export function normalizeFindingEvidenceText(value: string): string {
	return normalizeText(value, true);
}

/** Canonical item fingerprint shared by closure validation and routing. */
export function fingerprintVerdictItem(
	item: VerdictItem,
	fallback?: PersistedFinding,
	linkage?: { phase?: string },
): string {
	const scopeClass =
		item.scopeClass ?? fallback?.scopeClass ?? "acceptance_required";
	const failure = item.failure ?? fallback?.failure ?? item.reason;
	const lowestCostCorrection =
		item.lowestCostCorrection ?? fallback?.lowestCostCorrection ?? item.reason;
	return canonicalFindingFingerprint({
		title: item.title || fallback?.title || "",
		scopeClass,
		failure,
		lowestCostCorrection,
		phase: linkage?.phase,
		planWorkItemIds: item.planWorkItemIds,
	});
}

/**
 * Implementation identity for an admitted numeric phase.
 * Plan fingerprints stay on {@link fingerprintVerdictItem} and omit phase.
 * Observation writers must use this helper (or the identities already
 * attached to implementation governance) so cross-phase collisions cannot
 * collapse onto an empty phase.
 */
export function fingerprintImplementationVerdictItem(
	item: VerdictItem,
	admittedPhase: string,
	fallback?: PersistedFinding,
): string {
	const phase = admittedNumericPhase(admittedPhase);
	if (!phase) {
		throw new TypeError(
			"Implementation fingerprints require an admitted numeric phase.",
		);
	}
	return fingerprintVerdictItem(item, fallback, { phase });
}
