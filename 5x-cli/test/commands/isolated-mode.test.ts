/**
 * Tests for isolated mode command flows.
 *
 * Isolated mode: parent repo is NOT 5x-initialized. User runs `5x init`
 * in a linked worktree checkout, creating a local state DB. Commands
 * operate entirely against that local state.
 *
 * Test matrix coverage:
 * - 5x init in externally attached worktree with no parent DB → local state DB
 * - Commands in isolated mode do not read/write root DB
 * - run init in isolated mode creates run in local DB
 * - invoke --run in isolated mode uses local DB run context
 * - quality run --run in isolated mode executes against local checkout
 * - Root DB creation overrides isolated mode (mode switch)
 *
 * Each test creates its own temp dirs with `finally` cleanup for concurrent safety.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const env = cleanGitEnv();
const BIN = resolve(import.meta.dir, "../../src/bin.ts");

function makeTmpDir(prefix = "5x-iso"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

function initRepo(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(join(dir, "README.md"), "# Test\n");
	git(["add", "."], dir);
	git(["commit", "-m", "initial"], dir);
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(
	cwd: string,
	args: string[],
	timeoutMs = 15000,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env,
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

function cleanup(dirs: string[]): void {
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
}

// ===========================================================================
// Isolated mode tests
// ===========================================================================

describe("isolated mode", () => {
	test(
		"5x init in externally attached worktree with no parent DB creates local state DB",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-iso-ext");
			try {
				initRepo(tmp);
				// Do NOT init 5x in the main repo

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-ext-branch"], tmp);

				// Init 5x inside the external worktree
				const result = await run5x(wtPath, ["init"]);

				expect(result.exitCode).toBe(0);
				// Local state DB should exist in the worktree
				expect(existsSync(join(wtPath, ".5x"))).toBe(true);
				expect(existsSync(join(wtPath, "5x.toml"))).toBe(true);
				// Root repo should NOT have a state DB
				expect(existsSync(join(tmp, ".5x", "5x.db"))).toBe(false);
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"commands in isolated mode do not read/write root DB",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-iso-notouch");
			try {
				initRepo(tmp);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-notouch-branch"], tmp);

				// Set up plan in worktree
				mkdirSync(join(wtPath, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtPath, "docs", "development", "test-plan.md"),
					"# Plan\n\n## Phase 1\n\n- [ ] Task\n",
				);
				git(["add", "-A"], wtPath);
				git(["commit", "-m", "add plan"], wtPath);

				// Init 5x in worktree (isolated mode)
				await run5x(wtPath, ["init"]);
				// Commit init artifacts so worktree is clean
				git(["add", "-A"], wtPath);
				git(["commit", "-m", "init 5x"], wtPath);

				// Create a run in isolated mode
				const initResult = await run5x(wtPath, [
					"run",
					"init",
					"--plan",
					"docs/development/test-plan.md",
				]);
				expect(initResult.exitCode).toBe(0);

				// List runs from worktree
				const listResult = await run5x(wtPath, ["run", "list"]);
				expect(listResult.exitCode).toBe(0);
				const listData = parseJson(listResult.stdout);
				const runs = (listData.data as { runs: { id: string }[] }).runs;
				expect(runs.length).toBe(1);

				// Root repo should NOT have a .5x/5x.db
				expect(existsSync(join(tmp, ".5x", "5x.db"))).toBe(false);
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run init in isolated mode creates run in local DB",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-iso-runinit");
			try {
				initRepo(tmp);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-runinit-branch"], tmp);

				mkdirSync(join(wtPath, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtPath, "docs", "development", "test-plan.md"),
					"# Plan\n\n## Phase 1\n\n- [ ] Task\n",
				);
				git(["add", "-A"], wtPath);
				git(["commit", "-m", "add plan"], wtPath);

				// Init 5x in worktree, then commit so worktree is clean
				await run5x(wtPath, ["init"]);
				git(["add", "-A"], wtPath);
				git(["commit", "-m", "init 5x"], wtPath);

				// Init a run
				const result = await run5x(wtPath, [
					"run",
					"init",
					"--plan",
					"docs/development/test-plan.md",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const runId = (json.data as { run_id: string }).run_id;
				expect(runId).toBeTruthy();

				// Run should be in local DB (listable from worktree)
				const listResult = await run5x(wtPath, ["run", "list"]);
				const listData = parseJson(listResult.stdout);
				const runs = (listData.data as { runs: { id: string }[] }).runs;
				expect(runs.some((r) => r.id === runId)).toBe(true);
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --run in isolated mode uses local DB run context",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-iso-invoke");
			try {
				initRepo(tmp);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-invoke-branch"], tmp);

				mkdirSync(join(wtPath, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtPath, "docs", "development", "test-plan.md"),
					"# Plan\n\n## Phase 1\n\n- [ ] Task\n",
				);

				git(["add", "-A"], wtPath);
				git(["commit", "-m", "add plan"], wtPath);

				// Init 5x in worktree
				await run5x(wtPath, ["init"]);

				// Overwrite config with sample provider
				writeFileSync(
					join(wtPath, "5x.toml"),
					'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
				);

				// Commit init artifacts + config so worktree is clean
				git(["add", "-A"], wtPath);
				git(["commit", "-m", "init 5x and config"], wtPath);

				// Init a run in the local DB
				const initResult = await run5x(wtPath, [
					"run",
					"init",
					"--plan",
					"docs/development/test-plan.md",
				]);
				expect(initResult.exitCode).toBe(0);
				const initData = parseJson(initResult.stdout);
				const runId = (initData.data as { run_id: string }).run_id;

				// Invoke using the local run
				const planPath = join(wtPath, "docs", "development", "test-plan.md");
				const result = await run5x(wtPath, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"quality run --run in isolated mode executes against local checkout",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-iso-quality");
			try {
				initRepo(tmp);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-quality-branch"], tmp);

				mkdirSync(join(wtPath, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtPath, "docs", "development", "test-plan.md"),
					"# Plan\n\n## Phase 1\n\n- [ ] Task\n",
				);

				git(["add", "-A"], wtPath);
				git(["commit", "-m", "add plan"], wtPath);

				// Init 5x in worktree
				await run5x(wtPath, ["init"]);

				// Config with quality gates (qualityGates before sections)
				writeFileSync(
					join(wtPath, "5x.toml"),
					'qualityGates = ["echo isolated-ok"]\n\n[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
				);

				// Commit init artifacts + config so worktree is clean
				git(["add", "-A"], wtPath);
				git(["commit", "-m", "init 5x and config"], wtPath);

				// Init a run
				const initResult = await run5x(wtPath, [
					"run",
					"init",
					"--plan",
					"docs/development/test-plan.md",
				]);
				const initData = parseJson(initResult.stdout);
				const runId = (initData.data as { run_id: string }).run_id;

				// Quality run in isolated mode
				const result = await run5x(wtPath, ["quality", "run", "--run", runId]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as {
					passed: boolean;
					results: { command: string }[];
				};
				expect(data.results.length).toBeGreaterThan(0);
				expect(data.results[0]?.command).toBe("echo isolated-ok");
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"root DB creation overrides isolated mode (mode switch to managed)",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-iso-switch");
			try {
				initRepo(tmp);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-switch-branch"], tmp);

				mkdirSync(join(wtPath, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtPath, "docs", "development", "test-plan.md"),
					"# Plan\n\n## Phase 1\n\n- [ ] Task\n",
				);
				git(["add", "-A"], wtPath);
				git(["commit", "-m", "add plan"], wtPath);

				// Step 1: Init 5x in worktree (isolated mode)
				await run5x(wtPath, ["init"]);
				git(["add", "-A"], wtPath);
				git(["commit", "-m", "init 5x"], wtPath);

				// Create a run in isolated mode
				const isoInitResult = await run5x(wtPath, [
					"run",
					"init",
					"--plan",
					"docs/development/test-plan.md",
				]);
				expect(isoInitResult.exitCode).toBe(0);
				const isoRunId = (
					parseJson(isoInitResult.stdout).data as { run_id: string }
				).run_id;

				// Verify the run is in local DB
				const isoListResult = await run5x(wtPath, ["run", "list"]);
				const isoRuns = (
					parseJson(isoListResult.stdout).data as {
						runs: { id: string }[];
					}
				).runs;
				expect(isoRuns.some((r) => r.id === isoRunId)).toBe(true);

				// Step 2: Init 5x in the MAIN checkout (creates root DB)
				// Need plan at main checkout too
				mkdirSync(join(tmp, "docs", "development"), { recursive: true });
				writeFileSync(
					join(tmp, "docs", "development", "test-plan.md"),
					"# Root Plan\n\n## Phase 1\n\n- [ ] Task\n",
				);
				git(["add", "-A"], tmp);
				git(["commit", "-m", "add plan to root"], tmp);
				await run5x(tmp, ["init"]);
				git(["add", "-A"], tmp);
				git(["commit", "-m", "init 5x root"], tmp);

				// Create a run in managed mode from root
				const managedInitResult = await run5x(tmp, [
					"run",
					"init",
					"--plan",
					"docs/development/test-plan.md",
				]);
				expect(managedInitResult.exitCode).toBe(0);
				const managedRunId = (
					parseJson(managedInitResult.stdout).data as { run_id: string }
				).run_id;

				// Step 3: From the worktree, run list should now show the
				// MANAGED mode runs (root DB wins)
				const switchListResult = await run5x(wtPath, ["run", "list"]);
				expect(switchListResult.exitCode).toBe(0);
				const switchRuns = (
					parseJson(switchListResult.stdout).data as {
						runs: { id: string }[];
					}
				).runs;

				// Should see the managed run (from root DB)
				expect(switchRuns.some((r) => r.id === managedRunId)).toBe(true);
				// The isolated run should NOT be visible (local DB is ignored)
				expect(switchRuns.some((r) => r.id === isoRunId)).toBe(false);

				// Split-brain warning for leftover local DB is covered in
				// worktree-guards.test.ts "legacy split-brain detection".
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);
});
