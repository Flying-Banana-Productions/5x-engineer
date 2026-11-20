import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAmendmentReviewContext } from "../../../src/commands/amendment-review-context.js";
import {
	amendImplementationPlanCommand,
	showReviewGate,
	submitReviewDecision,
} from "../../../src/commands/review-decision.handler.js";
import {
	createMemoryPromptStore,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";
import { deriveOpenImplementationGate } from "../../../src/review-governance/store.js";
import type { ReviewGateCause } from "../../../src/review-governance/types.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";
import {
	AMENDED_PLAN,
	amendmentLedger as ledger,
	AMENDMENT_PLAN as PLAN,
	seedImplementationAmendmentObservation,
	seedPendingImplementationAmendment,
} from "./amendment-test-helpers.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

const RUN = "run1";

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

function repoFixture(options?: {
	maxSteps?: number;
	boundaryHash?: "review" | "side";
}) {
	const dir = mkdtempSync(join(tmpdir(), "amend-cmd-"));
	const amended = AMENDED_PLAN;
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
	return { dir, ctx, prior, author, review, boundary, amended };
}

/**
 * Record the author, commit, and plan reviewer steps that assess the amended
 * plan after the human step, and return the `amend` input that cites them.
 */
function recordPlanReview(
	repo: ReturnType<typeof repoFixture>,
	putStep: ReturnType<typeof seedImplementationAmendmentObservation>["putStep"],
	humanStepId: string,
	gateCauses?: ReviewGateCause[],
) {
	const { ctx, author, review, boundary, amended } = repo;
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
		effectiveGateCauses: gateCauses ?? [],
		origin: TEST_ORIGIN,
	});
	return {
		runId: RUN,
		humanStep: humanStepId,
		approvalStep: "reviewer:plan:plan:1",
		fromPhase: "2",
		resolves: [] as string[],
	};
}

function fixture(options?: {
	maxSteps?: number;
	mode?: "advisory" | "enforced";
	gateCauses?: ReviewGateCause[];
	boundaryHash?: "review" | "side";
}) {
	const repo = repoFixture(options);
	const { dir, ctx, author, review } = repo;
	const { decision, scope, fingerprint, human, putStep } =
		seedPendingImplementationAmendment(ctx, {
			runId: RUN,
			priorCommit: repo.prior,
			authorCommit: author,
			mode: options?.mode,
		});
	const input = recordPlanReview(repo, putStep, human.id, options?.gateCauses);
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

// Each fixture spawns ~20 git processes and the handler spawns more. Under
// `bun test --concurrent` on macOS, Bun intermittently loses the exit of a
// child process, so a test stalls until its timeout or the whole process
// hangs inside `Bun.spawnSync`. `test.serial` keeps the subprocess-heavy
// tests one at a time; `describe.serial` does not serialize under
// `--concurrent`.
// Bun bug: https://github.com/oven-sh/bun/issues/45365 (async form) and
// https://github.com/oven-sh/bun/issues/34069 (spawnSync form). Seen on
// 1.3.14 through 1.4.4. Once fixed, drop `test.serial` here, in
// protocol-validate.test.ts and in
// test/integration/providers/cursor-agent.test.ts.
describe("review implementation amend", () => {
	test.serial(
		"dry-run and record use the author commit across a later review commit",
		async () => {
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
		},
		20000,
	);

	test.serial(
		"rejects a code change, a dirty plan, and a boundary that is not an ancestor",
		async () => {
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
		},
		20000,
	);

	test.serial(
		"resolves numeric and run-qualified steps and rejects another run",
		async () => {
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
		},
		20000,
	);

	test.serial(
		"advisory budget gates stay nonblocking and enforced semantic gates reject",
		async () => {
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
		},
		20000,
	);

	test.serial(
		"an advisory plan_amendment cause opens an authorize-only gate that amend registers",
		async () => {
			const repo = repoFixture();
			try {
				const { ctx } = repo;
				const { fingerprint, putStep } = seedImplementationAmendmentObservation(
					ctx,
					{
						runId: RUN,
						priorCommit: repo.prior,
						authorCommit: repo.author,
					},
				);
				const promptStore = createMemoryPromptStore();
				const deps = { context: ctx, promptStore };
				const shown = await showReviewGate(RUN, deps, { phase: "2" });
				if (!shown.open || !("gate" in shown))
					throw new Error("expected an advisory amendment gate");
				expect(shown).toMatchObject({
					mode: "advisory",
					allowedChoices: ["authorize_amendment"],
				});
				expect(shown.gate.causes).toEqual([
					{ kind: "plan_amendment", findingId: "R1", fingerprint },
				]);
				expect(promptStore.listOpenPrompts(RUN)).toHaveLength(0);
				// Boundary and run-state checks still see no open gate.
				expect(
					deriveOpenImplementationGate(ctx.recordStore, RUN, "2"),
				).toBeNull();
				const decide = (
					choice: "authorize_amendment" | "defer_accept_risk",
					extra: object = {},
				) =>
					submitReviewDecision(
						{
							runId: RUN,
							gateId: shown.gate.gateId,
							phase: "2",
							findingIds: ["R1"],
							payload: {
								choice,
								rationale: "Operator authorized the provider change",
								evidence: [],
								...extra,
							},
						},
						deps,
					);
				await expect(decide("defer_accept_risk")).rejects.toMatchObject({
					code: "REVIEW_DECISION_INVALID",
				});
				const decided = await decide("authorize_amendment", {
					amendmentScope: {
						predecessorRevisionId: "binding-1",
						earliestAffectedPhase: "2",
						reopenCompletedPhases: false,
						claimEdits: [],
						resolutionRefs: [],
					},
				});
				expect(decided).toMatchObject({ nextAction: "plan_amendment" });
				expect(await showReviewGate(RUN, deps, { phase: "2" })).toMatchObject({
					open: false,
					mode: "advisory",
				});
				const human = ctx.recordStore
					.listLines(RUN, "steps")
					.find(
						(line) =>
							(line.payload as { step_name?: string }).step_name ===
							"human:review-governance",
					);
				if (!human) throw new Error("expected the coupled human step");
				const input = recordPlanReview(repo, putStep, human.idempotencyKey);
				const preview = await amendImplementationPlanCommand(
					{ ...input, dryRun: true },
					ctx,
				);
				expect(preview.dryRun).toBe(true);
				const recorded = await amendImplementationPlanCommand(input, ctx);
				expect(recorded.created).toBe(true);
				expect(recorded.completionAuthorized).toBe(false);
			} finally {
				repo.ctx.db.close();
				rmSync(repo.dir, { recursive: true, force: true });
			}
		},
		20000,
	);

	test.serial(
		"admission rejects registration once the step budget is exhausted",
		async () => {
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
		},
		20000,
	);
});

describe("trusted amendment review context", () => {
	test.serial(
		"supplies the predecessor, exact committed hash, and diff that registration accepts",
		async () => {
			const built = fixture();
			const warnings: string[] = [];
			try {
				const resolved = await resolveAmendmentReviewContext({
					ctx: built.ctx,
					runId: RUN,
					warn: (message) => warnings.push(message),
				});
				expect(resolved.status).toBe("ready");
				if (resolved.status !== "ready") return;
				expect(warnings).toEqual([]);
				expect(resolved.authorizationId).toBe(built.decision.decisionId);
				expect(resolved.predecessorRevisionId).toBe(
					built.scope.predecessorRevisionId,
				);
				expect(resolved.reviewedPlanHash).toBe(hashPlanBytes(AMENDED_PLAN));
				expect(resolved.append).toContain(
					"## Trusted Amendment Review Context",
				);
				expect(resolved.append).toContain("Predecessor revision: `binding-1`");
				expect(resolved.append).toContain(
					`Reviewed plan hash: \`${hashPlanBytes(AMENDED_PLAN)}\``,
				);
				expect(resolved.append).toContain("--- a/plan.md");
				expect(resolved.append).toContain("+++ b/plan.md");
				expect(resolved.append).toContain("-- [ ] Read digits");
				expect(resolved.append).toContain("+- [ ] Honor offsets");
				// The fixture's approval copied exactly these values; registration
				// accepts them, after which nothing is pending.
				const recorded = await amendImplementationPlanCommand(
					inputFor(built),
					built.ctx,
				);
				expect(recorded.created).toBe(true);
				expect(
					await resolveAmendmentReviewContext({
						ctx: built.ctx,
						runId: RUN,
						warn: (message) => warnings.push(message),
					}),
				).toEqual({ status: "none" });
			} finally {
				built.close();
			}
		},
		20000,
	);

	test.serial(
		"a final-corrections commit moves the hash, and a dirty plan warns",
		async () => {
			const built = fixture();
			const warnings: string[] = [];
			try {
				const corrected = AMENDED_PLAN.replace(
					"Honor offsets",
					"Honor UTC offsets",
				);
				writeFileSync(join(built.dir, "plan.md"), corrected);
				const dirty = await resolveAmendmentReviewContext({
					ctx: built.ctx,
					runId: RUN,
					warn: (message) => warnings.push(message),
				});
				expect(dirty.status).toBe("ready");
				if (dirty.status !== "ready") return;
				expect(dirty.reviewedPlanHash).toBe(hashPlanBytes(AMENDED_PLAN));
				expect(warnings).toHaveLength(1);
				expect(warnings[0]).toContain("differs from HEAD");
				git(built.dir, ["commit", "-am", "final corrections"]);
				warnings.length = 0;
				const reassessed = await resolveAmendmentReviewContext({
					ctx: built.ctx,
					runId: RUN,
					warn: (message) => warnings.push(message),
				});
				expect(reassessed.status).toBe("ready");
				if (reassessed.status !== "ready") return;
				expect(warnings).toEqual([]);
				expect(reassessed.reviewedPlanHash).toBe(hashPlanBytes(corrected));
				expect(reassessed.predecessorRevisionId).toBe("binding-1");
				expect(reassessed.append).toContain("+- [ ] Honor UTC offsets");
			} finally {
				built.close();
			}
		},
		20000,
	);

	test("is absent when the run has no amendment authorization", async () => {
		const ctx = makeBudgetContext({ mode: "advisory" });
		try {
			expect(
				await resolveAmendmentReviewContext({
					ctx,
					runId: RUN,
					warn: () => {},
				}),
			).toEqual({ status: "none" });
		} finally {
			ctx.db.close();
		}
	});
});
