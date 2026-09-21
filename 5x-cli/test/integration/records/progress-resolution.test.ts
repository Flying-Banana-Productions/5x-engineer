/**
 * Progress resolution: `plan list` / `plan phases` / `run state --plan`
 * against a scripted real-git fixture (`207` §2.4).
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitLogNameOnly } from "../../../src/git.js";
import {
	parseLogNameOnly,
	resolvePlanProgress,
} from "../../../src/records/resolve.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(prefix: string): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().trim();
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	git(["branch", "-M", "main"], dir);
}

function planMarkdown(title: string, phaseDone: boolean[]): string {
	const phases = phaseDone.map((done, i) => {
		const n = i + 1;
		const mark = done ? "x" : " ";
		return `## Phase ${n}: P${n}\n\n- [${mark}] task ${n}\n`;
	});
	return `# ${title}\n\n${phases.join("\n")}`;
}

function commitPlan(
	dir: string,
	rel: string,
	markdown: string,
	message: string,
): void {
	const abs = join(dir, rel);
	mkdirSync(resolve(abs, ".."), { recursive: true });
	writeFileSync(abs, markdown);
	git(["add", "--", rel], dir);
	git(["commit", "-m", message], dir);
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(
	cwd: string,
	args: string[],
	timeoutMs = 25000,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill("SIGINT"), timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

const PLAN_REL = "docs/development/alpha.md";

async function resolveAlpha(dir: string) {
	return resolvePlanProgress({
		workdir: dir,
		planPath: join(dir, PLAN_REL),
		planSlug: "alpha",
		recordsRelPath: "docs/development/runs",
	});
}

async function listedPlans(dir: string, args: string[] = []) {
	const list = await run5x(dir, ["plan", "list", ...args]);
	expect(list.exitCode).toBe(0);
	return (
		parseJson(list.stdout).data as {
			plans: Array<{
				plan_path: string;
				source: string;
				plan_state: string;
				title: string;
				completion_pct: number;
				diverged_sources?: Array<{
					source: string;
					ref?: string;
					plan_state: string;
				}>;
			}>;
		}
	).plans;
}

describe("progress resolution", () => {
	test.each([false, true])(
		"archive moves take effect before commit (staged: %s)",
		async (staged) => {
			const dir = makeTmpDir("5x-prog-uncommitted-archive");
			try {
				initRepo(dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [true]), "add alpha");
				git(["branch", "5x/alpha"], dir);
				mkdirSync(join(dir, "docs/archive"), { recursive: true });
				renameSync(join(dir, PLAN_REL), join(dir, "docs/archive/alpha.md"));
				if (staged) git(["add", "-A"], dir);
				expect((await resolveAlpha(dir)).state).toBe("deleted");
				expect(await listedPlans(dir)).toEqual([]);
				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).not.toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"merged remote copies cannot resurrect an archived plan; explicit reintroduction works",
		async () => {
			const dir = makeTmpDir("5x-prog-archive");
			try {
				initRepo(dir);
				git(["checkout", "-b", "5x/alpha"], dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [true]), "add alpha");
				git(["update-ref", "refs/remotes/origin/5x/alpha", "HEAD"], dir);
				git(["checkout", "main"], dir);
				git(["merge", "--no-ff", "5x/alpha", "-m", "merge alpha"], dir);
				git(["branch", "-d", "5x/alpha"], dir);
				mkdirSync(join(dir, "docs/archive"), { recursive: true });
				renameSync(join(dir, PLAN_REL), join(dir, "docs/archive/alpha.md"));
				git(["add", "-A"], dir);
				git(["commit", "-m", "archive alpha"], dir);
				git(["branch", "5x/bravo"], dir);
				expect(await listedPlans(dir)).toEqual([]);
				expect(await listedPlans(dir, ["--all-refs"])).toEqual([]);
				const resolved = await resolveAlpha(dir);
				expect(resolved.state).toBe("deleted");
				expect(resolved.markdown).toBeNull();
				expect(resolved.source.label).toBe("HEAD");
				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).not.toBe(0);
				expect(parseJson(phases.stdout).error).toMatchObject({
					code: "PLAN_NOT_FOUND",
					detail: { plan_state: "deleted" },
				});

				// An untracked recreation uses checkout attribution, not the archive commit.
				mkdirSync(join(dir, "docs/development"), { recursive: true });
				writeFileSync(
					join(dir, PLAN_REL),
					planMarkdown("Reintroduced", [false]),
				);
				const local = await resolveAlpha(dir);
				expect(local.state).toBe("present");
				expect(local.source.label).toBe("HEAD");
				expect(local.commit).toBeNull();
				expect((await listedPlans(dir))[0]?.title).toBe("Reintroduced");
				git(["add", PLAN_REL], dir);
				git(["commit", "-m", "reintroduce alpha"], dir);
				expect((await resolveAlpha(dir)).state).toBe("present");
				expect((await listedPlans(dir))[0]?.title).toBe("Reintroduced");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"deletion on a newer unrelated branch beats an older checkout copy",
		async () => {
			const dir = makeTmpDir("5x-prog-newer-deletion");
			try {
				initRepo(dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [true]), "add alpha");
				git(["checkout", "-b", "5x/bravo"], dir);
				git(["rm", PLAN_REL], dir);
				git(["commit", "-m", "delete alpha"], dir);
				git(["checkout", "main"], dir);
				expect(existsSync(join(dir, PLAN_REL))).toBe(true);
				expect((await resolveAlpha(dir)).state).toBe("deleted");
				expect(await listedPlans(dir)).toEqual([]);
				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).not.toBe(0);
				expect(parseJson(phases.stdout).error).toMatchObject({
					code: "PLAN_NOT_FOUND",
				});
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"divergent deletion and modification remain explicit instead of hiding the live plan",
		async () => {
			const dir = makeTmpDir("5x-prog-delete-modify");
			try {
				initRepo(dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [false]), "base alpha");
				git(["checkout", "-b", "5x/alpha"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [true]),
					"finish alpha",
				);
				git(["checkout", "main"], dir);
				git(["rm", PLAN_REL], dir);
				git(["commit", "-m", "delete alpha"], dir);
				const resolved = await resolveAlpha(dir);
				expect(resolved.state).toBe("diverged");
				expect(resolved.markdown).toContain("- [x]");
				const row = (await listedPlans(dir))[0];
				expect(row?.source).toBe("diverged");
				expect(row?.completion_pct).toBe(100);
				expect(row?.diverged_sources).toEqual([
					{ source: "HEAD", ref: "HEAD", plan_state: "deleted" },
					{ source: "5x/alpha", ref: "5x/alpha", plan_state: "present" },
				]);
				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).toBe(0);
				expect(parseJson(phases.stdout).data).toMatchObject({
					plan_state: "diverged",
					diverged_sources: row?.diverged_sources,
				});
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"nested archive paths are excluded from both disk and branch discovery",
		async () => {
			const dir = makeTmpDir("5x-prog-nested-archive");
			try {
				initRepo(dir);
				writeFileSync(
					join(dir, "5x.toml"),
					'[paths]\narchive = "docs/development/retired"\n',
				);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [false]),
					"active plan",
				);
				commitPlan(
					dir,
					"docs/development/retired/old.md",
					planMarkdown("Old", [true]),
					"archived plan",
				);
				commitPlan(
					dir,
					"docs/development/retired-next/new.md",
					planMarkdown("New", [false]),
					"similar directory",
				);
				git(["checkout", "-b", "5x/bravo"], dir);
				commitPlan(
					dir,
					"docs/development/retired/branch-only.md",
					planMarkdown("Old branch", [true]),
					"branch archive",
				);
				git(["checkout", "main"], dir);
				writeFileSync(
					join(dir, "docs/development/retired/untracked.md"),
					planMarkdown("Untracked", [true]),
				);
				expect((await listedPlans(dir)).map((p) => p.plan_path).sort()).toEqual(
					["alpha.md", "retired-next/new.md"],
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"HEAD wins equivalent-progress ties while newer branch progress still wins",
		async () => {
			const dir = makeTmpDir("5x-prog-source-ties");
			try {
				initRepo(dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [false]), "base alpha");
				git(["branch", "5x/alpha"], dir);
				git(["branch", "5x/aaa-unrelated"], dir);
				git(["update-ref", "refs/remotes/origin/5x/alpha", "HEAD"], dir);
				commitPlan(
					dir,
					"unrelated.txt",
					"unrelated",
					"advance main without touching alpha",
				);
				expect((await listedPlans(dir))[0]?.source).toBe("HEAD");
				expect((await resolveAlpha(dir)).source.label).toBe("HEAD");
				git(["checkout", "5x/alpha"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [true]),
					"finish alpha",
				);
				git(["checkout", "main"], dir);
				expect((await listedPlans(dir))[0]).toMatchObject({
					source: "5x/alpha",
					completion_pct: 100,
				});
				expect((await resolveAlpha(dir)).source.label).toBe("5x/alpha");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
	test(
		"batched history includes plan progress resolved in a merge commit",
		async () => {
			const dir = makeTmpDir("5x-prog-merge-history");
			try {
				initRepo(dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [false, false]),
					"add plan",
				);
				git(["checkout", "-b", "side"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [false, true]),
					"side progress",
				);
				git(["checkout", "main"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [true, false]),
					"main progress",
				);
				git(["merge", "--no-commit", "-s", "ours", "side"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [true, true]),
					"resolve progress",
				);
				const merge = git(["rev-parse", "HEAD"], dir);
				const history = await gitLogNameOnly(dir, ["HEAD"], [PLAN_REL]);
				expect(parseLogNameOnly(history ?? "")[0]).toEqual({
					commit: merge,
					files: [PLAN_REL],
				});
				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).toBe(0);
				const data = parseJson(phases.stdout).data as {
					source_commit: string;
					phases: Array<{ done: boolean }>;
				};
				expect(data.source_commit).toBe(merge);
				expect(data.phases.every((phase) => phase.done)).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"batched history parses filenames from real git output across commits",
		async () => {
			const dir = makeTmpDir("5x-prog-history");
			try {
				initRepo(dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [false]), "add plan");
				const first = git(["rev-parse", "HEAD"], dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [true]), "finish plan");
				const second = git(["rev-parse", "HEAD"], dir);
				const history = await gitLogNameOnly(dir, ["HEAD"], [PLAN_REL]);
				expect(history).not.toBeNull();
				expect(parseLogNameOnly(history ?? "")).toEqual([
					{ commit: second, files: [PLAN_REL] },
					{ commit: first, files: [PLAN_REL] },
				]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"merged: squash-merge + deleted branch reports source HEAD",
		async () => {
			const dir = makeTmpDir("5x-prog-merged");
			try {
				initRepo(dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [false]), "add plan");
				git(["checkout", "-b", "5x/alpha"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [true]),
					"complete phase 1",
				);
				git(["checkout", "main"], dir);
				git(["merge", "--squash", "5x/alpha"], dir);
				git(["commit", "-m", "squash alpha"], dir);
				git(["branch", "-D", "5x/alpha"], dir);

				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).toBe(0);
				const pdata = parseJson(phases.stdout).data as {
					source: string;
					phases: Array<{ done: boolean }>;
				};
				expect(pdata.source).toBe("HEAD");
				expect(pdata.phases[0]?.done).toBe(true);

				const list = await run5x(dir, ["plan", "list"]);
				expect(list.exitCode).toBe(0);
				const row = (
					parseJson(list.stdout).data as {
						plans: Array<{
							plan_path: string;
							source: string;
							completion_pct: number;
						}>;
					}
				).plans.find((p) => p.plan_path === "alpha.md");
				expect(row?.source).toBe("HEAD");
				expect(row?.completion_pct).toBe(100);

				const text = await run5x(dir, ["--text", "plan", "list"]);
				expect(text.stdout).toContain("Source");
				expect(text.stdout).toContain("HEAD");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"stacked: plan B untouched on A is not diverged",
		async () => {
			const dir = makeTmpDir("5x-prog-stacked");
			try {
				initRepo(dir);
				const planB = "docs/development/bravo.md";
				const planA = "docs/development/alpha.md";
				git(["checkout", "-b", "5x/bravo"], dir);
				commitPlan(dir, planB, planMarkdown("Bravo", [true]), "plan B");
				git(["checkout", "-b", "5x/alpha"], dir);
				commitPlan(dir, planA, planMarkdown("Alpha", [false]), "plan A");

				const list = await run5x(dir, ["plan", "list"]);
				expect(list.exitCode).toBe(0);
				const plans = (
					parseJson(list.stdout).data as {
						plans: Array<{
							plan_path: string;
							source: string;
							diverged?: boolean;
						}>;
					}
				).plans;
				const bravo = plans.find((p) => p.plan_path === "bravo.md");
				expect(bravo?.diverged).toBeUndefined();
				expect(bravo?.source).not.toBe("diverged");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"diverged: local 5x/slug and origin/5x/slug both edit the plan",
		async () => {
			const root = makeTmpDir("5x-prog-diverged");
			const origin = join(root, "origin.git");
			const clone = join(root, "clone");
			const other = join(root, "other");
			try {
				mkdirSync(origin);
				git(["init", "--bare"], origin);
				initRepo(clone);
				git(["remote", "add", "origin", origin], clone);
				git(["push", "-u", "origin", "main"], clone);
				commitPlan(
					clone,
					PLAN_REL,
					planMarkdown("Alpha", [false, false]),
					"base plan",
				);
				git(["checkout", "-b", "5x/alpha"], clone);
				git(["push", "-u", "origin", "5x/alpha"], clone);

				git(["clone", origin, other], root);
				git(["config", "user.email", "test@test.com"], other);
				git(["config", "user.name", "Test"], other);
				git(["checkout", "5x/alpha"], other);
				commitPlan(
					other,
					PLAN_REL,
					planMarkdown("Alpha", [true, false]),
					"other half",
				);
				git(["push", "origin", "5x/alpha"], other);

				commitPlan(
					clone,
					PLAN_REL,
					planMarkdown("Alpha", [true, true]),
					"local complete",
				);
				git(["fetch", "origin"], clone);

				const list = await run5x(clone, ["plan", "list"]);
				expect(list.exitCode).toBe(0);
				const row = (
					parseJson(list.stdout).data as {
						plans: Array<{
							plan_path: string;
							source: string;
							diverged?: boolean;
							completion_pct: number;
						}>;
					}
				).plans.find((p) => p.plan_path === "alpha.md");
				expect(row?.source).toBe("diverged");
				expect(row?.diverged).toBe(true);
				expect(row?.completion_pct).toBe(100);

				const phases = await run5x(clone, ["plan", "phases", PLAN_REL]);
				const pdata = parseJson(phases.stdout).data as {
					source: string;
					diverged_sources?: Array<{ source: string }>;
				};
				expect(pdata.source).toBe("diverged");
				const labels = pdata.diverged_sources?.map((s) => s.source).sort();
				expect(labels).toContain("HEAD");
				expect(labels).toContain("origin/5x/alpha");

				const text = await run5x(clone, ["--text", "plan", "phases", PLAN_REL]);
				expect(text.stdout).toContain("source: diverged");
			} finally {
				cleanupDir(root);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"branch-only: plan exists only on 5x/slug",
		async () => {
			const dir = makeTmpDir("5x-prog-branch");
			try {
				initRepo(dir);
				git(["checkout", "-b", "5x/alpha"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [false]),
					"branch plan",
				);
				git(["branch", "5x/aaa-unrelated"], dir);
				git(["update-ref", "refs/remotes/origin/5x/alpha", "HEAD"], dir);
				git(["checkout", "main"], dir);
				expect(existsSync(join(dir, PLAN_REL))).toBe(false);

				const list = await run5x(dir, ["plan", "list"]);
				expect(list.exitCode).toBe(0);
				const row = (
					parseJson(list.stdout).data as {
						plans: Array<{ plan_path: string; source: string }>;
					}
				).plans.find((p) => p.plan_path === "alpha.md");
				expect(row).toBeDefined();
				expect(row?.source).toBe("5x/alpha");

				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).toBe(0);
				const pdata = parseJson(phases.stdout).data as { source: string };
				expect(pdata.source).toBe("5x/alpha");
				git(["branch", "-D", "5x/alpha"], dir);
				expect((await listedPlans(dir))[0]?.source).toBe("origin/5x/alpha");
				expect((await resolveAlpha(dir)).source.label).toBe("origin/5x/alpha");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"remote-only: stale tracking without --fetch; --fetch updates",
		async () => {
			const root = makeTmpDir("5x-prog-remote");
			const origin = join(root, "origin.git");
			const clone = join(root, "clone");
			const pusher = join(root, "pusher");
			try {
				mkdirSync(origin);
				git(["init", "--bare"], origin);
				initRepo(clone);
				git(["remote", "add", "origin", origin], clone);
				git(["push", "-u", "origin", "main"], clone);
				git(["checkout", "-b", "5x/alpha"], clone);
				commitPlan(
					clone,
					PLAN_REL,
					planMarkdown("Alpha", [false]),
					"remote v1",
				);
				git(["push", "-u", "origin", "5x/alpha"], clone);
				git(["checkout", "main"], clone);
				git(["branch", "-D", "5x/alpha"], clone);

				const stale = await run5x(clone, ["plan", "phases", PLAN_REL]);
				expect(stale.exitCode).toBe(0);
				const staleData = parseJson(stale.stdout).data as {
					source: string;
					source_age_seconds?: number;
					phases: Array<{ done: boolean }>;
				};
				expect(staleData.source).toBe("origin/5x/alpha");
				expect(typeof staleData.source_age_seconds).toBe("number");
				expect(staleData.phases[0]?.done).toBe(false);

				git(["clone", origin, pusher], root);
				git(["config", "user.email", "test@test.com"], pusher);
				git(["config", "user.name", "Test"], pusher);
				git(["checkout", "5x/alpha"], pusher);
				commitPlan(
					pusher,
					PLAN_REL,
					planMarkdown("Alpha", [true]),
					"remote v2",
				);
				git(["push", "origin", "5x/alpha"], pusher);

				const noFetch = await run5x(clone, ["plan", "phases", PLAN_REL]);
				const noFetchData = parseJson(noFetch.stdout).data as {
					source_commit?: string;
					phases: Array<{ done: boolean }>;
				};
				expect(noFetchData.phases[0]?.done).toBe(false);

				const fetched = await run5x(clone, [
					"plan",
					"phases",
					PLAN_REL,
					"--fetch",
				]);
				expect(fetched.exitCode).toBe(0);
				const fetchedData = parseJson(fetched.stdout).data as {
					source: string;
					phases: Array<{ done: boolean }>;
				};
				expect(fetchedData.source).toBe("origin/5x/alpha");
				expect(fetchedData.phases[0]?.done).toBe(true);
			} finally {
				cleanupDir(root);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"worktree: mapped worktree with newer checklist wins",
		async () => {
			const dir = makeTmpDir("5x-prog-wt");
			try {
				initRepo(dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [false]), "add plan");
				const init = await run5x(dir, [
					"run",
					"init",
					"--plan",
					PLAN_REL,
					"--worktree",
				]);
				expect(init.exitCode).toBe(0);
				const initData = parseJson(init.stdout).data as {
					worktree_path?: string;
				};
				const wt = initData.worktree_path;
				expect(wt && existsSync(wt)).toBe(true);
				if (!wt) throw new Error("missing worktree");
				writeFileSync(join(wt, PLAN_REL), planMarkdown("Alpha", [true]));

				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).toBe(0);
				const pdata = parseJson(phases.stdout).data as {
					source: string;
					phases: Array<{ done: boolean }>;
				};
				expect(pdata.source).toBe("worktree");
				expect(pdata.phases[0]?.done).toBe(true);

				const text = await run5x(dir, ["--text", "plan", "phases", PLAN_REL]);
				expect(text.stdout).not.toMatch(/^source:/m);

				// A mapped checkout's removal must not fall back to the root copy.
				rmSync(join(wt, PLAN_REL));
				expect(existsSync(join(dir, PLAN_REL))).toBe(true);
				expect(await listedPlans(dir)).toEqual([]);
				const removed = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(removed.exitCode).not.toBe(0);
				expect(parseJson(removed.stdout).error).toMatchObject({
					code: "PLAN_NOT_FOUND",
					detail: { plan_state: "deleted", source: "worktree" },
				});
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run state --plan reads git records when SQLite has no run",
		async () => {
			const dir = makeTmpDir("5x-prog-state");
			try {
				initRepo(dir);
				git(["checkout", "-b", "5x/alpha"], dir);
				commitPlan(dir, PLAN_REL, planMarkdown("Alpha", [false]), "plan");
				const runId = "run_gitonly01";
				const recDir = join(dir, "docs", "development", "runs", "alpha", runId);
				mkdirSync(recDir, { recursive: true });
				writeFileSync(
					join(recDir, "run.json"),
					`${JSON.stringify(
						{
							id: runId,
							plan_path: join(dir, PLAN_REL),
							config_json: null,
							created_at: "2026-01-01T00:00:00.000Z",
							sealed_at: null,
							status: "active",
							final_head_commit: null,
							cli_version: "1.0.0",
							format_version: 1,
							creator: {
								installation_id: "00000000-0000-4000-8000-000000000001",
							},
						},
						null,
						2,
					)}\n`,
				);
				writeFileSync(
					join(recDir, "steps.jsonl"),
					`${JSON.stringify({
						schema_version: 1,
						stream: "steps",
						idempotency_key: `${runId}:run:init:null:1`,
						created_at: "2026-01-01T00:00:01.000Z",
						provenance: "recorded",
						origin: {
							recorder: {
								installation_id: "00000000-0000-4000-8000-000000000001",
							},
							performer: { kind: "system", role: "cli" },
						},
						payload: {
							step_name: "run:init",
							phase: null,
							iteration: 1,
							result_json: { ok: true },
							head_commit: null,
							patch_id: null,
							diff_summary: null,
							duration_ms: null,
							tokens_in: null,
							tokens_out: null,
							cost_usd: null,
							model: null,
						},
					})}\n`,
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "records"], dir);

				const state = await run5x(dir, ["run", "state", "--plan", PLAN_REL]);
				expect(state.exitCode).toBe(0);
				const data = parseJson(state.stdout).data as {
					source: string;
					run: { id: string; status: string };
					steps: Array<{ id?: number; step_name: string }>;
				};
				expect(data.source).toBe("HEAD");
				expect(data.run.id).toBe(runId);
				expect(data.run.status).toBe("active");
				expect(data.steps[0]?.step_name).toBe("run:init");
				expect(data.steps[0]?.id).toBeUndefined();
				git(["update-ref", "refs/remotes/origin/5x/alpha", "HEAD"], dir);
				git(["rm", PLAN_REL], dir);
				git(["commit", "-m", "delete plan but retain run history"], dir);
				git(["branch", "5x/bravo"], dir);
				expect(await listedPlans(dir)).toEqual([]);
				const deletedState = await run5x(dir, [
					"run",
					"state",
					"--plan",
					PLAN_REL,
				]);
				expect(deletedState.exitCode).toBe(0);
				expect(parseJson(deletedState.stdout).data).toMatchObject({
					source: "HEAD",
					plan_state: "deleted",
					run: { id: runId },
				});
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--all-refs discovers a non-conventional branch",
		async () => {
			const dir = makeTmpDir("5x-prog-allrefs");
			try {
				initRepo(dir);
				git(["checkout", "-b", "feature/alpha"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [true]),
					"feature plan",
				);
				git(["checkout", "main"], dir);

				const without = await run5x(dir, ["plan", "list"]);
				const withoutPlans = (
					parseJson(without.stdout).data as {
						plans: Array<{ plan_path: string }>;
					}
				).plans;
				expect(
					withoutPlans.find((p) => p.plan_path === "alpha.md"),
				).toBeUndefined();

				const withAll = await run5x(dir, ["plan", "list", "--all-refs"]);
				expect(withAll.exitCode).toBe(0);
				const row = (
					parseJson(withAll.stdout).data as {
						plans: Array<{ plan_path: string; source: string }>;
					}
				).plans.find((p) => p.plan_path === "alpha.md");
				expect(row).toBeDefined();
				expect(row?.source).toBe("feature/alpha");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"plans.branch: plan exists only on the configured plans branch",
		async () => {
			const dir = makeTmpDir("5x-prog-plans-branch");
			try {
				initRepo(dir);
				git(["checkout", "-b", "release/plans"], dir);
				commitPlan(
					dir,
					PLAN_REL,
					planMarkdown("Alpha", [true]),
					"plans-branch plan",
				);
				const runId = "run_plansbranch01";
				const recDir = join(dir, "docs", "development", "runs", "alpha", runId);
				mkdirSync(recDir, { recursive: true });
				writeFileSync(
					join(recDir, "run.json"),
					`${JSON.stringify(
						{
							id: runId,
							plan_path: PLAN_REL,
							config_json: {},
							created_at: "2026-01-01T00:00:00.000Z",
							sealed_at: null,
							status: "active",
							final_head_commit: null,
							cli_version: "1.0.0",
							format_version: 1,
							creator: {
								installation_id: "00000000-0000-4000-8000-000000000001",
							},
						},
						null,
						2,
					)}\n`,
				);
				writeFileSync(
					join(recDir, "steps.jsonl"),
					`${JSON.stringify({
						schema_version: 1,
						stream: "steps",
						idempotency_key: `${runId}:run:init:null:1`,
						created_at: "2026-01-01T00:00:01.000Z",
						provenance: "recorded",
						origin: {
							recorder: {
								installation_id: "00000000-0000-4000-8000-000000000001",
							},
							performer: { kind: "system", role: "cli" },
						},
						payload: {
							step_name: "run:init",
							phase: null,
							iteration: 1,
							result_json: { ok: true },
							head_commit: null,
							patch_id: null,
							diff_summary: null,
							duration_ms: null,
							tokens_in: null,
							tokens_out: null,
							cost_usd: null,
							model: null,
						},
					})}\n`,
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "records"], dir);
				git(["branch", "5x/aaa-unrelated"], dir);
				git(["branch", "5x/alpha"], dir);
				git(["checkout", "main"], dir);
				expect(existsSync(join(dir, PLAN_REL))).toBe(false);

				writeFileSync(
					join(dir, "5x.toml"),
					`[plans]\nbranch = "release/plans"\n`,
				);

				const list = await run5x(dir, ["plan", "list"]);
				expect(list.exitCode).toBe(0);
				const row = (
					parseJson(list.stdout).data as {
						plans: Array<{
							plan_path: string;
							source: string;
							source_ref?: string;
							completion_pct: number;
						}>;
					}
				).plans.find((p) => p.plan_path === "alpha.md");
				expect(row).toBeDefined();
				expect(row?.source).toBe("release/plans");
				expect(row?.source_ref).toBe("release/plans");
				expect(row?.completion_pct).toBe(100);

				const phases = await run5x(dir, ["plan", "phases", PLAN_REL]);
				expect(phases.exitCode).toBe(0);
				const pdata = parseJson(phases.stdout).data as {
					source: string;
					source_ref?: string;
					source_commit?: string;
					phases: Array<{ done: boolean }>;
				};
				expect(pdata.source).toBe("release/plans");
				expect(pdata.source_ref).toBe("release/plans");
				expect(typeof pdata.source_commit).toBe("string");
				expect(pdata.phases[0]?.done).toBe(true);

				const state = await run5x(dir, ["run", "state", "--plan", PLAN_REL]);
				expect(state.exitCode).toBe(0);
				const sdata = parseJson(state.stdout).data as {
					source: string;
					source_ref?: string;
					run: { id: string };
				};
				expect(sdata.source).toBe("release/plans");
				expect(sdata.source_ref).toBe("release/plans");
				expect(sdata.run.id).toBe(runId);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);
});
