import { describe, expect, test } from "bun:test";
import {
	type BudgetSnapshotPayload,
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
	test("round-trips baselineAssessment when present", () => {
		const input = { ...payload(), baselineAssessment };
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
