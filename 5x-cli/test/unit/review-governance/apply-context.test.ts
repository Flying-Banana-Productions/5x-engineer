import { describe, expect, test } from "bun:test";
import type { ReviewBudgetSnapshotRecord } from "../../../src/control-plane/review-budget-store.js";
import { persistedFindingsFromSnapshots } from "../../../src/review-governance/apply.js";
import {
	appendPlanReviewPromptContext,
	formatReviewerGovernanceContext,
} from "../../../src/review-governance/context.js";
import { canonicalFindingFingerprint } from "../../../src/review-governance/fingerprint.js";
import { pendingSnapshot } from "../commands/review-budget-test-helpers.js";

const identity = {
	title: "Atomic write",
	scopeClass: "acceptance_required" as const,
	failure: "A retry can write twice.",
	lowestCostCorrection: "Use an idempotency key.",
};
const fingerprint = canonicalFindingFingerprint(identity);

function snapshot(
	iteration: number,
	input: {
		finding?: boolean;
		status?: "addressed" | "partially_addressed" | "still_open";
	},
): ReviewBudgetSnapshotRecord {
	const value = pendingSnapshot(iteration);
	return {
		...value,
		createdAt: `2026-01-01 00:00:0${iteration}`,
		findings: input.finding
			? [
					{
						id: "P1.1",
						action: "auto_fix",
						effortDelta: 1,
						architectureDelta: 0,
						estimateConfidence: "high",
						fingerprint,
						...identity,
					},
				]
			: [],
		priorFindings: input.status ? [{ id: "P1.1", status: input.status }] : [],
	} as unknown as ReviewBudgetSnapshotRecord;
}

describe("plan review finding history", () => {
	test("reintroduced findings clear stale prior outcomes", () => {
		const findings = persistedFindingsFromSnapshots([
			snapshot(1, { finding: true }),
			snapshot(2, { status: "addressed" }),
			snapshot(3, { finding: true }),
		]);
		expect(findings).toEqual([
			expect.objectContaining({ findingId: "P1.1", fingerprint }),
		]);
		expect(findings[0]).not.toHaveProperty("status");
	});
});

describe("plan review prompt projection", () => {
	test("renders prior findings and appends diff before governance identically", () => {
		const governance = formatReviewerGovernanceContext({
			reviewKind: "closure",
			mode: "enforced",
			priorFindings: [
				{
					findingId: "P1.1",
					fingerprint,
					...identity,
					status: "still_open",
				},
			],
			deferredOrAcceptedRisks: [],
			approvedScope: { retained: ["W1"], removed: [] },
			governingBaseline: 3,
			requestAuthorReestimate: false,
		});
		expect(governance).toContain("### Prior findings");
		expect(governance).toContain(`P1.1 (${fingerprint}) [still_open]`);
		const projected = appendPlanReviewPromptContext({
			prompt: "base",
			diffAppend: "diff",
			governanceAppend: governance,
		});
		expect(projected).toBe(`base\ndiff\n\n${governance}`);
	});
});
