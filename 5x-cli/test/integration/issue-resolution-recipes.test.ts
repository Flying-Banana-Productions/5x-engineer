/**
 * Executable checks for the `5x-issue-resolution` skill's documented
 * recipes. Each test extracts a `# recipe:` block from the rendered skill and
 * runs it with real `git` on a temp repository, with a stub `gh` / `5x` on
 * PATH. These prove the command recipes behave as written; they do not prove
 * an agent follows them.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
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
			"prepare-pr",
			"publish-resolution",
			"refresh-compare",
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
					env: { MARK, SOURCE, PLANS_REL },
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
				expect(gated.ok).toBe(false);
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
				const receipt = `<!-- 5x:issue-resolution-comment v1 source=${SOURCE} pr=57 -->\nResolved by PR #57 (merge commit abc123, reviewed head def456).\n`;
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
				expect(result.lines).toEqual([]);
				expect(await repo.git(["status", "--porcelain"])).toBe(before);
				expect(await repo.git(["rev-parse", "HEAD"])).toBe(briefCommit);
			});
		},
		TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// Publication ordering (stub gh)
// ---------------------------------------------------------------------------

const MERGE = "abc123";
const RECEIPT_BODY = `<!-- 5x:issue-resolution-comment v1 source=${SOURCE} pr=57 -->\nResolved by PR #57 (merge commit ${MERGE}, reviewed head def456).\n`;

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

async function publish(
	root: string,
	state: Parameters<typeof makeStubBin>[1],
): Promise<{
	lines: string[];
	ops: Op[];
	markedComments: number;
	closed: boolean;
	invalid: string[];
}> {
	const stub = makeStubBin(root, state);
	const commentFile = join(root, "comment.md");
	writeFileSync(commentFile, RECEIPT_BODY);
	const result = await runRecipe("publish-resolution", {
		cwd: root,
		env: {
			OWNER_REPO: "OWNER/REPO",
			N: "42",
			SOURCE,
			PR: "57",
			MERGE_COMMIT: MERGE,
			COMMENT_FILE: commentFile,
			GH_STUB_STATE: stub.statePath,
		},
		binDir: stub.binDir,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	const final = stub.read();
	return {
		lines: result.lines,
		ops: ops(final.log),
		markedComments: final.comments.filter((c) =>
			c.body.startsWith("<!-- 5x:issue-resolution-comment v1"),
		).length,
		closed: final.issue.state === "CLOSED",
		invalid: final.invalid,
	};
}

function before(list: Op[], a: Op, b: Op): boolean {
	const ia = list.indexOf(a);
	const ib = list.indexOf(b);
	return ia >= 0 && ib > ia && list.slice(ia + 1, ib).includes("list");
}

describe("publish-resolution recipe", () => {
	test(
		"open issue: creates, confirms by re-list, then closes and re-reads",
		async () => {
			await withRoot("pub-ok", async (root) => {
				const r = await publish(root, {});
				expect(r.invalid).toEqual([]);
				expect(r.lines.at(-1)).toBe("outcome: resolved");
				expect(before(r.ops, "create", "close")).toBe(true);
				expect(r.ops.at(-1)).toBe("view");
				expect(r.markedComments).toBe(1);
				expect(r.closed).toBe(true);
			});
		},
		TIMEOUT,
	);

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
		"second resume after a successful close makes no writes",
		async () => {
			await withRoot("pub-idempotent", async (root) => {
				const r = await publish(root, {
					issue: { state: "CLOSED", title: "Bug", body: "Broken" },
					comments: [comment(10, RECEIPT_BODY, "five-x-bot")],
				});
				expect(r.lines.at(-1)).toBe("outcome: resolved");
				expect(r.ops).not.toContain("create");
				expect(r.ops).not.toContain("patch");
				expect(r.ops).not.toContain("close");
			});
		},
		TIMEOUT,
	);

	test(
		"existing marked comment with an open issue is reused and the close is completed",
		async () => {
			await withRoot("pub-reuse", async (root) => {
				const r = await publish(root, {
					comments: [comment(10, RECEIPT_BODY, "five-x-bot")],
				});
				expect(r.lines.at(-1)).toBe("outcome: resolved");
				expect(r.ops).not.toContain("create");
				expect(r.ops).toContain("close");
				expect(r.markedComments).toBe(1);
			});
		},
		TIMEOUT,
	);

	test(
		"externally closed issue gets a marked comment and no close call",
		async () => {
			await withRoot("pub-external", async (root) => {
				const r = await publish(root, {
					issue: { state: "CLOSED", title: "Bug", body: "Broken" },
				});
				expect(r.lines.at(-1)).toBe(
					"outcome: resolved_externally_closed_unverified",
				);
				expect(r.ops).toContain("create");
				expect(r.ops).not.toContain("close");
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
						{ event: "closed", created_at: "2026-11-01T00:00:01Z" },
						{ event: "reopened", created_at: "2026-11-03T00:00:00Z" },
					],
				});
				expect(r.lines.at(-1)).toBe("outcome: needs_human");
				expect(r.ops).not.toContain("create");
				expect(r.ops).not.toContain("close");
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
		"stale marked comment is updated and confirmed; update failure is comment-update pending",
		async () => {
			const stale = RECEIPT_BODY.replace(MERGE, "0000000");
			await withRoot("pub-update", async (root) => {
				const updated = await publish(join(root, "a"), {
					comments: [comment(10, stale, "five-x-bot")],
				});
				expect(updated.ops).toContain("patch");
				expect(before(updated.ops, "patch", "close")).toBe(true);
				expect(updated.lines.at(-1)).toBe("outcome: resolved");

				const failed = await publish(join(root, "b"), {
					comments: [comment(10, stale, "five-x-bot")],
					behaviors: { commentUpdate: "fail" },
				});
				expect(failed.lines).toContain("missing: comment-update");
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
	},
): Promise<{
	lines: string[];
	log: string[][];
	prs: number;
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
	writeFileSync(
		body,
		`<!-- 5x:issue-resolution v1 source=${SOURCE} plan=${PLAN} -->\nRefs ${SOURCE}\n`,
	);
	const result = await runRecipe("prepare-pr", {
		cwd: repo.dir,
		env: {
			AUTHORIZED: opts.authorized,
			OWNER_REPO: "OWNER/REPO",
			BRANCH: "5x/218-issue-42-example",
			TARGET: "main",
			TITLE: "Fix issue 42",
			BODY_FILE: body,
			GH_STUB_STATE: stub.statePath,
		},
		binDir: stub.binDir,
	});
	expect(result.exitCode, result.stderr).toBe(0);
	const final = stub.read();
	return {
		lines: result.lines,
		log: final.log,
		prs: final.prs.length,
		invalid: final.invalid,
	};
}

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
		"an existing open pull request is edited instead of re-created",
		async () => {
			await withRoot("pr-existing", async (root) => {
				const r = await prepare(root, {
					authorized: "yes",
					state: {
						prs: [
							{
								number: 57,
								state: "OPEN",
								headRefName: "5x/218-issue-42-example",
								url: "https://github.com/OWNER/REPO/pull/57",
								body: "old",
							},
						],
					},
				});
				expect(r.invalid).toEqual([]);
				expect(r.log.filter((a) => a[1] === "create")).toHaveLength(0);
				expect(r.log.filter((a) => a[1] === "edit")).toHaveLength(1);
				expect(r.lines.at(-1)).toBe("outcome: awaiting_merge");
			});
		},
		TIMEOUT,
	);
});
