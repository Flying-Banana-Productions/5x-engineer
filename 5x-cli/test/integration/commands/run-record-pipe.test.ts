/**
 * Tests for pipe ingestion in `5x run record`.
 *
 * Validates that `run record` can auto-extract fields from piped upstream
 * envelopes (invoke and non-invoke), and that CLI flags override piped values.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-record-pipe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
}> {
	// Init git repo
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
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
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

	// Initial commit so worktree is clean
	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
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
		data: { run_id: string };
	};
	if (!initData.ok) {
		throw new Error(`Failed to init run: ${initStdout}`);
	}

	return { projectRoot: dir, runId: initData.data.run_id };
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

/** Build a mock invoke envelope for piping. */
function makeInvokeEnvelope(overrides?: Record<string, unknown>): string {
	return JSON.stringify({
		ok: true,
		data: {
			run_id: "PLACEHOLDER_RUN_ID",
			step_name: "author:implement",
			phase: "1",
			model: "anthropic/claude-sonnet-4-6",
			result: { result: "complete", commit: "abc123" },
			session_id: "sess_xyz",
			duration_ms: 45000,
			tokens: { in: 8500, out: 3200 },
			cost_usd: 0.12,
			log_path: ".5x/logs/run_abc/agent-001.ndjson",
			...overrides,
		},
	});
}

/** Build a mock quality envelope for piping. */
function makeQualityEnvelope(): string {
	return JSON.stringify({
		ok: true,
		data: {
			passed: true,
			results: [
				{
					command: "bun test",
					passed: true,
					duration_ms: 3000,
					output: "all tests passed",
				},
			],
		},
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("run record pipe ingestion", () => {
	test(
		"pipe invoke envelope → record auto-extracts all fields",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				const envelope = makeInvokeEnvelope({ run_id: runId });
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record"],
					envelope,
				);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const stepData = data.data as Record<string, unknown>;
				expect(stepData.recorded).toBe(true);
				expect(stepData.step_name).toBe("author:implement");
				expect(stepData.phase).toBe("1");
				expect(stepData.iteration).toBe(1);

				// Verify metadata was persisted
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps).toHaveLength(1);
				const step = steps[0];
				expect(step?.session_id).toBe("sess_xyz");
				expect(step?.model).toBe("anthropic/claude-sonnet-4-6");
				expect(step?.duration_ms).toBe(45000);
				expect(step?.tokens_in).toBe(8500);
				expect(step?.tokens_out).toBe(3200);
				expect(step?.cost_usd).toBe(0.12);
				expect(step?.log_path).toBe(".5x/logs/run_abc/agent-001.ndjson");
				// Verify result was stored correctly
				const resultJson = JSON.parse(step?.result_json as string) as Record<
					string,
					unknown
				>;
				expect(resultJson.result).toBe("complete");
				expect(resultJson.commit).toBe("abc123");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"pipe quality envelope → record uses JSON.stringify(data) as result, requires explicit step name and --run",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				const envelope = makeQualityEnvelope();
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record", "quality:check", "--run", runId],
					envelope,
				);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as Record<string, unknown>).recorded).toBe(true);
				expect((data.data as Record<string, unknown>).step_name).toBe(
					"quality:check",
				);

				// Verify the result was stored as full data JSON
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				const resultJson = JSON.parse(
					steps[0]?.result_json as string,
				) as Record<string, unknown>;
				expect(resultJson.passed).toBe(true);
				expect(resultJson.results).toBeArray();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"CLI flags override piped values (e.g., --phase 2 overrides piped phase: '1')",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				const envelope = makeInvokeEnvelope({ run_id: runId, phase: "1" });
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record", "--phase", "2"],
					envelope,
				);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as Record<string, unknown>).phase).toBe("2");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"positional step name overrides piped step_name",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				const envelope = makeInvokeEnvelope({
					run_id: runId,
					step_name: "author:implement",
				});
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record", "custom:step"],
					envelope,
				);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as Record<string, unknown>).step_name).toBe(
					"custom:step",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"error when stdin not piped and required params missing",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot } = await setupProjectWithRun(dir);

				// No stdin, no positional, no --run, no --result
				const result = await run5x(projectRoot, ["run", "record"]);

				expect(result.exitCode).not.toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				expect((data.error as Record<string, unknown>).code).toBe(
					"INVALID_ARGS",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"error when piped envelope is ok: false",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot } = await setupProjectWithRun(dir);

				const errorEnvelope = JSON.stringify({
					ok: false,
					error: { code: "SOME_ERROR", message: "upstream failed" },
				});
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record"],
					errorEnvelope,
				);

				// Should fail because the upstream envelope is an error
				expect(result.exitCode).not.toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--result @./file.json with piped envelope → result from file, run_id/step_name from pipe",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				// Write a result file
				const resultFile = join(projectRoot, "result.json");
				writeFileSync(resultFile, '{"from":"file","status":"done"}');

				const envelope = makeInvokeEnvelope({ run_id: runId });
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record", "--result", `@${resultFile}`],
					envelope,
				);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as Record<string, unknown>).step_name).toBe(
					"author:implement",
				);

				// Verify result came from file, not pipe
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				const resultJson = JSON.parse(
					steps[0]?.result_json as string,
				) as Record<string, unknown>;
				expect(resultJson.from).toBe("file");
				expect(resultJson.status).toBe("done");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--result=- consumes stdin for raw result (not envelope parsing)",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				// When --result=- is specified, stdin is consumed as raw result JSON
				// (not parsed as an envelope). Must provide --run and step name explicitly.
				// Note: `--result=-` (equals syntax) preserves the "-" value;
				// `--result -` would be swallowed by the arg parser.
				const rawResult = '{"raw":"from_stdin"}';
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record", "manual:step", "--run", runId, "--result=-"],
					rawResult,
				);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as Record<string, unknown>).step_name).toBe(
					"manual:step",
				);

				// Verify result is the raw stdin content
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				const resultJson = JSON.parse(
					steps[0]?.result_json as string,
				) as Record<string, unknown>;
				expect(resultJson.raw).toBe("from_stdin");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		'--result \'{"inline":"json"}\' with piped envelope → result from inline, context from pipe',
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				const envelope = makeInvokeEnvelope({ run_id: runId });
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record", "--result", '{"inline":"json"}'],
					envelope,
				);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				// step_name from pipe, result from inline
				expect((data.data as Record<string, unknown>).step_name).toBe(
					"author:implement",
				);

				// Verify result came from inline JSON
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				const resultJson = JSON.parse(
					steps[0]?.result_json as string,
				) as Record<string, unknown>;
				expect(resultJson.inline).toBe("json");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"pipe with explicit --run (partial override — run from CLI, result from pipe)",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				// Pipe has a different run_id but we override with --run
				const envelope = makeInvokeEnvelope({
					run_id: "run_doesnotexist",
				});
				const result = await run5xWithStdin(
					projectRoot,
					["run", "record", "--run", runId],
					envelope,
				);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as Record<string, unknown>).recorded).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
