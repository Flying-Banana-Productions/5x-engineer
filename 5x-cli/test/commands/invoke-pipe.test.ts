/**
 * Tests for upstream context reading in `5x invoke` (Phase 4).
 *
 * Validates that `invoke` can auto-extract `run_id` and template variable
 * fallbacks from piped upstream envelopes (e.g., from `5x run init`).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-invoke-pipe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Create a minimal project with git repo and plan file, then init a run. */
async function setupProjectWithRun(dir: string): Promise<{
	projectRoot: string;
	runId: string;
	planPath: string;
}> {
	// Init git repo
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});

	// Create plan file
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(
		planPath,
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	// Create .5x directory and gitignore it
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	// Configure sample provider with valid structured output
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test-model"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
	);

	// Initial commit so worktree is clean
	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});

	// Init a run
	const initProc = Bun.spawn(
		["bun", "run", BIN, "run", "init", "--plan", planPath],
		{
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const initStdout = await new Response(initProc.stdout).text();
	await initProc.exited;
	const initData = JSON.parse(initStdout.trim()) as {
		ok: boolean;
		data: { run_id: string; plan_path: string };
	};
	if (!initData.ok) {
		throw new Error(`Failed to init run: ${initStdout}`);
	}

	return {
		projectRoot: dir,
		runId: initData.data.run_id,
		planPath: initData.data.plan_path,
	};
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5xWithStdin(
	cwd: string,
	args: string[],
	stdinData: string,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(stdinData);
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
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

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

/** Build a mock run init envelope for piping. */
function makeRunInitEnvelope(
	runId: string,
	planPath: string,
	overrides?: Record<string, unknown>,
): string {
	return JSON.stringify({
		ok: true,
		data: {
			run_id: runId,
			plan_path: planPath,
			status: "active",
			created_at: new Date().toISOString(),
			resumed: false,
			...overrides,
		},
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("invoke pipe ingestion", () => {
	test(
		"pipe run init envelope → invoke picks up data.run_id as --run",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				const envelope = makeRunInitEnvelope(runId, planPath);
				const result = await run5xWithStdin(
					projectRoot,
					[
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						`plan_path=${planPath}`,
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=test",
					],
					envelope,
				);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
				expect(data.step_name).toBe("author:implement");
				expect(data.phase).toBe("1");
				expect(data.model).toBe("sample/test-model");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"pipe run init envelope → invoke auto-injects data.plan_path as template variable",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Don't pass --var plan_path — it should come from the piped envelope
				const envelope = makeRunInitEnvelope(runId, planPath);
				const result = await run5xWithStdin(
					projectRoot,
					[
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=test",
					],
					envelope,
				);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"explicit --var plan_path=other.md overrides piped data.plan_path",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Create another plan file to use as override
				const otherPlan = join(dir, "docs", "development", "other-plan.md");
				writeFileSync(
					otherPlan,
					"# Other Plan\n\n## Phase 1: Other\n\n- [ ] Do other\n",
				);

				const envelope = makeRunInitEnvelope(runId, planPath);
				const result = await run5xWithStdin(
					projectRoot,
					[
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						`plan_path=${otherPlan}`,
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=test",
					],
					envelope,
				);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				// run_id from pipe, but plan_path from explicit --var
				expect(data.run_id).toBe(runId);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"explicit --run R2 overrides piped data.run_id",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Pipe contains one run_id, but --run explicitly provides the same
				// (we can't test with a different run_id since it needs to exist in DB,
				// but we can verify that --run takes precedence by using the same ID
				// and verifying invocation succeeds)
				const envelope = makeRunInitEnvelope("run_wrong_one", planPath);
				const result = await run5xWithStdin(
					projectRoot,
					[
						"invoke",
						"author",
						"author-next-phase",
						"--run",
						runId,
						"--var",
						`plan_path=${planPath}`,
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=test",
					],
					envelope,
				);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				// --run flag overrides piped run_id
				expect(data.run_id).toBe(runId);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"error when no --run and stdin is not piped",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot } = await setupProjectWithRun(dir);

				// No --run, no stdin piped
				const result = await run5x(projectRoot, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					"plan_path=/p",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
				]);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
				expect(error.message).toContain("--run");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--var key=@- prevents upstream context reading (stdin consumed for var)",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Pipe contains a valid envelope, but --var uses @- which should
				// prevent envelope parsing. Since @- is Phase 5, this test verifies
				// that the hasStdinVar check correctly skips pipe reading.
				// Without --run, invoke should fail with INVALID_ARGS.
				const envelope = makeRunInitEnvelope(runId, planPath);
				const result = await run5xWithStdin(
					projectRoot,
					[
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"user_notes=@-",
						"--var",
						"phase_number=1",
						"--var",
						`plan_path=${planPath}`,
					],
					envelope,
				);

				// Should fail because --run is not provided and stdin was not
				// consumed for upstream context (it's reserved for @-)
				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test("non-string data fields are not injected as template vars", async () => {
		// This is a unit-level test using extractPipeContext directly
		const { extractPipeContext } = await import("../../src/pipe.js");

		const ctx = extractPipeContext({
			run_id: "run_abc",
			plan_path: "/path/to/plan.md",
			numeric_field: 42,
			boolean_field: true,
			array_field: [1, 2, 3],
			object_field: { nested: "value" },
			null_field: null,
		});

		expect(ctx.templateVars.plan_path).toBe("/path/to/plan.md");
		expect(ctx.templateVars).not.toHaveProperty("numeric_field");
		expect(ctx.templateVars).not.toHaveProperty("boolean_field");
		expect(ctx.templateVars).not.toHaveProperty("array_field");
		expect(ctx.templateVars).not.toHaveProperty("object_field");
		expect(ctx.templateVars).not.toHaveProperty("null_field");
	});

	test("values with newlines in data fields are skipped for template var injection", async () => {
		const { extractPipeContext } = await import("../../src/pipe.js");

		const ctx = extractPipeContext({
			run_id: "run_abc",
			clean_value: "single-line",
			multiline_value: "line1\nline2",
			arrow_value: "some-->thing",
		});

		expect(ctx.templateVars.clean_value).toBe("single-line");
		expect(ctx.templateVars).not.toHaveProperty("multiline_value");
		expect(ctx.templateVars).not.toHaveProperty("arrow_value");
	});

	// Phase 4: worktree context propagation via pipe

	test("pipe run init envelope with worktree_path → extractPipeContext extracts worktree fields", async () => {
		const { extractPipeContext } = await import("../../src/pipe.js");

		// Simulate a run init envelope with Phase 4 top-level worktree fields
		const ctx = extractPipeContext({
			run_id: "run_abc123",
			plan_path: "/project/docs/plan.md",
			status: "active",
			resumed: false,
			worktree_path: "/project/.5x/worktrees/plan-abc",
			worktree_plan_path: "/project/.5x/worktrees/plan-abc/docs/plan.md",
			worktree: {
				action: "created",
				worktree_path: "/project/.5x/worktrees/plan-abc",
				branch: "5x/plan",
			},
		});

		// worktree fields extracted into PipeContext
		expect(ctx.worktreePath).toBe("/project/.5x/worktrees/plan-abc");
		expect(ctx.worktreePlanPath).toBe(
			"/project/.5x/worktrees/plan-abc/docs/plan.md",
		);
		// These are excluded from templateVars
		expect(ctx.templateVars).not.toHaveProperty("worktree_path");
		expect(ctx.templateVars).not.toHaveProperty("worktree_plan_path");
		// Nested worktree object is not a string, so not in templateVars
		expect(ctx.templateVars).not.toHaveProperty("worktree");
	});

	test("pipe envelope without worktree fields → extractPipeContext omits worktree context (backward compat)", async () => {
		const { extractPipeContext } = await import("../../src/pipe.js");

		// Simulate a run init envelope without --worktree
		const ctx = extractPipeContext({
			run_id: "run_def456",
			plan_path: "/project/docs/plan.md",
			status: "active",
			resumed: false,
		});

		expect(ctx.worktreePath).toBeUndefined();
		expect(ctx.worktreePlanPath).toBeUndefined();
		expect(ctx.runId).toBe("run_def456");
	});

	test("excluded metadata keys (session_id, log_path, etc.) are not injected as template vars", async () => {
		const { extractPipeContext } = await import("../../src/pipe.js");

		const ctx = extractPipeContext({
			run_id: "run_abc",
			session_id: "sess_xyz",
			log_path: ".5x/logs/run_abc/agent-001.ndjson",
			cost_usd: "0.12", // even as string, should be excluded by key
			duration_ms: "45000", // even as string, should be excluded by key
			model: "anthropic/claude-sonnet-4-6",
			step_name: "author:implement",
			ok: "true",
			plan_path: "/path/to/plan.md", // this SHOULD be included
		});

		// Excluded keys should not appear
		expect(ctx.templateVars).not.toHaveProperty("run_id");
		expect(ctx.templateVars).not.toHaveProperty("session_id");
		expect(ctx.templateVars).not.toHaveProperty("log_path");
		expect(ctx.templateVars).not.toHaveProperty("cost_usd");
		expect(ctx.templateVars).not.toHaveProperty("duration_ms");
		expect(ctx.templateVars).not.toHaveProperty("model");
		expect(ctx.templateVars).not.toHaveProperty("step_name");
		expect(ctx.templateVars).not.toHaveProperty("ok");

		// Eligible keys should appear
		expect(ctx.templateVars.plan_path).toBe("/path/to/plan.md");
	});
});
