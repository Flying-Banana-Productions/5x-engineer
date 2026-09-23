import { describe, expect, test } from "bun:test";
import type { ReviewBudgetSnapshotRecord } from "../../../src/control-plane/review-budget-store.js";
import {
	applyPlanReviewGovernance,
	persistedFindingsFromSnapshots,
} from "../../../src/review-governance/apply.js";
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

	test("governance decoration returns a new pending snapshot without mutating input", () => {
		const pending = pendingSnapshot();
		const before = structuredClone(pending);
		Object.freeze(pending);
		const result = applyPlanReviewGovernance({
			verdict: {
				readiness: "ready",
				items: [],
				baselineAssessment: pending.baselineAssessment,
			},
			budgetResult: {
				status: "applied",
				verdict: {
					readiness: "ready",
					items: [],
					baselineAssessment: pending.baselineAssessment,
					budget: pending.derived,
				},
				pendingSnapshot: pending,
			},
			snapshots: [],
			decisions: [],
			governingState: {
				governingBaseline: 2,
				approvedScope: { retained: [], removed: [] },
				acceptedRisks: [],
				architectureApprovals: [],
				aborted: false,
				history: [],
				auditOnly: [],
			},
			mode: "enforced",
		});
		expect(result.status).toBe("applied");
		if (result.status !== "applied") throw new Error("expected applied result");
		expect(result.pendingSnapshot).not.toBe(pending);
		expect(pending).toEqual(before);
		expect(result.pendingSnapshot.mode).toBe("enforced");
	});
});

describe("plan review prompt projection", () => {
	test("renders prior findings and appends diff before governance identically", () => {
		const governance = formatReviewerGovernanceContext({
			reviewKind: "closure",
			mode: "enforced",
			requiredOutcomeIds: ["P1.1"],
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
