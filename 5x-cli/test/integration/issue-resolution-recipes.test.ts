/**
 * Executable checks for the `5x-issue-resolution` skill's documented
 * recipes. Each test extracts a `# recipe:` block from the rendered skill and
 * runs it with real `git` on a temp repository, with a stub `gh` / `5x` on
 * PATH. These prove the command recipes behave as written; they do not prove
 * an agent follows them.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupRoot,
	FixtureRepo,
	issueResolutionSkill,
	listRecipeNames,
	makeStubBin,
	makeTempRoot,
	rec,
	runRecipe,
	type StubComment,
	writeRunRecords,
} from "../helpers/issue-delivery-fixtures.js";

const TIMEOUT = 60_000;
const SOURCE = "github.com/OWNER/REPO#42";
const MARK = `<!-- 5x:issue-source v1 ${SOURCE} -->`;
const PLANS_REL = "docs/development/plans";
const PLAN = `${PLANS_REL}/218-issue-42-example.md`;
const BRIEF = "docs/development/issues/218-issue-42-example/brief.md";
const BRIEF_REL = "docs/development/issues/218-issue-42-example";
const EXCLUDED = [
	"docs/development/runs",
	"docs/development/reviews",
	PLAN,
].join("\n");

function brief(source = SOURCE, plan = PLAN, mark = MARK): string {
	return `${mark}\nSource: ${source}\nPlan: ${plan}\nPlanning run: run_aaaa\n\nDisposition: ready\nIntake status: complete\n`;
}

async function withRoot<T>(
	prefix: string,
	fn: (root: string) => Promise<T>,
): Promise<T> {
	const root = makeTempRoot(prefix);
	try {
		return await fn(root);
	} finally {
		cleanupRoot(root);
	}
}

test("the skill documents every recipe these tests execute", () => {
	expect(listRecipeNames(issueResolutionSkill()).sort()).toEqual(
		[
			"accepted-intervals",
			"classify-delivery",
			"compatibility-intervals",
			"discover-briefs",
			"intake-association",
			"prepare-pr",
			"publish-resolution",
			"refresh-compare",
			"refresh-fetch",
		].sort(),
	);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("discover-briefs recipe", () => {
	test(
		"finds a validated brief on a remote-tracking ref and rejects quoted or mismatched markers",
		async () => {
			await withRoot("discover", async (root) => {
				const repo = FixtureRepo.create(root);
				const stub = makeStubBin(root);
				await repo.commit("init", { "README.md": "x\n" });
				await repo.git(["checkout", "-q", "-b", "5x/218-issue-42-example"]);
				const branchHead = await repo.commit("intake", {
					[PLAN]: "plan\n",
					[BRIEF]: brief(),
					// Marker quoted inside raw source JSON is never searched.
					[`${BRIEF_REL}/source/issue.json`]: JSON.stringify({ body: MARK }),
					// A brief for another issue quoting this marker below line one.
					"docs/development/issues/219-issue-7-other/brief.md": `<!-- 5x:issue-source v1 github.com/OWNER/REPO#7 -->\nSource: github.com/OWNER/REPO#7\nPlan: ${PLANS_REL}/219-issue-7-other.md\nQuoted: ${MARK}\n`,
					// First line matches, but the Source line names another issue.
					"docs/development/issues/220-issue-42-x/brief.md": brief(
						"github.com/OWNER/REPO#43",
						`${PLANS_REL}/220-issue-42-x.md`,
					),
					// Valid marker and source, but in the wrong brief directory.
					"docs/development/issues/wrong-dir/brief.md": brief(),
					// Valid marker and source, but the plan exists nowhere.
					"docs/development/issues/221-issue-42-gone/brief.md": brief(
						SOURCE,
						`${PLANS_REL}/221-issue-42-gone.md`,
					),
				});
				// Only a remote-tracking ref holds the work; no local branch, no chat.
				await repo.git(["checkout", "-q", "main"]);
				await repo.git([
					"update-ref",
					"refs/remotes/origin/5x/218-issue-42-example",
					branchHead,
				]);
				await repo.git(["branch", "-q", "-D", "5x/218-issue-42-example"]);

				const result = await runRecipe("discover-briefs", {
					cwd: repo.dir,
					env: { MARK, SOURCE, PLANS_REL, ...stub.env },
					binDir: stub.binDir,
				});
				expect(result.exitCode, result.stderr).toBe(0);
				const ref = "refs/remotes/origin/5x/218-issue-42-example";
				expect(result.lines).toContain(`valid ${ref} ${BRIEF} ${PLAN}`);
				expect(result.lines).toContain(
					`rejected ${ref} docs/development/issues/219-issue-7-other/brief.md first-line-marker`,
				);
				expect(result.lines).toContain(
					`rejected ${ref} docs/development/issues/220-issue-42-x/brief.md source-mismatch`,
				);
				expect(result.lines).toContain(
					`rejected ${ref} docs/development/issues/wrong-dir/brief.md brief-dir-mismatch`,
				);
				expect(result.lines).toContain(
					`rejected ${ref} docs/development/issues/221-issue-42-gone/brief.md plan-not-found`,
				);
				expect(result.stdout).not.toContain("source/issue.json");
				expect(result.lines.filter((l) => l.startsWith("valid "))).toHaveLength(
					1,
				);
			});
		},
		TIMEOUT,
	);

	test(
		"a failed run-list query is an error, never evidence that a run exists",
		async () => {
			await withRoot("discover-runlist", async (root) => {
				const repo = FixtureRepo.create(root);
				// The plan file is absent at the ref, so validation must query runs.
				await repo.commit("intake", { [BRIEF]: brief() });
				const stub = makeStubBin(root, {}, { "run list": { exit: 1 } });
				const result = await runRecipe("discover-briefs", {
					cwd: repo.dir,
					env: { MARK, SOURCE, PLANS_REL, ...stub.env },
					binDir: stub.binDir,
				});
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.lines).toEqual([
					`error refs/heads/main ${BRIEF} run-list-failed`,
				]);

				const malformed = makeStubBin(
					join(root, "m"),
					{},
					{ "run list": '{"ok":false,"error":{"code":"X"}}' },
				);
				const again = await runRecipe("discover-briefs", {
					cwd: repo.dir,
					env: { MARK, SOURCE, PLANS_REL, ...malformed.env },
					binDir: malformed.binDir,
				});
				expect(again.lines).toEqual([
					`error refs/heads/main ${BRIEF} run-list-failed`,
				]);
			});
		},
		TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// Intake association (resume reuse)
// ---------------------------------------------------------------------------

describe("intake-association recipe", () => {
	const initFor = (runId: string) =>
		JSON.stringify({
			ok: true,
			data: { run_id: runId, worktree_path: "/wt/218", resumed: true },
		});

	async function associate(
		root: string,
		opts: { valid: string; fivex: Parameters<typeof makeStubBin>[2] },
	) {
		const repo = FixtureRepo.create(root);
		await repo.commit("intake", {
			[BRIEF]: brief().replace(
				"Intake status: complete",
				"Intake status: incomplete",
			),
		});
		const stub = makeStubBin(root, {}, opts.fivex);
		const result = await runRecipe("intake-association", {
			cwd: repo.dir,
			env: {
				VALID: opts.valid,
				TOP: repo.dir,
				PLANS_DIR: join(repo.dir, PLANS_REL),
				PLANS_REL,
				N: "42",
				SHORT_SLUG: "fresh",
				...stub.env,
			},
			binDir: stub.binDir,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		return { repo, result, calls: stub.fivexLog() };
	}

	test(
		"resume of an incomplete intake reuses the validated plan, brief, run, and worktree",
		async () => {
			await withRoot("assoc-reuse", async (root) => {
				// The same brief found on a local branch and its origin ref is one association.
				const valid = [
					`valid refs/heads/main ${BRIEF} ${PLAN}`,
					`valid refs/remotes/origin/main ${BRIEF} ${PLAN}`,
				].join("\n");
				const { repo, result, calls } = await associate(root, {
					valid,
					fivex: {
						"run init": initFor("run_aaaa"),
						"plan list": '{"ok":true,"data":{"plans":[{"file":"300-x.md"}]}}',
					},
				});
				expect(result.lines).toEqual([
					"association: existing",
					`plan-path: ${join(repo.dir, PLAN)}`,
					`plan-file: ${PLAN}`,
					"plan-slug: 218-issue-42-example",
					`brief-rel: ${BRIEF_REL}`,
					"plan-run: run_aaaa",
					"worktree: /wt/218",
				]);
				// No new plan number is allocated; init targets the existing plan.
				expect(calls).toEqual([
					["run", "init", "--plan", join(repo.dir, PLAN), "--worktree"],
				]);
			});
		},
		TIMEOUT,
	);

	test(
		"a different active planning run, ambiguous briefs, or a failed init stop instead of starting duplicate work",
		async () => {
			await withRoot("assoc-stop", async (root) => {
				const mismatch = await associate(join(root, "a"), {
					valid: `valid refs/heads/main ${BRIEF} ${PLAN}`,
					fivex: { "run init": initFor("run_zzzz") },
				});
				expect(mismatch.result.lines).toEqual([
					"stop: planning-run-mismatch run_aaaa run_zzzz",
					"outcome: needs_human",
				]);

				const ambiguous = await associate(join(root, "b"), {
					valid: [
						`valid refs/heads/main ${BRIEF} ${PLAN}`,
						`valid refs/heads/main docs/development/issues/230-issue-42-b/brief.md ${PLANS_REL}/230-issue-42-b.md`,
					].join("\n"),
					fivex: { "run init": initFor("run_aaaa") },
				});
				expect(ambiguous.result.lines).toEqual([
					"stop: ambiguous-briefs",
					"outcome: needs_human",
				]);
				expect(ambiguous.calls).toEqual([]);

				const initFails = await associate(join(root, "c"), {
					valid: `valid refs/heads/main ${BRIEF} ${PLAN}`,
					fivex: { "run init": { exit: 1 } },
				});
				expect(initFails.result.lines).toEqual([
					"stop: run-init",
					"outcome: needs_human",
				]);
			});
		},
		TIMEOUT,
	);

	test(
		"allocates a new association only when discovery found none",
		async () => {
			await withRoot("assoc-new", async (root) => {
				const { repo, result, calls } = await associate(root, {
					valid: "",
					fivex: {
						"plan list":
							'{"ok":true,"data":{"plans":[{"file":"217-a.md"},{"file":"105-b.md"}]}}',
						"run init": JSON.stringify({
							ok: true,
							data: {
								run_id: "run_new",
								worktree_path: "/wt/218",
								warnings: ["harness stale"],
							},
						}),
					},
				});
				expect(result.lines).toEqual([
					"association: new",
					'init-warnings: {"warnings":["harness stale"],"harness_freshness":null}',
					`plan-path: ${join(repo.dir, PLANS_REL, "218-issue-42-fresh.md")}`,
					`plan-file: ${PLANS_REL}/218-issue-42-fresh.md`,
					"plan-slug: 218-issue-42-fresh",
					"brief-rel: docs/development/issues/218-issue-42-fresh",
					"plan-run: run_new",
					"worktree: /wt/218",
				]);
				expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
					"plan list",
					"run init",
				]);
			});
		},
		TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// Delivery identity
// ---------------------------------------------------------------------------

type DeliveryRun = { lines: string[]; ok: boolean; intervals: string[] };

async function classify(
	root: string,
	repo: FixtureRepo,
	input: {
		budget: string[];
		steps: string[];
		base: string;
		final: string;
		prHead: string;
		recipe?: "accepted-intervals" | "compatibility-intervals";
	},
): Promise<DeliveryRun> {
	const rd = writeRunRecords(root, {
		budget: input.budget,
		steps: input.steps,
		finalHead: input.final,
	});
	const intervals = await runRecipe(input.recipe ?? "accepted-intervals", {
		cwd: repo.dir,
		env: { RD: rd },
	});
	expect(intervals.exitCode, intervals.stderr).toBe(0);
	const result = await runRecipe("classify-delivery", {
		cwd: repo.dir,
		env: {
			BASE: input.base,
			FINAL: input.final,
			PR_HEAD: input.prHead,
			EXCLUDED,
			INTERVALS: intervals.stdout,
		},
	});
	expect(result.exitCode, result.stderr).toBe(0);
	return {
		lines: result.lines,
		ok: result.lines.at(-1) === "delivery: ok",
		intervals: intervals.lines,
	};
}

/** Plan commit P, then the run's review document, checkbox, and seal commits. */
async function evidenceTail(repo: FixtureRepo): Promise<{
	review: string;
	checkbox: string;
	final: string;
	seal: string;
}> {
	const review = await repo.commit("review: phase 1", {
		"docs/development/reviews/run_impl-phase-1-review.md": "ready\n",
		"docs/development/runs/218/run_impl/steps.jsonl": "{}\n",
	});
	const checkbox = await repo.commit("plan: check phase 1", {
		[PLAN]: "plan\n- [x] done\n",
	});
	const seal = await repo.commit("5x: seal run", {
		"docs/development/runs/218/run_impl/run.json": "{}\n",
	});
	return { review, checkbox, final: checkbox, seal };
}

describe("delivery identity recipes", () => {
	test(
		"accepts reviewed code plus review-document, checkbox, and seal commits",
		async () => {
			await withRoot("deliver-ok", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				const a1 = await repo.commit("feat", { "src/a.ts": "a\n" });
				const tail = await evidenceTail(repo);
				const run = await classify(root, repo, {
					budget: [
						rec.binding("b1", p),
						rec.context("c1", "b1", "1", p, a1),
						rec.observation({
							id: "o1",
							bindingId: "b1",
							contextId: "c1",
							phase: "1",
							route: "complete",
							completionAuthorized: true,
						}),
					],
					steps: [rec.preAuthor("b1", "1", p)],
					base: p,
					final: tail.final,
					prHead: tail.seal,
				});
				expect(run.lines).toEqual([
					`reviewed ${a1}`,
					`evidence ${tail.review}`,
					`evidence ${tail.checkbox}`,
					`evidence ${tail.seal}`,
					"delivery: ok",
				]);
			});
		},
		TIMEOUT,
	);

	test(
		"rejects pre-admission code U in the P, U, A example",
		async () => {
			await withRoot("deliver-pre", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				const u = await repo.commit("unreviewed", { "src/u.ts": "u\n" });
				const a = await repo.commit("feat", { "src/a.ts": "a\n" });
				const run = await classify(root, repo, {
					budget: [
						rec.binding("b1", p),
						rec.context("c1", "b1", "1", u, a),
						rec.observation({
							id: "o1",
							bindingId: "b1",
							contextId: "c1",
							phase: "1",
							route: "complete",
							completionAuthorized: true,
						}),
					],
					steps: [rec.preAuthor("b1", "1", u)],
					base: p,
					final: a,
					prHead: a,
				});
				expect(run.lines).toContain(`uncovered ${u}`);
				expect(run.lines).toContain(`reviewed ${a}`);
				expect(run.ok).toBe(false);
			});
		},
		TIMEOUT,
	);

	test(
		"accepts multiple settled phases and rejects uncovered inter-phase code",
		async () => {
			await withRoot("deliver-phases", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				const a1 = await repo.commit("phase 1", { "src/a.ts": "a\n" });
				const r1 = await repo.commit("review 1", {
					"docs/development/reviews/p1.md": "ok\n",
				});
				const x = await repo.commit("between", { "src/x.ts": "x\n" });
				const a2 = await repo.commit("phase 2", { "src/b.ts": "b\n" });
				const budget = [
					rec.binding("b1", p),
					rec.context("c1", "b1", "1", p, a1),
					rec.observation({
						id: "o1",
						bindingId: "b1",
						contextId: "c1",
						phase: "1",
						route: "complete",
						completionAuthorized: true,
					}),
					rec.context("c2", "b1", "2", x, a2),
					rec.observation({
						id: "o2",
						bindingId: "b1",
						contextId: "c2",
						phase: "2",
						route: "complete",
						completionAuthorized: true,
					}),
				];
				const uncovered = await classify(root, repo, {
					budget,
					steps: [rec.preAuthor("b1", "1", p), rec.preAuthor("b1", "2", x)],
					base: p,
					final: a2,
					prHead: a2,
				});
				expect(uncovered.lines).toEqual([
					`reviewed ${a1}`,
					`evidence ${r1}`,
					`uncovered ${x}`,
					`reviewed ${a2}`,
					"delivery: needs_human",
				]);

				// Same history, but phase 2 admitted at r1 and reviewed x..a2.
				const covered = await classify(root, repo, {
					budget: [
						...budget.slice(0, 3),
						rec.context("c2", "b1", "2", r1, a2),
						budget[4] as string,
					],
					steps: [rec.preAuthor("b1", "1", p), rec.preAuthor("b1", "2", r1)],
					base: p,
					final: a2,
					prHead: a2,
				});
				expect(covered.ok).toBe(true);
				expect(covered.lines).toContain(`reviewed ${x}`);
			});
		},
		TIMEOUT,
	);

	test(
		"a prepared context with no observation, or an unsettled latest observation, is not approval",
		async () => {
			await withRoot("deliver-prepared", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				const a1 = await repo.commit("feat", { "src/a.ts": "a\n" });
				const prepared = await classify(root, repo, {
					budget: [rec.binding("b1", p), rec.context("c1", "b1", "1", p, a1)],
					steps: [rec.preAuthor("b1", "1", p)],
					base: p,
					final: a1,
					prHead: a1,
				});
				expect(prepared.intervals).toEqual([]);
				expect(prepared.lines).toEqual([
					"records no-accepted-interval",
					`uncovered ${a1}`,
					"delivery: needs_human",
				]);

				const gated = await classify(root, repo, {
					budget: [
						rec.binding("b1", p),
						rec.context("c1", "b1", "1", p, a1),
						rec.observation({
							id: "o1",
							bindingId: "b1",
							contextId: "c1",
							phase: "1",
							route: "human_gate",
							completionAuthorized: false,
						}),
					],
					steps: [rec.preAuthor("b1", "1", p)],
					base: p,
					final: a1,
					prHead: a1,
				});
				expect(gated.intervals).toEqual(["unsettled 1"]);
				expect(gated.lines).toContain("records unsettled 1");
				expect(gated.ok).toBe(false);
			});
		},
		TIMEOUT,
	);

	async function classifyRaw(
		repo: FixtureRepo,
		env: Record<string, string>,
	): Promise<string[]> {
		const result = await runRecipe("classify-delivery", {
			cwd: repo.dir,
			env: { EXCLUDED, ...env },
		});
		expect(result.exitCode, result.stderr).toBe(0);
		return result.lines;
	}

	test(
		"unsettled, error, malformed, and empty interval output never classify as delivered when no code changed",
		async () => {
			await withRoot("deliver-unsettled", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				// BASE = FINAL = PR_HEAD: the phase has no code-touching commits.
				const same = { BASE: p, FINAL: p, PR_HEAD: p };
				expect(
					await classifyRaw(repo, { ...same, INTERVALS: "unsettled 1" }),
				).toEqual([
					"records unsettled 1",
					"records no-accepted-interval",
					"delivery: needs_human",
				]);
				expect(
					await classifyRaw(repo, {
						...same,
						INTERVALS: "needs_human records-unreadable",
					}),
				).toEqual([
					"records records-unreadable",
					"records no-accepted-interval",
					"delivery: needs_human",
				]);
				expect(
					await classifyRaw(repo, { ...same, INTERVALS: "garbage line" }),
				).toEqual([
					"records malformed-line garbage",
					"records no-accepted-interval",
					"delivery: needs_human",
				]);
				expect(
					await classifyRaw(repo, {
						...same,
						INTERVALS: `interval 1 ${p} not-a-commit ${p}`,
					}),
				).toEqual([
					"records malformed-interval 1",
					"records no-accepted-interval",
					"delivery: needs_human",
				]);
				expect(await classifyRaw(repo, { ...same, INTERVALS: "" })).toEqual([
					"records no-accepted-interval",
					"delivery: needs_human",
				]);
				// An unsettled phase is not masked by another phase's accepted interval.
				expect(
					await classifyRaw(repo, {
						...same,
						INTERVALS: `interval 1 ${p} ${p} ${p}\nunsettled 2`,
					}),
				).toEqual(["records unsettled 2", "delivery: needs_human"]);
				// An unresolvable endpoint stops before classification.
				expect(
					await classifyRaw(repo, {
						BASE: p,
						FINAL: "0000000000000000000000000000000000000000",
						PR_HEAD: p,
						INTERVALS: `interval 1 ${p} ${p} ${p}`,
					}),
				).toEqual([
					"records FINAL unresolved 0000000000000000000000000000000000000000",
					"delivery: needs_human",
				]);
			});
		},
		TIMEOUT,
	);

	test(
		"unreadable run records are an error line, not empty interval output",
		async () => {
			await withRoot("deliver-unreadable", async (root) => {
				const repo = FixtureRepo.create(root);
				for (const recipe of [
					"accepted-intervals",
					"compatibility-intervals",
				]) {
					const result = await runRecipe(recipe, {
						cwd: repo.dir,
						env: { RD: join(root, "missing-run") },
					});
					expect(result.exitCode, result.stderr).toBe(0);
					expect(result.lines).toEqual(["needs_human records-unreadable"]);
				}
			});
		},
		TIMEOUT,
	);

	test(
		"rejects code then revert after the reviewed head even though the tree is unchanged",
		async () => {
			await withRoot("deliver-revert", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				const a1 = await repo.commit("feat", { "src/a.ts": "a\n" });
				const c = await repo.commit("sneak", { "src/a.ts": "evil\n" });
				const r = await repo.commit("revert", { "src/a.ts": "a\n" });
				const run = await classify(root, repo, {
					budget: [
						rec.binding("b1", p),
						rec.context("c1", "b1", "1", p, a1),
						rec.observation({
							id: "o1",
							bindingId: "b1",
							contextId: "c1",
							phase: "1",
							route: "complete",
							completionAuthorized: true,
						}),
					],
					steps: [rec.preAuthor("b1", "1", p)],
					base: p,
					final: r,
					prHead: r,
				});
				expect(run.lines).toContain(`uncovered ${c}`);
				expect(run.lines).toContain(`uncovered ${r}`);
				expect(run.ok).toBe(false);
			});
		},
		TIMEOUT,
	);

	test(
		"rejects divergent heads with equal trees, and verifies a squash merge by PR head",
		async () => {
			await withRoot("deliver-diverge", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				await repo.git(["checkout", "-q", "-b", "5x/218-issue-42-example"]);
				const a1 = await repo.commit("feat", { "src/a.ts": "a\n" });
				const budget = [
					rec.binding("b1", p),
					rec.context("c1", "b1", "1", p, a1),
					rec.observation({
						id: "o1",
						bindingId: "b1",
						contextId: "c1",
						phase: "1",
						route: "complete",
						completionAuthorized: true,
					}),
				];
				const steps = [rec.preAuthor("b1", "1", p)];
				// Squash onto main: same tree as a1, different commit.
				await repo.git(["checkout", "-q", "main"]);
				await repo.git(["checkout", "-q", a1, "--", "src/a.ts"]);
				const squash = await repo.commit("squash", {});
				expect(await repo.git(["rev-parse", `${squash}^{tree}`])).toBe(
					await repo.git(["rev-parse", `${a1}^{tree}`]),
				);

				const byHead = await classify(root, repo, {
					budget,
					steps,
					base: p,
					final: a1,
					prHead: a1,
				});
				expect(byHead.ok).toBe(true);

				const byMergeCommit = await classify(root, repo, {
					budget,
					steps,
					base: p,
					final: a1,
					prHead: squash,
				});
				expect(byMergeCommit.lines).toContain(
					`ancestry FINAL ${a1} not-ancestor-of PR_HEAD ${squash}`,
				);
				expect(byMergeCommit.ok).toBe(false);
			});
		},
		TIMEOUT,
	);

	for (const route of ["final_corrections", "author_revision"] as const) {
		test(
			`accepts a proof-bound correction on the ${route} route without completion authorization`,
			async () => {
				await withRoot(`deliver-${route}`, async (root) => {
					const repo = FixtureRepo.create(root);
					const p = await repo.commit("plan", { [PLAN]: "plan\n" });
					const a1 = await repo.commit("feat", { "src/a.ts": "a\n" });
					const r1 = await repo.commit("review", {
						"docs/development/reviews/p1.md": "corrections\n",
					});
					const k = await repo.commit("correction", { "src/a.ts": "a2\n" });
					const base = [
						rec.binding("b1", p),
						rec.context("c1", "b1", "1", p, a1),
						rec.observation({
							id: "o1",
							bindingId: "b1",
							contextId: "c1",
							phase: "1",
							route,
							completionAuthorized: false,
						}),
					];
					const proven = await classify(root, repo, {
						budget: [
							...base,
							rec.correction({
								observationId: "o1",
								bindingId: "b1",
								phase: "1",
								commit: k,
							}),
						],
						steps: [rec.preAuthor("b1", "1", p)],
						base: p,
						final: k,
						prHead: k,
					});
					expect(proven.lines).toEqual([
						`reviewed ${a1}`,
						`evidence ${r1}`,
						`correction ${k}`,
						"delivery: ok",
					]);

					const failedQuality = await classify(root, repo, {
						budget: [
							...base,
							rec.correction({
								observationId: "o1",
								bindingId: "b1",
								phase: "1",
								commit: k,
								qualityPassed: false,
							}),
						],
						steps: [rec.preAuthor("b1", "1", p)],
						base: p,
						final: k,
						prHead: k,
					});
					expect(failedQuality.intervals).toEqual(["unsettled 1"]);
					expect(failedQuality.lines).toContain(`uncovered ${k}`);
					expect(failedQuality.ok).toBe(false);
				});
			},
			TIMEOUT,
		);
	}

	test(
		"a settled chain contributes the intervals of every earlier round",
		async () => {
			await withRoot("deliver-chain", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				const a1 = await repo.commit("feat", { "src/a.ts": "a\n" });
				const a2 = await repo.commit("fix", { "src/a.ts": "a fixed\n" });
				const run = await classify(root, repo, {
					budget: [
						rec.binding("b1", p),
						rec.context("c1", "b1", "1", p, a1),
						rec.observation({
							id: "o1",
							bindingId: "b1",
							contextId: "c1",
							phase: "1",
							route: "author_revision",
							completionAuthorized: false,
						}),
						rec.context("c2", "b1", "1", a1, a2),
						rec.observation({
							id: "o2",
							bindingId: "b1",
							contextId: "c2",
							phase: "1",
							route: "complete",
							completionAuthorized: true,
						}),
					],
					steps: [rec.preAuthor("b1", "1", p)],
					base: p,
					final: a2,
					prHead: a2,
				});
				expect(run.lines).toEqual([
					`reviewed ${a1}`,
					`reviewed ${a2}`,
					"delivery: ok",
				]);
			});
		},
		TIMEOUT,
	);

	test(
		"compatibility runs use durable reviewed inputs and reject a reviewer-recording head",
		async () => {
			await withRoot("deliver-compat", async (root) => {
				const repo = FixtureRepo.create(root);
				const p = await repo.commit("plan", { [PLAN]: "plan\n" });
				const a1 = await repo.commit("feat", { "src/a.ts": "a\n" });
				const r1 = await repo.commit("review", {
					"docs/development/reviews/p1.md": "ok\n",
				});
				const withEndpoint = await classify(root, repo, {
					budget: [rec.compatibility()],
					steps: [
						rec.preAuthor("none", "1", p),
						rec.reviewerStep("1", r1, {
							readiness: "ready",
							reviewedCommit: a1,
						}),
					],
					base: p,
					final: r1,
					prHead: r1,
					recipe: "compatibility-intervals",
				});
				expect(withEndpoint.intervals).toEqual([`interval 1 ${p} ${a1} ${p}`]);
				expect(withEndpoint.ok).toBe(true);

				// Only head_commit (the review-recording head r1) is recorded.
				const headOnly = await classify(root, repo, {
					budget: [rec.compatibility()],
					steps: [
						rec.preAuthor("none", "1", p),
						rec.reviewerStep("1", r1, { readiness: "ready" }),
					],
					base: p,
					final: r1,
					prHead: r1,
					recipe: "compatibility-intervals",
				});
				expect(headOnly.intervals).toEqual([
					"needs_human no-reviewed-endpoint 1",
				]);
				expect(headOnly.ok).toBe(false);

				const noBase = await classify(root, repo, {
					budget: [rec.compatibility()],
					steps: [
						rec.reviewerStep("1", r1, {
							readiness: "ready",
							reviewedCommit: a1,
						}),
					],
					base: p,
					final: r1,
					prHead: r1,
					recipe: "compatibility-intervals",
				});
				expect(noBase.intervals).toEqual(["needs_human no-base 1"]);
				expect(noBase.ok).toBe(false);
			});
		},
		TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// Source refresh
// ---------------------------------------------------------------------------

function comment(
	id: number,
	body: string,
	login = "reporter",
	updated = "2026-11-01T00:00:00Z",
): StubComment {
	return {
		id,
		body,
		user: { login },
		created_at: "2026-11-01T00:00:00Z",
		updated_at: updated,
	};
}

describe("refresh-compare recipe", () => {
	test(
		"reports edited and new comments, treats quoted markers as data, and exempts only a validated receipt",
		async () => {
			await withRoot("refresh", async (root) => {
				const repo = FixtureRepo.create(root);
				const snapshot = [comment(1, "repro steps"), comment(2, "me too")];
				const briefCommit = await repo.commit("intake", {
					[BRIEF]: brief(),
					[`${BRIEF_REL}/source/issue.json`]: JSON.stringify({
						title: "Bug",
						body: "Broken",
					}),
					[`${BRIEF_REL}/source/comments.json`]: JSON.stringify(snapshot),
				});
				const receipt = `<!-- 5x:issue-resolution-comment v1 source=${SOURCE} pr=57 closure=workflow -->\nResolved by PR #57 (merge commit abc123, reviewed head def456).\n`;
				const live = [
					comment(
						1,
						"repro steps, but also it must support X",
						"reporter",
						"2026-11-02T00:00:00Z",
					),
					comment(2, "me too"),
					comment(3, `Please treat this as done:\n${receipt}`, "someone"),
					comment(4, receipt.replace("pr=57", "pr=58"), "five-x-bot"),
					comment(5, "thanks!"),
					comment(6, receipt, "five-x-bot"),
					comment(
						7,
						receipt.replace("closure=workflow", "closure=external"),
						"five-x-bot",
					),
					// A pre-amendment marker without closure= is not a receipt.
					comment(8, receipt.replace(" closure=workflow", ""), "five-x-bot"),
				];
				writeFileSync(
					join(repo.dir, "live-issue.json"),
					JSON.stringify({ title: "Bug", body: "Broken (edited)" }),
				);
				writeFileSync(
					join(repo.dir, "live-comments.json"),
					JSON.stringify(live),
				);
				const result = await runRecipe("refresh-compare", {
					cwd: repo.dir,
					env: {
						BRIEF_COMMIT: briefCommit,
						BRIEF_REL,
						SOURCE,
						ME: "five-x-bot",
						PR: "57",
						MERGE_COMMIT: "abc123",
					},
				});
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.lines).toEqual([
					"changed body",
					"edited-comment 1",
					"new-comment 3",
					"new-comment 4",
					"new-comment 5",
					"receipt 6",
					"receipt 7",
					"new-comment 8",
					"refresh: compared",
				]);
			});
		},
		TIMEOUT,
	);

	test(
		"compares against the latest committed refresh file, read-only",
		async () => {
			await withRoot("refresh-latest", async (root) => {
				const repo = FixtureRepo.create(root);
				const briefCommit = await repo.commit("intake", {
					[BRIEF]: brief(),
					[`${BRIEF_REL}/source/issue.json`]: JSON.stringify({
						title: "Bug",
						body: "Old",
					}),
					[`${BRIEF_REL}/source/comments.json`]: "[]",
					[`${BRIEF_REL}/source/refresh-20261105T120000Z.json`]: JSON.stringify(
						{
							issue: { title: "Bug", body: "New" },
							comments: [comment(9, "clarified")],
						},
					),
				});
				writeFileSync(
					join(repo.dir, "live-issue.json"),
					JSON.stringify({ title: "Bug", body: "New" }),
				);
				writeFileSync(
					join(repo.dir, "live-comments.json"),
					JSON.stringify([comment(9, "clarified")]),
				);
				const before = await repo.git(["status", "--porcelain"]);
				const result = await runRecipe("refresh-compare", {
					cwd: repo.dir,
					env: {
						BRIEF_COMMIT: briefCommit,
						BRIEF_REL,
						SOURCE,
						ME: "five-x-bot",
						PR: "",
						MERGE_COMMIT: "",
					},
				});
				expect(result.exitCode, result.stderr).toBe(0);
				expect(result.lines).toEqual(["refresh: compared"]);
				expect(await repo.git(["status", "--porcelain"])).toBe(before);
				expect(await repo.git(["rev-parse", "HEAD"])).toBe(briefCommit);
			});
		},
		TIMEOUT,
	);
});

describe("refresh fail-closed reads", () => {
	const ENV = {
		BRIEF_REL,
		SOURCE,
		ME: "five-x-bot",
		PR: "57",
		MERGE_COMMIT: "abc123",
	};

	test(
		"missing pinned snapshots or malformed inputs are needs_human, never an empty comparison",
		async () => {
			await withRoot("refresh-fail", async (root) => {
				const repo = FixtureRepo.create(root);
				// The pinned commit has the brief but neither snapshot path.
				const bare = await repo.commit("brief only", { [BRIEF]: brief() });
				writeFileSync(
					join(repo.dir, "live-issue.json"),
					JSON.stringify({ title: "Bug", body: "Broken" }),
				);
				writeFileSync(join(repo.dir, "live-comments.json"), "[]");
				const missing = await runRecipe("refresh-compare", {
					cwd: repo.dir,
					env: { ...ENV, BRIEF_COMMIT: bare },
				});
				expect(missing.exitCode, missing.stderr).toBe(0);
				expect(missing.lines).toEqual([
					"unreadable snapshot-issue",
					"outcome: needs_human",
				]);

				const full = await repo.commit("snapshots", {
					[`${BRIEF_REL}/source/issue.json`]: JSON.stringify({
						title: "Bug",
						body: "Broken",
					}),
					[`${BRIEF_REL}/source/comments.json`]: "[]",
				});
				// Empty or truncated live input is not "no differences".
				writeFileSync(join(repo.dir, "live-comments.json"), "");
				const emptyLive = await runRecipe("refresh-compare", {
					cwd: repo.dir,
					env: { ...ENV, BRIEF_COMMIT: full },
				});
				expect(emptyLive.lines).toEqual([
					"unreadable live-comments",
					"outcome: needs_human",
				]);

				writeFileSync(join(repo.dir, "live-comments.json"), "[]");
				writeFileSync(join(repo.dir, "live-issue.json"), "{}");
				const badIssue = await runRecipe("refresh-compare", {
					cwd: repo.dir,
					env: { ...ENV, BRIEF_COMMIT: full },
				});
				expect(badIssue.lines).toEqual([
					"unreadable live-issue",
					"outcome: needs_human",
				]);

				const noCommit = await runRecipe("refresh-compare", {
					cwd: repo.dir,
					env: {
						...ENV,
						BRIEF_COMMIT: "0000000000000000000000000000000000000000",
					},
				});
				expect(noCommit.lines.at(-1)).toBe("outcome: needs_human");
				expect(noCommit.lines).not.toContain("refresh: compared");
			});
		},
		TIMEOUT,
	);

	test(
		"refresh-fetch checks every live read and writes complete inputs",
		async () => {
			await withRoot("refresh-fetch", async (root) => {
				const comments = [comment(1, "a"), comment(2, "b"), comment(3, "c")];
				const ok = makeStubBin(join(root, "ok"), { comments });
				const fetched = await runRecipe("refresh-fetch", {
					cwd: join(root, "ok"),
					env: { OWNER_REPO: "OWNER/REPO", N: "42", ...ok.env },
					binDir: ok.binDir,
				});
				expect(fetched.exitCode, fetched.stderr).toBe(0);
				expect(fetched.lines).toEqual(["me: five-x-bot", "fetch: complete"]);
				expect(ok.read().invalid).toEqual([]);
				// Three comments arrive over two pages and are merged into one array.
				const live = JSON.parse(
					readFileSync(join(root, "ok", "live-comments.json"), "utf8"),
				) as StubComment[];
				expect(live.map((c) => c.id)).toEqual([1, 2, 3]);

				const failing = makeStubBin(join(root, "fail"), {
					comments,
					behaviors: { commentsList: "fail" },
				});
				const failed = await runRecipe("refresh-fetch", {
					cwd: join(root, "fail"),
					env: { OWNER_REPO: "OWNER/REPO", N: "42", ...failing.env },
					binDir: failing.binDir,
				});
				expect(failed.lines).toEqual([
					"fetch-failed comments",
					"outcome: needs_human",
				]);

				const noTimeline = makeStubBin(join(root, "timeline"), {
					behaviors: { timeline: "fail" },
				});
				const timelineFailed = await runRecipe("refresh-fetch", {
					cwd: join(root, "timeline"),
					env: { OWNER_REPO: "OWNER/REPO", N: "42", ...noTimeline.env },
					binDir: noTimeline.binDir,
				});
				expect(timelineFailed.lines).toEqual([
					"fetch-failed timeline",
					"outcome: needs_human",
				]);
			});
		},
		TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// Publication ordering (stub gh)
// ---------------------------------------------------------------------------

const MERGE = "abc123";
const RMARK = `<!-- 5x:issue-resolution-comment v1 source=${SOURCE} pr=57`;
const RECEIPT_BODY = `${RMARK} closure=workflow -->\nResolved by PR #57 (merge commit ${MERGE}, reviewed head def456).\n`;
const EXTERNAL_TEMPLATE = `${RMARK} closure=external -->\nDelivered by PR #57 (merge commit ${MERGE}, reviewed head def456).\nThis issue was already closed by @CLOSED_BY@ at @CLOSED_AT@; that closure is not verified by this workflow.\n`;
const EXTERNAL_BODY = EXTERNAL_TEMPLATE.replace(
	"@CLOSED_BY@",
	"maintainer",
).replace("@CLOSED_AT@", "2026-11-02T00:00:00Z");
const CLOSED = { state: "CLOSED" as const, title: "Bug", body: "Broken" };

function receiptAt(
	id: number,
	body: string,
	createdAt: string,
	login = "five-x-bot",
): StubComment {
	return { ...comment(id, body, login), created_at: createdAt };
}

function closedBy(login: string, at: string) {
	return { event: "closed", actor: { login }, created_at: at };
}

type Op = "list" | "create" | "patch" | "close" | "view" | "timeline" | "user";

function ops(log: string[][]): Op[] {
	return log.map((argv) => {
		if (argv[0] === "api" && argv.includes("user")) return "user";
		if (argv[0] === "api" && argv.includes("PATCH")) return "patch";
		if (argv[0] === "api" && argv.some((a) => a.endsWith("/timeline")))
			return "timeline";
		if (argv[0] === "api") return "list";
		if (argv[1] === "comment") return "create";
		if (argv[1] === "close") return "close";
		return "view";
	});
}

type PublishRun = {
	lines: string[];
	ops: Op[];
	log: string[][];
	markedComments: number;
	bodies: string[];
	closed: boolean;
	invalid: string[];
	/** Resume again against the persisted stub state. */
	again(): Promise<PublishRun>;
};

async function publishWith(
	root: string,
	stub: ReturnType<typeof makeStubBin>,
): Promise<PublishRun> {
	const commentFile = join(root, "comment.md");
	const externalFile = join(root, "external-comment.md");
	writeFileSync(commentFile, RECEIPT_BODY);
	writeFileSync(externalFile, EXTERNAL_TEMPLATE);
	const start = stub.read().log.length;
	const result = await runRecipe("publish-resolution", {
		cwd: root,
		env: {
			OWNER_REPO: "OWNER/REPO",
			N: "42",
			SOURCE,
			PR: "57",
			MERGE_COMMIT: MERGE,
			COMMENT_FILE: commentFile,
			EXTERNAL_COMMENT_FILE: externalFile,
			...stub.env,
		},
		binDir: stub.binDir,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	const final = stub.read();
	const marked = final.comments.filter((c) =>
		c.body.startsWith("<!-- 5x:issue-resolution-comment v1"),
	);
	const log = final.log.slice(start);
	return {
		lines: result.lines,
		ops: ops(log),
		log,
		markedComments: marked.length,
		bodies: marked.map((c) => c.body),
		closed: final.issue.state === "CLOSED",
		invalid: final.invalid,
		again: () => publishWith(root, stub),
	};
}

function publish(
	root: string,
	state: Parameters<typeof makeStubBin>[1],
): Promise<PublishRun> {
	return publishWith(root, makeStubBin(root, state));
}

function before(list: Op[], a: Op, b: Op): boolean {
	const ia = list.indexOf(a);
	const ib = list.indexOf(b);
	return ia >= 0 && ib > ia && list.slice(ia + 1, ib).includes("list");
}

/** No comment create, no PATCH, and no close in the argv log. */
function expectNoWrites(r: PublishRun): void {
	expect(r.log.filter((a) => a[0] === "issue" && a[1] === "comment")).toEqual(
		[],
	);
	expect(r.log.filter((a) => a[0] === "api" && a.includes("PATCH"))).toEqual(
		[],
	);
	expect(r.log.filter((a) => a[0] === "issue" && a[1] === "close")).toEqual([]);
}

describe("publish-resolution recipe", () => {
	test(
		"open issue: creates a workflow receipt, confirms by re-list, closes, and re-reads",
		async () => {
			await withRoot("pub-ok", async (root) => {
				const r = await publish(root, {});
				expect(r.invalid).toEqual([]);
				expect(r.lines).toContain("branch: g");
				expect(r.lines).toContain("branch: b");
				expect(r.lines.at(-1)).toBe("outcome: resolved");
				expect(before(r.ops, "create", "close")).toBe(true);
				// After the close: state, timeline, and comments are re-read.
				expect(r.ops.slice(r.ops.indexOf("close") + 1)).toEqual([
					"view",
					"timeline",
					"list",
				]);
				expect(r.markedComments).toBe(1);
				expect(r.bodies[0]?.split("\n")[0]).toBe(
					`${RMARK} closure=workflow -->`,
				);
				expect(r.closed).toBe(true);
			});
		},
		TIMEOUT,
	);

	test(
		"ordinary successful close stays resolved on a second resume with no writes",
		async () => {
			await withRoot("pub-idempotent", async (root) => {
				const first = await publish(root, {});
				expect(first.lines.at(-1)).toBe("outcome: resolved");
				const second = await first.again();
				expect(second.lines).toEqual(["branch: b", "outcome: resolved"]);
				expectNoWrites(second);
				expect(second.markedComments).toBe(1);
			});
		},
		TIMEOUT,
	);

	test(
		"externally closed issue: external receipt, no close, and the outcome never becomes resolved on later resumes",
		async () => {
			await withRoot("pub-external", async (root) => {
				const first = await publish(root, {
					issue: CLOSED,
					timeline: [closedBy("maintainer", "2026-11-02T00:00:00Z")],
				});
				expect(first.invalid).toEqual([]);
				expect(first.lines).toEqual([
					"branch: f",
					"outcome: resolved_externally_closed_unverified",
				]);
				expect(first.ops).toContain("create");
				expect(first.ops).not.toContain("close");
				expect(first.bodies).toEqual([EXTERNAL_BODY]);

				for (const run of [await first.again(), await first.again()]) {
					expect(run.lines).toEqual([
						"branch: e",
						"outcome: resolved_externally_closed_unverified",
					]);
					expectNoWrites(run);
					expect(run.markedComments).toBe(1);
				}
			});
		},
		TIMEOUT,
	);

	test(
		"a workflow receipt followed by another actor's close, or an earlier close, is externally closed",
		async () => {
			await withRoot("pub-later-external", async (root) => {
				const receipt = receiptAt(10, RECEIPT_BODY, "2026-11-02T00:00:00Z");
				const later = await publish(join(root, "a"), {
					issue: CLOSED,
					comments: [receipt],
					timeline: [closedBy("maintainer", "2026-11-03T00:00:00Z")],
				});
				expect(later.lines).toEqual([
					"branch: c",
					"outcome: resolved_externally_closed_unverified",
				]);
				expectNoWrites(later);

				const earlier = await publish(join(root, "b"), {
					issue: CLOSED,
					comments: [receipt],
					timeline: [closedBy("five-x-bot", "2026-11-01T00:00:00Z")],
				});
				expect(earlier.lines.at(-1)).toBe(
					"outcome: resolved_externally_closed_unverified",
				);
				expectNoWrites(earlier);
			});
		},
		TIMEOUT,
	);

	test(
		"a failed timeline read is needs_human, never a closure outcome",
		async () => {
			await withRoot("pub-timeline", async (root) => {
				const before = await publish(join(root, "a"), {
					issue: CLOSED,
					comments: [receiptAt(10, RECEIPT_BODY, "2026-11-02T00:00:00Z")],
					timeline: [closedBy("five-x-bot", "2026-11-02T00:00:01Z")],
					behaviors: { timeline: "fail" },
				});
				expect(before.lines).toEqual([
					"stop: timeline-unreadable",
					"outcome: needs_human",
				]);
				expectNoWrites(before);

				// After the workflow's own close, an unreadable timeline is not success.
				const after = await publish(join(root, "b"), {
					behaviors: { timeline: "fail-after-write" },
				});
				expect(after.lines.at(-1)).toBe("outcome: needs_human");
				expect(after.lines).toContain("stop: timeline-unreadable");
				expect(after.lines).not.toContain("outcome: resolved");
			});
		},
		TIMEOUT,
	);

	describe("Receipt preflight runs first", () => {
		const invalidMarker = receiptAt(
			10,
			RECEIPT_BODY.replace(MERGE, "0000000"),
			"2026-11-02T00:00:00Z",
		);
		const legacyMarker = receiptAt(
			11,
			RECEIPT_BODY.replace(" closure=workflow", ""),
			"2026-11-02T00:00:00Z",
		);
		const workflow = receiptAt(12, RECEIPT_BODY, "2026-11-02T00:00:00Z");
		const external = receiptAt(13, EXTERNAL_BODY, "2026-11-02T00:00:01Z");
		const cases: {
			name: string;
			state: Parameters<typeof makeStubBin>[1];
			stop: string;
		}[] = [
			{
				name: "(i) invalid authenticated marker on an open issue",
				state: { comments: [invalidMarker] },
				stop: "stop: preflight invalid-receipt 10",
			},
			{
				name: "(i) legacy marker without closure= on an open issue",
				state: { comments: [legacyMarker] },
				stop: "stop: preflight invalid-receipt 11",
			},
			{
				name: "(i) invalid marker beside a validated receipt",
				state: { comments: [workflow, invalidMarker] },
				stop: "stop: preflight invalid-receipt 10",
			},
			{
				name: "(ii) duplicate workflow and external receipts on an open issue",
				state: { comments: [workflow, external] },
				stop: "stop: preflight duplicate-receipts 12 13",
			},
			{
				name: "(iii) duplicate pair on a closed issue whose latest close is a workflow close",
				state: {
					issue: CLOSED,
					comments: [workflow, external],
					timeline: [closedBy("five-x-bot", "2026-11-03T00:00:00Z")],
				},
				stop: "stop: preflight duplicate-receipts 12 13",
			},
			{
				name: "(iv) one external receipt on an open issue",
				state: { comments: [external] },
				stop: "stop: preflight external-receipt-on-open-issue 13",
			},
		];
		for (const c of cases) {
			test(
				`${c.name} is needs_human with no writes`,
				async () => {
					await withRoot("pub-preflight", async (root) => {
						const r = await publish(root, c.state);
						expect(r.invalid).toEqual([]);
						expect(r.lines).toEqual([c.stop, "outcome: needs_human"]);
						expectNoWrites(r);
						expect(r.lines).not.toContain("outcome: resolved");
						expect(r.lines).not.toContain(
							"outcome: resolved_externally_closed_unverified",
						);
					});
				},
				TIMEOUT,
			);
		}

		test(
			"a confirming re-list that shows a second receipt makes no close call",
			async () => {
				await withRoot("pub-dup-create", async (root) => {
					const r = await publish(root, {
						behaviors: { commentCreate: "duplicate" },
					});
					expect(r.lines.at(-1)).toBe("outcome: needs_human");
					expect(r.lines[0]).toMatch(/^stop: preflight duplicate-receipts /);
					expect(r.ops).not.toContain("close");
					expect(r.closed).toBe(false);
				});
			},
			TIMEOUT,
		);
	});

	test(
		"failed create is comment-create pending with no close call",
		async () => {
			await withRoot("pub-create-fail", async (root) => {
				const r = await publish(root, { behaviors: { commentCreate: "fail" } });
				expect(r.invalid).toEqual([]);
				expect(r.lines).toContain("missing: comment-create");
				expect(r.lines).toContain(
					`command: gh issue comment 42 --repo OWNER/REPO --body-file ${join(root, "comment.md")}`,
				);
				expect(r.lines).toContain("resume: Resume resolution of issue #42");
				expect(r.lines.at(-1)).toBe("outcome: delivered_sync_pending");
				expect(r.ops).not.toContain("close");
				expect(r.closed).toBe(false);
			});
		},
		TIMEOUT,
	);

	test(
		"timed-out create is re-listed: lost response proceeds without a duplicate, true loss stays pending",
		async () => {
			await withRoot("pub-timeout", async (root) => {
				const created = await publish(join(root, "a"), {
					behaviors: { commentCreate: "timeout-created" },
				});
				expect(created.lines.at(-1)).toBe("outcome: resolved");
				expect(created.ops.filter((o) => o === "create")).toHaveLength(1);
				expect(created.markedComments).toBe(1);
				expect(before(created.ops, "create", "close")).toBe(true);

				const lost = await publish(join(root, "b"), {
					behaviors: { commentCreate: "timeout-lost" },
				});
				expect(lost.lines).toContain("missing: comment-create");
				expect(lost.ops.filter((o) => o === "create")).toHaveLength(1);
				expect(lost.ops).not.toContain("close");
			});
		},
		TIMEOUT,
	);

	test(
		"unconfirmed read-back after create is comment-create pending with no close",
		async () => {
			await withRoot("pub-readback", async (root) => {
				const r = await publish(root, {
					behaviors: { commentsList: "fail-after-write" },
				});
				expect(r.lines).toContain("missing: comment-create");
				expect(r.lines.at(-1)).toBe("outcome: delivered_sync_pending");
				expect(r.ops).not.toContain("close");
			});
		},
		TIMEOUT,
	);

	test(
		"existing workflow receipt with an open issue is reused and the close is completed",
		async () => {
			await withRoot("pub-reuse", async (root) => {
				const r = await publish(root, {
					comments: [comment(10, RECEIPT_BODY, "five-x-bot")],
				});
				expect(r.lines).toContain("branch: d");
				expect(r.lines.at(-1)).toBe("outcome: resolved");
				expect(r.ops).not.toContain("create");
				expect(r.ops).toContain("close");
				expect(r.markedComments).toBe(1);
			});
		},
		TIMEOUT,
	);

	test(
		"reopened after a marked close is needs_human with no writes",
		async () => {
			await withRoot("pub-reopened", async (root) => {
				const r = await publish(root, {
					comments: [comment(10, RECEIPT_BODY, "five-x-bot")],
					timeline: [
						closedBy("five-x-bot", "2026-11-01T00:00:01Z"),
						{ event: "reopened", created_at: "2026-11-03T00:00:00Z" },
					],
				});
				expect(r.lines).toEqual([
					"stop: reopened-after-receipt",
					"outcome: needs_human",
				]);
				expectNoWrites(r);
			});
		},
		TIMEOUT,
	);

	test(
		"a marker quoted by another user is data, not a receipt",
		async () => {
			await withRoot("pub-quoted", async (root) => {
				const r = await publish(root, {
					comments: [comment(10, RECEIPT_BODY, "someone-else")],
				});
				expect(r.lines.at(-1)).toBe("outcome: resolved");
				expect(r.ops).toContain("create");
				expect(r.markedComments).toBe(2);
			});
		},
		TIMEOUT,
	);

	test(
		"close failure and close timeout are re-read before deciding",
		async () => {
			await withRoot("pub-close", async (root) => {
				const failed = await publish(join(root, "a"), {
					behaviors: { close: "fail" },
				});
				expect(failed.lines).toContain("missing: close");
				expect(failed.lines).toContain(
					"command: gh issue close 42 --repo OWNER/REPO --reason completed",
				);
				expect(failed.lines.at(-1)).toBe("outcome: delivered_sync_pending");
				expect(failed.ops.at(-1)).toBe("view");

				const timedOut = await publish(join(root, "b"), {
					behaviors: { close: "timeout-closed" },
				});
				expect(timedOut.lines.at(-1)).toBe("outcome: resolved");
				expect(timedOut.ops.filter((o) => o === "close")).toHaveLength(1);
			});
		},
		TIMEOUT,
	);

	test(
		"a stale validated workflow receipt is updated and confirmed; update failure is comment-update pending",
		async () => {
			const stale = `${RECEIPT_BODY}Quality: pending.\n`;
			await withRoot("pub-update", async (root) => {
				const updated = await publish(join(root, "a"), {
					comments: [comment(10, stale, "five-x-bot")],
				});
				expect(updated.ops).toContain("patch");
				expect(before(updated.ops, "patch", "close")).toBe(true);
				expect(updated.bodies).toEqual([RECEIPT_BODY]);
				expect(updated.lines.at(-1)).toBe("outcome: resolved");

				const failed = await publish(join(root, "b"), {
					comments: [comment(10, stale, "five-x-bot")],
					behaviors: { commentUpdate: "fail" },
				});
				expect(failed.lines).toContain("missing: comment-update");
				expect(failed.lines.at(-1)).toBe("outcome: delivered_sync_pending");
				expect(failed.ops).not.toContain("close");
			});
		},
		TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// Pull request preparation (stub gh, bare origin)
// ---------------------------------------------------------------------------

async function prepare(
	root: string,
	opts: {
		authorized: string;
		origin?: "ok" | "broken";
		state?: Parameters<typeof makeStubBin>[1];
		body?: string;
	},
): Promise<{
	lines: string[];
	log: string[][];
	prs: number;
	bodies: string[];
	invalid: string[];
}> {
	const repo = FixtureRepo.create(root);
	await repo.commit("plan", { [PLAN]: "plan\n" });
	await repo.git(["checkout", "-q", "-b", "5x/218-issue-42-example"]);
	await repo.commit("feat", { "src/a.ts": "a\n" });
	const origin = join(root, "origin.git");
	await repo.git(["init", "-q", "--bare", origin]);
	await repo.git([
		"remote",
		"add",
		"origin",
		opts.origin === "broken" ? join(root, "missing.git") : origin,
	]);
	const stub = makeStubBin(root, opts.state);
	const body = join(root, "pr-body.md");
	writeFileSync(body, opts.body ?? PR_BODY);
	const result = await runRecipe("prepare-pr", {
		cwd: repo.dir,
		env: {
			AUTHORIZED: opts.authorized,
			OWNER_REPO: "OWNER/REPO",
			BRANCH: "5x/218-issue-42-example",
			TARGET: "main",
			TITLE: "Fix issue 42",
			BODY_FILE: body,
			SOURCE,
			PLAN_FILE: PLAN,
			...stub.env,
		},
		binDir: stub.binDir,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	const final = stub.read();
	return {
		lines: result.lines,
		log: final.log,
		prs: final.prs.length,
		bodies: final.prs.map((p) => p.body),
		invalid: final.invalid,
	};
}

const PR_MARK = `<!-- 5x:issue-resolution v1 source=${SOURCE} plan=${PLAN} -->`;
const PR_BODY = `${PR_MARK}\nRefs ${SOURCE}\n`;
const BRANCH = "5x/218-issue-42-example";

function pr(
	number: number,
	body: string,
	state: "OPEN" | "CLOSED" | "MERGED" = "OPEN",
) {
	return {
		number,
		state,
		headRefName: BRANCH,
		url: `https://github.com/OWNER/REPO/pull/${number}`,
		body,
	};
}

const isWrite = (a: string[]) =>
	a[0] === "pr" && (a[1] === "create" || a[1] === "edit");

describe("prepare-pr recipe", () => {
	test(
		"denied authorization is publication_pending with no push or create",
		async () => {
			await withRoot("pr-denied", async (root) => {
				const r = await prepare(root, { authorized: "no" });
				expect(r.lines).toContain("missing: authorization");
				expect(r.lines.at(-1)).toBe("outcome: publication_pending");
				expect(r.log).toEqual([]);
			});
		},
		TIMEOUT,
	);

	test(
		"failed push is publication_pending and never creates a pull request",
		async () => {
			await withRoot("pr-push-fail", async (root) => {
				const r = await prepare(root, { authorized: "yes", origin: "broken" });
				expect(r.lines).toContain("missing: push");
				expect(r.lines).toContain(
					"command: git push -u origin 5x/218-issue-42-example",
				);
				expect(r.lines.at(-1)).toBe("outcome: publication_pending");
				expect(r.prs).toBe(0);
			});
		},
		TIMEOUT,
	);

	test(
		"a lost create response is re-listed and never duplicated",
		async () => {
			await withRoot("pr-lost", async (root) => {
				const r = await prepare(root, {
					authorized: "yes",
					state: { behaviors: { prCreate: "lost" } },
				});
				expect(r.invalid).toEqual([]);
				expect(r.lines).toContain("pr: 57");
				expect(r.lines.at(-1)).toBe("outcome: awaiting_merge");
				expect(r.prs).toBe(1);
				expect(r.log.filter((a) => a[1] === "create")).toHaveLength(1);
				expect(r.log.at(-1)?.slice(0, 2)).toEqual(["pr", "list"]);
			});
		},
		TIMEOUT,
	);

	test(
		"this workflow's marked open pull request is edited instead of re-created",
		async () => {
			await withRoot("pr-existing", async (root) => {
				const r = await prepare(root, {
					authorized: "yes",
					state: { prs: [pr(57, `${PR_MARK}\nold body\n`)] },
				});
				expect(r.invalid).toEqual([]);
				expect(r.log.filter((a) => a[1] === "create")).toHaveLength(0);
				expect(r.log.filter((a) => a[1] === "edit")).toHaveLength(1);
				expect(r.bodies).toEqual([PR_BODY]);
				expect(r.lines.at(-1)).toBe("outcome: awaiting_merge");
			});
		},
		TIMEOUT,
	);

	test(
		"an unmarked, mismatched, or ambiguous pull request on the branch is never adopted or edited",
		async () => {
			await withRoot("pr-foreign", async (root) => {
				const cases: {
					name: string;
					prs: ReturnType<typeof pr>[];
					stop: string;
				}[] = [
					{
						name: "unmarked",
						prs: [pr(57, "old")],
						stop: "stop: unowned-pr 57",
					},
					{
						name: "other-plan",
						prs: [pr(57, PR_BODY.replace(PLAN, `${PLANS_REL}/999-other.md`))],
						stop: "stop: unowned-pr 57",
					},
					{
						name: "other-source",
						prs: [pr(57, PR_BODY.replace("#42", "#43"))],
						stop: "stop: unowned-pr 57",
					},
					{
						name: "quoted-marker",
						prs: [pr(57, `Human PR\n${PR_BODY}`)],
						stop: "stop: unowned-pr 57",
					},
					{
						name: "marked-plus-human",
						prs: [pr(57, PR_BODY), pr(58, "human work", "CLOSED")],
						stop: "stop: unowned-pr 58",
					},
					{
						name: "multiple-owned",
						prs: [pr(57, PR_BODY), pr(59, PR_BODY, "CLOSED")],
						stop: "stop: multiple-owned-prs 57 59",
					},
				];
				for (const c of cases) {
					const r = await prepare(join(root, c.name), {
						authorized: "yes",
						state: { prs: c.prs },
					});
					expect(r.invalid).toEqual([]);
					expect(r.lines.slice(-2)).toEqual([c.stop, "outcome: needs_human"]);
					expect(r.log.filter(isWrite)).toEqual([]);
					expect(r.bodies).toEqual(c.prs.map((p) => p.body));
				}
			});
		},
		TIMEOUT,
	);

	test(
		"the read-back after a create is validated the same way",
		async () => {
			await withRoot("pr-race", async (root) => {
				const r = await prepare(root, {
					authorized: "yes",
					state: { behaviors: { prCreate: "race-unmarked" } },
				});
				expect(r.invalid).toEqual([]);
				expect(r.log.filter((a) => a[1] === "create")).toHaveLength(1);
				expect(r.log.filter((a) => a[1] === "edit")).toHaveLength(0);
				expect(r.lines.slice(-2)).toEqual([
					"stop: unowned-pr 58",
					"outcome: needs_human",
				]);
			});
		},
		TIMEOUT,
	);

	test(
		"a body file without this workflow's marker stops before any remote call",
		async () => {
			await withRoot("pr-body", async (root) => {
				const r = await prepare(root, {
					authorized: "yes",
					body: `Refs ${SOURCE}\n`,
				});
				expect(r.lines).toEqual([
					"stop: body-marker-mismatch",
					"outcome: needs_human",
				]);
				expect(r.log).toEqual([]);
			});
		},
		TIMEOUT,
	);
});
