/**
 * Plan 217 Phase 5: combined workflow-repair lifecycle on ONE run lineage.
 *
 * Earlier phases test each recovery in isolation. This fixture composes them
 * in the order an operator meets them, over fixture journals only (memory
 * record store plus temp plan file; never an external project's database or
 * worktree):
 *
 *   1. A legacy sealed source whose final corrections added `P1.1` to W2's
 *      `Addresses` (stale snapshot ledger) binds through the deterministic
 *      reconciliation, with derivation provenance and an untouched source.
 *   2. An older CLI left a gate-less `human_gate` observation in the journal,
 *      and the operator's manual checkbox fix drifted the plan. Inspection
 *      reports both and puts the direct mechanical repair first.
 *   3. One operator instruction records the prefix-only repair on the same
 *      run; binding, source, approval and ledger are unchanged.
 *   4. The corrective reviewer's first answer is an empty negative verdict:
 *      a correctable structured-output failure that appends nothing.
 *   5. The corrected review supersedes the gate-less routing; the old
 *      observation stays as audit history; admission resumes.
 *   6. Restart: the journals alone rebuild identical lineage, binding,
 *      routing and receipts, and every retry is idempotent.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	composeImplementationReviewerRecord,
	recordImplementationReviewerStepWithObservation,
} from "../../../src/commands/implementation-review-context.js";
import {
	type RunRepairDeps,
	repairChecklistsForRun,
} from "../../../src/commands/plan-checklist-repair.handler.js";
import { showReviewGate } from "../../../src/commands/review-decision.handler.js";
import { presentImplementationGovernance } from "../../../src/commands/run-v1.handler.js";
import {
	createMemoryPromptStore,
	createMemoryRecordStore,
	createReviewBudgetIndex,
	createReviewBudgetStore,
	type RecordStore,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { reindexReviewBudget } from "../../../src/control-plane/review-budget-index.js";
import { runMigrations } from "../../../src/db/schema.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import {
	encodeImplementationReviewObservationPayload,
	type ImplementationReviewObservationPayload,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import type { CodeDiffContext } from "../../../src/review-governance/code-diff.js";
import { GATELESS_HUMAN_GATE } from "../../../src/review-governance/gate-invariant.js";
import {
	ensureImplementationAdmission,
	hashPlanBytes,
} from "../../../src/review-governance/implementation-state.js";
import { reindexReviewGovernance } from "../../../src/review-governance/sqlite-index.js";
import {
	deriveGatelessImplementationObservation,
	deriveOpenImplementationGate,
} from "../../../src/review-governance/store.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "../commands/review-budget-test-helpers.js";

const RUN = "run1";
const SOURCE = "source";
const PLAN_PATH = "/tmp/plan.md";
const REVIEWER_HEAD = "a".repeat(40);
const AUTHOR_HEAD = "b".repeat(40);
const CODE_HEAD = "c".repeat(40);
const REASON = "Operator authorized checklist-format repair and continuation";

/** The incident shape: gate lists without task markers in every phase. */
const APPROVED = `# Booking preview

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Preview model | 2 | 0 | - | - | Required |
| W2 | Modal | 1 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Preview model

**Completion gate:** Preview data is typed.

- Add the preview type
  - include the member tier
- Map API fields

## Phase 2: Modal

**Completion gate:** The modal renders.

- Render the modal
`;

/** Final corrections changed only W2's Addresses (the stale-ledger cause). */
const SEALED = APPROVED.replace(
	"| W2 | Modal | 1 | 0 | - | - | Required |",
	"| W2 | Modal | 1 | 0 | - | P1.1 | Required |",
);

const CORRECTION_ITEM = {
	id: "P1.1",
	title: "Name the modal's failure path",
	action: "auto_fix",
	reason: "W2 omits the failure path.",
	scopeClass: "acceptance_required",
	effortDelta: 0,
	architectureDelta: 0,
};

const diff: CodeDiffContext = {
	baseCommit: AUTHOR_HEAD,
	reviewedCommit: CODE_HEAD,
	patch: "",
	patchHash: "sha256:patch",
	excludedPaths: ["docs/plan.md"],
	hunks: [],
	binaryPaths: [],
};

type Ctx = ReturnType<typeof makeBudgetContext>;

function appendStep(
	recordStore: RecordStore,
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
		idempotencyKey: stepIdempotencyKey({ runId, stepName, phase, iteration }),
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
		...recordedEnvelope(TEST_ORIGIN),
	});
}

/**
 * A completed plan-review run sealed by a CLI that predates
 * `plan-approval-finalization`: the reviewer snapshot holds the
 * pre-correction ledger, the recorded author pass committed `SEALED`.
 */
function sealLegacySource(ctx: Ctx) {
	const parsed = parseDeliveryBudget(APPROVED);
	if (!parsed.ok) throw new Error(parsed.message);
	ctx.recordStore.putRun({
		id: SOURCE,
		plan_path: PLAN_PATH,
		config_json: null,
		created_at: "2026-11-05 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "0.0.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: TEST_ORIGIN.recorder,
	});
	ctx.store.captureBaseline({
		runId: SOURCE,
		captureKind: "initial",
		parsed: parsed.value,
		configSnapshot: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		mode: "enforced",
		origin: TEST_ORIGIN,
	});
	const snapshot = ctx.store.appendSnapshot({
		runId: SOURCE,
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: parsed.value,
		findings: [],
		assessments: [],
		origin: TEST_ORIGIN,
	});
	appendStep(
		ctx.recordStore,
		SOURCE,
		"reviewer:plan",
		"plan",
		1,
		{
			readiness: "not_ready",
			items: [CORRECTION_ITEM],
			governance: { route: "final_corrections" },
		},
		REVIEWER_HEAD,
	);
	appendStep(
		ctx.recordStore,
		SOURCE,
		"author:process-plan-review",
		"plan",
		1,
		{ result: "complete", commit: AUTHOR_HEAD },
		AUTHOR_HEAD,
	);
	appendStep(
		ctx.recordStore,
		SOURCE,
		"run:complete",
		"plan",
		1,
		{ status: "completed", reason: null },
		AUTHOR_HEAD,
	);
	const summary = ctx.recordStore.getRun(SOURCE);
	if (!summary) throw new Error("source run missing");
	ctx.recordStore.putRun({
		...summary,
		status: "completed",
		sealed_at: "2026-11-05T00:00:02.000Z",
		final_head_commit: AUTHOR_HEAD,
		sealer: TEST_ORIGIN.recorder,
	});
	return snapshot;
}

function sourceJournal(recordStore: RecordStore): string[] {
	return (["steps", "budget", "decisions"] as const).map((stream) =>
		JSON.stringify(recordStore.listLines(SOURCE, stream)),
	);
}

function stepNames(recordStore: RecordStore, runId: string): string[] {
	return recordStore
		.listLines(runId, "steps")
		.map((line) => String((line.payload as { step_name: string }).step_name));
}

function gatelessObservation(
	bindingId: string,
): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: "obs-historical",
		runId: RUN,
		stepKey: { stepName: "reviewer:commit", phase: "1", iteration: 1 },
		bindingId,
		contextId: "ctx-1",
		domain: "implementation",
		phase: "1",
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
		budgetInvariant: { W: 3, R: 0, B: 3, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-11-05 12:00:00",
	};
}

/** Append the step+observation pair exactly as an older CLI did. */
function appendHistoricalGateless(ctx: Ctx, bindingId: string) {
	const payload = gatelessObservation(bindingId);
	appendStep(ctx.recordStore, RUN, "reviewer:commit", "1", 1, {}, CODE_HEAD);
	ctx.recordStore.append({
		runId: RUN,
		stream: "budget",
		idempotencyKey: `budget:implementation-review:${payload.id}`,
		payload: encodeImplementationReviewObservationPayload(payload),
		...recordedEnvelope(TEST_ORIGIN),
	});
}

/** Copy every run summary and journal line into a fresh store (restart). */
function restartFromJournals(recordStore: RecordStore): RecordStore {
	const fresh = createMemoryRecordStore();
	for (const run of recordStore.listRuns()) {
		const summary = recordStore.getRun(run.id);
		if (!summary) throw new Error(`missing ${run.id}`);
		fresh.putRun(summary);
		for (const stream of ["steps", "budget", "decisions"] as const) {
			for (const line of recordStore.listLines(run.id, stream)) {
				fresh.append({ ...line });
			}
		}
	}
	return fresh;
}

describe("combined workflow-repair lifecycle (plan 217 phase 5)", () => {
	test("stale final-corrections ledger, prefix-only drift, empty negative verdict, gate-less history and restart on one lineage", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const promptStore = createMemoryPromptStore();
		const tmp = mkdtempSync(join(tmpdir(), "5x-repair-lifecycle-"));
		const planFile = join(tmp, "plan.md");
		ctx.executionContext.effectivePlanPath = planFile;
		const commits = new Map<string, string>([
			[REVIEWER_HEAD, APPROVED],
			[AUTHOR_HEAD, SEALED],
		]);
		let head = AUTHOR_HEAD;
		let commitCalls = 0;
		const readPlanAtCommit = async (commit: string) =>
			commits.get(commit) ?? null;
		const readFile = () => readFileSync(planFile, "utf8");
		const repairDeps = (
			recordStore: RecordStore,
			store: Ctx["store"],
		): RunRepairDeps => ({
			recordStore,
			store,
			origin: TEST_ORIGIN,
			planPath: planFile,
			readPlanAtCommit,
			readPlanFile: readFile,
			writePlanFile: (bytes) => writeFileSync(planFile, bytes),
			commitPlanFile: async () => {
				commitCalls += 1;
				const bytes = readFile();
				if (commits.get(head) === bytes)
					return { commit: head, committed: false };
				head = String(commits.size).repeat(40).slice(0, 40);
				commits.set(head, bytes);
				return { commit: head, committed: true };
			},
		});
		const admit = (
			markdown: string,
			store: Ctx["store"] = ctx.store,
			recordStore: RecordStore = ctx.recordStore,
		) =>
			ensureImplementationAdmission({
				store,
				recordStore,
				executionRunId: RUN,
				planPath: PLAN_PATH,
				planMarkdown: markdown,
				configuredMode: "enforced",
				origin: TEST_ORIGIN,
				readPlanAtCommit,
			});
		const recordReview = async (
			verdict: { readiness: string; items: unknown[] },
			iteration: number,
		) => {
			const composed = await composeImplementationReviewerRecord({
				ctx,
				runId: RUN,
				stepName: "reviewer:commit",
				phase: "1",
				iteration,
				verdict: verdict as Parameters<
					typeof composeImplementationReviewerRecord
				>[0]["verdict"],
				contextId: "ctx-1",
				codeContext: diff,
			});
			if (composed.status !== "applied") return composed;
			const written = await recordImplementationReviewerStepWithObservation(
				{
					run: RUN,
					stepName: "reviewer:commit",
					result: JSON.stringify(verdict),
					phase: "1",
					iteration,
					performer: {
						kind: "agent" as const,
						role: "reviewer",
						provider: "cursor",
					},
				},
				composed.pending,
				ctx,
				composed.reconciliation,
			);
			return { status: "recorded" as const, written };
		};
		const governanceState = (planDrifted: boolean) =>
			presentImplementationGovernance({
				readiness: {
					executionObligations: true,
					checklistSufficient: false,
					planDrifted,
					bindingPresent: true,
					phases: [],
				},
				binding: ctx.store.getImplementationBinding(RUN),
				contexts: [],
				observations: ctx.store.listImplementationReviews(RUN),
				reconciliations: [],
				correctionAttempts: [],
				activeGate: null,
				recordStore: ctx.recordStore,
				runId: RUN,
			});

		try {
			// 1. Legacy stale-Addresses source binds from sealed evidence.
			const snapshot = sealLegacySource(ctx);
			const sealedJournal = sourceJournal(ctx.recordStore);
			writeFileSync(planFile, SEALED);
			const bound = await admit(SEALED);
			if (bound.status !== "bound") throw new Error(JSON.stringify(bound));
			const binding = bound.binding;
			expect(binding).toMatchObject({
				sourceRunId: SOURCE,
				sourceSnapshotId: snapshot.id,
				approvedPlanCommit: AUTHOR_HEAD,
				approvedPlanHash: hashPlanBytes(SEALED),
				approvalFinalization: {
					derivation: "legacy_stale_addresses",
					finalCommit: AUTHOR_HEAD,
					admittedFindingIds: ["P1.1"],
					addressAdditions: [{ workItemId: "W2", findingIds: ["P1.1"] }],
				},
			});
			expect(
				binding.ledger.workItems.map((item) => [item.id, item.addresses]),
			).toEqual([
				["W1", []],
				["W2", ["P1.1"]],
			]);
			expect(sourceJournal(ctx.recordStore)).toEqual(sealedJournal);
			expect(ctx.store.listPlanApprovalFinalizations(SOURCE)).toEqual([]);
			expect(ctx.recordStore.getRun(SOURCE)?.status).toBe("completed");
			ctx.store.saveImplementationReviewContext(
				{
					kind: "implementation-review-context",
					version: 1,
					id: "ctx-1",
					executionRunId: RUN,
					bindingId: binding.id,
					phase: "1",
					baseCommit: diff.baseCommit,
					reviewedCommit: diff.reviewedCommit,
					patchHash: diff.patchHash,
					excludedPaths: [...diff.excludedPaths],
					hunks: [],
					binaryPaths: [],
					createdAt: "2026-11-05 11:00:00",
				},
				TEST_ORIGIN,
			);

			// 2. Older-CLI gate-less observation plus manual marker drift.
			appendHistoricalGateless(ctx, binding.id);
			expect(
				deriveOpenImplementationGate(ctx.recordStore, RUN, "1"),
			).toBeNull();
			const manual = SEALED.replace(
				"- Add the preview type",
				"- [x] Add the preview type",
			).replace("- Map API fields", "- [ ] Map API fields");
			writeFileSync(planFile, manual);
			const drifted = await admit(manual);
			expect(drifted.status).toBe("error");
			if (drifted.status === "error") {
				expect(drifted.code).toBe("IMPLEMENTATION_PLAN_DRIFT");
				expect(drifted.message).toContain(
					`5x plan repair-checklists --run ${RUN} --dry-run`,
				);
			}
			const shownDrifted = await showReviewGate(
				RUN,
				{ context: ctx, promptStore },
				{ phase: "1" },
			);
			if (
				shownDrifted.open ||
				!("inconsistency" in shownDrifted) ||
				!shownDrifted.inconsistency
			)
				throw new Error("expected a gate-less inconsistency");
			expect(shownDrifted.inconsistency).toMatchObject({
				code: GATELESS_HUMAN_GATE,
				recordId: "obs-historical",
				planDrifted: true,
			});
			// Repair drift first, then the corrected review on the same run.
			expect(shownDrifted.inconsistency.next[0]).toBe(
				`5x plan repair-checklists --run ${RUN} --dry-run`,
			);
			expect(shownDrifted.inconsistency.next.join("\n")).toContain(
				`--run ${RUN}`,
			);
			expect(governanceState(true).gatelessHumanGate).toMatchObject({
				code: GATELESS_HUMAN_GATE,
				planDrifted: true,
			});
			expect(promptStore.listOpenPrompts(RUN)).toHaveLength(0);

			// 3. One operator instruction: preview, then apply on the same run.
			const deps = repairDeps(ctx.recordStore, ctx.store);
			const revisionBefore = ctx.store.readEffectiveImplementationRevision(RUN);
			const stepsBeforeRepair = stepNames(ctx.recordStore, RUN);
			const preview = await repairChecklistsForRun(
				{ runId: RUN, dryRun: true },
				deps,
			);
			expect(preview.recorded).toBe(false);
			expect(readFile()).toBe(manual);
			expect(
				(
					(preview as { resetChecked?: Array<{ repaired: string }> })
						.resetChecked ?? []
				).map((entry) => entry.repaired),
			).toEqual(["- [ ] Add the preview type"]);
			const applied = await repairChecklistsForRun(
				{
					runId: RUN,
					apply: true,
					reason: REASON,
					intent: preview.intentDigest,
				},
				deps,
			);
			expect(applied.created).toBe(true);
			expect(applied.completionAuthorized).toBe(false);
			expect(commitCalls).toBe(1);
			const repaired = readFile();
			expect(repaired).toContain(
				"- [ ] Add the preview type\n  - include the member tier",
			);
			expect(repaired).toContain("- [ ] Map API fields");
			expect(repaired).toContain("- [ ] Render the modal");
			expect(repaired).toContain(
				"| W2 | Modal | 1 | 0 | - | P1.1 | Required |",
			);
			const receipts = ctx.store.listPlanChecklistRepairs(RUN);
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({
				subject: "execution",
				bindingId: binding.id,
				beforeCommit: AUTHOR_HEAD,
				reason: REASON,
			});
			expect(stepNames(ctx.recordStore, RUN)).toEqual([
				...stepsBeforeRepair,
				"checklist-repair",
			]);
			// Binding, source, approval and ledger are unchanged.
			expect(ctx.store.getImplementationBinding(RUN)).toEqual(binding);
			expect(sourceJournal(ctx.recordStore)).toEqual(sealedJournal);
			const revisionAfter = ctx.store.readEffectiveImplementationRevision(RUN);
			if (!revisionBefore?.ok || !revisionAfter?.ok)
				throw new Error("lineage fold failed");
			expect(revisionAfter.currentRevisionId).toBe(
				revisionBefore.currentRevisionId,
			);
			expect(revisionAfter.evidence).toEqual(revisionBefore.evidence);
			expect(revisionAfter.findings).toEqual(revisionBefore.findings);
			expect(revisionAfter.approvedPlanBytes).toBe(repaired);

			// Inspection after the repair: no drift, corrected review is next.
			const shownRepaired = await showReviewGate(
				RUN,
				{ context: ctx, promptStore },
				{ phase: "1" },
			);
			if (
				shownRepaired.open ||
				!("inconsistency" in shownRepaired) ||
				!shownRepaired.inconsistency
			)
				throw new Error("the gate-less routing persists until a new review");
			expect(shownRepaired.inconsistency.planDrifted).toBe(false);
			expect(shownRepaired.inconsistency.next[0]).toContain(
				`5x template render reviewer-commit --run ${RUN} --var phase_number=1`,
			);
			expect(shownRepaired.inconsistency.next.join("\n")).toContain(
				"--iteration 2",
			);

			// 4. Empty unexplained negative verdict: correctable, nothing appended.
			const linesBefore = {
				steps: ctx.recordStore.listLines(RUN, "steps").length,
				budget: ctx.recordStore.listLines(RUN, "budget").length,
				decisions: ctx.recordStore.listLines(RUN, "decisions").length,
			};
			const empty = await recordReview(
				{ readiness: "not_ready", items: [] },
				2,
			);
			expect(empty).toMatchObject({
				status: "error",
				code: "INVALID_STRUCTURED_OUTPUT",
				detail: {
					reason: "UNEXPLAINED_NEGATIVE_VERDICT",
					recorded: false,
					runPreserved: true,
				},
			});
			expect({
				steps: ctx.recordStore.listLines(RUN, "steps").length,
				budget: ctx.recordStore.listLines(RUN, "budget").length,
				decisions: ctx.recordStore.listLines(RUN, "decisions").length,
			}).toEqual(linesBefore);
			expect(
				deriveOpenImplementationGate(ctx.recordStore, RUN, "1"),
			).toBeNull();
			expect(ctx.store.listImplementationReviews(RUN)).toHaveLength(1);

			// 5. The corrected response supersedes the gate-less routing.
			const corrected = await recordReview(
				{ readiness: "ready", items: [] },
				2,
			);
			if (corrected.status !== "recorded")
				throw new Error(JSON.stringify(corrected));
			expect(corrected.written.observation?.route).toBe("complete");
			expect(corrected.written.completionAuthorized).toBe(true);
			expect(
				deriveGatelessImplementationObservation(ctx.recordStore, RUN, "1"),
			).toBeNull();
			const observations = ctx.store.listImplementationReviews(RUN);
			expect(observations.map((entry) => [entry.id, entry.route])).toEqual([
				["obs-historical", "human_gate"],
				[expect.any(String), "complete"],
			]);
			expect(governanceState(false).gatelessHumanGate).toBeUndefined();

			// The author checks the new boxes against that evidence; admission resumes.
			const checked = repaired
				.replace("- [ ] Add the preview type", "- [x] Add the preview type")
				.replace("- [ ] Map API fields", "- [x] Map API fields");
			writeFileSync(planFile, checked);
			const resumed = await admit(checked);
			if (resumed.status !== "bound") throw new Error(JSON.stringify(resumed));
			expect(resumed.binding).toEqual(binding);

			// Invocation counts: one historical plus one corrective review; the
			// repair and finalization added no reviewer or quality step.
			const execSteps = stepNames(ctx.recordStore, RUN);
			expect(execSteps.filter((name) => name.startsWith("reviewer:"))).toEqual([
				"reviewer:commit",
				"reviewer:commit",
			]);
			expect(execSteps.filter((name) => name.startsWith("quality"))).toEqual(
				[],
			);
			expect(
				stepNames(ctx.recordStore, SOURCE).filter((name) =>
					name.startsWith("reviewer:"),
				),
			).toEqual(["reviewer:plan"]);
			expect(
				ctx.recordStore
					.listLines(RUN, "budget")
					.filter(
						(line) =>
							(line.payload as { kind?: string }).kind ===
							"implementation-binding",
					),
			).toHaveLength(1);

			// 6. Restart from the journals alone.
			const snapshotOf = (recordStore: RecordStore, store: Ctx["store"]) => {
				const revision = store.readEffectiveImplementationRevision(RUN);
				if (!revision?.ok) throw new Error("lineage fold failed");
				return {
					binding: store.getImplementationBinding(RUN),
					revisionId: revision.currentRevisionId,
					approvedPlanBytes: revision.approvedPlanBytes,
					evidence: revision.evidence,
					findings: revision.findings,
					receipts: store.listPlanChecklistRepairs(RUN),
					finalizations: store.listPlanApprovalFinalizations(SOURCE),
					routes: store
						.listImplementationReviews(RUN)
						.map((entry) => [entry.id, entry.route]),
					gateless: deriveGatelessImplementationObservation(
						recordStore,
						RUN,
						"1",
					),
					openGate: deriveOpenImplementationGate(recordStore, RUN, "1"),
					steps: stepNames(recordStore, RUN),
				};
			};
			const before = snapshotOf(ctx.recordStore, ctx.store);
			const restarted = restartFromJournals(ctx.recordStore);
			const freshDb = new Database(":memory:");
			try {
				runMigrations(freshDb);
				const index = createReviewBudgetIndex(freshDb);
				for (const runId of [SOURCE, RUN])
					reindexReviewBudget(restarted, index, runId);
				expect(reindexReviewGovernance(restarted, freshDb).diagnostics).toEqual(
					[],
				);
				const openIndexed = freshDb
					.query(
						"SELECT gate_id FROM review_gate_index WHERE run_id = ? AND resolved_decision_id IS NULL",
					)
					.all(RUN);
				expect(openIndexed).toEqual([]);
				const freshStore = createReviewBudgetStore(restarted, index);
				expect(snapshotOf(restarted, freshStore)).toEqual(before);

				// Idempotent retries after restart: no duplicate records.
				const counts = () => ({
					steps: restarted.listLines(RUN, "steps").length,
					budget: restarted.listLines(RUN, "budget").length,
				});
				const settled = counts();
				const readmitted = await admit(checked, freshStore, restarted);
				if (readmitted.status !== "bound")
					throw new Error(JSON.stringify(readmitted));
				expect(readmitted.binding).toEqual(binding);
				writeFileSync(planFile, repaired);
				const retry = await repairChecklistsForRun(
					{ runId: RUN, apply: true, reason: REASON },
					repairDeps(restarted, freshStore),
				);
				expect(retry.created).toBe(false);
				expect(commitCalls).toBe(1);
				expect(counts()).toEqual(settled);
				expect(freshStore.listPlanChecklistRepairs(RUN)).toHaveLength(1);
				expect(sourceJournal(restarted)).toEqual(sealedJournal);
			} finally {
				freshDb.close();
			}
		} finally {
			ctx.db.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
