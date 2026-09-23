import { describe, expect, test } from "bun:test";
import {
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
	implementationReviewObservationKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import type { CodeDiffContext } from "../../../src/review-governance/code-diff.js";
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
		creditRealizations: [
			{
				creditClaimId: "DC0",
				realization: "not_realized" as const,
				realizedArchitectureDelta: -5,
				evidence: "The second store is still on the path.",
			},
		],
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
		expect(protocol.pending.claimObservations).toEqual([
			{
				creditClaimId: "DC0",
				realization: "not_realized",
				realizedArchitectureDelta: -5,
				evidence: "The second store is still on the path.",
			},
		]);
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
});
