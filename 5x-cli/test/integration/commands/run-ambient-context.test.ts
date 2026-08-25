/**
 * Phase 4: two-worktree ambient identity + `run list` marker.
 *
 * Two linked (or attached) worktrees sharing one DB each resolve their own
 * uniquely mapped active run without `--run` / `FIVEX_RUN` / coordinating
 * the pointer. A shared pointer cannot make worktree A select worktree B's run.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initScaffold } from "../../../src/commands/init.handler.js";
import { CURRENT_RUN_FILENAME } from "../../../src/commands/run-pointer.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const env = cleanGitEnv();

function makeTmpDir(prefix = "5x-ambient"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanup(dirs: string[]): void {
	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env,
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

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(
	cwd: string,
	args: string[],
	extraEnv?: Record<string, string | undefined>,
	timeoutMs = 15000,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: { ...env, ...extraEnv },
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

function writePointer(root: string, runId: string): void {
	writeFileSync(join(root, ".5x", CURRENT_RUN_FILENAME), `${runId}\n`);
}

function readPointer(root: string): string | null {
	const path = join(root, ".5x", CURRENT_RUN_FILENAME);
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8").trim();
}

interface DualWorktree {
	root: string;
	planA: string;
	planB: string;
	wtA: string;
	wtB: string;
	runA: string;
	runB: string;
}

async function setupDualWorktree(): Promise<DualWorktree> {
	const root = makeTmpDir();

	git(["init"], root);
	git(["config", "user.email", "test@test.com"], root);
	git(["config", "user.name", "Test"], root);
	writeFileSync(join(root, ".gitignore"), ".5x/\n5x.toml.local\n");
	writeFileSync(join(root, "README.md"), "# Ambient\n");
	git(["add", "."], root);
	git(["commit", "-m", "initial"], root);

	await initScaffold({ startDir: root });
	writeFileSync(join(root, "5x.toml"), 'qualityGates = ["echo ok"]\n');

	const planDir = join(root, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planA = join(planDir, "plan-a.md");
	const planB = join(planDir, "plan-b.md");
	writeFileSync(planA, "# Plan A\n\n## Phase 1\n\n- [ ] Task A\n");
	writeFileSync(planB, "# Plan B\n\n## Phase 1\n\n- [ ] Task B\n");
	git(["add", "-A"], root);
	git(["commit", "-m", "plans and config"], root);

	mkdirSync(join(root, ".5x", "worktrees"), { recursive: true });
	const wtA = join(root, ".5x", "worktrees", "plan-a");
	const wtB = join(root, ".5x", "worktrees", "plan-b");
	git(["worktree", "add", wtA, "-b", "5x/plan-a"], root);
	git(["worktree", "add", wtB, "-b", "5x/plan-b"], root);

	const initA = await run5x(root, [
		"run",
		"init",
		"--plan",
		planA,
		"--worktree",
		wtA,
	]);
	if (initA.exitCode !== 0) {
		throw new Error(`run init A failed: ${initA.stdout}\n${initA.stderr}`);
	}
	const runA = (parseJson(initA.stdout).data as { run_id: string }).run_id;

	const initB = await run5x(root, [
		"run",
		"init",
		"--plan",
		planB,
		"--worktree",
		wtB,
	]);
	if (initB.exitCode !== 0) {
		throw new Error(`run init B failed: ${initB.stdout}\n${initB.stderr}`);
	}
	const runB = (parseJson(initB.stdout).data as { run_id: string }).run_id;

	// Shared pointer names A (init B overwrote it).
	writePointer(root, runA);

	return { root, planA, planB, wtA, wtB, runA, runB };
}

type ListRun = {
	id: string;
	status: string;
	ambient?: boolean;
	ambient_source?: string;
};

function listRuns(stdout: string): ListRun[] {
	return (parseJson(stdout).data as { runs: ListRun[] }).runs;
}

function focused(runs: ListRun[]): ListRun | undefined {
	const marked = runs.filter((r) => r.ambient === true);
	expect(marked.length).toBeLessThanOrEqual(1);
	return marked[0];
}

describe("two-worktree ambient identity", () => {
	test(
		"each worktree resolves its own run; shared pointer cannot cross",
		async () => {
			const ctx = await setupDualWorktree();
			try {
				const stateB = await run5x(ctx.wtB, ["run", "state"]);
				expect(stateB.exitCode).toBe(0);
				const runB = (parseJson(stateB.stdout).data as { run: { id: string } })
					.run;
				expect(runB.id).toBe(ctx.runB);

				const listB = await run5x(ctx.wtB, ["run", "list"]);
				expect(listB.exitCode).toBe(0);
				const listedB = listRuns(listB.stdout);
				const focusB = focused(listedB);
				expect(focusB?.id).toBe(ctx.runB);
				expect(focusB?.ambient_source).toBe("worktree");
				expect(listedB.find((r) => r.id === ctx.runA)?.ambient).toBeUndefined();

				const stateA = await run5x(ctx.wtA, ["run", "state"]);
				expect(stateA.exitCode).toBe(0);
				expect(
					(parseJson(stateA.stdout).data as { run: { id: string } }).run.id,
				).toBe(ctx.runA);

				// Pointer names A; from B, worktree rank still wins.
				writePointer(ctx.root, ctx.runA);
				const stateBAgain = await run5x(ctx.wtB, ["run", "state"]);
				expect(stateBAgain.exitCode).toBe(0);
				expect(
					(parseJson(stateBAgain.stdout).data as { run: { id: string } }).run
						.id,
				).toBe(ctx.runB);

				const listBPointerA = await run5x(ctx.wtB, ["run", "list"]);
				expect(focused(listRuns(listBPointerA.stdout))?.ambient_source).toBe(
					"worktree",
				);
				expect(focused(listRuns(listBPointerA.stdout))?.id).toBe(ctx.runB);

				writePointer(ctx.root, ctx.runB);
				const listAPointerB = await run5x(ctx.wtA, ["run", "list"]);
				const focusA = focused(listRuns(listAPointerB.stdout));
				expect(focusA?.id).toBe(ctx.runA);
				expect(focusA?.ambient_source).toBe("worktree");
			} finally {
				cleanup([ctx.root]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"unmapped checkout with pointer-to-A fails RUN_POINTER_INCOMPATIBLE",
		async () => {
			const ctx = await setupDualWorktree();
			try {
				writePointer(ctx.root, ctx.runA);

				const detach = await run5x(ctx.root, [
					"worktree",
					"detach",
					"--plan",
					ctx.planB,
				]);
				expect(detach.exitCode).toBe(0);

				const state = await run5x(ctx.wtB, ["run", "state"]);
				expect(state.exitCode).not.toBe(0);
				const error = parseJson(state.stdout).error as { code: string };
				expect(error.code).toBe("RUN_POINTER_INCOMPATIBLE");
			} finally {
				cleanup([ctx.root]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"FIVEX_RUN overrides pointer and worktree",
		async () => {
			const ctx = await setupDualWorktree();
			try {
				writePointer(ctx.root, ctx.runB);
				const state = await run5x(ctx.wtB, ["run", "state"], {
					FIVEX_RUN: ctx.runA,
				});
				expect(state.exitCode).toBe(0);
				expect(
					(parseJson(state.stdout).data as { run: { id: string } }).run.id,
				).toBe(ctx.runA);

				const list = await run5x(ctx.wtB, ["run", "list"], {
					FIVEX_RUN: ctx.runA,
				});
				const focus = focused(listRuns(list.stdout));
				expect(focus?.id).toBe(ctx.runA);
				expect(focus?.ambient_source).toBe("environment");
			} finally {
				cleanup([ctx.root]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"two active mappings to B are ambiguous; pointer does not break the tie",
		async () => {
			const ctx = await setupDualWorktree();
			try {
				const planC = join(ctx.root, "docs", "development", "plan-c.md");
				writeFileSync(planC, "# Plan C\n\n## Phase 1\n\n- [ ] Task C\n");
				const initC = await run5x(ctx.root, [
					"run",
					"init",
					"--plan",
					planC,
					"--allow-dirty",
				]);
				expect(initC.exitCode).toBe(0);
				const runC = (parseJson(initC.stdout).data as { run_id: string })
					.run_id;

				const relink = await run5x(ctx.root, [
					"run",
					"relink",
					"--run",
					runC,
					"--worktree",
					ctx.wtB,
				]);
				expect(relink.exitCode).toBe(0);

				writePointer(ctx.root, ctx.runA);

				const state = await run5x(ctx.wtB, ["run", "state"]);
				expect(state.exitCode).not.toBe(0);
				const error = parseJson(state.stdout).error as {
					code: string;
					detail?: { candidates?: string[] };
				};
				expect(error.code).toBe("RUN_CONTEXT_AMBIGUOUS");
				const candidates = error.detail?.candidates ?? [];
				expect(candidates).toContain(ctx.runB);
				expect(candidates).toContain(runC);

				const list = await run5x(ctx.wtB, ["run", "list"]);
				expect(list.exitCode).toBe(0);
				expect(focused(listRuns(list.stdout))).toBeUndefined();
			} finally {
				cleanup([ctx.root]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"optional diff and quality from B use B's mapping without --run",
		async () => {
			const ctx = await setupDualWorktree();
			try {
				writeFileSync(join(ctx.wtA, "README.md"), "# Ambient\nMARKER_A\n");
				writeFileSync(join(ctx.wtB, "README.md"), "# Ambient\nMARKER_B\n");
				writePointer(ctx.root, ctx.runA);

				const diff = await run5x(ctx.wtB, ["diff", "--stat"]);
				expect(diff.exitCode).toBe(0);
				const diffData = parseJson(diff.stdout).data as {
					run_id?: string;
					diff: string;
				};
				expect(diffData.run_id).toBe(ctx.runB);
				expect(diffData.diff).toContain("MARKER_B");
				expect(diffData.diff).not.toContain("MARKER_A");

				const quality = await run5x(ctx.wtB, ["quality", "run"]);
				expect(quality.exitCode).toBe(0);
				const q = parseJson(quality.stdout).data as { passed: boolean };
				expect(q.passed).toBe(true);
			} finally {
				cleanup([ctx.root]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"completing A leaves a pointer that names B",
		async () => {
			const ctx = await setupDualWorktree();
			try {
				writePointer(ctx.root, ctx.runB);
				const complete = await run5x(ctx.root, [
					"run",
					"complete",
					"--run",
					ctx.runA,
				]);
				expect(complete.exitCode).toBe(0);
				expect(readPointer(ctx.root)).toBe(ctx.runB);
			} finally {
				cleanup([ctx.root]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run list marks a completed run via FIVEX_RUN without changing status",
		async () => {
			const ctx = await setupDualWorktree();
			try {
				const complete = await run5x(ctx.root, [
					"run",
					"complete",
					"--run",
					ctx.runA,
				]);
				expect(complete.exitCode).toBe(0);

				const list = await run5x(ctx.root, ["run", "list"], {
					FIVEX_RUN: ctx.runA,
				});
				expect(list.exitCode).toBe(0);
				const focus = focused(listRuns(list.stdout));
				expect(focus?.id).toBe(ctx.runA);
				expect(focus?.status).toBe("completed");
				expect(focus?.ambient_source).toBe("environment");
			} finally {
				cleanup([ctx.root]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run list --text has a Focus column; no marker when identity is none",
		async () => {
			const ctx = await setupDualWorktree();
			try {
				const textB = await run5x(ctx.wtB, ["--text", "run", "list"]);
				expect(textB.exitCode).toBe(0);
				expect(textB.stdout).toContain("Focus");
				expect(textB.stdout).toContain("worktree");
				expect(textB.stdout).toContain(ctx.runB);
				expect(textB.stdout).not.toContain('{"ok"');

				rmSync(join(ctx.root, ".5x", CURRENT_RUN_FILENAME), { force: true });
				const textRoot = await run5x(ctx.root, ["--text", "run", "list"]);
				expect(textRoot.exitCode).toBe(0);
				expect(textRoot.stdout).toContain("Focus");
				expect(textRoot.stdout).not.toContain("worktree");
				expect(textRoot.stdout).not.toContain("pointer");
				expect(textRoot.stdout).not.toMatch(/\benv\b/);

				const jsonRoot = await run5x(ctx.root, ["run", "list"]);
				expect(focused(listRuns(jsonRoot.stdout))).toBeUndefined();
			} finally {
				cleanup([ctx.root]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"externally attached worktree resolves its unique run without --run",
		async () => {
			const ctx = await setupDualWorktree();
			const externalDir = makeTmpDir("5x-ambient-ext");
			try {
				const planExt = join(ctx.root, "docs", "development", "plan-ext.md");
				writeFileSync(planExt, "# Plan Ext\n\n## Phase 1\n\n- [ ] Task\n");
				const extWt = join(externalDir, "wt");
				git(["worktree", "add", extWt, "-b", "5x/plan-ext"], ctx.root);

				const initExt = await run5x(ctx.root, [
					"run",
					"init",
					"--plan",
					planExt,
					"--worktree",
					extWt,
					"--allow-dirty",
				]);
				expect(initExt.exitCode).toBe(0);
				const runExt = (parseJson(initExt.stdout).data as { run_id: string })
					.run_id;

				writePointer(ctx.root, ctx.runA);

				const state = await run5x(extWt, ["run", "state"]);
				expect(state.exitCode).toBe(0);
				expect(
					(parseJson(state.stdout).data as { run: { id: string } }).run.id,
				).toBe(runExt);

				const list = await run5x(extWt, ["run", "list"]);
				const focus = focused(listRuns(list.stdout));
				expect(focus?.id).toBe(runExt);
				expect(focus?.ambient_source).toBe("worktree");
				expect(realpathSync(extWt)).not.toContain(
					`${join(".5x", "worktrees")}/`,
				);
			} finally {
				cleanup([externalDir, ctx.root]);
			}
		},
		{ timeout: 30000 },
	);
});
