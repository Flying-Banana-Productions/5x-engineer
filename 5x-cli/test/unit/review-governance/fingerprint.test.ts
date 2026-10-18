import { describe, expect, test } from "bun:test";
import {
	canonicalFindingFingerprint,
	fingerprintVerdictItem,
} from "../../../src/review-governance/fingerprint.js";

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

	test("keeps plan hashes stable and qualifies implementation identities by phase and work items", () => {
		const plan = canonicalFindingFingerprint(finding);
		expect(
			canonicalFindingFingerprint({
				...finding,
				phase: "2",
				planWorkItemIds: ["W2", "W1"],
			}),
		).toBe(plan);
		const implementation = {
			...finding,
			scopeClass: "implementation_defect" as const,
			planWorkItemIds: ["W2", "W1"],
			phase: "2",
		};
		const first = canonicalFindingFingerprint(implementation);
		expect(
			canonicalFindingFingerprint({
				...implementation,
				planWorkItemIds: ["W1", "W2"],
			}),
		).toBe(first);
		expect(
			canonicalFindingFingerprint({ ...implementation, phase: "3" }),
		).not.toBe(first);
		expect(
			canonicalFindingFingerprint({
				...implementation,
				planWorkItemIds: ["W9"],
			}),
		).not.toBe(first);
		expect(first).not.toBe(plan);
		expect(() =>
			canonicalFindingFingerprint({
				...finding,
				scopeClass: "implementation_defect",
			}),
		).toThrow("admitted numeric phase");
		expect(() =>
			fingerprintVerdictItem({
				id: "I1",
				title: finding.title,
				action: "auto_fix",
				reason: finding.failure,
				scopeClass: "implementation_defect",
				failure: finding.failure,
				lowestCostCorrection: finding.lowestCostCorrection,
				planWorkItemIds: ["W1"],
			}),
		).toThrow("admitted numeric phase");
		expect(
			fingerprintVerdictItem(
				{
					id: "I1",
					title: finding.title,
					action: "auto_fix",
					reason: finding.failure,
					scopeClass: "implementation_defect",
					failure: finding.failure,
					lowestCostCorrection: finding.lowestCostCorrection,
					planWorkItemIds: ["W1"],
				},
				undefined,
				{ phase: "2" },
			),
		).toBe(
			canonicalFindingFingerprint({
				title: finding.title,
				scopeClass: "implementation_defect",
				failure: finding.failure,
				lowestCostCorrection: finding.lowestCostCorrection,
				phase: "2",
				planWorkItemIds: ["W1"],
			}),
		);
	});
});
