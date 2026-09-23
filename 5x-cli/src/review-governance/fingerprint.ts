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
		values.phase = normalizeText(input.phase ?? "");
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
