import { describe, expect, test } from "bun:test";
import {
	addedPathsFromCodeContext,
	composeImplementationReviewerRecord,
	type PendingImplementationObservation,
	recordImplementationReviewerStepWithObservation,
} from "../../../src/commands/implementation-review-context.js";
import { createMemoryRecordStore } from "../../../src/control-plane/record-memory.js";
import {
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
} from "../../../src/control-plane/record-types.js";
import {
	createReviewBudgetIndex,
	reindexReviewBudget,
} from "../../../src/control-plane/review-budget-index.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import { deriveBudget } from "../../../src/review-budget/arithmetic.js";
import {
	decodeImplementationReviewObservationPayload,
	type ImplementationBindingPayload,
	type ImplementationReviewContextPayload,
	implementationCreditReconciliationKey,
	implementationReviewObservationKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import type { CodeDiffContext } from "../../../src/review-governance/code-diff.js";
import { createImplementationDecision } from "../../../src/review-governance/decisions.js";
import {
	hashPlanBytes,
	recordCorrectionAttempt,
} from "../../../src/review-governance/implementation-state.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

const PHASE = "1";
const STEP = "reviewer:review";

const diff: CodeDiffContext = {
	baseCommit: "a".repeat(40),
	reviewedCommit: "b".repeat(40),
	patch: "patch",
	patchHash: "sha256:patch",
	excludedPaths: ["docs/development/reviews"],
	hunks: [
		{
			oldPath: "/dev/null",
			newPath: "src/new.ts",
			header: "@@ -0,0 +1 @@",
			text: "diff --git a/src/new.ts b/src/new.ts\n",
			hash: "h1",
		},
		{
			oldPath: "/dev/null",
			newPath: ".5x/records/x.jsonl",
			header: "@@ -0,0 +1 @@",
			text: "diff --git a/.5x/records/x.jsonl b/.5x/records/x.jsonl\n",
			hash: "h2",
		},
		{
			oldPath: "/dev/null",
			newPath: "docs/development/reviews/note.md",
			header: "@@ -0,0 +1 @@",
			text: "diff --git a/docs/development/reviews/note.md b/docs/development/reviews/note.md\n",
			hash: "h3",
		},
		{
			oldPath: "src/old.ts",
			newPath: "src/old.ts",
			header: "@@ -1 +1 @@",
			text: "diff --git a/src/old.ts b/src/old.ts\n@@ -1 +1 @@\n-old\n+new\n",
			hash: "h4",
		},
	],
	binaryPaths: [],
};

function binding(input?: {
	effort?: 1 | 2 | 3 | 5 | 8;
	governingB?: number;
	mode?: "advisory" | "enforced";
}): ImplementationBindingPayload {
	const effort = input?.effort ?? 2;
	const governingB = input?.governingB ?? effort;
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: "run1",
		sourceRunId: "source",
		sourceSnapshotId: "snap",
		sourceBaselineId: "base",
		approvedPlanCommit: "c".repeat(40),
		approvedPlanHash: "sha256:plan",
		approvedPlanBytes: "# Plan\n",
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
					architectureDelta: 0,
					debtClaim: {
						debtClaimId: "DC0",
						coupling: "intrinsic",
						targetPhase: "1",
						minimalAlternativeEffortDelta: 0,
						minimalAlternativeArchitectureDelta: -1,
						before: "two stores",
						after: "one binding",
					},
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
		phaseMap: [{ id: "1", heading: "Phase 1" }],
		debtTargets: [],
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
		executionRunId: "run1",
		bindingId: "binding-1",
		phase: PHASE,
		baseCommit: diff.baseCommit,
		reviewedCommit: diff.reviewedCommit,
		patchHash: diff.patchHash,
		excludedPaths: [...diff.excludedPaths],
		hunks: diff.hunks.map((hunk) => ({ ...hunk })),
		binaryPaths: [],
		createdAt: "2026-01-01 00:00:00",
	};
}

function defectVerdict() {
	return {
		readiness: "not_ready" as const,
		items: [
			{
				id: "I1",
				title: "Wrong status",
				action: "auto_fix" as const,
				reason: "The write failure is ignored.",
				priority: "P1" as const,
				scopeClass: "implementation_defect" as const,
				effortDelta: 3,
				architectureDelta: 4,
				planWorkItemIds: ["W1"],
				introducedBy: {
					commitRange: `${"a".repeat(40)}..${"b".repeat(40)}`,
					diffHunk:
						"diff --git a/src/old.ts b/src/old.ts\n@@ -1 +1 @@\n-old\n+new\n",
					explanation: "The status write ignores the failure.",
				},
			},
		],
		creditRealizations: [],
	};
}

function readyVerdict() {
	return {
		readiness: "ready" as const,
		items: [],
		nonblocking: [
			{
				id: "n1",
				title: "Old note",
				reason: "Left from before.",
				scopeClass: "pre_existing" as const,
			},
		],
	};
}

function inheritedBudget(seed: ImplementationBindingPayload) {
	return deriveBudget({
		B0: seed.b0,
		B: seed.governingB,
		I: null,
		workItems: seed.ledger.workItems,
		findings: [],
		assessments: [],
		config: seed.thresholds,
		semanticHumanRequired: false,
	});
}

function seed(
	ctx: ReturnType<typeof makeBudgetContext>,
	seedBinding: ImplementationBindingPayload,
) {
	ctx.store.saveImplementationBinding(seedBinding, TEST_ORIGIN);
	ctx.store.saveImplementationReviewContext(contextPayload(), TEST_ORIGIN);
}

function recordParams(verdict: unknown, iteration?: number) {
	return {
		run: "run1",
		stepName: STEP,
		result: JSON.stringify(verdict),
		phase: PHASE,
		iteration,
		performer: {
			kind: "agent" as const,
			role: "reviewer",
			provider: "cursor",
		},
	};
}

async function composeDefect(
	ctx: ReturnType<typeof makeBudgetContext>,
	sessionId?: string,
) {
	const verdict = defectVerdict();
	const composed = await composeImplementationReviewerRecord({
		ctx,
		runId: "run1",
		stepName: STEP,
		phase: PHASE,
		iteration: 1,
		verdict,
		contextId: "ctx-1",
		codeContext: diff,
		sessionId,
	});
	if (composed.status !== "applied") {
		throw new Error(
			composed.status === "error"
				? `${composed.code}: ${composed.message}`
				: composed.status,
		);
	}
	return { verdict, pending: composed.pending };
}

function appendStep(
	ctx: ReturnType<typeof makeBudgetContext>,
	stepName: string,
	iteration: number,
	head: string | null,
) {
	ctx.recordStore.append({
		runId: "run1",
		stream: "steps",
		idempotencyKey: `step:run1:${stepName}:${PHASE}:${iteration}`,
		payload: {
			step_name: stepName,
			phase: PHASE,
			iteration,
			result_json: {},
			head_commit: head,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		createdAt: "2026-01-01 00:00:00",
		...recordedEnvelope(TEST_ORIGIN),
	});
}

describe("implementation review observations", () => {
	test("ordinary defects route to author revision and variance does not move W/R/B/D", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const seedBinding = binding({ effort: 8, governingB: 1 });
		seed(ctx, seedBinding);
		appendStep(ctx, "author:impl", 1, "author-commit");
		appendStep(ctx, "reviewer:earlier", 1, "review-commit");
		appendStep(ctx, "author:impl", 2, "author-fix");
		appendStep(ctx, "quality:check", 1, null);
		appendStep(ctx, "quality:check", 2, null);
		const before = inheritedBudget(seedBinding);
		let snapshotCalls = 0;
		const appendSnapshot = ctx.store.appendSnapshot.bind(ctx.store);
		ctx.store.appendSnapshot = (input) => {
			snapshotCalls += 1;
			return appendSnapshot(input);
		};
		const protocol = await composeDefect(ctx, "protocol-session");
		const invoke = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: PHASE,
			iteration: 1,
			verdict: defectVerdict(),
			contextId: "ctx-1",
			codeContext: diff,
			sessionId: "invoke-session",
		});
		expect(invoke.status).toBe("applied");
		if (invoke.status !== "applied") return;
		expect(protocol.pending.route).toBe(invoke.pending.route);
		expect(protocol.pending.nextAction).toBe(invoke.pending.nextAction);
		expect(protocol.pending.telemetry).toEqual(invoke.pending.telemetry);
		expect(protocol.pending.gateCauses).toEqual(invoke.pending.gateCauses);
		expect(protocol.pending.budgetInvariant).toEqual(
			invoke.pending.budgetInvariant,
		);
		expect(protocol.pending.completionAuthorized).toBe(false);
		expect(protocol.pending.route).toBe("author_revision");
		expect(protocol.pending.nextAction).toBe("author_revision");
		expect(protocol.pending.domain).toBe("implementation");
		expect(protocol.pending.phase).toBe("1");
		expect(protocol.pending.originalVerdict.items[0]?.id).toBe("I1");
		expect(protocol.pending.claimObservations).toEqual([]);
		expect(
			protocol.pending.gateCauses.some(
				(cause) => cause.kind === "inherited_budget",
			),
		).toBe(true);
		expect(protocol.pending.telemetry.addedPaths).toEqual(["src/new.ts"]);
		expect(protocol.pending.telemetry.boundaryInventory).toEqual([
			{ itemId: "I1", changes: [], unknown: true },
		]);
		expect(protocol.pending.telemetry.classCounts.implementation_defect).toBe(
			1,
		);
		expect(protocol.pending.telemetry.effortVariance).toBe(3);
		expect(protocol.pending.telemetry.architectureVariance).toBe(4);
		expect(protocol.pending.telemetry.reviewCycles).toBe(2);
		expect(protocol.pending.telemetry.fixCycles).toBe(1);
		expect(protocol.pending.telemetry.reviewOriginatedCommits).toBe(1);
		expect(protocol.pending.telemetry.qualityReruns).toBe(1);
		expect(protocol.pending.budgetInvariant).toEqual({
			W: before.W,
			R: before.R,
			B: before.B,
			D: before.D,
		});
		expect(before.D).toBe(0);
		expect(before.R).toBe(0);

		const written = await recordImplementationReviewerStepWithObservation(
			recordParams(protocol.verdict, 1),
			protocol.pending,
			ctx,
		);
		expect(written.recorded).toBe(true);
		expect(written.completionAuthorized).toBe(false);
		expect(protocol.pending.completionAuthorized).toBe(false);
		expect(written.observation?.route).toBe("author_revision");
		expect(ctx.store.listSnapshots("run1")).toEqual([]);
		expect(ctx.store.getBaseline("run1")).toBeNull();
		expect(snapshotCalls).toBe(0);
		const after = inheritedBudget(seedBinding);
		expect({ W: after.W, R: after.R, B: after.B, D: after.D }).toEqual({
			W: before.W,
			R: before.R,
			B: before.B,
			D: before.D,
		});
		const stored = ctx.store.listImplementationReviews("run1");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.kind).toBe("implementation-review");
		const raw = ctx.recordStore
			.listLines("run1", "budget")
			.find(
				(line) =>
					(line.payload as { kind?: string }).kind === "implementation-review",
			);
		expect(raw).toBeDefined();
		const withFindings = {
			...(raw?.payload as Record<string, unknown>),
			findings: [{ id: "I1", effortDelta: 3 }],
		};
		expect(() =>
			decodeImplementationReviewObservationPayload(withFindings),
		).toThrow(/unknown field 'findings'/);
		ctx.db.close();
	});

	test("a clean complete route is authorized only after the durable write", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const seedBinding = binding({ effort: 2 });
		seed(ctx, seedBinding);
		const composed = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: PHASE,
			iteration: 1,
			verdict: readyVerdict(),
			contextId: "ctx-1",
			codeContext: diff,
		});
		expect(composed.status).toBe("applied");
		if (composed.status !== "applied") return;
		expect(composed.pending.route).toBe("complete");
		expect(composed.pending.completionAuthorized).toBe(false);
		expect(composed.pending.gateCauses).toEqual([]);

		let authorizedAtAppend: boolean | undefined;
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			const budget = ops[1]?.payload as { completionAuthorized?: boolean };
			authorizedAtAppend = budget.completionAuthorized;
			throw new Error("injected append failure");
		};
		await expect(
			recordImplementationReviewerStepWithObservation(
				recordParams(readyVerdict(), 1),
				composed.pending,
				ctx,
			),
		).rejects.toThrow("injected append failure");
		expect(authorizedAtAppend).toBe(true);
		expect(composed.pending.completionAuthorized).toBe(false);
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(0);
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(0);

		ctx.recordStore.atomicAppendIfAllNew = original;
		const written = await recordImplementationReviewerStepWithObservation(
			recordParams(readyVerdict(), 1),
			composed.pending,
			ctx,
		);
		expect(written.completionAuthorized).toBe(true);
		expect(written.observation?.completionAuthorized).toBe(true);
		expect(composed.pending.completionAuthorized).toBe(false);
		ctx.db.close();
	});

	test("a complete route with inherited budget becomes a human gate", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		const composed = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: PHASE,
			iteration: 1,
			verdict: readyVerdict(),
			contextId: "ctx-1",
			codeContext: diff,
		});
		expect(composed.status).toBe("applied");
		if (composed.status !== "applied") return;
		expect(composed.pending.route).toBe("human_gate");
		expect(composed.pending.nextAction).toBe("human_gate");
		expect(
			composed.pending.gateCauses.some(
				(cause) => cause.kind === "inherited_budget",
			),
		).toBe(true);
		expect(composed.pending.completionAuthorized).toBe(false);
		const written = await recordImplementationReviewerStepWithObservation(
			recordParams(readyVerdict(), 1),
			composed.pending,
			ctx,
		);
		expect(written.observation?.route).toBe("human_gate");
		expect(written.observation?.nextAction).toBe("human_gate");
		expect(written.completionAuthorized).toBe(false);
		ctx.db.close();
	});

	test("duplicate explicit iteration returns the stored winner", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		const { verdict, pending } = await composeDefect(ctx);
		await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			pending,
			ctx,
		);
		const rival: PendingImplementationObservation = {
			...pending,
			id: "rival-observation",
			route: "complete",
			nextAction: "complete",
			gateCauses: [],
		};
		const retry = await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			rival,
			ctx,
		);
		expect(retry.recorded).toBe(false);
		expect(retry.observation?.id).toBe(pending.id);
		expect(retry.observation?.route).toBe("author_revision");
		expect(retry.completionAuthorized).toBe(false);
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(1);
		expect(
			ctx.store.listImplementationReviews("run1")[0]?.telemetry.classCounts
				.implementation_defect,
		).toBe(1);
		ctx.db.close();
	});

	test("omitted iteration allocates the next review and a lost race does not attach to the winner", async () => {
		const ctx = makeBudgetContext();
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		const { verdict, pending } = await composeDefect(ctx);
		const omitted = recordParams(verdict);
		const first = await recordImplementationReviewerStepWithObservation(
			omitted,
			pending,
			ctx,
		);
		const secondPending = {
			...pending,
			id: "second-observation",
		};
		const second = await recordImplementationReviewerStepWithObservation(
			omitted,
			secondPending,
			ctx,
		);
		expect([first.iteration, second.iteration]).toEqual([1, 2]);
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(2);

		const raced = makeBudgetContext();
		seed(raced, binding({ effort: 8 }));
		const racedCompose = await composeDefect(raced);
		const original = raced.recordStore.atomicAppendIfAllNew.bind(
			raced.recordStore,
		);
		let racedOnce = false;
		raced.recordStore.atomicAppendIfAllNew = (ops) => {
			if (!racedOnce) {
				racedOnce = true;
				const step = ops[0];
				if (!step) throw new Error("missing step op");
				raced.recordStore.append({
					...step,
					payload: {
						...(step.payload as object),
						result_json: { winner: true },
					},
				});
			}
			return original(ops);
		};
		const result = await recordImplementationReviewerStepWithObservation(
			recordParams(racedCompose.verdict),
			racedCompose.pending,
			raced,
		);
		expect(result.iteration).toBe(2);
		expect(
			raced.recordStore.getLine(
				"run1",
				"budget",
				implementationReviewObservationKey("run1", {
					stepName: STEP,
					phase: PHASE,
					iteration: 1,
				}),
			),
		).toBeNull();
		expect(raced.store.listImplementationReviews("run1")).toHaveLength(1);
		ctx.db.close();
		raced.db.close();
	});

	test("coupled-key corruption does not publish a computed route", async () => {
		const ctx = makeBudgetContext();
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		const { verdict, pending } = await composeDefect(ctx);
		ctx.recordStore.append({
			runId: "run1",
			stream: "budget",
			idempotencyKey: implementationReviewObservationKey("run1", {
				stepName: STEP,
				phase: PHASE,
				iteration: 1,
			}),
			payload: { kind: "implementation-review", orphan: true },
			createdAt: "2026-01-01 00:00:00",
			...recordedEnvelope(TEST_ORIGIN),
		});
		await expect(
			recordImplementationReviewerStepWithObservation(
				recordParams(verdict, 1),
				pending,
				ctx,
			),
		).rejects.toMatchObject({ code: "RECORD_PAIR_CORRUPT" });
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(0);
		ctx.db.close();
	});

	test("a new step at the ceiling performs no append", async () => {
		const ctx = makeBudgetContext({ maxSteps: 1 });
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		ctx.db.run(
			"INSERT INTO steps(run_id, step_name, phase, iteration, result_json) VALUES ('run1','old','1',1,'{}')",
		);
		const { verdict, pending } = await composeDefect(ctx);
		let calls = 0;
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			calls += 1;
			return original(ops);
		};
		await expect(
			recordImplementationReviewerStepWithObservation(
				recordParams(verdict, 1),
				pending,
				ctx,
			),
		).rejects.toMatchObject({ code: "MAX_STEPS_EXCEEDED" });
		expect(calls).toBe(0);
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(0);
		ctx.db.close();
	});

	test("failed unique append leaves no step or observation", async () => {
		const ctx = makeBudgetContext();
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		const { verdict, pending } = await composeDefect(ctx);
		ctx.recordStore.atomicAppendIfAllNew = () => {
			throw new Error("injected append failure");
		};
		await expect(
			recordImplementationReviewerStepWithObservation(
				recordParams(verdict, 1),
				pending,
				ctx,
			),
		).rejects.toThrow("injected append failure");
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(0);
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(0);
		ctx.db.close();
	});

	test("interrupted projection repair and a fresh clone do not double-count", async () => {
		const ctx = makeBudgetContext();
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		const { verdict, pending } = await composeDefect(ctx);
		const project = ctx.store.projectImplementationReview.bind(ctx.store);
		let fail = true;
		ctx.store.projectImplementationReview = (runId, key) => {
			if (fail) {
				fail = false;
				throw new Error("injected index failure");
			}
			return project(runId, key);
		};
		await expect(
			recordImplementationReviewerStepWithObservation(
				recordParams(verdict, 1),
				pending,
				ctx,
			),
		).rejects.toThrow("injected index failure");
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(1);
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(1);
		ctx.db.run("DELETE FROM steps");
		const retry = await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			pending,
			ctx,
		);
		expect(retry.recorded).toBe(false);
		expect(retry.observation?.id).toBe(pending.id);
		expect(ctx.db.query("SELECT count(*) AS n FROM steps").get()).toEqual({
			n: 1,
		});
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(1);

		const clone = createMemoryRecordStore();
		clone.putRun({
			id: "run1",
			plan_path: "/tmp/plan.md",
			config_json: null,
			created_at: "2026-01-01 00:00:00",
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: "test",
			format_version: RUN_RECORD_FORMAT_VERSION,
			creator: TEST_ORIGIN.recorder,
		});
		for (const line of ctx.recordStore.listLines("run1", "budget")) {
			clone.append(line);
		}
		const fresh = createReviewBudgetStore(clone);
		expect(fresh.listImplementationReviews("run1")).toHaveLength(1);
		expect(fresh.listImplementationReviews("run1")[0]?.id).toBe(pending.id);
		expect(fresh.listSnapshots("run1")).toEqual([]);
		expect(fresh.getBaseline("run1")).toBeNull();
		const index = createReviewBudgetIndex(ctx.db);
		reindexReviewBudget(ctx.recordStore, index, "run1");
		expect(index.listSnapshots("run1")).toEqual([]);
		ctx.db.close();
	});

	test("redacted origin is shared by the step and the observation", async () => {
		const redacted = {
			recorder: { installation_id: TEST_ORIGIN.recorder.installation_id },
			performer: {
				kind: "agent" as const,
				role: "reviewer",
				provider: "cursor",
			},
		};
		const ctx = makeBudgetContext({ originFor: () => redacted });
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		const { verdict, pending } = await composeDefect(ctx);
		await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			pending,
			ctx,
		);
		const observationKey = implementationReviewObservationKey("run1", {
			stepName: STEP,
			phase: PHASE,
			iteration: 1,
		});
		const lines = [
			...ctx.recordStore.listLines("run1", "steps"),
			ctx.recordStore.getLine("run1", "budget", observationKey),
		];
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line?.origin).toEqual(redacted);
			expect(line?.origin?.recorder.actor).toBeUndefined();
		}
		ctx.db.close();
	});

	test("empty and binary additions come from patch headers", () => {
		const patch = [
			"diff --git a/src/empty.ts b/src/empty.ts",
			"new file mode 100644",
			"index 0000000..e69de29",
			"--- /dev/null",
			"+++ b/src/empty.ts",
			"diff --git a/assets/logo.bin b/assets/logo.bin",
			"new file mode 100644",
			"index 0000000..abc123",
			"GIT binary patch",
			"literal 0",
			"diff --git a/assets/old.bin b/assets/old.bin",
			"index 1111111..2222222",
			"GIT binary patch",
			"literal 0",
			"diff --git a/.5x/cache.bin b/.5x/cache.bin",
			"new file mode 100644",
			"index 0000000..abc123",
			"Binary files /dev/null and b/.5x/cache.bin differ",
			"",
		].join("\n");
		expect(
			addedPathsFromCodeContext({
				...diff,
				patch,
				hunks: [],
				binaryPaths: ["assets/logo.bin", "assets/old.bin", ".5x/cache.bin"],
			}),
		).toEqual(["assets/logo.bin", "src/empty.ts"]);
	});

	test("a duplicate step without its observation is corrupt in enforced mode", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		seed(ctx, binding({ effort: 8, governingB: 1 }));
		const { verdict, pending } = await composeDefect(ctx);
		appendStep(ctx, STEP, 1, null);
		await expect(
			recordImplementationReviewerStepWithObservation(
				recordParams(verdict, 1),
				pending,
				ctx,
			),
		).rejects.toMatchObject({ code: "RECORD_PAIR_CORRUPT" });
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(0);
		ctx.db.close();
	});

	test("plan amendments are phase-scoped and unique by finding fingerprint", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		seed(ctx, binding());
		const planDefect = {
			readiness: "not_ready" as const,
			items: [
				{
					id: "P1",
					title: "The bug requires a new store",
					action: "auto_fix" as const,
					reason: "The approved design cannot represent this write.",
					priority: "P1" as const,
					scopeClass: "plan_defect" as const,
					effortDelta: 1,
					architectureDelta: 0,
					planImpact: { kind: "design" as const, locations: [] },
				},
			],
		};
		const first = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: PHASE,
			iteration: 1,
			verdict: planDefect,
			contextId: "ctx-1",
			codeContext: diff,
		});
		expect(first.status).toBe("applied");
		if (first.status !== "applied") return;
		expect(first.pending.telemetry.planAmendments).toBe(1);
		expect(first.pending.route).toBe("human_gate");
		ctx.recordStore.append({
			runId: "run1",
			stream: "budget",
			idempotencyKey: implementationReviewObservationKey("run1", {
				stepName: STEP,
				phase: PHASE,
				iteration: 1,
			}),
			payload: {
				...first.pending,
				completionAuthorized: false,
				createdAt: "2026-01-01 00:00:00",
			},
			createdAt: "2026-01-01 00:00:00",
			...recordedEnvelope(TEST_ORIGIN),
		});
		ctx.store.saveImplementationTextAmendment(
			{
				kind: "implementation-text-amendment",
				version: 1,
				id: "amend-phase",
				bindingId: "binding-1",
				executionRunId: "run1",
				guardId: "guard-1",
				sourceObservationId: first.pending.id,
				parentLineageId: null,
				beforeCommit: "a".repeat(40),
				afterCommit: "b".repeat(40),
				beforeBlobHash: "sha256:before",
				afterBlobHash: "sha256:after",
				authorizedPlanBytes: "# Plan\n",
				createdAt: "2026-01-01 00:00:00",
			},
			TEST_ORIGIN,
		);
		ctx.store.saveImplementationTextAmendment(
			{
				kind: "implementation-text-amendment",
				version: 1,
				id: "amend-other-phase",
				bindingId: "binding-1",
				executionRunId: "run1",
				guardId: "guard-2",
				sourceObservationId: "other-phase-observation",
				parentLineageId: null,
				beforeCommit: "a".repeat(40),
				afterCommit: "c".repeat(40),
				beforeBlobHash: "sha256:before",
				afterBlobHash: "sha256:after2",
				authorizedPlanBytes: "# Plan\n",
				createdAt: "2026-01-01 00:00:01",
			},
			TEST_ORIGIN,
		);
		const second = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: PHASE,
			iteration: 2,
			verdict: planDefect,
			contextId: "ctx-1",
			codeContext: diff,
		});
		expect(second.status).toBe("applied");
		if (second.status !== "applied") return;
		expect(second.pending.telemetry.planAmendments).toBe(1);
		ctx.db.close();
	});

	test("a corrupt observation line is a typed compose error", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		seed(ctx, binding());
		ctx.recordStore.append({
			runId: "run1",
			stream: "budget",
			idempotencyKey: "budget:implementation-review:run1:corrupt",
			payload: {
				kind: "implementation-review",
				version: 99,
			},
			createdAt: "2026-01-01 00:00:00",
			...recordedEnvelope(TEST_ORIGIN),
		});
		const composed = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: PHASE,
			iteration: 1,
			verdict: readyVerdict(),
			contextId: "ctx-1",
			codeContext: diff,
		});
		expect(composed.status).toBe("error");
		if (composed.status !== "error") return;
		expect(composed.code).toBe("IMPLEMENTATION_REVIEW_RECORD_CORRUPT");
		ctx.db.close();
	});

	test("activity telemetry uses the canonical phase id", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		seed(ctx, binding());
		ctx.recordStore.append({
			runId: "run1",
			stream: "steps",
			idempotencyKey: "step:run1:reviewer:earlier:Phase 1:1",
			payload: {
				step_name: "reviewer:earlier",
				phase: "Phase 1",
				iteration: 1,
				result_json: {},
				head_commit: "review-commit",
				patch_id: null,
				diff_summary: null,
				duration_ms: null,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
				model: null,
			},
			createdAt: "2026-01-01 00:00:00",
			...recordedEnvelope(TEST_ORIGIN),
		});
		const composed = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "phase-1",
			iteration: 2,
			verdict: readyVerdict(),
			contextId: "ctx-1",
			codeContext: diff,
		});
		expect(composed.status).toBe("applied");
		if (composed.status !== "applied") return;
		expect(composed.pending.phase).toBe("1");
		expect(composed.pending.telemetry.reviewCycles).toBe(2);
		ctx.db.close();
	});

	test("snapshots a text guard and downgrades when the lineage cannot be verified", async () => {
		const markdown = `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Bind | 2 | 0 | - | - | Required |

## Design Decisions

Keep the approved ledger.

## Phase 1: Bind

Bind execution to the approved plan.

- [ ] Complete the phase

## Acceptance

The binding is unchanged.
`;
		const ctx = makeBudgetContext({ mode: "enforced" });
		const seedBinding = binding();
		seedBinding.approvedPlanBytes = markdown;
		seedBinding.approvedPlanHash = hashPlanBytes(markdown);
		seedBinding.phaseMap = [{ id: "1", heading: "Phase 1: Bind" }];
		seed(ctx, seedBinding);
		const verdict = {
			readiness: "not_ready" as const,
			items: [
				{
					id: "R1",
					title: "Stale wording",
					action: "auto_fix" as const,
					reason: "The sentence is stale.",
					scopeClass: "plan_defect" as const,
					priority: "P2" as const,
					effortDelta: 0,
					architectureDelta: 0,
					planImpact: {
						kind: "text_only" as const,
						locations: [
							{
								heading: "Phase 1: Bind",
								staleText: "Bind execution to the approved plan.",
							},
						],
					},
				},
			],
		};
		const composed = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: PHASE,
			iteration: 1,
			verdict,
			contextId: "ctx-1",
			codeContext: diff,
		});
		expect(composed.status).toBe("applied");
		if (composed.status !== "applied") return;
		expect(composed.pending.nextAction).toBe("author_revision");
		expect(composed.pending.textGuard?.allowedSpans).toHaveLength(1);
		const written = await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			composed.pending,
			ctx,
		);
		expect(written.observation?.textGuard?.id).toBe(
			composed.pending.textGuard?.id,
		);
		const broken = makeBudgetContext({ mode: "enforced" });
		const brokenBinding = binding();
		brokenBinding.approvedPlanBytes = markdown;
		brokenBinding.approvedPlanHash = hashPlanBytes(markdown);
		brokenBinding.phaseMap = [{ id: "1", heading: "Phase 1: Bind" }];
		seed(broken, brokenBinding);
		broken.store.saveImplementationTextAmendment(
			{
				kind: "implementation-text-amendment",
				version: 1,
				id: "amend-broken",
				bindingId: brokenBinding.id,
				executionRunId: "run1",
				guardId: "guard-old",
				sourceObservationId: "obs-old",
				parentLineageId: "missing",
				beforeCommit: "a".repeat(40),
				afterCommit: "b".repeat(40),
				beforeBlobHash: hashPlanBytes(markdown),
				afterBlobHash: hashPlanBytes(markdown),
				authorizedPlanBytes: markdown,
				createdAt: "2026-09-23 00:00:00",
			},
			TEST_ORIGIN,
		);
		const downgraded = await composeImplementationReviewerRecord({
			ctx: broken,
			runId: "run1",
			stepName: STEP,
			phase: PHASE,
			iteration: 1,
			verdict,
			contextId: "ctx-1",
			codeContext: diff,
		});
		expect(downgraded.status).toBe("applied");
		if (downgraded.status !== "applied") return;
		expect(downgraded.pending.route).toBe("human_gate");
		expect(downgraded.pending.nextAction).toBe("plan_amendment");
		expect(downgraded.pending.textGuard).toBeUndefined();
		ctx.db.close();
		broken.db.close();
	});
});

describe("implementation credit reconciliation composition", () => {
	const COMMIT = "b".repeat(40);
	const NEXT = "d".repeat(40);

	function creditBinding(mode: "advisory" | "enforced" = "enforced") {
		const seedBinding = binding({ mode });
		seedBinding.phaseMap = [
			{ id: "1", heading: "Phase 1" },
			{ id: "2", heading: "Phase 2" },
		];
		const item = seedBinding.ledger.workItems[0];
		if (!item) throw new Error("missing work item");
		item.architectureDelta = -3;
		item.debtClaim = {
			debtClaimId: "DC1",
			coupling: "intrinsic",
			targetPhase: "1",
			minimalAlternativeEffortDelta: 0,
			minimalAlternativeArchitectureDelta: 0,
			before: "two stores",
			after: "one binding",
		};
		seedBinding.debtTargets = [
			{ claimId: "DC1", sourceLabel: "1", phaseId: "1" },
		];
		return seedBinding;
	}

	function phaseContext(phase: string, commit: string, id: string) {
		return {
			...contextPayload(),
			id,
			phase,
			reviewedCommit: commit,
		};
	}

	function phaseDiff(commit: string): CodeDiffContext {
		return { ...diff, reviewedCommit: commit };
	}

	function realizedVerdict(commit: string) {
		return {
			readiness: "ready" as const,
			items: [],
			creditRealizations: [
				{
					creditClaimId: "DC1",
					realization: "realized" as const,
					realizedArchitectureDelta: -3,
					evidence: `Post-state at ${commit} matches the approved shape.`,
				},
			],
		};
	}

	test("composition persists reconciliation, downgrades completion, and matches invoke and protocol", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const seedBinding = creditBinding();
		ctx.store.saveImplementationBinding(seedBinding, TEST_ORIGIN);
		ctx.store.saveImplementationReviewContext(
			phaseContext("1", COMMIT, "ctx-1"),
			TEST_ORIGIN,
		);
		const verdict = realizedVerdict(COMMIT);
		const protocol = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 1,
			verdict,
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
			sessionId: "protocol-session",
		});
		const invoke = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 1,
			verdict,
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
			sessionId: "invoke-session",
		});
		expect(protocol.status).toBe("applied");
		expect(invoke.status).toBe("applied");
		if (protocol.status !== "applied" || invoke.status !== "applied") return;
		expect(protocol.reconciliation.claims).toEqual(
			invoke.reconciliation.claims,
		);
		expect(protocol.reconciliation.budget.realizedCredit).toBe(3);
		expect(protocol.pending.route).toBe(invoke.pending.route);
		expect(protocol.pending.route).toBe("complete");

		const written = await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			protocol.pending,
			ctx,
			protocol.reconciliation,
		);
		expect(written.recorded).toBe(true);
		const stepKey = { stepName: STEP, phase: "1", iteration: 1 };
		expect(
			ctx.recordStore.getLine(
				"run1",
				"budget",
				implementationReviewObservationKey("run1", stepKey),
			),
		).toBeDefined();
		expect(
			ctx.recordStore.getLine(
				"run1",
				"budget",
				implementationCreditReconciliationKey("run1", stepKey),
			),
		).toBeDefined();
		const replay = await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			invoke.pending,
			ctx,
			invoke.reconciliation,
		);
		expect(replay.recorded).toBe(false);
		expect(
			ctx.store.listImplementationCreditReconciliations("run1"),
		).toHaveLength(1);
		expect(ctx.store.listImplementationReviews("run1")).toHaveLength(1);

		const open = makeBudgetContext({ mode: "enforced" });
		open.store.saveImplementationBinding(creditBinding(), TEST_ORIGIN);
		open.store.saveImplementationReviewContext(
			phaseContext("1", COMMIT, "ctx-1"),
			TEST_ORIGIN,
		);
		const blocked = await composeImplementationReviewerRecord({
			ctx: open,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 2,
			verdict: readyVerdict(),
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(blocked.status).toBe("applied");
		if (blocked.status !== "applied") return;
		expect(blocked.pending.route).toBe("human_gate");
		expect(blocked.pending.gateCauses).toContainEqual({
			kind: "credit_unreconciled",
			claimIds: ["DC1"],
		});
		expect(
			await composeImplementationReviewerRecord({
				ctx: open,
				runId: "run1",
				stepName: STEP,
				phase: "1",
				iteration: 3,
				verdict: {
					readiness: "ready",
					items: [],
					creditRealizations: [
						{
							creditClaimId: "DC1",
							realization: "realized",
							realizedArchitectureDelta: -5,
							evidence: `Post-state at ${COMMIT} matches the approved shape.`,
						},
					],
				},
				contextId: "ctx-1",
				codeContext: phaseDiff(COMMIT),
			}),
		).toMatchObject({
			status: "error",
			code: "CREDIT_REALIZATION_INVALID",
		});
		ctx.db.close();
		open.db.close();
	});

	test("a settled phase-1 claim lets phase 2 complete", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		ctx.store.saveImplementationBinding(creditBinding(), TEST_ORIGIN);
		ctx.store.saveImplementationReviewContext(
			phaseContext("1", COMMIT, "ctx-1"),
			TEST_ORIGIN,
		);
		const verdict = realizedVerdict(COMMIT);
		const first = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 1,
			verdict,
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(first.status).toBe("applied");
		if (first.status !== "applied") return;
		await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			first.pending,
			ctx,
			first.reconciliation,
		);
		ctx.store.saveImplementationReviewContext(
			phaseContext("2", NEXT, "ctx-2"),
			TEST_ORIGIN,
		);
		const second = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "2",
			iteration: 1,
			verdict: readyVerdict(),
			contextId: "ctx-2",
			codeContext: phaseDiff(NEXT),
		});
		expect(second.status).toBe("applied");
		if (second.status !== "applied") return;
		expect(second.pending.route).toBe("complete");
		expect(
			second.pending.gateCauses.some(
				(cause) => cause.kind === "credit_unreconciled",
			),
		).toBe(false);
		expect(second.reconciliation.budget.realizedCredit).toBe(3);
		expect(second.reconciliation.claims[0]?.status).toBe("realized");
		ctx.db.close();
	});

	test("an eligible correction proof carries the same-phase claim", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		ctx.store.saveImplementationBinding(creditBinding(), TEST_ORIGIN);
		ctx.store.saveImplementationReviewContext(
			phaseContext("1", COMMIT, "ctx-1"),
			TEST_ORIGIN,
		);
		const verdict = realizedVerdict(COMMIT);
		const first = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 1,
			verdict,
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(first.status).toBe("applied");
		if (first.status !== "applied") return;
		await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			first.pending,
			ctx,
			first.reconciliation,
		);
		const carried = first.pending.claimObservations;
		recordCorrectionAttempt({
			store: ctx.store,
			origin: TEST_ORIGIN,
			payload: {
				kind: "implementation-correction-attempt",
				version: 1,
				id: "attempt-1",
				runId: "run1",
				observationId: first.pending.id,
				phase: "1",
				bindingId: "binding-1",
				authorCommit: NEXT,
				tree: "tree",
				qualityConfigDigest: "sha256:quality",
				executionDirectory: "/work",
				outcome: "passed",
				shortcutInvalidated: false,
				reason: "passed",
				qualityPassed: true,
				qualitySkipped: false,
				qualityTimedOut: false,
				qualityResults: [],
				architectureDelta: 0,
				boundaryChanges: [],
				changedPaths: ["src/fix.ts"],
				inventoryClean: true,
				boundaryUncertain: false,
				sourceObservationId: first.pending.id,
				assessedCommit: COMMIT,
				destinationCommit: NEXT,
				carriedClaims: carried,
				qualityRerun: 1,
				createdAt: "2026-09-24 00:00:01",
			},
		});
		ctx.store.saveImplementationReviewContext(
			phaseContext("1", NEXT, "ctx-next"),
			TEST_ORIGIN,
		);
		const second = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 2,
			verdict: readyVerdict(),
			contextId: "ctx-next",
			codeContext: phaseDiff(NEXT),
		});
		expect(second.status).toBe("applied");
		if (second.status !== "applied") return;
		expect(second.reconciliation.claims[0]).toMatchObject({
			status: "realized",
			carried: true,
			sourceObservationId: first.pending.id,
		});
		expect(second.pending.route).toBe("complete");
		ctx.db.close();
	});

	test("advisory evidence stays diagnostic and a binding waiver changes the envelope", async () => {
		const advisory = makeBudgetContext({ mode: "advisory" });
		advisory.store.saveImplementationBinding(
			creditBinding("advisory"),
			TEST_ORIGIN,
		);
		advisory.store.saveImplementationReviewContext(
			phaseContext("1", COMMIT, "ctx-1"),
			TEST_ORIGIN,
		);
		const missing = await composeImplementationReviewerRecord({
			ctx: advisory,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 1,
			verdict: {
				readiness: "ready",
				items: [],
				creditRealizations: [
					{
						creditClaimId: "DC1",
						realization: "realized",
						realizedArchitectureDelta: -3,
						evidence: "Collapsed, but the commit is not cited.",
					},
				],
			},
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(missing.status).toBe("applied");
		if (missing.status !== "applied") return;
		expect(missing.pending.diagnostics).toContainEqual(
			expect.objectContaining({ code: "CREDIT_EVIDENCE_UNRESOLVED" }),
		);
		expect(missing.reconciliation.claims[0]?.status).toBe("pending");
		expect(missing.pending.route).toBe("human_gate");

		const short = await composeImplementationReviewerRecord({
			ctx: advisory,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 2,
			verdict: realizedVerdict(COMMIT.slice(0, 7)),
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(short.status).toBe("applied");
		if (short.status !== "applied") return;
		expect(short.reconciliation.claims[0]?.status).toBe("realized");

		const waived = makeBudgetContext({ mode: "enforced" });
		const seedBinding = creditBinding();
		seedBinding.effectiveDecisions = [
			{
				kind: "waiver",
				decisionId: "dec-waive",
				creditClaimId: "DC1",
				approvedMagnitude: 2,
				active: true,
			},
		];
		waived.store.saveImplementationBinding(seedBinding, TEST_ORIGIN);
		waived.store.saveImplementationReviewContext(
			phaseContext("1", COMMIT, "ctx-1"),
			TEST_ORIGIN,
		);
		const envelope = await composeImplementationReviewerRecord({
			ctx: waived,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 1,
			verdict: readyVerdict(),
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(envelope.status).toBe("applied");
		if (envelope.status !== "applied") return;
		expect(envelope.reconciliation.claims[0]).toMatchObject({
			status: "waived",
			effectiveApprovedMagnitude: 2,
			realizedArchitectureDelta: null,
		});
		expect(envelope.reconciliation.budget.realizedCredit).toBe(0);
		expect(envelope.pending.route).toBe("complete");
		advisory.db.close();
		waived.db.close();
	});

	test("an accepted higher-burden decision clears the same-phase shortfall", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const seedBinding = creditBinding();
		const item = seedBinding.ledger.workItems[0];
		if (!item) throw new Error("missing work item");
		item.architectureDelta = -5;
		ctx.store.saveImplementationBinding(seedBinding, TEST_ORIGIN);
		ctx.store.saveImplementationReviewContext(
			phaseContext("1", COMMIT, "ctx-1"),
			TEST_ORIGIN,
		);
		const verdict = {
			readiness: "ready" as const,
			items: [],
			creditRealizations: [
				{
					creditClaimId: "DC1",
					realization: "not_realized" as const,
					realizedArchitectureDelta: 0,
					evidence: `No collapse at ${COMMIT}.`,
				},
			],
		};
		const first = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 1,
			verdict,
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(first.status).toBe("applied");
		if (first.status !== "applied") return;
		expect(
			first.pending.gateCauses.some(
				(cause) => cause.kind === "credit_shortfall",
			),
		).toBe(true);
		await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			first.pending,
			ctx,
			first.reconciliation,
		);
		const made = createImplementationDecision({
			gateId: "gate-burden",
			observationId: first.pending.id,
			bindingId: seedBinding.id,
			phase: "1",
			choice: "approve_higher_burden",
			findingRefs: [],
			rationale: "Approve the unrealized burden",
			evidence: [],
			claimAdjustments: [
				{ creditClaimId: "DC1", approvedArchitectureDelta: 0 },
			],
			ledgerHash: seedBinding.ledgerHash,
			decisionsHash: seedBinding.decisionsHash,
			createdAt: "2026-01-02 00:00:00",
		});
		ctx.recordStore.append({
			runId: "run1",
			stream: "steps",
			idempotencyKey: "step:run1:human:review-governance:1:2",
			payload: {
				step_name: "human:review-governance",
				phase: "1",
				iteration: 2,
				result_json: { decisionId: made.decisionId, gateId: made.gateId },
				head_commit: null,
				patch_id: null,
				diff_summary: null,
				duration_ms: null,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
				model: null,
			},
			createdAt: "2026-01-02 00:00:00",
			...recordedEnvelope(TEST_ORIGIN),
		});
		ctx.recordStore.append({
			runId: "run1",
			stream: "decisions",
			idempotencyKey: `decision:review-gate:${made.gateId}`,
			payload: made,
			createdAt: made.createdAt,
			...recordedEnvelope(TEST_ORIGIN),
		});
		const second = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 2,
			verdict,
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(second.status).toBe("applied");
		if (second.status !== "applied") return;
		expect(
			second.pending.gateCauses.some(
				(cause) => cause.kind === "credit_shortfall",
			),
		).toBe(false);
		expect(second.reconciliation.claims[0]).toMatchObject({
			creditClaimId: "DC1",
			effectiveApprovedMagnitude: 0,
			waiverDecisionId: made.decisionId,
		});
		ctx.db.close();
	});

	test("an accepted restoration reopens the superseded claim without waiving it", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const seedBinding = creditBinding();
		ctx.store.saveImplementationBinding(seedBinding, TEST_ORIGIN);
		ctx.store.saveImplementationReviewContext(
			phaseContext("1", COMMIT, "ctx-1"),
			TEST_ORIGIN,
		);
		const verdict = realizedVerdict(COMMIT);
		const first = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 1,
			verdict,
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(first.status).toBe("applied");
		if (first.status !== "applied") return;
		expect(first.reconciliation.claims[0]).toMatchObject({
			status: "realized",
			realizedArchitectureDelta: -3,
		});
		await recordImplementationReviewerStepWithObservation(
			recordParams(verdict, 1),
			first.pending,
			ctx,
			first.reconciliation,
		);
		const settled = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 2,
			verdict: readyVerdict(),
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(settled.status).toBe("applied");
		if (settled.status !== "applied") return;
		expect(settled.reconciliation.claims[0]).toMatchObject({
			status: "realized",
			carried: true,
			sourceObservationId: first.pending.id,
		});
		const made = createImplementationDecision({
			gateId: "gate-restore",
			observationId: first.pending.id,
			bindingId: seedBinding.id,
			phase: "1",
			choice: "restore_simplification",
			findingRefs: [],
			rationale: "Reopen the settled claim",
			evidence: [],
			claimAdjustments: [
				{
					creditClaimId: "DC1",
					approvedArchitectureDelta: -3,
					supersedesObservationId: first.pending.id,
				},
			],
			ledgerHash: seedBinding.ledgerHash,
			decisionsHash: seedBinding.decisionsHash,
			createdAt: "2026-01-02 00:00:00",
		});
		ctx.recordStore.append({
			runId: "run1",
			stream: "steps",
			idempotencyKey: "step:run1:human:review-governance:1:2",
			payload: {
				step_name: "human:review-governance",
				phase: "1",
				iteration: 2,
				result_json: { decisionId: made.decisionId, gateId: made.gateId },
				head_commit: null,
				patch_id: null,
				diff_summary: null,
				duration_ms: null,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
				model: null,
			},
			createdAt: "2026-01-02 00:00:00",
			...recordedEnvelope(TEST_ORIGIN),
		});
		ctx.recordStore.append({
			runId: "run1",
			stream: "decisions",
			idempotencyKey: `decision:review-gate:${made.gateId}`,
			payload: made,
			createdAt: made.createdAt,
			...recordedEnvelope(TEST_ORIGIN),
		});
		const reopened = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 3,
			verdict: readyVerdict(),
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(reopened.status).toBe("applied");
		if (reopened.status !== "applied") return;
		expect(reopened.reconciliation.supersedesObservationId).toBe(
			first.pending.id,
		);
		expect(reopened.reconciliation.claims[0]).toMatchObject({
			creditClaimId: "DC1",
			status: "pending",
			carried: false,
			effectiveApprovedMagnitude: 3,
			realizedArchitectureDelta: null,
			waiverDecisionId: null,
			sourceObservationId: null,
		});
		expect(reopened.pending.gateCauses).toContainEqual({
			kind: "credit_unreconciled",
			claimIds: ["DC1"],
		});
		const fresh = await composeImplementationReviewerRecord({
			ctx,
			runId: "run1",
			stepName: STEP,
			phase: "1",
			iteration: 4,
			verdict: {
				readiness: "ready",
				items: [],
				creditRealizations: [
					{
						creditClaimId: "DC1",
						realization: "partial",
						realizedArchitectureDelta: -1,
						evidence: `Partial collapse remains at ${COMMIT}.`,
					},
				],
			},
			contextId: "ctx-1",
			codeContext: phaseDiff(COMMIT),
		});
		expect(fresh.status).toBe("applied");
		if (fresh.status !== "applied") return;
		expect(fresh.reconciliation.claims[0]).toMatchObject({
			creditClaimId: "DC1",
			status: "partial",
			carried: false,
			sourceObservationId: null,
			realizedArchitectureDelta: -1,
			effectiveApprovedMagnitude: 3,
			waiverDecisionId: null,
		});
		ctx.db.close();
	});
});
