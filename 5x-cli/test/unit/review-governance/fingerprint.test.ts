import { describe, expect, test } from "bun:test";
import { canonicalFindingFingerprint } from "../../../src/review-governance/fingerprint.js";

describe("canonicalFindingFingerprint", () => {
	const finding = {
		title: "Missing rollback",
		scopeClass: "acceptance_required" as const,
		failure: "A failed write leaves partial state.",
		lowestCostCorrection: "Wrap both writes in one transaction.",
	};

	test("is stable across object key order, Unicode form, line endings, and insignificant whitespace", () => {
		const reordered = {
			lowestCostCorrection: "Wrap both writes in one transaction.\r\n",
			failure: "A failed write leaves  partial state.",
			scopeClass: "acceptance_required" as const,
			title: "MISSING ROLLBACK",
		};
		expect(canonicalFindingFingerprint(reordered)).toBe(
			canonicalFindingFingerprint(finding),
		);

		const composed = { ...finding, title: "Café rollback" };
		const decomposed = { ...finding, title: "Cafe\u0301 rollback" };
		expect(canonicalFindingFingerprint(composed)).toBe(
			canonicalFindingFingerprint(decomposed),
		);
		expect(canonicalFindingFingerprint(finding)).toMatch(
			/^sha256:[0-9a-f]{64}$/,
		);
	});

	test("changes for material identity fields but not mutable estimates or prose", () => {
		const original = canonicalFindingFingerprint(finding);
		expect(
			canonicalFindingFingerprint({ ...finding, failure: "Data is deleted." }),
		).not.toBe(original);
		expect(
			canonicalFindingFingerprint({ ...finding, scopeClass: "risk_reduction" }),
		).not.toBe(original);
		expect(
			canonicalFindingFingerprint({
				...finding,
				lowestCostCorrection: "Use an idempotency key.",
			}),
		).not.toBe(original);
	});
});
