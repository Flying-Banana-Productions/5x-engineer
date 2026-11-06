import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composeImplementationReviewerRecord,
	recordImplementationReviewerStepWithObservation,
} from "../../../src/commands/implementation-review-context.js";
import {
	composePlanReviewerRecord,
	recordPlanReviewerStepWithSnapshot,
} from "../../../src/commands/review-budget-context.js";
import {
	showPlanReviewGate,
	showReviewGate,
	submitPlanReviewDecision,
	submitReviewDecision,
} from "../../../src/commands/review-decision.handler.js";
import {
	buildReviewGovernanceState,
	presentImplementationGovernance,
} from "../../../src/commands/run-v1.handler.js";
import {
	createMemoryPromptStore,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { runMigrations } from "../../../src/db/schema.js";
import type { VerdictItem } from "../../../src/protocol.js";
import {
	encodeImplementationReviewObservationPayload,
	type ImplementationBindingPayload,
	type ImplementationObservationGateCause,
	type ImplementationReviewContextPayload,
	type ImplementationReviewObservationPayload,
} from "../../../src/review-budget/record-lines.js";
import {
	DEFAULT_REVIEW_BUDGET_CONFIG,
	type ParsedDeliveryBudget,
} from "../../../src/review-budget/types.js";
import type { CodeDiffContext } from "../../../src/review-governance/code-diff.js";
import {
	buildImplementationReviewPromptContext,
	formatImplementationReviewerContext,
} from "../../../src/review-governance/context.js";
import { GATELESS_HUMAN_GATE } from "../../../src/review-governance/gate-invariant.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";
import { reindexReviewGovernance } from "../../../src/review-governance/sqlite-index.js";
import {
	createReviewGovernanceStore,
	deriveGatelessImplementationObservation,
	deriveOpenImplementationGate,
} from "../../../src/review-governance/store.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

const RUN = "run1";
const PHASE = "1";
const STEP = "reviewer:commit";
const PLAN = `# Plan

## Phase 1: Wire the store

**Completion gate:** The store is wired.

- [ ] Implement the store
`;

const diff: CodeDiffContext = {
	baseCommit: "a".repeat(40),
	reviewedCommit: "b".repeat(40),
	patch: "",
	patchHash: "sha256:patch",
	excludedPaths: ["docs/plan.md"],
	hunks: [],
	binaryPaths: [],
};

function binding(input?: {
	effort?: 1 | 2 | 3 | 5 | 8;
	governingB?: number;
	mode?: "advisory" | "enforced";
	architectureDelta?: 0 | -5;
}): ImplementationBindingPayload {
	const effort = input?.effort ?? 2;
	const governingB = input?.governingB ?? effort;
	const architectureDelta = input?.architectureDelta ?? 0;
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: RUN,
		sourceRunId: "source",
		sourceSnapshotId: "snap",
		sourceBaselineId: "base",
		approvedPlanCommit: "c".repeat(40),
		approvedPlanHash: hashPlanBytes(PLAN),
		approvedPlanBytes: PLAN,
		b0: governingB,
		governingB,
		mode: input?.mode ?? "enforced",
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger: {
			estimateConfidence: "high",
			workItems: [
				{
					id: "W1",
					title: "Work",
					effort,
					architectureDelta,
					debtClaim:
						architectureDelta < 0
							? {
									debtClaimId: "DC1",
									coupling: "intrinsic",
									targetPhase: PHASE,
									minimalAlternativeEffortDelta: 0,
									minimalAlternativeArchitectureDelta: 0,
									before: "many",
									after: "one",
								}
							: null,
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
		},
		effectiveDecisions: [],
		phaseMap: [{ id: PHASE, heading: "Phase 1" }],
		debtTargets:
			architectureDelta < 0
				? [{ claimId: "DC1", sourceLabel: PHASE, phaseId: PHASE }]
				: [],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-01-01 00:00:00",
	};
}

function contextPayload(): ImplementationReviewContextPayload {
	return {
		kind: "implementation-review-context",
		version: 1,
		id: "ctx-1",
		executionRunId: RUN,
		bindingId: "binding-1",
		phase: PHASE,
		baseCommit: diff.baseCommit,
		reviewedCommit: diff.reviewedCommit,
		patchHash: diff.patchHash,
		excludedPaths: [...diff.excludedPaths],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-01-01 00:00:00",
	};
}

function implementationContext(
	seedBinding: ImplementationBindingPayload = binding(),
) {
	const ctx = makeBudgetContext({ mode: seedBinding.mode });
	ctx.store.saveImplementationBinding(seedBinding, TEST_ORIGIN);
	ctx.store.saveImplementationReviewContext(contextPayload(), TEST_ORIGIN);
	return ctx;
}

function recordParams(verdict: unknown, iteration: number, phase = PHASE) {
	return {
		run: RUN,
		stepName: phase === "plan" ? "reviewer:review" : STEP,
		result: JSON.stringify(verdict),
		phase,
		iteration,
		performer: { kind: "agent" as const, role: "reviewer", provider: "cursor" },
	};
}

async function compose(
	ctx: ReturnType<typeof implementationContext>,
	verdict: Parameters<typeof composeImplementationReviewerRecord>[0]["verdict"],
	iteration = 1,
) {
	return composeImplementationReviewerRecord({
		ctx,
		runId: RUN,
		stepName: STEP,
		phase: PHASE,
		iteration,
		verdict,
		contextId: "ctx-1",
		codeContext: diff,
	});
}

function observation(
	overrides: Partial<ImplementationReviewObservationPayload> = {},
): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: "obs-1",
		runId: RUN,
		stepKey: { stepName: STEP, phase: PHASE, iteration: 1 },
		bindingId: "binding-1",
		contextId: "ctx-1",
		domain: "implementation",
		phase: PHASE,
		originalVerdict: { readiness: "not_ready", items: [] },
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: 0,
				plan_defect: 0,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 0,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 0,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 2, R: 0, B: 2, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-01-01 00:00:00",
		...overrides,
	};
}

/** Append a historical step+observation pair directly, as older CLIs did. */
function appendHistorical(
	ctx: ReturnType<typeof implementationContext>,
	payload: ImplementationReviewObservationPayload,
) {
	const iteration = payload.stepKey.iteration ?? 1;
	ctx.recordStore.append({
		runId: RUN,
		stream: "steps",
		idempotencyKey: stepIdempotencyKey({
			runId: RUN,
			stepName: payload.stepKey.stepName,
			phase: PHASE,
			iteration,
		}),
		payload: {
			step_name: payload.stepKey.stepName,
			phase: PHASE,
			iteration,
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
	ctx.recordStore.append({
		runId: RUN,
		stream: "budget",
		idempotencyKey: `budget:implementation-review:${payload.id}`,
		payload: encodeImplementationReviewObservationPayload(payload),
		...recordedEnvelope(TEST_ORIGIN),
	});
}

function withPlanFile<T>(
	ctx: ReturnType<typeof implementationContext>,
	bytes: string,
	run: () => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "5x-gate-invariant-"));
	const path = join(dir, "plan.md");
	writeFileSync(path, bytes);
	ctx.executionContext.effectivePlanPath = path;
	return run().finally(() => rmSync(dir, { recursive: true, force: true }));
}

function openIndexedGates(
	ctx: ReturnType<typeof implementationContext>,
	observationId: string,
): string[] {
	const fresh = new Database(":memory:");
	try {
		runMigrations(fresh);
		expect(
			reindexReviewGovernance(ctx.recordStore, fresh, RUN).diagnostics,
		).toEqual([]);
		return (
			fresh
				.query(
					"SELECT gate_id FROM review_gate_index WHERE run_id = ? AND observation_id = ? AND resolved_decision_id IS NULL",
				)
				.all(RUN, observationId) as Array<{ gate_id: string }>
		).map((row) => row.gate_id);
	} finally {
		fresh.close();
	}
}

const readiness = (planDrifted: boolean) => ({
	executionObligations: true,
	checklistSufficient: false as const,
	planDrifted,
	bindingPresent: true,
	phases: [],
});

describe("enforced empty negative verdicts are response repairs", () => {
	test("implementation: nothing is recorded and no gate opens; the corrected response records", async () => {
		const ctx = implementationContext();
		try {
			const rejected = await compose(ctx, {
				readiness: "not_ready",
				items: [],
			});
			expect(rejected).toMatchObject({
				status: "error",
				code: "INVALID_STRUCTURED_OUTPUT",
				detail: {
					reason: "UNEXPLAINED_NEGATIVE_VERDICT",
					recorded: false,
					runPreserved: true,
				},
			});
			expect(ctx.recordStore.listLines(RUN, "steps")).toHaveLength(0);
			expect(ctx.store.listImplementationReviews(RUN)).toHaveLength(0);
			expect(
				deriveOpenImplementationGate(ctx.recordStore, RUN, PHASE),
			).toBeNull();

			const corrected = await compose(ctx, { readiness: "ready", items: [] });
			if (corrected.status !== "applied") throw new Error("expected applied");
			const written = await recordImplementationReviewerStepWithObservation(
				recordParams({ readiness: "ready", items: [] }, 1),
				corrected.pending,
				ctx,
				corrected.reconciliation,
			);
			expect(written.observation?.route).toBe("complete");
			expect(written.completionAuthorized).toBe(true);
		} finally {
			ctx.db.close();
		}
	});

	test("implementation: an independent inherited cause keeps a real, decidable gate", async () => {
		const ctx = implementationContext(binding({ effort: 8, governingB: 1 }));
		try {
			const composed = await compose(ctx, {
				readiness: "not_ready",
				items: [],
			});
			if (composed.status !== "applied") throw new Error("expected applied");
			expect(composed.pending.route).toBe("human_gate");
			expect(composed.pending.gateCauses.map((cause) => cause.kind)).toEqual([
				"inherited_budget",
			]);
			await recordImplementationReviewerStepWithObservation(
				recordParams({ readiness: "not_ready", items: [] }, 1),
				composed.pending,
				ctx,
				composed.reconciliation,
			);
			expect(
				deriveOpenImplementationGate(ctx.recordStore, RUN, PHASE),
			).not.toBeNull();
			expect(
				deriveGatelessImplementationObservation(ctx.recordStore, RUN, PHASE),
			).toBeNull();
		} finally {
			ctx.db.close();
		}
	});

	test("implementation advisory keeps v1 routing without a mandatory durable gate", async () => {
		const ctx = implementationContext(binding({ mode: "advisory" }));
		try {
			const composed = await compose(ctx, {
				readiness: "not_ready",
				items: [],
			});
			if (composed.status !== "applied") throw new Error("expected applied");
			expect(composed.pending.route).toBe("human_gate");
			expect(composed.pending.gateCauses).toEqual([]);
			await recordImplementationReviewerStepWithObservation(
				recordParams({ readiness: "not_ready", items: [] }, 1),
				composed.pending,
				ctx,
				composed.reconciliation,
			);
			expect(
				deriveOpenImplementationGate(ctx.recordStore, RUN, PHASE),
			).toBeNull();
			expect(
				deriveGatelessImplementationObservation(ctx.recordStore, RUN, PHASE),
			).toBeNull();
			const shown = await showReviewGate(
				RUN,
				{ context: ctx, promptStore: createMemoryPromptStore() },
				{ phase: PHASE },
			);
			expect(shown).toMatchObject({ open: false, mode: "advisory" });
			expect("inconsistency" in shown).toBe(false);
		} finally {
			ctx.db.close();
		}
	});

	test("paired persistence refuses a cause-less enforced gate", async () => {
		const ctx = implementationContext();
		try {
			const composed = await compose(ctx, { readiness: "ready", items: [] });
			if (composed.status !== "applied") throw new Error("expected applied");
			await expect(
				recordImplementationReviewerStepWithObservation(
					recordParams({ readiness: "ready", items: [] }, 1),
					{
						...composed.pending,
						route: "human_gate",
						nextAction: "human_gate",
					},
					ctx,
				),
			).rejects.toMatchObject({ code: "REVIEW_GATE_INVARIANT" });
			expect(ctx.recordStore.listLines(RUN, "steps")).toHaveLength(0);
			expect(ctx.store.listImplementationReviews(RUN)).toHaveLength(0);
		} finally {
			ctx.db.close();
		}
	});

	test("plan: enforced empty negative is neither an approval nor a gate; advisory keeps v1", async () => {
		const planMarkdown = `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Work | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Work

- [ ] Do the work
`;
		const verdict = {
			readiness: "not_ready" as const,
			items: [],
			baselineAssessment: {
				independentEffortEstimate: 2,
				confidence: "high" as const,
				reason: "Small and self-contained.",
			},
		};
		const common = {
			runId: RUN,
			stepName: "reviewer:review",
			phase: "plan",
			iteration: 1,
			planMarkdown,
			verdict,
			optInBaseline: false,
			origin: TEST_ORIGIN,
			warn: () => {},
		};
		const enforced = makeBudgetContext({ mode: "enforced" });
		const advisory = makeBudgetContext({ mode: "advisory" });
		try {
			const rejected = await composePlanReviewerRecord({
				ctx: enforced,
				...common,
			});
			expect(rejected).toMatchObject({
				status: "error",
				code: "INVALID_STRUCTURED_OUTPUT",
			});
			expect(JSON.stringify(rejected)).toContain(
				"UNEXPLAINED_NEGATIVE_VERDICT",
			);
			expect(enforced.store.listSnapshots(RUN)).toHaveLength(0);
			expect(enforced.recordStore.listLines(RUN, "steps")).toHaveLength(0);

			const v1 = await composePlanReviewerRecord({ ctx: advisory, ...common });
			if (v1.status !== "applied") throw new Error("expected advisory applied");
			expect(v1.verdict.governance.route).toBe("human_gate");
			expect(v1.verdict.governance.hypotheticalEnforcedRoute).toBe("complete");

			const ready = await composePlanReviewerRecord({
				ctx: enforced,
				...common,
				verdict: { ...verdict, readiness: "ready" },
			});
			if (ready.status !== "applied") throw new Error("expected applied");
			await expect(
				recordPlanReviewerStepWithSnapshot(
					recordParams(
						{
							...ready.verdict,
							governance: { ...ready.verdict.governance, route: "human_gate" },
						},
						1,
						"plan",
					),
					ready.pendingSnapshot,
					enforced,
				),
			).rejects.toMatchObject({ code: "REVIEW_GATE_INVARIANT" });
			expect(enforced.store.listSnapshots(RUN)).toHaveLength(0);
		} finally {
			enforced.db.close();
			advisory.db.close();
		}
	});
});

describe("historical gate-less observations", () => {
	test("inspection reports the inconsistency and a same-run recovery without a decision", async () => {
		const ctx = implementationContext();
		const promptStore = createMemoryPromptStore();
		try {
			appendHistorical(ctx, observation());
			expect(
				deriveOpenImplementationGate(ctx.recordStore, RUN, PHASE),
			).toBeNull();
			expect(openIndexedGates(ctx, "obs-1")).toEqual([]);

			await withPlanFile(ctx, PLAN, async () => {
				const shown = await showReviewGate(
					RUN,
					{ context: ctx, promptStore },
					{ phase: PHASE },
				);
				if (shown.open || !("inconsistency" in shown) || !shown.inconsistency)
					throw new Error("expected a gate-less inconsistency");
				expect(shown.inconsistency).toMatchObject({
					code: GATELESS_HUMAN_GATE,
					recordId: "obs-1",
					planDrifted: false,
				});
				expect(shown.inconsistency.next[0]).toContain(
					"5x template render reviewer-commit --run run1 --var phase_number=1",
				);
				expect(shown.inconsistency.next.join("\n")).toContain("--iteration 2");
				expect(promptStore.listOpenPrompts(RUN)).toHaveLength(0);
			});

			// Drift also present: the direct mechanical repair comes first.
			await withPlanFile(
				ctx,
				PLAN.replace("- [ ] Implement", "- [x] Implement").concat("extra\n"),
				async () => {
					const error = await submitReviewDecision(
						{
							runId: RUN,
							gateId: "sha256:absent",
							phase: PHASE,
							payload: { choice: "abort", rationale: "nothing to decide" },
						},
						{ context: ctx, promptStore },
					).catch((caught: unknown) => caught);
					expect(error).toMatchObject({ code: GATELESS_HUMAN_GATE });
					const detail = (error as { detail: { next: string[] } }).detail;
					expect(detail.next[0]).toBe(
						"5x plan repair-checklists --run run1 --dry-run",
					);
					expect(ctx.recordStore.listLines(RUN, "decisions")).toHaveLength(0);
				},
			);

			const state = presentImplementationGovernance({
				readiness: readiness(true),
				binding: ctx.store.getImplementationBinding(RUN),
				contexts: [],
				observations: ctx.store.listImplementationReviews(RUN),
				reconciliations: [],
				correctionAttempts: [],
				activeGate: null,
				recordStore: ctx.recordStore,
				runId: RUN,
			});
			expect(state.gatelessHumanGate).toMatchObject({
				code: GATELESS_HUMAN_GATE,
				planDrifted: true,
			});

			// A corrective review on the same run supersedes the routing; the
			// historical record stays as audit history.
			const corrected = await compose(
				ctx,
				{ readiness: "ready", items: [] },
				2,
			);
			if (corrected.status !== "applied") throw new Error("expected applied");
			await recordImplementationReviewerStepWithObservation(
				recordParams({ readiness: "ready", items: [] }, 2),
				corrected.pending,
				ctx,
				corrected.reconciliation,
			);
			expect(
				deriveGatelessImplementationObservation(ctx.recordStore, RUN, PHASE),
			).toBeNull();
			expect(ctx.store.listImplementationReviews(RUN)).toHaveLength(2);
			expect(
				presentImplementationGovernance({
					readiness: readiness(false),
					binding: ctx.store.getImplementationBinding(RUN),
					contexts: [],
					observations: ctx.store.listImplementationReviews(RUN),
					reconciliations: [],
					correctionAttempts: [],
					activeGate: null,
					recordStore: ctx.recordStore,
					runId: RUN,
				}).gatelessHumanGate,
			).toBeUndefined();
		} finally {
			ctx.db.close();
		}
	});

	test("plan runs report a cause-less recorded human_gate and refuse a fictional decision", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const promptStore = createMemoryPromptStore();
		const ledger: ParsedDeliveryBudget = {
			estimateConfidence: "high",
			workItems: [
				{
					id: "W1",
					title: "work",
					effort: 2,
					architectureDelta: 0,
					debtClaim: null,
					addresses: [],
					rationale: "required",
					line: 1,
				},
			],
			surface: {
				subsystems: 1,
				productionFiles: 1,
				persistentOrExternalBoundaries: 0,
			},
		};
		try {
			ctx.store.captureBaseline({
				runId: RUN,
				captureKind: "initial",
				mode: "enforced",
				parsed: ledger,
				configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
				origin: TEST_ORIGIN,
			});
			ctx.recordStore.append({
				runId: RUN,
				stream: "steps",
				idempotencyKey: stepIdempotencyKey({
					runId: RUN,
					stepName: "reviewer:plan",
					phase: "plan",
					iteration: 1,
				}),
				payload: {
					step_name: "reviewer:plan",
					phase: "plan",
					iteration: 1,
					result_json: {
						readiness: "not_ready",
						items: [],
						governance: { route: "human_gate", gateCauses: [] },
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
				...recordedEnvelope(TEST_ORIGIN),
			});
			ctx.store.appendSnapshot({
				runId: RUN,
				stepName: "reviewer:plan",
				phase: "plan",
				iteration: 1,
				currentLedger: ledger,
				findings: [],
				assessments: [],
				effectiveGateCauses: [],
				origin: TEST_ORIGIN,
			});
			const shown = await showPlanReviewGate(RUN, {
				context: ctx,
				promptStore,
			});
			expect(shown).toMatchObject({
				open: false,
				inconsistency: { code: GATELESS_HUMAN_GATE, domain: "plan" },
			});
			await expect(
				submitPlanReviewDecision(
					{
						runId: RUN,
						gateId: "sha256:absent",
						payload: { choice: "abort", rationale: "nothing to decide" },
					},
					{ context: ctx, promptStore },
				),
			).rejects.toMatchObject({ code: GATELESS_HUMAN_GATE });
			const baseline = ctx.store.getBaseline(RUN);
			if (!baseline) throw new Error("expected baseline");
			const state = buildReviewGovernanceState({
				runId: RUN,
				b0: baseline.b0,
				recordStore: ctx.recordStore,
				reviewBudgetStore: ctx.store,
			});
			expect(state.gate_inconsistency?.next[0]).toContain(
				"5x template render reviewer-plan --run run1",
			);
			expect(state.active_gate).toBeUndefined();
			expect(
				createReviewGovernanceStore(ctx.recordStore).deriveOpenGate(RUN),
			).toBeNull();
			expect(reindexReviewGovernance(ctx.recordStore, ctx.db, RUN).gates).toBe(
				0,
			);
		} finally {
			ctx.db.close();
		}
	});
});

const finding: VerdictItem = {
	id: "F1",
	title: "Needs a human",
	action: "human_required",
	reason: "Operator judgment",
	priority: "P1",
	scopeClass: "implementation_defect",
	planWorkItemIds: ["W1"],
};

const ROUTES: Array<{
	name: string;
	cause: ImplementationObservationGateCause;
	architectureDelta?: 0 | -5;
	payload: { choice: string } & Record<string, unknown>;
	findingIds?: string[];
	claimAdjustments?: Array<{
		creditClaimId: string;
		approvedArchitectureDelta: number;
	}>;
}> = [
	{
		name: "semantic_human",
		cause: {
			kind: "semantic_human",
			findingId: "F1",
			fingerprint: "sha256:f1",
		},
		payload: {
			choice: "defer_accept_risk",
			rationale: "Accept for this release",
			evidence: ["operator evidence"],
		},
		findingIds: ["F1"],
	},
	{
		name: "critical_safety",
		cause: {
			kind: "critical_safety",
			findingId: "F1",
			fingerprint: "sha256:f1",
		},
		payload: {
			choice: "accept_with_restriction",
			rationale: "Ship behind the flag",
			restriction: "Keep the flag off in production",
		},
		findingIds: ["F1"],
	},
	{
		name: "plan_amendment",
		cause: {
			kind: "plan_amendment",
			findingId: "F1",
			fingerprint: "sha256:f1",
		},
		payload: {
			choice: "defer_accept_risk",
			rationale: "Defer the plan change",
			evidence: ["operator evidence"],
		},
		findingIds: ["F1"],
	},
	{
		name: "inherited_budget",
		cause: {
			kind: "inherited_budget",
			band: "within_standard",
			alerts: ["positive_architecture_exceeded"],
		},
		payload: { choice: "revise_plan", rationale: "Return to plan review" },
	},
	{
		name: "credit_shortfall",
		architectureDelta: -5,
		cause: {
			kind: "credit_shortfall",
			claimIds: ["DC1"],
			claims: [
				{
					creditClaimId: "DC1",
					approvedArchitectureDelta: -5,
					realizedArchitectureDelta: 0,
					evidence: "none",
				},
			],
		},
		payload: {
			choice: "approve_higher_burden",
			rationale: "Accept the burden",
		},
		claimAdjustments: [{ creditClaimId: "DC1", approvedArchitectureDelta: 0 }],
	},
];

describe("every enforced implementation human route is decidable", () => {
	test.each(ROUTES)(
		"$name: gate show, eligible decision, next action and replay agree",
		async (route) => {
			const ctx = implementationContext(
				binding({ architectureDelta: route.architectureDelta ?? 0 }),
			);
			const promptStore = createMemoryPromptStore();
			try {
				appendHistorical(
					ctx,
					observation({
						originalVerdict: {
							readiness: "not_ready",
							items: "findingId" in route.cause ? [finding] : [],
						},
						gateCauses: [route.cause],
					}),
				);
				const shown = await showReviewGate(
					RUN,
					{ context: ctx, promptStore },
					{ phase: PHASE },
				);
				if (!shown.open || !("allowedChoices" in shown))
					throw new Error(`expected an open ${route.name} gate`);
				expect(shown.allowedChoices as string[]).toContain(
					route.payload.choice,
				);
				expect(openIndexedGates(ctx, "obs-1")).toEqual([shown.gateId]);
				const decided = await submitReviewDecision(
					{
						runId: RUN,
						gateId: shown.gateId,
						phase: PHASE,
						payload: route.payload as never,
						...(route.findingIds ? { findingIds: route.findingIds } : {}),
						...(route.claimAdjustments
							? { claimAdjustments: route.claimAdjustments }
							: {}),
					},
					{ context: ctx, promptStore },
				);
				expect(decided).toMatchObject({ created: true });
				expect(typeof (decided as { nextAction?: unknown }).nextAction).toBe(
					"string",
				);
				// Restart: authoritative records and a rebuilt index agree.
				const open = deriveOpenImplementationGate(ctx.recordStore, RUN, PHASE);
				expect(openIndexedGates(ctx, "obs-1")).toEqual(
					open ? [open.gateId] : [],
				);
				expect(
					deriveGatelessImplementationObservation(ctx.recordStore, RUN, PHASE),
				).toBeNull();
			} finally {
				ctx.db.close();
			}
		},
	);
});

describe("plan evidence reaches every implementation reviewer session", () => {
	test("initial and continued sessions receive identical runtime plan authority", () => {
		const ctx = implementationContext();
		try {
			const build = (sessionId?: string) =>
				buildImplementationReviewPromptContext({
					runId: RUN,
					phase: PHASE,
					store: ctx.store,
					recordStore: ctx.recordStore,
					reviewContext: contextPayload(),
					workdir: "/repo",
					planRepoPath: "docs/plan.md",
					planOnlyDiff: null,
					...(sessionId ? { sessionId } : {}),
				});
			const fresh = build("new");
			const continued = build("sess-123");
			if (!fresh || !continued) throw new Error("expected context");
			expect(continued.planEvidence).toEqual(fresh.planEvidence);
			expect(fresh.planEvidence?.phase?.heading).toBe(
				"## Phase 1: Wire the store",
			);
			const rendered = formatImplementationReviewerContext(fresh);
			expect(rendered).toBe(formatImplementationReviewerContext(continued));
			expect(rendered).toContain("### Plan evidence");
			expect(rendered).toContain("- [ ] Implement the store");
			expect(rendered).toContain(":(literal,top)docs/plan.md");
		} finally {
			ctx.db.close();
		}
	});
});
