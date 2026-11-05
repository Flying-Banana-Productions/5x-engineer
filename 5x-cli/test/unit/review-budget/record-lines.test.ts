import { describe, expect, test } from "bun:test";
import {
	type BudgetSnapshotPayload,
	decodeBudgetBaselinePayload,
	decodeBudgetSnapshotPayload,
	decodeImplementationBindingPayload,
	encodeBudgetSnapshotPayload,
	encodeImplementationBindingPayload,
	type ImplementationBindingPayload,
} from "../../../src/review-budget/record-lines.js";
import {
	type BaselineAssessment,
	DEFAULT_REVIEW_BUDGET_CONFIG,
} from "../../../src/review-budget/types.js";

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

function binding(
	extra?: Partial<
		Pick<
			ImplementationBindingPayload,
			| "planSchema"
			| "governingHash"
			| "schemaMigrationId"
			| "predecessorPlanCommit"
		>
	>,
): ImplementationBindingPayload {
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding",
		executionRunId: "exec",
		sourceRunId: "source",
		sourceSnapshotId: "snap",
		sourceBaselineId: "base",
		approvedPlanCommit: "a".repeat(40),
		approvedPlanHash: "sha256:approved",
		approvedPlanBytes: "# Plan\n",
		b0: 2,
		governingB: 2,
		mode: "advisory",
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger: {
			estimateConfidence: "medium",
			workItems: [],
			surface: {
				subsystems: 1,
				productionFiles: 1,
				persistentOrExternalBoundaries: 0,
			},
		},
		effectiveDecisions: [],
		phaseMap: [],
		debtTargets: [],
		ledgerHash: "sha256:ledger",
		decisionsHash: "sha256:decisions",
		createdAt: "2026-10-29 00:00:00",
		...extra,
	};
}

describe("implementation binding schema fields", () => {
	test("round-trips a schema 0 binding without schema fields", () => {
		const payload = binding();
		const encoded = encodeImplementationBindingPayload(payload) as Record<
			string,
			unknown
		>;
		expect(encoded.planSchema).toBeUndefined();
		expect(encoded.governingHash).toBeUndefined();
		expect(encoded.schemaMigrationId).toBeUndefined();
		expect(encoded.predecessorPlanCommit).toBeUndefined();
		expect(decodeImplementationBindingPayload(encoded)).toEqual(payload);
	});

	test("round-trips a schema 1 binding", () => {
		const payload = binding({
			planSchema: 1,
			governingHash: "sha256:governing",
			schemaMigrationId: "mig-1",
			predecessorPlanCommit: "b".repeat(40),
		});
		expect(
			decodeImplementationBindingPayload(
				encodeImplementationBindingPayload(payload),
			),
		).toEqual(payload);
	});

	test("decodes a historical fixture that has no schema fields", () => {
		const payload = binding();
		const historical = encodeImplementationBindingPayload(payload) as Record<
			string,
			unknown
		>;
		delete historical.planSchema;
		delete historical.governingHash;
		delete historical.schemaMigrationId;
		delete historical.predecessorPlanCommit;
		const decoded = decodeImplementationBindingPayload(historical);
		expect(decoded.planSchema).toBeUndefined();
		expect(decoded.governingHash).toBeUndefined();
		expect(decoded.approvedPlanBytes).toBe("# Plan\n");
	});

	test("rejects planSchema 2 and schema 1 without a governing hash", () => {
		const historical = encodeImplementationBindingPayload(binding()) as Record<
			string,
			unknown
		>;
		expect(() =>
			decodeImplementationBindingPayload({ ...historical, planSchema: 2 }),
		).toThrow(/planSchema/);
		expect(() =>
			decodeImplementationBindingPayload({ ...historical, planSchema: 1 }),
		).toThrow(/governingHash/);
		expect(() =>
			decodeImplementationBindingPayload({
				...historical,
				planSchema: 1,
				governingHash: "",
			}),
		).toThrow(/governingHash/);
	});
});
