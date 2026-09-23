import { Database } from "bun:sqlite";
import type { ReviewBudgetCommandContext } from "../../../src/commands/review-budget-context.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import {
	createMemoryRecordStore,
	createReviewBudgetIndex,
	createReviewBudgetStore,
	type RecordOrigin,
	type RecordPerformer,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
} from "../../../src/control-plane/index.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import type { PendingBudgetSnapshot } from "../../../src/review-budget/apply.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import { createReviewDecision } from "../../../src/review-governance/decisions.js";
import { createReviewGovernanceStore } from "../../../src/review-governance/store.js";

export const TEST_ORIGIN: RecordOrigin = {
	recorder: {
		installation_id: "11111111-1111-4111-8111-111111111111",
		actor: "tester",
	},
	performer: { kind: "agent", role: "reviewer", provider: "cursor" },
};

export function makeBudgetContext(opts?: {
	maxSteps?: number;
	mode?: "off" | "advisory" | "enforced";
	status?: "active" | "completed" | "aborted";
	originFor?: (performer: RecordPerformer) => RecordOrigin;
}): ReviewBudgetCommandContext & { db: Database } {
	const db = new Database(":memory:");
	runMigrations(db);
	createRunV1(db, { id: "run1", planPath: "/tmp/plan.md" });
	if (opts?.status && opts.status !== "active") {
		db.run("UPDATE runs SET status = ? WHERE id = 'run1'", [opts.status]);
	}
	const recordStore = createMemoryRecordStore();
	recordStore.putRun({
		id: "run1",
		plan_path: "/tmp/plan.md",
		config_json: null,
		created_at: "2026-01-01 00:00:00",
		sealed_at: opts?.status === "active" ? null : "2026-01-01 00:00:01",
		status: opts?.status ?? "active",
		final_head_commit: null,
		cli_version: "test",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: TEST_ORIGIN.recorder,
	});
	const config = FiveXConfigSchema.parse({
		maxStepsPerRun: opts?.maxSteps ?? 250,
		...(opts?.mode ? { reviewBudget: { mode: opts.mode } } : {}),
	});
	const originFor =
		opts?.originFor ??
		((performer: RecordPerformer): RecordOrigin => ({
			...TEST_ORIGIN,
			performer,
		}));
	return {
		db,
		config,
		recordStore,
		store: createReviewBudgetStore(recordStore, createReviewBudgetIndex(db)),
		recordsRelPath: "records",
		recordsAbsPath: "/tmp/records",
		executionContext: {
			controlPlaneRoot: "/tmp",
			run: {
				id: "run1",
				plan_path: "/tmp/plan.md",
				status: opts?.status ?? "active",
			},
			mappedWorktreePath: null,
			effectiveWorkingDirectory: "/tmp",
			effectivePlanPath: "/tmp/plan.md",
			planPathInWorktreeExists: true,
		},
		originFor,
		redactedRecorder: () => originFor({ kind: "system", role: "cli" }).recorder,
	};
}

export function pendingSnapshot(iteration = 1): PendingBudgetSnapshot {
	const currentLedger = {
		estimateConfidence: "high" as const,
		workItems: [
			{
				id: "W1",
				title: "Work",
				effort: 2 as const,
				architectureDelta: 0 as const,
				debtClaim: null,
				addresses: [],
				rationale: "Required",
				line: 1,
			},
		],
		surface: {
			subsystems: 1,
			productionFiles: 1,
			persistentOrExternalBoundaries: 0,
		},
	};
	return {
		id: `snapshot-${iteration}`,
		runId: "run1",
		stepName: "reviewer:review",
		phase: "plan",
		iteration,
		currentLedger,
		findings: [],
		assessments: [],
		priorFindings: [],
		effectiveGateCauses: [],
		suppressedGateCauses: [],
		diagnostics: [],
		baselineAssessment: {
			independentEffortEstimate: 2,
			confidence: "high",
			reason: "estimate",
		},
		derived: {
			B0: 2,
			B: 2,
			I: 2,
			W: 2,
			R: 0,
			projectedEffort: 2,
			S: 4,
			N: 0,
			D: 0,
			E: 4,
			A: 6,
			P: 0,
			baselineDirection: "aligned",
			budgetBand: "within_standard",
			budgetAlerts: [],
			requiresHuman: false,
			positiveArchitectureLimit: 2,
			baselineDisagreementThreshold: 2,
			thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
		},
	};
}

export function seedPromptGovernanceContext(
	ctx: ReturnType<typeof makeBudgetContext>,
): void {
	const pending = pendingSnapshot();
	ctx.store.captureBaseline({
		runId: "run1",
		captureKind: "initial",
		mode: "enforced",
		parsed: pending.currentLedger,
		configSnapshot: pending.derived.thresholds,
		origin: TEST_ORIGIN,
	});
	ctx.recordStore.append({
		runId: "run1",
		stream: "steps",
		idempotencyKey: "step:reviewer:prompt:1",
		payload: {
			step_name: "reviewer:review",
			phase: "plan",
			iteration: 1,
			result_json: {},
			head_commit: null,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		...recordedEnvelope(TEST_ORIGIN),
	});
	const finding = (id: string, fingerprint: string) => ({
		id,
		title: `Finding ${id}`,
		effortDelta: 1,
		architectureDelta: 0,
		scopeClass: "acceptance_required" as const,
		coupling: undefined,
		failure: `Failure for ${id}`,
		lowestCostCorrection: `Correction for ${id}`,
		fingerprint,
	});
	const snapshot = ctx.store.appendSnapshot({
		...pending,
		findings: [
			finding("P1.open", "sha256:open"),
			finding("P1.deferred", "sha256:deferred"),
		],
		origin: TEST_ORIGIN,
	});
	const decision = createReviewDecision({
		gateId: "gate-prompt",
		snapshotId: snapshot.id,
		choice: "defer_accept_risk",
		findingRefs: [{ findingId: "P1.deferred", fingerprint: "sha256:deferred" }],
		rationale: "Accept the bounded risk for prompt projection.",
		evidence: ["Operator accepted the bounded failure."],
		approvedScope: { retained: ["W1"], removed: [] },
		decisionId: "44444444-4444-4444-8444-444444444444",
		createdAt: "2026-01-01 00:00:02",
	});
	createReviewGovernanceStore(ctx.recordStore).resolveGate({
		runId: "run1",
		decision,
		humanStep: {
			step_name: "human:review-governance",
			phase: "plan",
			iteration: 2,
			result_json: {
				decisionId: decision.decisionId,
				gateId: decision.gateId,
			},
			head_commit: null,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		origin: {
			...TEST_ORIGIN,
			performer: { kind: "human", role: "operator" },
		},
	});
}
