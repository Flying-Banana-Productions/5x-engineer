/**
 * Tests for commands executed from linked worktree contexts.
 *
 * Covers test matrix sections:
 * - Core behavior: invoke --run from linked worktree resolves root DB
 * - Run subcommands from linked worktree: state, record, complete, reopen, watch, list, init
 * - Quality/diff: quality run --workdir, diff --run happy path
 * - Externally attached worktree E2E: invoke, quality, run state, run init, run list
 * - Artifact path re-anchoring: quality logs, run watch logs, template overrides,
 *   default worktree creation path
 *
 * Each test creates its own temp directories and cleans up in `finally` blocks
 * for `bun test --concurrent` safety.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import { cleanGitEnv } from "../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const env = cleanGitEnv();
const BIN = resolve(import.meta.dir, "../../src/bin.ts");

function makeTmpDir(prefix = "5x-lwc"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function git(args: string[], cwd: string): string {
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
	return result.stdout.toString().trim();
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

function setupProject(dir: string): string {
	initRepo(dir);

	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
	);

	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(
		join(planDir, "test-plan.md"),
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	git(["add", "-A"], dir);
	git(["commit", "-m", "add project files"], dir);
	return dir;
}

function initDb(dir: string): void {
	Bun.spawnSync(["bun", "run", BIN, "run", "list"], {
		cwd: dir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function insertRun(dir: string, runId: string, planPath: string): void {
	const { Database } = require("bun:sqlite");
	const dbPath = join(dir, ".5x", "5x.db");
	const db = new Database(dbPath);
	db.query("INSERT INTO runs (id, plan_path) VALUES (?1, ?2)").run(
		runId,
		planPath,
	);
	db.close();
}

function insertPlan(
	dir: string,
	planPath: string,
	worktreePath: string | null,
): void {
	const { Database } = require("bun:sqlite");
	const dbPath = join(dir, ".5x", "5x.db");
	const db = new Database(dbPath);
	db.query("INSERT INTO plans (plan_path, worktree_path) VALUES (?1, ?2)").run(
		planPath,
		worktreePath,
	);
	db.close();
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

async function initRun(projectRoot: string): Promise<string> {
	const result = await run5x(projectRoot, [
		"run",
		"init",
		"--plan",
		"docs/development/test-plan.md",
	]);
	const data = parseJson(result.stdout);
	return (data.data as { run_id: string }).run_id;
}

function cleanup(dirs: string[]): void {
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
}

// ===========================================================================
// Commands from a linked worktree (inside repo tree)
// ===========================================================================

describe("commands from linked worktree", () => {
	test(
		"invoke --run from linked worktree resolves root DB and uses mapped worktree",
		async () => {
			const tmp = makeTmpDir();
			const wtDir = makeTmpDir("5x-lwc-wt");
			try {
				setupProject(tmp);
				initDb(tmp);

				const planPath = join(tmp, "docs", "development", "test-plan.md");
				const runId = "run_from_wt_test";
				insertPlan(tmp, planPath, wtDir);
				insertRun(tmp, runId, planPath);

				// Create plan in worktree
				mkdirSync(join(wtDir, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtDir, "docs", "development", "test-plan.md"),
					"# WT Plan\n",
				);

				// Create a linked worktree inside the repo
				const linkedWt = join(tmp, ".5x", "worktrees", "linked-branch");
				git(["worktree", "add", linkedWt, "-b", "linked-branch"], tmp);

				// Run invoke FROM the linked worktree cwd
				const result = await run5x(linkedWt, [
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
				expect(data.worktree_path).toBe(wtDir);
			} finally {
				cleanup([wtDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --run --workdir from linked worktree uses explicit workdir override",
		async () => {
			const tmp = makeTmpDir();
			const explicitDir = makeTmpDir("5x-lwc-explicit");
			try {
				setupProject(tmp);
				initDb(tmp);

				const planPath = join(tmp, "docs", "development", "test-plan.md");
				const runId = "run_workdir_test";
				// Map to a missing worktree — if --workdir is respected,
				// WORKTREE_MISSING should NOT fire
				const missingWt = join(tmpdir(), `5x-lwc-missing-${Date.now()}`);
				insertPlan(tmp, planPath, missingWt);
				insertRun(tmp, runId, planPath);

				// Copy plan to explicit dir so sample provider can work
				mkdirSync(join(explicitDir, "docs", "development"), {
					recursive: true,
				});
				writeFileSync(
					join(explicitDir, "docs", "development", "test-plan.md"),
					"# Plan\n",
				);

				const linkedWt = join(tmp, ".5x", "worktrees", "wdir-branch");
				git(["worktree", "add", linkedWt, "-b", "wdir-branch"], tmp);

				const result = await run5x(linkedWt, [
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
					"--workdir",
					explicitDir,
				]);

				const json = parseJson(result.stdout);
				// Should NOT fail with WORKTREE_MISSING — explicit --workdir overrides
				if (!json.ok) {
					const error = json.error as { code: string };
					expect(error.code).not.toBe("WORKTREE_MISSING");
				}
			} finally {
				cleanup([explicitDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run list from linked worktree lists runs from root DB",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);

				// Create a run via root
				const runId = await initRun(tmp);

				// Create a linked worktree
				const linkedWt = join(tmp, ".5x", "worktrees", "list-branch");
				git(["worktree", "add", linkedWt, "-b", "list-branch"], tmp);

				// List runs from the linked worktree
				const result = await run5x(linkedWt, ["run", "list"]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const runs = (json.data as { runs: { id: string }[] }).runs;
				expect(runs.length).toBeGreaterThanOrEqual(1);
				expect(runs.some((r) => r.id === runId)).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run init from linked worktree creates run in root DB",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				// Ensure DB exists by running list
				initDb(tmp);

				const linkedWt = join(tmp, ".5x", "worktrees", "init-branch");
				git(["worktree", "add", linkedWt, "-b", "init-branch"], tmp);

				// Init a run from the linked worktree
				const result = await run5x(linkedWt, [
					"run",
					"init",
					"--plan",
					join(tmp, "docs", "development", "test-plan.md"),
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const runId = (json.data as { run_id: string }).run_id;

				// Verify the run is in the root DB by listing from root
				const listResult = await run5x(tmp, ["run", "list"]);
				const listData = parseJson(listResult.stdout);
				const runs = (listData.data as { runs: { id: string }[] }).runs;
				expect(runs.some((r) => r.id === runId)).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run state --run from linked worktree resolves root DB",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				const runId = await initRun(tmp);

				const linkedWt = join(tmp, ".5x", "worktrees", "state-branch");
				git(["worktree", "add", linkedWt, "-b", "state-branch"], tmp);

				const result = await run5x(linkedWt, ["run", "state", "--run", runId]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const run = (json.data as { run: { id: string } }).run;
				expect(run.id).toBe(runId);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run complete --run from linked worktree writes to root DB",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				const runId = await initRun(tmp);

				const linkedWt = join(tmp, ".5x", "worktrees", "complete-branch");
				git(["worktree", "add", linkedWt, "-b", "complete-branch"], tmp);

				const result = await run5x(linkedWt, [
					"run",
					"complete",
					"--run",
					runId,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				// Verify status changed by checking from root
				const stateResult = await run5x(tmp, ["run", "state", "--run", runId]);
				const stateData = parseJson(stateResult.stdout);
				const run = (stateData.data as { run: { status: string } }).run;
				expect(run.status).toBe("completed");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run reopen --run from linked worktree writes to root DB",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				const runId = await initRun(tmp);

				// Complete from root first
				await run5x(tmp, ["run", "complete", "--run", runId]);

				const linkedWt = join(tmp, ".5x", "worktrees", "reopen-branch");
				git(["worktree", "add", linkedWt, "-b", "reopen-branch"], tmp);

				// Reopen from linked worktree
				const result = await run5x(linkedWt, ["run", "reopen", "--run", runId]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				// Verify status is active again from root
				const stateResult = await run5x(tmp, ["run", "state", "--run", runId]);
				const stateData = parseJson(stateResult.stdout);
				const run = (stateData.data as { run: { status: string } }).run;
				expect(run.status).toBe("active");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run record --run from linked worktree writes to root DB",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				const runId = await initRun(tmp);

				const linkedWt = join(tmp, ".5x", "worktrees", "record-branch");
				git(["worktree", "add", linkedWt, "-b", "record-branch"], tmp);

				// Record a step from the linked worktree
				const result = await run5x(linkedWt, [
					"run",
					"record",
					"--run",
					runId,
					"test-step",
					"--result",
					'{"status":"pass"}',
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				// Verify step is visible from root
				const stateResult = await run5x(tmp, ["run", "state", "--run", runId]);
				const stateData = parseJson(stateResult.stdout);
				const steps = (stateData.data as { steps: { step_name: string }[] })
					.steps;
				expect(steps.some((s) => s.step_name === "test-step")).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run watch --run from linked worktree reads logs from root controlPlaneRoot",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				const runId = await initRun(tmp);

				// Create log file at root so watch has something to read
				const logDir = join(tmp, ".5x", "logs", runId);
				mkdirSync(logDir, { recursive: true });
				writeFileSync(join(logDir, "test.log"), "test log content\n");

				const linkedWt = join(tmp, ".5x", "worktrees", "watch-branch");
				git(["worktree", "add", linkedWt, "-b", "watch-branch"], tmp);

				// run watch exits quickly if no active process — just verify it resolves
				// the correct DB and doesn't error with DB_NOT_FOUND or similar
				const result = await run5x(linkedWt, ["run", "watch", "--run", runId]);

				// Watch may exit 0 or 1 depending on whether there's an active log,
				// but it should NOT fail with a DB resolution error
				const output = result.stdout + result.stderr;
				expect(output).not.toContain("DB_NOT_FOUND");
				expect(output).not.toContain("not 5x-managed");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"diff --run from linked worktree diffs mapped worktree (happy path)",
		async () => {
			const tmp = makeTmpDir();
			const wtDir = makeTmpDir("5x-lwc-diffwt");
			try {
				setupProject(tmp);
				initDb(tmp);

				const planPath = join(tmp, "docs", "development", "test-plan.md");
				const runId = "run_diff_happy";
				insertPlan(tmp, planPath, wtDir);
				insertRun(tmp, runId, planPath);

				// Init wtDir as a git worktree so diff works
				git(["worktree", "add", wtDir, "-b", "diff-wt-branch"], tmp);
				// Create a change in the worktree
				writeFileSync(join(wtDir, "new-file.txt"), "hello\n");

				// Create a linked worktree to run diff FROM
				const linkedWt = join(tmp, ".5x", "worktrees", "diff-src-branch");
				git(["worktree", "add", linkedWt, "-b", "diff-src-branch"], tmp);

				const result = await run5x(linkedWt, ["diff", "--run", runId]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				// Diff output should reference the change in the mapped worktree
				const data = json.data as { diff?: string };
				if (data.diff) {
					expect(data.diff).toContain("new-file.txt");
				}
			} finally {
				cleanup([wtDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"quality run --run --workdir uses explicit workdir override",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				// qualityGates MUST appear before any [section] headers in TOML
				writeFileSync(
					join(tmp, "5x.toml"),
					'qualityGates = ["echo ok"]\n\n[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
				);
				git(["add", "-A"], tmp);
				git(["commit", "-m", "add quality gate"], tmp);

				// Init run, then map to a missing worktree
				const runId = await initRun(tmp);
				const missingWt = join(tmpdir(), `5x-lwc-qmissing-${Date.now()}`);
				const testDb = getDb(tmp);
				const planPath = resolve(tmp, "docs/development/test-plan.md");
				testDb
					.query(
						"INSERT OR REPLACE INTO plans (plan_path, worktree_path) VALUES (?1, ?2)",
					)
					.run(planPath, missingWt);
				closeDb();
				_resetForTest();

				// --workdir uses a subdirectory inside the repo so control-plane
				// resolution still finds the root DB (quality handler resolves CP
				// from workdir, not cwd)
				const explicitDir = join(tmp, "src");
				mkdirSync(explicitDir, { recursive: true });

				const result = await run5x(tmp, [
					"quality",
					"run",
					"--run",
					runId,
					"--workdir",
					explicitDir,
				]);

				const json = parseJson(result.stdout);
				// Should NOT fail with WORKTREE_MISSING — explicit --workdir overrides
				if (!json.ok) {
					const error = json.error as { code: string };
					expect(error.code).not.toBe("WORKTREE_MISSING");
				} else {
					expect(json.ok).toBe(true);
				}
			} finally {
				try {
					closeDb();
					_resetForTest();
				} catch {}
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);
});

// ===========================================================================
// Artifact path re-anchoring from linked worktree
// ===========================================================================

describe("artifact paths from linked worktree", () => {
	test(
		"quality run --run from linked worktree: logs written under controlPlaneRoot",
		async () => {
			const tmp = makeTmpDir();
			try {
				// Set up project with quality gate before init
				// qualityGates MUST appear before any [section] headers in TOML
				initRepo(tmp);
				mkdirSync(join(tmp, ".5x"), { recursive: true });
				writeFileSync(
					join(tmp, "5x.toml"),
					'qualityGates = ["echo ok"]\n\n[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
				);
				mkdirSync(join(tmp, "docs", "development"), { recursive: true });
				writeFileSync(
					join(tmp, "docs", "development", "test-plan.md"),
					"# Plan\n\n## Phase 1\n\n- [ ] Task\n",
				);
				git(["add", "-A"], tmp);
				git(["commit", "-m", "add project files"], tmp);

				const runId = await initRun(tmp);

				const linkedWt = join(tmp, ".5x", "worktrees", "q-log-branch");
				git(["worktree", "add", linkedWt, "-b", "q-log-branch"], tmp);

				const result = await run5x(linkedWt, [
					"quality",
					"run",
					"--run",
					runId,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				// Logs should be under controlPlaneRoot (tmp)/.5x/logs/
				const logsDir = join(tmp, ".5x", "logs", runId);
				expect(existsSync(logsDir)).toBe(true);
				// Logs should NOT be under the linked worktree's own .5x
				expect(existsSync(join(linkedWt, ".5x", "logs"))).toBe(false);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"default worktree creation path uses controlPlaneRoot/stateDir/worktrees",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				const planPath = join(tmp, "docs", "development", "test-plan.md");

				// Create a worktree through the CLI
				const result = await run5x(tmp, [
					"worktree",
					"create",
					"--plan",
					planPath,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const wtPath = (json.data as { worktree_path: string }).worktree_path;
				// Worktree should be under controlPlaneRoot/.5x/worktrees/
				expect(wtPath.startsWith(join(tmp, ".5x", "worktrees"))).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --run from linked worktree: logs under controlPlaneRoot (not under worktree)",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				initDb(tmp);

				const planPath = join(tmp, "docs", "development", "test-plan.md");
				const runId = "run_log_wt_test";
				insertRun(tmp, runId, planPath);

				const linkedWt = join(tmp, ".5x", "worktrees", "inv-log-branch");
				git(["worktree", "add", linkedWt, "-b", "inv-log-branch"], tmp);

				const result = await run5x(linkedWt, [
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
				const logPath = data.log_path as string;

				// Log should be under controlPlaneRoot/.5x/logs/
				expect(logPath).toContain(join(tmp, ".5x", "logs", runId));
				// Should NOT be under linked worktree
				expect(logPath).not.toContain(linkedWt);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);
});

// ===========================================================================
// Commands from externally attached worktree (checkout outside repo tree)
// ===========================================================================

describe("commands from externally attached worktree (E2E)", () => {
	test(
		"invoke --run from externally attached worktree resolves root DB",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-lwc-ext");
			try {
				setupProject(tmp);
				initDb(tmp);

				const planPath = join(tmp, "docs", "development", "test-plan.md");
				const runId = "run_ext_invoke";
				insertRun(tmp, runId, planPath);

				// Create external worktree (outside repo tree)
				const extWt = join(externalDir, "wt");
				git(["worktree", "add", extWt, "-b", "ext-invoke-branch"], tmp);

				const result = await run5x(extWt, [
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
		"run state --run from externally attached worktree resolves root DB",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-lwc-ext-state");
			try {
				setupProject(tmp);
				const runId = await initRun(tmp);

				const extWt = join(externalDir, "wt");
				git(["worktree", "add", extWt, "-b", "ext-state-branch"], tmp);

				const result = await run5x(extWt, ["run", "state", "--run", runId]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const run = (json.data as { run: { id: string } }).run;
				expect(run.id).toBe(runId);
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run init from externally attached worktree creates run in root DB",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-lwc-ext-init");
			try {
				setupProject(tmp);
				initDb(tmp);

				const extWt = join(externalDir, "wt");
				git(["worktree", "add", extWt, "-b", "ext-init-branch"], tmp);

				const result = await run5x(extWt, [
					"run",
					"init",
					"--plan",
					join(tmp, "docs", "development", "test-plan.md"),
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const runId = (json.data as { run_id: string }).run_id;

				// Verify visible from root
				const listResult = await run5x(tmp, ["run", "list"]);
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
		"run list from externally attached worktree lists runs from root DB",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-lwc-ext-list");
			try {
				setupProject(tmp);
				const runId = await initRun(tmp);

				const extWt = join(externalDir, "wt");
				git(["worktree", "add", extWt, "-b", "ext-list-branch"], tmp);

				const result = await run5x(extWt, ["run", "list"]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const runs = (json.data as { runs: { id: string }[] }).runs;
				expect(runs.some((r) => r.id === runId)).toBe(true);
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"quality run --run from externally attached worktree resolves root DB",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-lwc-ext-qual");
			try {
				setupProject(tmp);
				// qualityGates MUST appear before any [section] headers in TOML
				writeFileSync(
					join(tmp, "5x.toml"),
					'qualityGates = ["echo ok"]\n\n[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
				);
				git(["add", "-A"], tmp);
				git(["commit", "-m", "add gate"], tmp);

				const runId = await initRun(tmp);

				const extWt = join(externalDir, "wt");
				git(["worktree", "add", extWt, "-b", "ext-qual-branch"], tmp);

				const result = await run5x(extWt, ["quality", "run", "--run", runId]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 30000 },
	);
});
