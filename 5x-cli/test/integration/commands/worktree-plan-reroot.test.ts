/**
 * Integration test: canonicalizePlanPath re-roots worktree paths to the
 * main repo when CWD is inside a linked worktree.
 *
 * Verifies that running `worktree attach --plan <relative-path>` from
 * inside a worktree stores the main-repo plan path, not the worktree-local
 * copy.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-plan-reroot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function git(cwd: string, args: string[]): void {
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
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(cwd: string, args: string[]): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("canonicalizePlanPath worktree re-root", () => {
	test(
		"worktree attach from inside worktree stores main-repo plan path",
		async () => {
			const dir = makeTmpDir();
			try {
				// Set up a git repo with a plan file
				git(dir, ["init"]);
				git(dir, ["config", "user.email", "test@test.com"]);
				git(dir, ["config", "user.name", "Test"]);

				const planDir = join(dir, "docs", "development");
				mkdirSync(planDir, { recursive: true });
				const planFile = join(planDir, "001-test.plan.md");
				writeFileSync(planFile, "# Plan\n\n## Phase 1\n\n- [ ] Task\n");

				mkdirSync(join(dir, ".5x"), { recursive: true });
				writeFileSync(join(dir, ".gitignore"), ".5x/\n");

				git(dir, ["add", "-A"]);
				git(dir, ["commit", "-m", "init"]);

				// Initialize 5x project
				const initResult = await run5x(dir, ["init"]);
				expect(initResult.exitCode).toBe(0);

				// Create a git worktree
				const wtDir = join(dir, ".5x", "worktrees", "test-wt");
				mkdirSync(join(dir, ".5x", "worktrees"), { recursive: true });
				git(dir, ["worktree", "add", wtDir, "-b", "test-branch"]);

				// The plan file exists in both the main repo and the worktree
				// (worktree shares the same commit)
				const mainPlanPath = join(
					dir,
					"docs",
					"development",
					"001-test.plan.md",
				);
				const wtPlanPath = join(
					wtDir,
					"docs",
					"development",
					"001-test.plan.md",
				);

				// Sanity: plan exists in both locations
				expect(Bun.file(mainPlanPath).size).toBeGreaterThan(0);
				expect(Bun.file(wtPlanPath).size).toBeGreaterThan(0);

				// Run worktree attach FROM INSIDE THE WORKTREE with a relative path
				const attachResult = await run5x(wtDir, [
					"worktree",
					"attach",
					"--plan",
					"docs/development/001-test.plan.md",
					"--path",
					wtDir,
				]);
				expect(attachResult.exitCode).toBe(0);

				const attachData = JSON.parse(attachResult.stdout) as {
					ok: boolean;
					data: { plan_path: string; worktree_path: string };
				};
				expect(attachData.ok).toBe(true);

				// The plan_path should point to the MAIN REPO, not the worktree
				expect(attachData.data.plan_path).toBe(mainPlanPath);
				expect(attachData.data.plan_path).not.toContain(".5x/worktrees");

				// Verify via worktree list from main repo
				const listResult = await run5x(dir, ["worktree", "list"]);
				expect(listResult.exitCode).toBe(0);
				const listData = JSON.parse(listResult.stdout) as {
					ok: boolean;
					data: {
						worktrees: Array<{
							plan_path: string;
							worktree_path: string;
						}>;
					};
				};

				const entry = listData.data.worktrees.find(
					(w) => w.worktree_path === wtDir,
				);
				expect(entry).toBeDefined();
				expect(entry?.plan_path).toBe(mainPlanPath);
				expect(entry?.plan_path).not.toContain(".5x/worktrees");
			} finally {
				// Clean up git worktrees before removing directory
				try {
					git(dir, ["worktree", "remove", "--force", "test-wt"]);
				} catch {}
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run init from inside worktree stores main-repo plan path",
		async () => {
			const dir = makeTmpDir();
			try {
				// Set up a git repo with a plan file
				git(dir, ["init"]);
				git(dir, ["config", "user.email", "test@test.com"]);
				git(dir, ["config", "user.name", "Test"]);

				const planDir = join(dir, "docs", "development");
				mkdirSync(planDir, { recursive: true });
				const planFile = join(planDir, "002-test.plan.md");
				writeFileSync(planFile, "# Plan\n\n## Phase 1\n\n- [ ] Task\n");

				mkdirSync(join(dir, ".5x"), { recursive: true });
				writeFileSync(join(dir, ".gitignore"), ".5x/\n");

				git(dir, ["add", "-A"]);
				git(dir, ["commit", "-m", "init"]);

				// Initialize 5x project
				await run5x(dir, ["init"]);

				// Create a git worktree
				const wtDir = join(dir, ".5x", "worktrees", "test-wt2");
				mkdirSync(join(dir, ".5x", "worktrees"), { recursive: true });
				git(dir, ["worktree", "add", wtDir, "-b", "test-branch-2"]);

				// Run init from inside the worktree with a relative plan path
				const initResult = await run5x(wtDir, [
					"run",
					"init",
					"--plan",
					"docs/development/002-test.plan.md",
					"--allow-dirty",
				]);
				expect(initResult.exitCode).toBe(0);

				const initData = JSON.parse(initResult.stdout) as {
					ok: boolean;
					data: { plan_path: string; run_id: string };
				};
				expect(initData.ok).toBe(true);

				// The plan_path should point to the MAIN REPO
				const mainPlanPath = join(
					dir,
					"docs",
					"development",
					"002-test.plan.md",
				);
				expect(initData.data.plan_path).toBe(mainPlanPath);
				expect(initData.data.plan_path).not.toContain(".5x/worktrees");
			} finally {
				try {
					git(dir, ["worktree", "remove", "--force", "test-wt2"]);
				} catch {}
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"plan path unique to worktree is NOT re-rooted",
		async () => {
			const dir = makeTmpDir();
			try {
				// Set up a git repo
				git(dir, ["init"]);
				git(dir, ["config", "user.email", "test@test.com"]);
				git(dir, ["config", "user.name", "Test"]);

				mkdirSync(join(dir, ".5x"), { recursive: true });
				writeFileSync(join(dir, ".gitignore"), ".5x/\n");
				writeFileSync(join(dir, "README.md"), "# Test\n");

				git(dir, ["add", "-A"]);
				git(dir, ["commit", "-m", "init"]);

				// Initialize 5x project
				await run5x(dir, ["init"]);

				// Create a git worktree
				const wtDir = join(dir, ".5x", "worktrees", "test-wt3");
				mkdirSync(join(dir, ".5x", "worktrees"), { recursive: true });
				git(dir, ["worktree", "add", wtDir, "-b", "test-branch-3"]);

				// Create a plan file ONLY in the worktree (not in main repo)
				const wtPlanDir = join(wtDir, "docs", "development");
				mkdirSync(wtPlanDir, { recursive: true });
				const wtOnlyPlan = join(wtPlanDir, "003-wt-only.plan.md");
				writeFileSync(
					wtOnlyPlan,
					"# WT Only Plan\n\n## Phase 1\n\n- [ ] Task\n",
				);

				// Run init from worktree — plan only exists in worktree
				// Attach the worktree first (worktree attach requires
				// a known git worktree), then run init
				const attachResult = await run5x(wtDir, [
					"worktree",
					"attach",
					"--plan",
					"docs/development/003-wt-only.plan.md",
					"--path",
					wtDir,
				]);
				expect(attachResult.exitCode).toBe(0);

				const attachData = JSON.parse(attachResult.stdout) as {
					ok: boolean;
					data: { plan_path: string };
				};
				expect(attachData.ok).toBe(true);

				// The plan_path should stay as the worktree path since
				// the file doesn't exist in the main repo
				expect(attachData.data.plan_path).toContain("test-wt3");
			} finally {
				try {
					git(dir, ["worktree", "remove", "--force", "test-wt3"]);
				} catch {}
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);
});
