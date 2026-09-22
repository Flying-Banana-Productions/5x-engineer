import { createHash } from "node:crypto";
import type { PlanScopeClass } from "../review-budget/types.js";

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
	scopeClass: PlanScopeClass;
	failure: string;
	lowestCostCorrection: string;
}): string {
	const canonical = canonicalJson({
		failure: normalizeText(input.failure),
		lowestCostCorrection: normalizeText(input.lowestCostCorrection),
		scopeClass: normalizeText(input.scopeClass, true),
		title: normalizeText(input.title, true),
	});
	const hash = createHash("sha256").update(canonical).digest("hex");
	return `sha256:${hash}`;
}

export function normalizeFindingEvidenceText(value: string): string {
	return normalizeText(value, true);
}
