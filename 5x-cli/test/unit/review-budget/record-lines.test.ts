import { describe, expect, test } from "bun:test";
import {
	type BudgetSnapshotPayload,
	decodeBudgetBaselinePayload,
	decodeBudgetSnapshotPayload,
	encodeBudgetSnapshotPayload,
} from "../../../src/review-budget/record-lines.js";
import type { BaselineAssessment } from "../../../src/review-budget/types.js";

const baselineAssessment: BaselineAssessment = {
	independentEffortEstimate: 5,
	confidence: "high",
	reason: "Independent estimate",
};

function payload(): BudgetSnapshotPayload {
	return {
		kind: "snapshot",
		id: "id",
		runId: "run1",
		stepKey: { stepName: "reviewer:plan", phase: "plan", iteration: 1 },
		currentLedger: {
			estimateConfidence: "medium",
			workItems: [],
			surface: {
				subsystems: 1,
				productionFiles: 2,
				persistentOrExternalBoundaries: 0,
			},
		},
		findings: [],
		assessments: [],
		createdAt: "2026-09-17T00:00:00.000Z",
	};
}

describe("budget snapshot payload codec", () => {
	test("defaults pre-governance baselines to advisory mode", () => {
		expect(
			decodeBudgetBaselinePayload({
				kind: "baseline",
				id: "baseline",
				runId: "run1",
				captureKind: "initial",
				b0: 2,
				b: 2,
				originalLedger: payload().currentLedger,
				surface: payload().currentLedger.surface,
				originalSection: null,
				configSnapshot: {
					growthPercent: 25,
					minimumGrowthPoints: 2,
					debtTradeoffRatio: 1,
					maxDebtCreditPercent: 25,
					absoluteGrowthPercent: 50,
					baselineDisagreementPercent: 25,
					minimumBaselineDisagreementPoints: 2,
					maxPositiveArchitecturePercent: 25,
					minimumPositiveArchitecturePoints: 2,
					singleArchitectureReviewPoints: 5,
				},
				createdAt: "2026-09-17T00:00:00.000Z",
			}).mode,
		).toBe("advisory");
	});

	test("round-trips baselineAssessment when present", () => {
		const input = { ...payload(), baselineAssessment };
		expect(
			decodeBudgetSnapshotPayload(encodeBudgetSnapshotPayload(input)),
		).toEqual(input);
	});

	test("round-trips governance evidence needed for rebuild", () => {
		const input: BudgetSnapshotPayload = {
			...payload(),
			priorFindings: [{ id: "P1", status: "still_open" }],
			effectiveGateCauses: [{ kind: "budget_band", band: "over_effective" }],
			suppressedGateCauses: [
				{ kind: "budget_alert", alert: "baseline_disputed", resolvedBy: "d1" },
			],
			diagnostics: [
				{
					code: "PRIOR_FINDING_OMITTED",
					severity: "error",
					message: "missing",
				},
			],
		};
		expect(
			decodeBudgetSnapshotPayload(encodeBudgetSnapshotPayload(input)),
		).toEqual(input);
	});

	test("omits baselineAssessment when absent", () => {
		const input = payload();
		const encoded = encodeBudgetSnapshotPayload(input) as Record<
			string,
			unknown
		>;
		expect(encoded).not.toHaveProperty("baselineAssessment");
		expect(
			decodeBudgetSnapshotPayload(encoded).baselineAssessment,
		).toBeUndefined();
	});
});
