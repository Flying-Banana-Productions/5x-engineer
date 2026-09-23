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
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import {
	decodeBudgetSnapshotPayload,
	type ImplementationBindingPayload,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	createReviewDecision,
	governanceDecisionKey,
} from "../../../src/review-governance/decisions.js";
import {
	detectPlanDrift,
	ensureImplementationAdmission,
	isImplementationAuthorTemplate,
	mapDebtTargetToPhaseId,
	planRepoPath,
	recordVerifiedTextAmendment,
} from "../../../src/review-governance/implementation-state.js";

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
		mode: "enforced",
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
			items: [],
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
				approvedPlanBytes: approved,
				approvedPlanHash: "unused",
				amendments: [],
				currentPlanBytes: checked,
			}).drifted,
		).toBe(false);
		expect(
			detectPlanDrift({
				approvedPlanBytes: "* [X] Bind\n",
				approvedPlanHash: "unused",
				amendments: [],
				currentPlanBytes: "* [ ] Bind\n",
			}).drifted,
		).toBe(false);
		expect(
			detectPlanDrift({
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
});
