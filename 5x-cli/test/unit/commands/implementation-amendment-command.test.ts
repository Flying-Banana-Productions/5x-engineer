import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	amendImplementationPlanCommand,
	submitReviewDecision,
} from "../../../src/commands/review-decision.handler.js";
import {
	createMemoryPromptStore,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { recordStep } from "../../../src/db/operations-v1.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import type { VerdictItem } from "../../../src/protocol.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	createImplementationDecision,
	governanceDecisionKey,
} from "../../../src/review-governance/decisions.js";
import { fingerprintImplementationVerdictItem } from "../../../src/review-governance/fingerprint.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";
import type { ReviewGateCause } from "../../../src/review-governance/types.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

const RUN = "run1";
const PLAN = `# Plan

## Design Decisions

Keep the binding.

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Foundation | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Foundation

**Completion gate:** Stable.

- [ ] Stable types

## Phase 2: Providers

**Completion gate:** Normalize.

- [ ] Read digits

## Phase 3: Verification

**Completion gate:** Verify.

- [ ] Verify timestamps
`;

function ledger(text: string) {
	const parsed = parseDeliveryBudget(text);
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.value;
}

function git(dir: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			result.stderr.toString() || result.stdout.toString() || args.join(" "),
		);
	}
	return result.stdout.toString().trim();
}

function item(id: string): VerdictItem {
	return {
		id,
		title: id,
		action: "human_required",
		reason: "Providers",
		priority: "P1",
		scopeClass: "implementation_defect",
		planWorkItemIds: ["W1"],
		effortDelta: 1,
		architectureDelta: 0,
		estimateConfidence: "high",
		failure: "Providers",
		lowestCostCorrection: "Amend the plan",
	};
}

function fixture(options?: {
	maxSteps?: number;
	mode?: "advisory" | "enforced";
	gateCauses?: ReviewGateCause[];
	boundaryHash?: "review" | "side";
}) {
	const dir = mkdtempSync(join(tmpdir(), "amend-cmd-"));
	const amended = PLAN.replace("Read digits", "Honor offsets");
	git(dir, ["init"]);
	git(dir, ["config", "user.email", "test@test.com"]);
	git(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "plan.md"), PLAN);
	git(dir, ["add", "plan.md"]);
	git(dir, ["commit", "-m", "base"]);
	const prior = git(dir, ["rev-parse", "HEAD"]);
	const branch = git(dir, ["branch", "--show-current"]);
	git(dir, ["branch", "side"]);
	writeFileSync(join(dir, "plan.md"), amended);
	git(dir, ["add", "plan.md"]);
	git(dir, ["commit", "-m", "author plan"]);
	const author = git(dir, ["rev-parse", "HEAD"]);
	mkdirSync(join(dir, "docs/development/reviews"), { recursive: true });
	writeFileSync(join(dir, "docs/development/reviews/review.md"), "# Review\n");
	git(dir, ["add", "docs/development/reviews/review.md"]);
	git(dir, ["commit", "-m", "review doc"]);
	const review = git(dir, ["rev-parse", "HEAD"]);
	git(dir, ["checkout", "side"]);
	writeFileSync(join(dir, "side.txt"), "side\n");
	git(dir, ["add", "side.txt"]);
	git(dir, ["commit", "-m", "side"]);
	const side = git(dir, ["rev-parse", "HEAD"]);
	git(dir, ["checkout", branch]);
	const boundary = options?.boundaryHash === "side" ? side : review;
	const ctx = makeBudgetContext({
		mode: "advisory",
		maxSteps: options?.maxSteps,
	});
	ctx.executionContext.effectiveWorkingDirectory = dir;
	ctx.executionContext.controlPlaneRoot = dir;
	ctx.executionContext.effectivePlanPath = join(dir, "plan.md");
	ctx.executionContext.run.plan_path = "plan.md";
	const finding = item("R1");
	const fingerprint = fingerprintImplementationVerdictItem(finding, "2");
	const append = (
		stream: "budget" | "steps" | "decisions",
		key: string,
		payload: unknown,
	) =>
		ctx.recordStore.append({
			runId: RUN,
			stream,
			idempotencyKey: key,
			payload,
			...recordedEnvelope(TEST_ORIGIN),
		});
	const putStep = (
		name: string,
		phase: string,
		iteration: number,
		result: unknown,
		head: string,
	) => {
		const key = stepIdempotencyKey({
			runId: RUN,
			stepName: name,
			phase,
			iteration,
		});
		append("steps", key, {
			step_name: name,
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
		});
		const row = recordStep(ctx.db, {
			run_id: RUN,
			step_name: name,
			phase,
			iteration,
			result_json: JSON.stringify(result),
			head_commit: head,
		});
		return { key, id: String(row.step_id) };
	};
	const mode = options?.mode ?? "advisory";
	append("budget", `budget:implementation-binding:${RUN}`, {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: RUN,
		sourceRunId: "source-run",
		sourceSnapshotId: "snapshot-1",
		sourceBaselineId: "baseline-1",
		approvedPlanCommit: prior,
		approvedPlanHash: hashPlanBytes(PLAN),
		approvedPlanBytes: PLAN,
		b0: 2,
		governingB: 4,
		mode,
		thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
		ledger: ledger(PLAN),
		effectiveDecisions: [],
		phaseMap: [
			{ id: "1", heading: "Foundation" },
			{ id: "2", heading: "Providers" },
			{ id: "3", heading: "Verification" },
		],
		debtTargets: [],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-10-19T00:00:00.000Z",
	});
	append("budget", "ctx-obs-2", {
		kind: "implementation-review-context",
		version: 1,
		id: "ctx-obs-2",
		executionRunId: RUN,
		bindingId: "binding-1",
		phase: "2",
		baseCommit: prior,
		reviewedCommit: author,
		patchHash: hashPlanBytes("patch"),
		excludedPaths: ["docs/development/reviews"],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-10-19T00:00:00.000Z",
	});
	append("budget", "obs-2", {
		kind: "implementation-review",
		version: 1,
		id: "obs-2",
		runId: RUN,
		stepKey: { stepName: "reviewer:impl", phase: "2", iteration: 0 },
		bindingId: "binding-1",
		contextId: "ctx-obs-2",
		domain: "implementation",
		phase: "2",
		originalVerdict: { readiness: "not_ready", items: [finding] },
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [
			{
				kind: "plan_amendment",
				findingId: "R1",
				fingerprint,
			},
		],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: 1,
				plan_defect: 0,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 1,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 0,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 2, R: 0, B: 4, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-10-19T00:00:00.000Z",
	});
	const scope = {
		predecessorRevisionId: "binding-1",
		earliestAffectedPhase: "2",
		reopenCompletedPhases: false,
		claimEdits: [],
		resolutionRefs: [],
	};
	const decision = createImplementationDecision({
		decisionId: "11111111-1111-4111-8111-111111111111",
		gateId: "gate-1",
		observationId: "obs-2",
		bindingId: "binding-1",
		phase: "2",
		choice: "authorize_amendment",
		findingRefs: [{ findingId: "R1", fingerprint }],
		rationale: "Authorize only the structured scope",
		evidence: [],
		claimAdjustments: [],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-10-19T00:00:00.000Z",
		amendmentScope: scope,
	});
	append("decisions", governanceDecisionKey(decision.gateId), decision);
	putStep(
		"reviewer:impl",
		"2",
		0,
		{ readiness: "not_ready", items: [finding] },
		prior,
	);
	const human = putStep(
		"human:review-governance",
		"2",
		1,
		{
			decisionId: decision.decisionId,
			gateId: decision.gateId,
			choice: "authorize_amendment",
		},
		author,
	);
	putStep(
		"author:process-plan-review",
		"plan",
		1,
		{ result: "complete", commit: author },
		author,
	);
	putStep(
		"git:commit",
		"plan",
		1,
		{
			hash: boundary,
			short_hash: boundary.slice(0, 8),
			message: "review doc",
			files: ["docs/development/reviews/review.md"],
		},
		boundary,
	);
	putStep(
		"reviewer:plan",
		"plan",
		1,
		{
			readiness: "ready",
			items: [],
			governance: { route: "complete" },
			amendmentAssessment: {
				predecessorRevisionId: "binding-1",
				reviewedPlanHash: hashPlanBytes(amended),
				earliestAffectedPhase: "2",
				preservedPhases: [{ phaseId: "1", reason: "phase section unchanged" }],
				resolvedFindings: [],
				claimEdits: [],
			},
		},
		review,
	);
	ctx.store.appendSnapshot({
		runId: RUN,
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: ledger(amended),
		findings: [],
		assessments: [],
		priorFindings: [],
		effectiveGateCauses: options?.gateCauses ?? [],
		origin: TEST_ORIGIN,
	});
	const input = {
		runId: RUN,
		humanStep: human.id,
		approvalStep: "reviewer:plan:plan:1",
		fromPhase: "2",
		resolves: [] as string[],
	};
	return {
		dir,
		ctx,
		author,
		review,
		input,
		decision,
		scope,
		fingerprint,
		close() {
			ctx.db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const inputFor = (built: ReturnType<typeof fixture>) => built.input;

describe("review implementation amend", () => {
	test("dry-run and record use the author commit across a later review commit", async () => {
		const built = fixture();
		try {
			const preview = await amendImplementationPlanCommand(
				{ ...inputFor(built), dryRun: true },
				built.ctx,
			);
			expect(preview.dryRun).toBe(true);
			expect(preview.created).toBe(false);
			expect(preview.approvedPlanCommit).toBe(built.author);
			expect(preview.completionAuthorized).toBe(false);
			expect(
				built.ctx.recordStore
					.listLines(RUN, "budget")
					.some(
						(line) =>
							(line.payload as { kind?: string }).kind ===
							"implementation-plan-amendment",
					),
			).toBe(false);
			const recorded = await amendImplementationPlanCommand(
				inputFor(built),
				built.ctx,
			);
			expect(recorded.created).toBe(true);
			expect(recorded.approvedPlanCommit).toBe(built.author);
			expect(recorded.approvedPlanCommit).not.toBe(built.review);
			const row = built.ctx.db
				.query(
					`SELECT id FROM steps WHERE run_id = ?1 AND step_name = 'implementation:amendment'`,
				)
				.get(RUN) as { id: number } | null;
			expect(row?.id).toBeGreaterThan(0);
			const retry = await amendImplementationPlanCommand(
				inputFor(built),
				built.ctx,
			);
			expect(retry.created).toBe(false);
			expect(retry.amendmentId).toBe(recorded.amendmentId);
			expect(
				built.ctx.recordStore
					.listLines(RUN, "budget")
					.filter(
						(line) =>
							(line.payload as { kind?: string }).kind ===
							"implementation-plan-amendment",
					),
			).toHaveLength(1);
			built.ctx.db.run(
				`DELETE FROM steps WHERE run_id = ?1 AND step_name = 'implementation:amendment'`,
				[RUN],
			);
			const projected = await amendImplementationPlanCommand(
				inputFor(built),
				built.ctx,
			);
			expect(projected.created).toBe(false);
			const again = built.ctx.db
				.query(
					`SELECT COUNT(*) AS n FROM steps WHERE run_id = ?1 AND step_name = 'implementation:amendment'`,
				)
				.get(RUN) as { n: number };
			expect(again.n).toBe(1);
			const promptStore = createMemoryPromptStore();
			const same = await submitReviewDecision(
				{
					runId: RUN,
					gateId: built.decision.gateId,
					phase: "2",
					payload: {
						choice: "authorize_amendment",
						rationale: built.decision.rationale,
						evidence: [],
						findingRefs: built.decision.findingRefs,
						amendmentScope: built.scope,
					},
				},
				{ context: built.ctx, promptStore },
			);
			expect(same.created).toBe(false);
			expect(same.decision.decisionId).toBe(built.decision.decisionId);
			await expect(
				submitReviewDecision(
					{
						runId: RUN,
						gateId: built.decision.gateId,
						phase: "2",
						payload: {
							choice: "authorize_amendment",
							rationale: built.decision.rationale,
							evidence: [],
							findingRefs: built.decision.findingRefs,
							amendmentScope: {
								...built.scope,
								earliestAffectedPhase: "3",
							},
						},
					},
					{ context: built.ctx, promptStore },
				),
			).rejects.toMatchObject({ code: "REVIEW_GATE_ALREADY_RESOLVED" });
		} finally {
			built.close();
		}
	}, 20000);

	test("rejects a code change, a dirty plan, and a boundary that is not an ancestor", async () => {
		const dirty = fixture();
		try {
			writeFileSync(join(dirty.dir, "plan.md"), `${PLAN}\n`, "utf8");
			await expect(
				amendImplementationPlanCommand(inputFor(dirty), dirty.ctx),
			).rejects.toThrow("uncommitted code changes");
		} finally {
			dirty.close();
		}
		const changed = fixture();
		try {
			writeFileSync(
				join(changed.dir, "src-changed.ts"),
				"export const n = 1;\n",
			);
			git(changed.dir, ["add", "src-changed.ts"]);
			git(changed.dir, ["commit", "-m", "code"]);
			await expect(
				amendImplementationPlanCommand(inputFor(changed), changed.ctx),
			).rejects.toThrow("Non-workflow files changed");
		} finally {
			changed.close();
		}
		const side = fixture({ boundaryHash: "side" });
		try {
			await expect(
				amendImplementationPlanCommand(inputFor(side), side.ctx),
			).rejects.toThrow("ancestor");
		} finally {
			side.close();
		}
	}, 20000);

	test("resolves numeric and run-qualified steps and rejects another run", async () => {
		const built = fixture();
		try {
			await expect(
				amendImplementationPlanCommand(
					{
						...inputFor(built),
						humanStep: "step:run-other:human:review-governance:2:1",
					},
					built.ctx,
				),
			).rejects.toThrow("must belong to the execution run");
			await expect(
				amendImplementationPlanCommand(
					{ ...inputFor(built), approvalStep: "99999" },
					built.ctx,
				),
			).rejects.toThrow("not in this run");
			const recorded = await amendImplementationPlanCommand(
				{
					...inputFor(built),
					humanStep: built.input.humanStep,
					approvalStep: stepIdempotencyKey({
						runId: RUN,
						stepName: "reviewer:plan",
						phase: "plan",
						iteration: 1,
					}),
				},
				built.ctx,
			);
			expect(recorded.created).toBe(true);
		} finally {
			built.close();
		}
	}, 20000);

	test("advisory budget gates stay nonblocking and enforced semantic gates reject", async () => {
		const advisory = fixture({
			gateCauses: [{ kind: "budget_alert", alert: "baseline_disputed" }],
		});
		try {
			const recorded = await amendImplementationPlanCommand(
				inputFor(advisory),
				advisory.ctx,
			);
			expect(recorded.created).toBe(true);
		} finally {
			advisory.close();
		}
		const enforced = fixture({
			mode: "enforced",
			gateCauses: [
				{
					kind: "semantic_human",
					finding: { findingId: "R1", fingerprint: "sha256:finding" },
				},
			],
		});
		try {
			await expect(
				amendImplementationPlanCommand(inputFor(enforced), enforced.ctx),
			).rejects.toThrow("unresolved approval gate");
		} finally {
			enforced.close();
		}
	}, 20000);

	test("admission rejects registration once the step budget is exhausted", async () => {
		const built = fixture({ maxSteps: 1 });
		try {
			await expect(
				amendImplementationPlanCommand(inputFor(built), built.ctx),
			).rejects.toMatchObject({ code: "MAX_STEPS_EXCEEDED" });
			expect(
				built.ctx.recordStore
					.listLines(RUN, "budget")
					.some(
						(line) =>
							(line.payload as { kind?: string }).kind ===
							"implementation-plan-amendment",
					),
			).toBe(false);
		} finally {
			built.close();
		}
	}, 20000);
});
