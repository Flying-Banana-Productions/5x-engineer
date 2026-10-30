import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRecordStore } from "../../../src/control-plane/record-memory.js";
import type { RecordOrigin } from "../../../src/control-plane/record-types.js";
import {
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
} from "../../../src/control-plane/record-types.js";
import { reindexReviewBudget } from "../../../src/control-plane/review-budget-index.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import { runMigrations } from "../../../src/db/schema.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import {
	readAuthoritativeBudget,
	readAuthoritativePlan,
} from "../../../src/plan-schema/authority.js";
import { loadPlanDocument } from "../../../src/plan-schema/document.js";
import { deriveBudget } from "../../../src/review-budget/arithmetic.js";
import {
	decodeBudgetSnapshotPayload,
	decodeImplementationBindingPayload,
	encodeImplementationBindingPayload,
	encodeImplementationReviewObservationPayload,
	type ImplementationBindingPayload,
	type ImplementationReviewObservationPayload,
	implementationBindingKey,
	implementationReviewObservationKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import { deriveInheritedBudgetGovernance } from "../../../src/review-governance/architecture-approval.js";
import {
	createReviewDecision,
	governanceDecisionKey,
} from "../../../src/review-governance/decisions.js";
import { resolvePlanImpactSpans } from "../../../src/review-governance/implementation.js";
import {
	detectPlanDrift,
	ensureImplementationAdmission,
	expectedSchemaForStore,
	hashPlanBytes,
	isImplementationAuthorTemplate,
	mapDebtTargetToPhaseId,
	PLAN_DRIFT_RECOVERY_HELP,
	planRepoPath,
	recordVerifiedTextAmendment,
	verifyAuthorTextAmendment,
} from "../../../src/review-governance/implementation-state.js";
import {
	prepareTextAmendmentGuard,
	structuralSignature,
} from "../../../src/review-governance/plan-amendment.js";
import { reindexReviewGovernance } from "../../../src/review-governance/sqlite-index.js";
import type { ReviewGateCause } from "../../../src/review-governance/types.js";
import {
	SCHEMA1_AUTHORITY_PLAN,
	SCHEMA1_NOTE_ONLY_TEXT,
	SCHEMA1_OVERVIEW,
	SCHEMA1_STALE_TEXT,
	withSchema1Status,
} from "../../helpers/schema1-authority-fixture.js";

const PLAN_PATH = "docs/development/plans/gov.md";
const ORIGIN: RecordOrigin = {
	recorder: { installation_id: "00000000-0000-4000-8000-000000000001" },
	performer: { kind: "system", role: "cli" },
};

function plan(options?: {
	target?: string;
	duplicatePhase?: boolean;
	effort?: number;
}): string {
	const target = options?.target;
	const debt = target
		? `| W1 | Bind | ${options?.effort ?? 2} | -1 | DC0 (\`intrinsic\`) | - | Required |`
		: `| W1 | Bind | ${options?.effort ?? 2} | 0 | - | - | Required |`;
	const claims = target
		? `
### Debt Claims

#### DC0

- Target phase: ${target}
- Minimal-compliant effort delta: 0
- Minimal-compliant architecture delta: -1
- Before: two authorities
- After: one binding
`
		: "";
	const phase2 = options?.duplicatePhase
		? "\n## Phase 1: Again\n\n- [ ] Also bind\n"
		: "\n## Phase 2: Follow\n\n- [ ] Follow\n";
	return `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
${debt}
${claims}
### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Bind

**Completion gate:** bound

- [ ] Bind execution
${target ? phase2 : ""}
`;
}

function setup() {
	const recordStore = createMemoryRecordStore();
	const store = createReviewBudgetStore(recordStore);
	let captureCalls = 0;
	const captureBaseline = store.captureBaseline.bind(store);
	store.captureBaseline = (input) => {
		captureCalls += 1;
		return captureBaseline(input);
	};
	return { recordStore, store, captureCalls: () => captureCalls };
}

function putRun(
	recordStore: ReturnType<typeof createMemoryRecordStore>,
	id: string,
	planPath = PLAN_PATH,
) {
	recordStore.putRun({
		id,
		plan_path: planPath,
		config_json: null,
		created_at: "2026-09-23 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "0.0.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: ORIGIN.recorder,
	});
}

function appendStep(
	recordStore: ReturnType<typeof createMemoryRecordStore>,
	runId: string,
	stepName: string,
	phase: string,
	iteration: number,
	result: unknown,
	head: string | null,
) {
	recordStore.append({
		runId,
		stream: "steps",
		idempotencyKey: `step:${runId}:${stepName}:${phase}:${iteration}`,
		payload: {
			step_name: stepName,
			phase,
			iteration,
			result_json: result,
			head_commit: head,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		...recordedEnvelope(ORIGIN),
	});
}

function approveSource(
	ctx: ReturnType<typeof setup>,
	runId: string,
	markdown: string,
	options?: {
		route?: "complete" | "author_revision" | "final_corrections" | "human_gate";
		head?: string;
		authorAfter?: { head: string };
		decision?: boolean;
		/** Sealed plan commit. Defaults to the approval-evidence commit. */
		finalHead?: string;
		/** `run:complete` head. Defaults to `finalHead`. */
		completeHead?: string;
		unsealed?: boolean;
		mode?: "advisory" | "enforced";
		/** Unresolved causes persisted on the reviewer snapshot. */
		gateCauses?: ReviewGateCause[];
		/** Reviewer verdict items; defaults to none. */
		items?: unknown[];
	},
) {
	const parsed = parseDeliveryBudget(markdown);
	if (!parsed.ok) throw new Error(parsed.message);
	putRun(ctx.recordStore, runId);
	const baseline = ctx.store.captureBaseline({
		runId,
		captureKind: "initial",
		parsed: parsed.value,
		configSnapshot: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		mode: options?.mode ?? "enforced",
		origin: ORIGIN,
	});
	const snapshot = ctx.store.appendSnapshot({
		runId,
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: parsed.value,
		findings: [],
		assessments: [],
		...(options?.gateCauses ? { effectiveGateCauses: options.gateCauses } : {}),
		origin: ORIGIN,
	});
	const route = options?.route ?? "complete";
	appendStep(
		ctx.recordStore,
		runId,
		"reviewer:plan",
		"plan",
		1,
		{
			readiness: route === "complete" ? "ready" : "not_ready",
			items: options?.items ?? [],
			governance: { route },
		},
		options?.head ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	);
	if (options?.authorAfter) {
		appendStep(
			ctx.recordStore,
			runId,
			"author:process-plan-review",
			"plan",
			1,
			{ result: "complete", commit: options.authorAfter.head },
			options.authorAfter.head,
		);
	}
	if (options?.decision) {
		const decision = createReviewDecision({
			gateId: "gate-1",
			snapshotId: snapshot.id,
			choice: "adjust_baseline",
			findingRefs: [],
			rationale: "Operator raised the governing baseline",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
			governingBaselineChange: {
				from: baseline.baseline.b0,
				to: baseline.baseline.b0 + 3,
			},
			decisionId: "11111111-1111-4111-8111-111111111111",
			createdAt: "2026-09-23 00:00:01",
		});
		appendStep(
			ctx.recordStore,
			runId,
			"human:review-governance",
			"plan",
			1,
			{ decisionId: decision.decisionId, gateId: decision.gateId },
			null,
		);
		ctx.recordStore.append({
			runId,
			stream: "decisions",
			idempotencyKey: governanceDecisionKey(decision.gateId),
			payload: decision,
			...recordedEnvelope(ORIGIN),
		});
	}
	if (!options?.unsealed) {
		const reviewerHead =
			options?.head ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const finalized =
			options?.finalHead ?? options?.authorAfter?.head ?? reviewerHead;
		const completeHead = options?.completeHead ?? finalized;
		appendStep(
			ctx.recordStore,
			runId,
			"run:complete",
			"plan",
			1,
			{ status: "completed", reason: null },
			completeHead,
		);
		const summary = ctx.recordStore.getRun(runId);
		if (!summary) throw new Error(`source run ${runId} missing`);
		ctx.recordStore.putRun({
			...summary,
			status: "completed",
			sealed_at: "2026-09-23T00:00:02.000Z",
			final_head_commit: finalized,
			sealer: ORIGIN.recorder,
		});
	}
	return { baseline: baseline.baseline, snapshot };
}

function admit(
	ctx: ReturnType<typeof setup>,
	input: {
		executionRunId: string;
		markdown: string | null;
		mode?: "off" | "advisory" | "enforced";
		sourceRunId?: string;
		read?: (commit: string) => Promise<string | null>;
	},
) {
	return ensureImplementationAdmission({
		store: ctx.store,
		recordStore: ctx.recordStore,
		executionRunId: input.executionRunId,
		planPath: PLAN_PATH,
		planMarkdown: input.markdown,
		configuredMode: input.mode ?? "advisory",
		origin: ORIGIN,
		...(input.sourceRunId ? { explicitSourceRunId: input.sourceRunId } : {}),
		readPlanAtCommit: input.read ?? (async () => input.markdown),
	});
}

describe("implementation execution binding", () => {
	test("checkbox normalization is limited to task-list markers", () => {
		const approved = "# Plan\n\n- [ ] Bind\n\nUse arr[x] in code.\n";
		const checked = approved.replace("- [ ] Bind", "- [x] Bind");
		expect(
			detectPlanDrift({
				recordedSchema: 0,
				approvedPlanBytes: approved,
				approvedPlanHash: "unused",
				amendments: [],
				currentPlanBytes: checked,
			}).drifted,
		).toBe(false);
		expect(
			detectPlanDrift({
				recordedSchema: 0,
				approvedPlanBytes: "* [X] Bind\n",
				approvedPlanHash: "unused",
				amendments: [],
				currentPlanBytes: "* [ ] Bind\n",
			}).drifted,
		).toBe(false);
		expect(
			detectPlanDrift({
				recordedSchema: 0,
				approvedPlanBytes: approved,
				approvedPlanHash: "unused",
				amendments: [],
				currentPlanBytes: approved.replace("arr[x]", "arr[ ]"),
			}).drifted,
		).toBe(true);
	});

	test("plan repo paths stay inside the control-plane root", () => {
		const root = mkdtempSync(join(tmpdir(), "5x-plan-repo-path-"));
		const outside = mkdtempSync(join(tmpdir(), "5x-plan-outside-"));
		try {
			const planDir = join(root, "docs", "plans");
			mkdirSync(planDir, { recursive: true });
			const planPath = join(planDir, "gov.md");
			writeFileSync(planPath, "# Plan\n");
			writeFileSync(join(outside, "gov.md"), "# Plan\n");
			expect(planRepoPath(planPath, root)).toBe("docs/plans/gov.md");
			expect(planRepoPath(join(outside, "gov.md"), root)).toBeNull();
			expect(planRepoPath("../gov.md", root)).toBeNull();
			expect(planRepoPath("docs/plans/gov.md", root)).toBe("docs/plans/gov.md");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("implementation author templates include continued variants", () => {
		expect(isImplementationAuthorTemplate("author-next-phase")).toBe(true);
		expect(isImplementationAuthorTemplate("author-next-phase-continued")).toBe(
			true,
		);
		expect(
			isImplementationAuthorTemplate("author-process-impl-review-continued"),
		).toBe(true);
		expect(isImplementationAuthorTemplate("author-generate-plan")).toBe(false);
	});

	test("maps phase-N and exact numeric targets and rejects arbitrary labels", () => {
		expect(mapDebtTargetToPhaseId("phase-2", ["1", "2", "2.1"])).toEqual({
			ok: true,
			phaseId: "2",
		});
		expect(mapDebtTargetToPhaseId("2.1", ["2", "2.1"])).toEqual({
			ok: true,
			phaseId: "2.1",
		});
		expect(mapDebtTargetToPhaseId("rollout", ["1", "2"])).toEqual({
			ok: false,
			reason: "unmatched",
		});
		expect(mapDebtTargetToPhaseId("phase-9", ["1"])).toEqual({
			ok: false,
			reason: "unmatched",
		});
		expect(mapDebtTargetToPhaseId("1", ["1", "1"])).toEqual({
			ok: false,
			reason: "ambiguous",
		});
	});

	test("budget and config matrix persists v1 or requires a binding", async () => {
		const plain = "# Plan\n\n## Phase 1: Bind\n\n- [ ] Bind\n";
		const budgeted = plan();
		const noBudget = setup();
		putRun(noBudget.recordStore, "exec");
		const v1 = await admit(noBudget, {
			executionRunId: "exec",
			markdown: plain,
			mode: "enforced",
		});
		expect(v1.status).toBe("v1");
		if (v1.status !== "v1") return;
		expect(v1.disposition.reason).toBe("no_budget");
		expect(noBudget.store.getBaseline("exec")).toBeNull();

		const later = await admit(noBudget, {
			executionRunId: "exec",
			markdown: budgeted,
			mode: "enforced",
		});
		expect(later.status).toBe("v1");

		const off = setup();
		putRun(off.recordStore, "exec");
		const modeOff = await admit(off, {
			executionRunId: "exec",
			markdown: budgeted,
			mode: "off",
		});
		expect(modeOff.status).toBe("v1");
		if (modeOff.status !== "v1") return;
		expect(modeOff.disposition.reason).toBe("mode_off");
		const stillOff = await admit(off, {
			executionRunId: "exec",
			markdown: budgeted,
			mode: "enforced",
		});
		expect(stillOff.status).toBe("v1");

		const missing = setup();
		putRun(missing.recordStore, "exec");
		const required = await admit(missing, {
			executionRunId: "exec",
			markdown: budgeted,
			mode: "advisory",
		});
		expect(required).toMatchObject({
			status: "approval_required",
			code: "IMPLEMENTATION_APPROVAL_REQUIRED",
			detail: { candidateRunIds: [] },
		});
		expect(missing.store.getBaseline("exec")).toBeNull();
		expect(missing.store.getImplementationBinding("exec")).toBeNull();
	});

	test("auto-selects one approved source and rejects zero or many", async () => {
		const markdown = plan();
		const one = setup();
		approveSource(one, "source", markdown);
		putRun(one.recordStore, "exec");
		const bound = await admit(one, { executionRunId: "exec", markdown });
		expect(bound.status).toBe("bound");
		if (bound.status !== "bound") return;
		expect(bound.created).toBe(true);
		expect(bound.binding.sourceRunId).toBe("source");
		expect(bound.binding.mode).toBe("enforced");
		expect(bound.binding.b0).toBe(2);
		expect(bound.binding.governingB).toBe(2);
		expect(one.store.getBaseline("exec")).toBeNull();
		expect(one.captureCalls()).toBe(1);

		const again = await admit(one, {
			executionRunId: "exec",
			markdown,
			mode: "off",
		});
		expect(again).toMatchObject({
			status: "bound",
			created: false,
			binding: { id: bound.binding.id, mode: "enforced" },
		});

		const none = setup();
		putRun(none.recordStore, "exec");
		approveSource(none, "draft", markdown, { route: "author_revision" });
		expect(
			await admit(none, { executionRunId: "exec", markdown }),
		).toMatchObject({
			status: "approval_required",
			detail: { candidateRunIds: [] },
		});

		const many = setup();
		approveSource(many, "source-b", markdown);
		approveSource(many, "source-a", markdown);
		putRun(many.recordStore, "exec");
		const multiple = await admit(many, { executionRunId: "exec", markdown });
		expect(multiple).toMatchObject({
			status: "approval_required",
			detail: { candidateRunIds: ["source-a", "source-b"] },
		});
	});

	test("advisory sources bind despite unresolved hypothetical budget alerts", async () => {
		const markdown = plan();
		const budgetAlerts: ReviewGateCause[] = [
			{ kind: "budget_alert", alert: "baseline_disputed" },
			{ kind: "budget_alert", alert: "credit_unrealized" },
		];

		const auto = setup();
		approveSource(auto, "source", markdown, {
			mode: "advisory",
			gateCauses: budgetAlerts,
		});
		putRun(auto.recordStore, "exec");
		const autoBound = await admit(auto, { executionRunId: "exec", markdown });
		expect(autoBound).toMatchObject({
			status: "bound",
			binding: { sourceRunId: "source", mode: "advisory" },
		});

		const explicit = setup();
		approveSource(explicit, "source", markdown, {
			mode: "advisory",
			gateCauses: budgetAlerts,
		});
		putRun(explicit.recordStore, "exec");
		expect(
			await admit(explicit, {
				executionRunId: "exec",
				markdown,
				sourceRunId: "source",
			}),
		).toMatchObject({
			status: "bound",
			binding: { sourceRunId: "source", mode: "advisory" },
		});
	});

	test("enforced open gates and unapproved advisory sources still refuse", async () => {
		const markdown = plan();

		const enforced = setup();
		approveSource(enforced, "source", markdown, {
			gateCauses: [{ kind: "budget_alert", alert: "baseline_disputed" }],
		});
		putRun(enforced.recordStore, "exec");
		const refused = await admit(enforced, { executionRunId: "exec", markdown });
		expect(refused).toMatchObject({
			status: "approval_required",
			detail: {
				candidateRunIds: [],
				rejectedSources: [
					{
						runId: "source",
						reason: "Source run source has an open review gate",
					},
				],
			},
		});
		if (refused.status !== "approval_required") return;
		expect(refused.message).toContain(
			"source: Source run source has an open review gate.",
		);
		expect(
			await admit(enforced, {
				executionRunId: "exec",
				markdown,
				sourceRunId: "source",
			}),
		).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PLAN_UNAPPROVED",
		});

		const humanRequired = setup();
		approveSource(humanRequired, "source", markdown, {
			mode: "advisory",
			route: "human_gate",
			items: [
				{
					id: "F1",
					title: "Needs a product call",
					action: "human_required",
					reason: "Scope is a human decision",
				},
			],
			gateCauses: [
				{
					kind: "semantic_human",
					finding: { findingId: "F1", fingerprint: "f1" },
				},
			],
		});
		putRun(humanRequired.recordStore, "exec");
		expect(
			await admit(humanRequired, { executionRunId: "exec", markdown }),
		).toMatchObject({
			status: "approval_required",
			detail: { candidateRunIds: [], rejectedSources: [{ runId: "source" }] },
		});
		expect(
			await admit(humanRequired, {
				executionRunId: "exec",
				markdown,
				sourceRunId: "source",
			}),
		).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PLAN_UNAPPROVED",
		});
	});

	test("earlier aggregate architecture approval survives later final-corrections closure and binding", async () => {
		const markdown = plan().replace(
			"| W1 | Bind | 2 | 0 | - | - | Required |",
			Array.from(
				{ length: 32 },
				(_, index) => `| W${index + 1} | Bind | 2 | 1 | - | - | Required |`,
			).join("\n"),
		);
		const ctx = setup();
		const initial = approveSource(ctx, "source", markdown, {
			unsealed: true,
			route: "human_gate",
		});
		const decision = createReviewDecision({
			gateId: "source-architecture-gate",
			snapshotId: initial.snapshot.id,
			choice: "approve_architecture_burden",
			findingRefs: [],
			rationale: "Approve P32",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
			architectureApproval: {
				approvedP: 32,
				approvedItemIds: [],
				approvedWorkItemIds: [],
			},
		});
		appendStep(
			ctx.recordStore,
			"source",
			"human:review-governance",
			"plan",
			1,
			{ decisionId: decision.decisionId, gateId: decision.gateId },
			null,
		);
		ctx.recordStore.append({
			runId: "source",
			stream: "decisions",
			idempotencyKey: governanceDecisionKey(decision.gateId),
			payload: decision,
			...recordedEnvelope(ORIGIN),
		});
		const closure = ctx.store.appendSnapshot({
			runId: "source",
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 2,
			currentLedger: initial.snapshot.currentLedger,
			findings: [],
			assessments: [],
			effectiveGateCauses: [],
			suppressedGateCauses: [
				{
					kind: "budget_alert",
					alert: "positive_architecture_exceeded",
					itemIds: [],
					workItemIds: [],
					resolvedBy: decision.decisionId,
				},
			],
			origin: ORIGIN,
		});
		appendStep(
			ctx.recordStore,
			"source",
			"reviewer:plan",
			"plan",
			2,
			{
				readiness: "ready_with_corrections",
				items: [],
				governance: { route: "final_corrections" },
			},
			"a".repeat(40),
		);
		appendStep(
			ctx.recordStore,
			"source",
			"author:process-plan-review",
			"plan",
			2,
			{ result: "complete", commit: "b".repeat(40) },
			"b".repeat(40),
		);
		appendStep(
			ctx.recordStore,
			"source",
			"run:complete",
			"plan",
			1,
			{ status: "completed", reason: null },
			"b".repeat(40),
		);
		const sourceRun = ctx.recordStore.getRun("source");
		if (!sourceRun) throw new Error("Missing source run");
		ctx.recordStore.putRun({
			...sourceRun,
			status: "completed",
			sealed_at: "2026-09-23T00:00:02.000Z",
			final_head_commit: "b".repeat(40),
			sealer: ORIGIN.recorder,
		});
		putRun(ctx.recordStore, "exec");
		const bound = await admit(ctx, { executionRunId: "exec", markdown });
		if (bound.status !== "bound") throw new Error(JSON.stringify(bound));
		expect(bound.binding.sourceSnapshotId).toBe(closure.id);
		expect(bound.binding.approvedPlanCommit).toBe("b".repeat(40));
		expect(bound.binding.effectiveDecisions).toEqual([decision]);
		const budget = deriveBudget({
			B0: bound.binding.b0,
			B: bound.binding.governingB,
			I: null,
			workItems: bound.binding.ledger.workItems,
			findings: [],
			assessments: [],
			config: bound.binding.thresholds,
			semanticHumanRequired: false,
		});
		expect(
			deriveInheritedBudgetGovernance(bound.binding, budget),
		).toMatchObject({
			P: 32,
			requiresHuman: false,
			sourceSnapshotId: closure.id,
			suppressedAlerts: [{ resolvedBy: decision.decisionId }],
		});
	});

	test("copies governing baseline and accepted decisions without recapture", async () => {
		const markdown = plan();
		const ctx = setup();
		approveSource(ctx, "source", markdown, { decision: true });
		putRun(ctx.recordStore, "exec");
		const bound = await admit(ctx, { executionRunId: "exec", markdown });
		expect(bound.status).toBe("bound");
		if (bound.status !== "bound") return;
		expect(bound.binding.b0).toBe(2);
		expect(bound.binding.governingB).toBe(5);
		expect(bound.binding.effectiveDecisions).toHaveLength(1);
		expect(ctx.store.getBaseline("exec")).toBeNull();
		expect(ctx.captureCalls()).toBe(1);
	});

	test("anchors approved bytes to the finalized plan commit, not a later HEAD", async () => {
		const draft = plan();
		const reviewed = draft.replace(
			"# Plan\n",
			"# Plan\n\n**Status:** Reviewed\n",
		);
		const noted = `${reviewed}\nPhase 0 verification note.\n`;
		const reviewerHead = "a".repeat(40);
		const finalizedHead = "b".repeat(40);
		const laterHead = "c".repeat(40);
		const ctx = setup();
		approveSource(ctx, "source", draft, {
			head: reviewerHead,
			finalHead: finalizedHead,
		});
		putRun(ctx.recordStore, "exec");
		const seen: string[] = [];
		const bound = await admit(ctx, {
			executionRunId: "exec",
			markdown: reviewed,
			read: async (commit) => {
				seen.push(commit);
				if (commit === finalizedHead) return reviewed;
				if (commit === laterHead) return noted;
				return draft;
			},
		});
		expect(seen).toEqual([finalizedHead]);
		expect(bound).toMatchObject({
			status: "bound",
			binding: {
				approvedPlanCommit: finalizedHead,
				approvedPlanBytes: reviewed,
			},
		});
		expect(
			await admit(ctx, { executionRunId: "exec", markdown: noted }),
		).toMatchObject({ status: "error", code: "IMPLEMENTATION_PLAN_DRIFT" });

		const unsealed = setup();
		approveSource(unsealed, "source", draft, { unsealed: true });
		putRun(unsealed.recordStore, "exec");
		const open = await admit(unsealed, {
			executionRunId: "exec",
			markdown: draft,
			sourceRunId: "source",
		});
		expect(open).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PLAN_UNAPPROVED",
		});
		if (open.status === "error") {
			expect(open.message).toContain("finalized plan commit");
		}

		const mismatched = setup();
		approveSource(mismatched, "source", draft, {
			head: reviewerHead,
			finalHead: laterHead,
			completeHead: finalizedHead,
		});
		putRun(mismatched.recordStore, "exec");
		const refused = await admit(mismatched, {
			executionRunId: "exec",
			markdown: noted,
			sourceRunId: "source",
			read: async () => noted,
		});
		expect(refused).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PLAN_UNAPPROVED",
		});
		if (refused.status === "error") {
			expect(refused.message).toContain("Later HEAD is not approval");
		}
		expect(mismatched.store.getImplementationBinding("exec")).toBeNull();
	});

	test("final corrections require the author commit and then bind that commit", async () => {
		const markdown = plan();
		const open = setup();
		approveSource(open, "source", markdown, { route: "final_corrections" });
		putRun(open.recordStore, "exec");
		const missingAuthor = await admit(open, {
			executionRunId: "exec",
			markdown,
			sourceRunId: "source",
		});
		expect(missingAuthor).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PLAN_UNAPPROVED",
		});
		if (missingAuthor.status === "error") {
			expect(missingAuthor.message).toContain("final author commit");
		}

		const closed = setup();
		const authorHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		approveSource(closed, "source", markdown, {
			route: "final_corrections",
			authorAfter: { head: authorHead },
		});
		putRun(closed.recordStore, "exec");
		const seen: string[] = [];
		const bound = await admit(closed, {
			executionRunId: "exec",
			markdown,
			read: async (commit) => {
				seen.push(commit);
				return markdown;
			},
		});
		expect(seen).toEqual([authorHead]);
		expect(bound).toMatchObject({
			status: "bound",
			binding: { approvedPlanCommit: authorHead, sourceRunId: "source" },
		});

		const reviewed = markdown.replace(
			"# Plan\n",
			"# Plan\n\n**Status:** Reviewed\n",
		);
		const statusHead = "c".repeat(40);
		const sealed = setup();
		approveSource(sealed, "source", markdown, {
			route: "final_corrections",
			authorAfter: { head: authorHead },
			finalHead: statusHead,
		});
		putRun(sealed.recordStore, "exec");
		const statusSeen: string[] = [];
		const statusBound = await admit(sealed, {
			executionRunId: "exec",
			markdown: reviewed,
			read: async (commit) => {
				statusSeen.push(commit);
				return commit === statusHead ? reviewed : markdown;
			},
		});
		expect(statusSeen).toEqual([statusHead]);
		expect(statusBound).toMatchObject({
			status: "bound",
			binding: {
				approvedPlanCommit: statusHead,
				approvedPlanBytes: reviewed,
			},
		});
	});

	test("identical bind is a no-op and a different source conflicts", async () => {
		const markdown = plan();
		const ctx = setup();
		approveSource(ctx, "source-a", markdown);
		approveSource(ctx, "source-b", markdown);
		putRun(ctx.recordStore, "exec");
		const first = await admit(ctx, {
			executionRunId: "exec",
			markdown,
			sourceRunId: "source-a",
		});
		expect(first.status).toBe("bound");
		if (first.status !== "bound") return;
		const retry = await admit(ctx, {
			executionRunId: "exec",
			markdown,
			sourceRunId: "source-a",
		});
		expect(retry).toMatchObject({
			status: "bound",
			created: false,
			binding: { id: first.binding.id },
		});
		expect(
			await admit(ctx, {
				executionRunId: "exec",
				markdown,
				sourceRunId: "source-b",
			}),
		).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_BINDING_CONFLICT",
		});
	});

	test("rejects unknown and ambiguous phases before activation", async () => {
		const unknown = plan({ target: "phase-9" });
		const ctx = setup();
		approveSource(ctx, "source", unknown);
		putRun(ctx.recordStore, "exec");
		expect(
			await admit(ctx, { executionRunId: "exec", markdown: unknown }),
		).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PHASE_UNRESOLVED",
		});
		expect(ctx.store.getImplementationBinding("exec")).toBeNull();

		const ambiguous = plan({ target: "phase-1", duplicatePhase: true });
		const other = setup();
		approveSource(other, "source", ambiguous);
		putRun(other.recordStore, "exec");
		expect(
			await admit(other, { executionRunId: "exec", markdown: ambiguous }),
		).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PHASE_UNRESOLVED",
		});
	});

	test("refuses a changed plan and ignores checkbox-only edits", async () => {
		const markdown = plan();
		const ctx = setup();
		approveSource(ctx, "source", markdown);
		putRun(ctx.recordStore, "exec");
		const changed = markdown
			.replace("Effort | Architecture", "Effort | Architecture")
			.replace(
				"| W1 | Bind | 2 | 0 | - | - | Required |",
				"| W1 | Bind | 5 | 0 | - | - | Required |",
			);
		expect(
			await admit(ctx, {
				executionRunId: "exec",
				markdown: changed,
				read: async () => markdown,
			}),
		).toMatchObject({ status: "error", code: "IMPLEMENTATION_PLAN_DRIFT" });
		expect(ctx.store.getImplementationBinding("exec")).toBeNull();

		const bound = await admit(ctx, { executionRunId: "exec", markdown });
		expect(bound.status).toBe("bound");
		const checked = markdown.replace(
			"- [ ] Bind execution",
			"- [x] Bind execution",
		);
		const retry = await admit(ctx, {
			executionRunId: "exec",
			markdown: checked,
		});
		expect(retry).toMatchObject({ status: "bound", created: false });
	});

	test("verified text lineage authorizes drift without a new binding", async () => {
		const markdown = plan();
		const ctx = setup();
		approveSource(ctx, "source", markdown);
		putRun(ctx.recordStore, "exec");
		const bound = await admit(ctx, { executionRunId: "exec", markdown });
		if (bound.status !== "bound") throw new Error("expected binding");
		const amended = markdown.replace(
			"Bind execution",
			"Bind the execution run",
		);
		const recorded = recordVerifiedTextAmendment({
			store: ctx.store,
			binding: bound.binding,
			origin: ORIGIN,
			guardId: "guard-1",
			sourceObservationId: "obs-1",
			beforeCommit: bound.binding.approvedPlanCommit,
			afterCommit: "cccccccccccccccccccccccccccccccccccccccc",
			authorizedPlanBytes: amended,
		});
		expect(recorded.status).toBe("ok");
		const next = await admit(ctx, {
			executionRunId: "exec",
			markdown: amended,
		});
		expect(next).toMatchObject({
			status: "bound",
			created: false,
			binding: {
				id: bound.binding.id,
				approvedPlanHash: bound.binding.approvedPlanHash,
			},
		});
		expect(ctx.store.getBaseline("exec")).toBeNull();

		const broken = setup();
		approveSource(broken, "source", markdown);
		putRun(broken.recordStore, "exec");
		const first = await admit(broken, { executionRunId: "exec", markdown });
		if (first.status !== "bound") throw new Error("expected binding");
		broken.recordStore.append({
			runId: "exec",
			stream: "budget",
			idempotencyKey: "budget:implementation-text-amendment:broken:1",
			payload: {
				kind: "implementation-text-amendment",
				version: 1,
				id: "amend-1",
				bindingId: first.binding.id,
				executionRunId: "exec",
				guardId: "guard-1",
				sourceObservationId: "obs-1",
				parentLineageId: null,
				beforeCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				afterCommit: "dddddddddddddddddddddddddddddddddddddddd",
				beforeBlobHash: "sha256:not-the-approved-hash",
				afterBlobHash: "sha256:also-wrong",
				authorizedPlanBytes: amended,
				createdAt: "2026-09-23 00:00:02",
			},
			...recordedEnvelope(ORIGIN),
		});
		expect(
			await admit(broken, { executionRunId: "exec", markdown: amended }),
		).toMatchObject({ status: "error", code: "IMPLEMENTATION_PLAN_DRIFT" });
		const drift = detectPlanDrift({
			recordedSchema: 0,
			approvedPlanBytes: first.binding.approvedPlanBytes,
			approvedPlanHash: first.binding.approvedPlanHash,
			amendments: [],
			currentPlanBytes: markdown.replace("- [ ]", "- [X]"),
		});
		expect(drift.drifted).toBe(false);
	});

	test("plan readers ignore implementation binding kinds", async () => {
		const markdown = plan();
		const ctx = setup();
		approveSource(ctx, "source", markdown);
		putRun(ctx.recordStore, "exec");
		const bound = await admit(ctx, { executionRunId: "exec", markdown });
		if (bound.status !== "bound") throw new Error("expected binding");
		expect(ctx.store.listSnapshots("exec")).toEqual([]);
		expect(ctx.store.getBaseline("exec")).toBeNull();
		expect(ctx.store.listSnapshots("source")).toHaveLength(1);
		const line = ctx.recordStore.getLine(
			"exec",
			"budget",
			`budget:implementation-binding:exec`,
		);
		expect(() => decodeBudgetSnapshotPayload(line?.payload)).toThrow(
			/snapshot/,
		);
		const snapshots: unknown[] = [];
		reindexReviewBudget(
			ctx.recordStore,
			{
				upsertBaseline() {},
				upsertSnapshot(snapshot) {
					snapshots.push(snapshot);
				},
				getBaseline: () => null,
				latestSnapshot: () => null,
				listSnapshots: () => [],
			},
			"exec",
		);
		expect(snapshots).toEqual([]);
		expect(bound.binding.kind).toBe("implementation-binding");
		const encoded = bound.binding satisfies ImplementationBindingPayload;
		expect(encoded.version).toBe(1);
	});

	test("schema 1 drift allows status and note edits and rejects governing edits", () => {
		const markdown = SCHEMA1_AUTHORITY_PLAN;
		const loaded = loadPlanDocument(markdown, 1);
		if (!loaded.ok) throw new Error(loaded.message);
		const governingHash = hashPlanBytes(loaded.document.comparisonBytes);
		const base = {
			approvedPlanBytes: markdown,
			approvedPlanHash: hashPlanBytes(markdown),
			amendments: [],
			recordedSchema: 1 as const,
			governingHash,
		};
		expect(
			detectPlanDrift({
				...base,
				currentPlanBytes: withSchema1Status(markdown, "Revised — 状态 line"),
			}).drifted,
		).toBe(false);
		expect(
			detectPlanDrift({
				...base,
				currentPlanBytes: markdown.replace(
					SCHEMA1_NOTE_ONLY_TEXT,
					"Different note prose.",
				),
			}).drifted,
		).toBe(false);
		expect(
			detectPlanDrift({
				...base,
				currentPlanBytes: markdown.replace(
					"- [ ] Second item",
					"- [x] Second item",
				),
			}).drifted,
		).toBe(false);
		const governing = detectPlanDrift({
			...base,
			currentPlanBytes: markdown.replace(SCHEMA1_OVERVIEW, "Changed overview."),
		});
		expect(governing.drifted).toBe(true);
		expect(governing.reason).toContain("not a legacy fallback");
		const missing = detectPlanDrift({
			...base,
			currentPlanBytes: markdown.replace("<!-- 5x:plan-schema:1 -->\n", ""),
		});
		expect(missing.drifted).toBe(true);
		expect(missing.reason).toContain("PLAN_SCHEMA_INVALID");
		expect(missing.reason).toContain("not a legacy fallback");
		const wrongHash = detectPlanDrift({
			...base,
			currentPlanBytes: markdown,
			governingHash: "sha256:not-the-comparison-hash",
		});
		expect(wrongHash.drifted).toBe(true);
		expect(wrongHash.reason).toContain("governingHash");
	});

	test("schema 0 drift still rejects a status edit and names migration recovery", async () => {
		expect(PLAN_DRIFT_RECOVERY_HELP).toContain(
			"5x review migrate-schema --help",
		);
		expect(PLAN_DRIFT_RECOVERY_HELP).toContain("5x-plan-migration");
		expect(PLAN_DRIFT_RECOVERY_HELP).toContain("recover-plan");
		expect(PLAN_DRIFT_RECOVERY_HELP).toContain("Legacy schema 0");
		const markdown = plan();
		const ctx = setup();
		approveSource(ctx, "source", markdown);
		putRun(ctx.recordStore, "exec");
		const bound = await admit(ctx, { executionRunId: "exec", markdown });
		expect(bound.status).toBe("bound");
		if (bound.status !== "bound") return;
		expect(bound.binding.planSchema).toBeUndefined();
		expect(bound.binding.governingHash).toBeUndefined();
		const drifted = await admit(ctx, {
			executionRunId: "exec",
			markdown: `**Status:** Revised\n\n${markdown}`,
		});
		expect(drifted).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PLAN_DRIFT",
			detail: { recoveryHelp: PLAN_DRIFT_RECOVERY_HELP },
		});
	});

	test("bind stores schema 1 fields and a later status edit does not drift", async () => {
		const markdown = `<!-- 5x:plan-schema:1 -->
**Version:** 1
**Status:** Approved

<!-- 5x:contract:start -->
${plan().trimEnd()}
<!-- 5x:contract:end -->
`;
		const loaded = loadPlanDocument(markdown, "file");
		if (!loaded.ok) throw new Error(loaded.message);
		const ctx = setup();
		approveSource(ctx, "source", markdown);
		putRun(ctx.recordStore, "exec");
		const bound = await admit(ctx, { executionRunId: "exec", markdown });
		expect(bound.status).toBe("bound");
		if (bound.status !== "bound") return;
		expect(bound.binding.planSchema).toBe(1);
		expect(bound.binding.governingHash).toBe(
			hashPlanBytes(loaded.document.comparisonBytes),
		);
		expect(bound.binding.schemaMigrationId).toBeUndefined();
		const again = await admit(ctx, {
			executionRunId: "exec",
			markdown: markdown.replace("**Status:** Approved", "**Status:** Revised"),
		});
		expect(again).toMatchObject({ status: "bound", created: false });
		const governing = await admit(ctx, {
			executionRunId: "exec",
			markdown: markdown.replace(
				"- [ ] Bind execution",
				"- [ ] Rebind execution",
			),
		});
		expect(governing).toMatchObject({
			status: "error",
			code: "IMPLEMENTATION_PLAN_DRIFT",
		});
	});

	test("parser, budget, signature, and drift agree on one schema 1 fixture", () => {
		const markdown = SCHEMA1_AUTHORITY_PLAN;
		const planRead = readAuthoritativePlan(markdown, "file");
		const budgetRead = readAuthoritativeBudget(markdown, "file");
		const loaded = loadPlanDocument(markdown, 1);
		expect(planRead.ok).toBe(true);
		expect(budgetRead.ok).toBe(true);
		expect(loaded.ok).toBe(true);
		if (!planRead.ok || !budgetRead.ok || !loaded.ok || !budgetRead.parsed.ok) {
			return;
		}
		const comparisonHash = hashPlanBytes(loaded.document.comparisonBytes);
		expect(hashPlanBytes(planRead.document.comparisonBytes)).toBe(
			comparisonHash,
		);
		expect(hashPlanBytes(budgetRead.document.comparisonBytes)).toBe(
			comparisonHash,
		);
		expect(structuralSignature(planRead.document.comparisonBytes)).toBe(
			structuralSignature(budgetRead.document.comparisonBytes),
		);
		expect(planRead.plan.phases.map((phase) => phase.number)).toEqual([
			"1",
			"2",
		]);
		expect(budgetRead.parsed.value.workItems.map((item) => item.id)).toEqual([
			"W1",
		]);
		expect(
			detectPlanDrift({
				approvedPlanBytes: markdown,
				approvedPlanHash: hashPlanBytes(markdown),
				amendments: [],
				currentPlanBytes: markdown,
				recordedSchema: 1,
				governingHash: comparisonHash,
			}),
		).toMatchObject({ drifted: false, chainValid: true });
	});

	test("a status-only schema 1 blob writes no amendment and a span change stores raw hashes", () => {
		const markdown = SCHEMA1_AUTHORITY_PLAN;
		const loaded = loadPlanDocument(markdown, 1);
		if (!loaded.ok) throw new Error(loaded.message);
		const resolved = resolvePlanImpactSpans({
			anchorText: loaded.document.authorityMarkdown,
			byteSource: markdown,
			locations: [
				{
					itemId: "R1",
					heading: "Phase 1: Bind",
					staleText: SCHEMA1_STALE_TEXT,
				},
			],
		});
		if (resolved.status !== "resolved") throw new Error(resolved.message);
		const prepared = prepareTextAmendmentGuard({
			id: "guard-1",
			anchorBytes: markdown,
			anchorCommit: "a".repeat(40),
			parentLineageId: null,
			allowedSpans: resolved.spans,
			recordedSchema: 1,
		});
		if (!prepared.ok) throw new Error(prepared.message);
		const recordStore = createMemoryRecordStore();
		putRun(recordStore, "exec");
		const store = createReviewBudgetStore(recordStore);
		const saved = store.saveImplementationBinding(
			{
				...bindingPayload(markdown),
				planSchema: 1,
				governingHash: hashPlanBytes(loaded.document.comparisonBytes),
			},
			ORIGIN,
		);
		const observation = schema1Observation(saved.payload, prepared.guard);
		recordStore.append({
			runId: "exec",
			stream: "budget",
			idempotencyKey: implementationReviewObservationKey(
				"exec",
				observation.stepKey,
			),
			payload: encodeImplementationReviewObservationPayload(observation),
			createdAt: observation.createdAt,
			...recordedEnvelope(ORIGIN),
		});
		const statusOnly = Buffer.from(
			withSchema1Status(markdown, "Revised — 状态 line"),
			"utf8",
		);
		expect(
			verifyAuthorTextAmendment({
				store,
				binding: saved.payload,
				origin: ORIGIN,
				phase: "1",
				committedPlanBytes: statusOnly,
				worktreePlanBytes: statusOnly,
				afterCommit: "b".repeat(40),
			}).status,
		).toBe("unchanged");
		expect(
			store.listImplementationTextAmendments("exec", saved.payload.id),
		).toEqual([]);
		const amended = markdown.replace(
			SCHEMA1_STALE_TEXT,
			"Bind the execution run to the approved plan.",
		);
		const bytes = Buffer.from(amended, "utf8");
		const verified = verifyAuthorTextAmendment({
			store,
			binding: saved.payload,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: bytes,
			worktreePlanBytes: bytes,
			afterCommit: "c".repeat(40),
		});
		expect(verified.status).toBe("verified");
		if (verified.status !== "verified") return;
		expect(verified.amendment.authorizedPlanBytes).toBe(amended);
		expect(verified.amendment.beforeBlobHash).toBe(hashPlanBytes(markdown));
		expect(verified.amendment.afterBlobHash).toBe(hashPlanBytes(amended));
	});

	test("replay accepts one schema migration and does not install an invalid target", () => {
		const approved = "# Plan\n\n- [ ] Bind\n";
		const target = `<!-- 5x:plan-schema:1 -->
**Status:** Approved

<!-- 5x:contract:start -->
# Plan

- [ ] Bind
<!-- 5x:contract:end -->
`;
		const targetDocument = loadPlanDocument(target, 1);
		if (!targetDocument.ok) throw new Error(targetDocument.message);
		const governingHash = hashPlanBytes(
			targetDocument.document.comparisonBytes,
		);
		const migration = {
			kind: "plan-schema-migration" as const,
			version: 1 as const,
			id: "mig-1",
			fromSchema: 0 as const,
			toSchema: 1 as const,
			parentLineageId: null,
			beforeBlobHash: hashPlanBytes(approved),
			afterBlobHash: hashPlanBytes(target),
			authorizedPlanBytes: target,
			governingHash,
		};
		const statusEdit = target.replace(
			"**Status:** Approved",
			"**Status:** Revised",
		);
		expect(
			detectPlanDrift({
				approvedPlanBytes: approved,
				approvedPlanHash: hashPlanBytes(approved),
				amendments: [migration],
				currentPlanBytes: statusEdit,
				recordedSchema: 1,
				governingHash,
			}),
		).toMatchObject({
			drifted: false,
			chainValid: true,
			authorizedBytes: target,
		});
		const invalid = detectPlanDrift({
			approvedPlanBytes: approved,
			approvedPlanHash: hashPlanBytes(approved),
			amendments: [{ ...migration, governingHash: "sha256:nope" }],
			currentPlanBytes: statusEdit,
			recordedSchema: 1,
			governingHash,
		});
		expect(invalid.chainValid).toBe(false);
		expect(invalid.authorizedBytes).toBe(approved);
		expect(invalid.drifted).toBe(true);
		expect(invalid.reason).toContain("PLAN_SCHEMA_INVALID");
		expect(invalid.reason).toContain("not a legacy fallback");
	});

	test("a binding read error does not downgrade to file mode", () => {
		const recordStore = createMemoryRecordStore();
		putRun(recordStore, "exec");
		putRun(recordStore, "plain");
		recordStore.append({
			runId: "exec",
			stream: "budget",
			idempotencyKey: implementationBindingKey("exec"),
			payload: { kind: "implementation-binding", version: 1 },
			createdAt: "2026-09-23 00:00:00",
			...recordedEnvelope(ORIGIN),
		});
		const store = createReviewBudgetStore(recordStore);
		expect(expectedSchemaForStore(store, "plain")).toBe("file");
		expect(expectedSchemaForStore(store, "missing")).toBe("file");
		expect(() => expectedSchemaForStore(store, "exec")).toThrow(TypeError);
	});

	test("historical bindings decode and the sqlite index keeps a schema 1 binding", () => {
		const historical = bindingPayload("# Plan\n");
		const encoded = encodeImplementationBindingPayload(historical) as Record<
			string,
			unknown
		>;
		expect(encoded.planSchema).toBeUndefined();
		expect(encoded.governingHash).toBeUndefined();
		expect(
			decodeImplementationBindingPayload(encoded).planSchema,
		).toBeUndefined();
		const recordStore = createMemoryRecordStore();
		putRun(recordStore, "exec");
		recordStore.append({
			runId: "exec",
			stream: "budget",
			idempotencyKey: implementationBindingKey("exec"),
			payload: encoded,
			createdAt: historical.createdAt,
			...recordedEnvelope(ORIGIN),
		});
		const store = createReviewBudgetStore(recordStore);
		expect(store.getImplementationBinding("exec")?.planSchema).toBeUndefined();
		expect(expectedSchemaForStore(store, "exec")).toBe(0);
		putRun(recordStore, "schema1");
		const schema1 = store.saveImplementationBinding(
			{
				...bindingPayload(SCHEMA1_AUTHORITY_PLAN),
				id: "binding-schema-1",
				executionRunId: "schema1",
				planSchema: 1,
				governingHash: "sha256:governing",
				schemaMigrationId: "mig-1",
				predecessorPlanCommit: "d".repeat(40),
			},
			ORIGIN,
		);
		expect(schema1.payload.planSchema).toBe(1);
		expect(schema1.payload.governingHash).toBe("sha256:governing");
		expect(expectedSchemaForStore(store, "schema1")).toBe(1);
		recordStore.append({
			runId: "schema1",
			stream: "budget",
			idempotencyKey: "budget:mystery-kind:schema1",
			payload: { kind: "mystery-budget", version: 9 },
			createdAt: historical.createdAt,
			...recordedEnvelope(ORIGIN),
		});
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.exec(
				"INSERT INTO runs(id, plan_path) VALUES ('schema1', 'docs/plan.md')",
			);
			const indexed = reindexReviewGovernance(recordStore, db, "schema1");
			expect(indexed.diagnostics).toEqual([]);
			const row = db
				.query(
					"SELECT payload_json FROM implementation_binding_index WHERE id = ?",
				)
				.get(schema1.payload.id) as { payload_json: string } | null;
			expect(row).not.toBeNull();
			const payload = JSON.parse(row?.payload_json ?? "{}") as {
				planSchema?: number;
			};
			expect(payload.planSchema).toBe(1);
		} finally {
			db.close();
		}
	});
});

function bindingPayload(markdown: string): ImplementationBindingPayload {
	const parsed = parseDeliveryBudget(markdown);
	const ledger = parsed.ok
		? parsed.value
		: {
				estimateConfidence: "high" as const,
				workItems: [],
				surface: {
					subsystems: 1,
					productionFiles: 1,
					persistentOrExternalBoundaries: 0,
				},
			};
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: "exec",
		sourceRunId: "source",
		sourceSnapshotId: "snap-1",
		sourceBaselineId: "base-1",
		approvedPlanCommit: "a".repeat(40),
		approvedPlanHash: hashPlanBytes(markdown),
		approvedPlanBytes: markdown,
		b0: 2,
		governingB: 2,
		mode: "enforced",
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger,
		effectiveDecisions: [],
		phaseMap: [{ id: "1", heading: "Phase 1: Bind" }],
		debtTargets: [],
		ledgerHash: "sha256:ledger",
		decisionsHash: "sha256:decisions",
		createdAt: "2026-09-23 00:00:00",
	};
}

function schema1Observation(
	binding: ImplementationBindingPayload,
	guard: ImplementationReviewObservationPayload["textGuard"],
): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: "obs-1",
		runId: binding.executionRunId,
		stepKey: { stepName: "reviewer:review", phase: "1", iteration: 0 },
		bindingId: binding.id,
		contextId: "ctx-1",
		domain: "implementation",
		phase: "1",
		originalVerdict: {
			readiness: "not_ready",
			items: [
				{
					id: "R1",
					title: "Stale wording",
					action: "auto_fix",
					reason: "The sentence is stale.",
					scopeClass: "plan_defect",
					priority: "P2",
					effortDelta: 0,
					architectureDelta: 0,
					planWorkItemIds: ["W1"],
					planImpact: {
						kind: "text_only",
						locations: [
							{
								heading: "Phase 1: Bind",
								staleText: SCHEMA1_STALE_TEXT,
							},
						],
					},
				},
			],
		},
		outcomes: [],
		route: "author_revision",
		nextAction: "author_revision",
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
				plan_defect: 1,
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
		textGuard: guard,
		createdAt: "2026-09-23 00:00:01",
	};
}
