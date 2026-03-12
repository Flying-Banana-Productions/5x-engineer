/**
 * Tests for --record and --record-step flags on `5x invoke` (Phase 6).
 *
 * Validates that invoke --record auto-records using the template's step_name,
 * that --record-step overrides the default, that metadata flows through, and
 * that recording failures don't suppress the primary envelope.
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
		`5x-invoke-record-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Create a minimal project with git repo, sample provider, and an active run. */
async function setupProjectWithRun(
	dir: string,
	opts?: { structured?: Record<string, unknown> },
): Promise<{
	projectRoot: string;
	runId: string;
	planPath: string;
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
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	// Configure sample provider with valid structured output
	const structured = opts?.structured ?? {
		result: "complete",
		commit: "abc123",
	};
	const structuredToml = Object.entries(structured)
		.map(([k, v]) => {
			if (typeof v === "string") return `${k} = "${v}"`;
			if (Array.isArray(v)) return `${k} = ${JSON.stringify(v)}`;
			return `${k} = ${JSON.stringify(v)}`;
		})
		.join("\n");

	writeFileSync(
		join(dir, "5x.toml"),
		`[author]\nprovider = "sample"\nmodel = "sample/test-model"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\n${structuredToml}\n`,
	);

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("invoke --record", () => {
	test(
		"auto-records using template's step_name (author:implement for author-next-phase)",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					runId,
					"--record",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
				]);

				// Primary envelope should be the invoke result
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
				expect(data.step_name).toBe("author:implement");

				// Verify step was recorded in DB
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const stateJson = parseJson(state.stdout);
				expect(stateJson.ok).toBe(true);
				const steps = (stateJson.data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThanOrEqual(1);
				const recordedStep = steps[0];
				expect(recordedStep?.step_name).toBe("author:implement");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 60000 },
	);

	test(
		"--record-step overrides template's step_name",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					runId,
					"--record",
					"--record-step",
					"custom:step",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				// Verify step was recorded with custom step name
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThanOrEqual(1);
				expect(steps[0]?.step_name).toBe("custom:step");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 60000 },
	);

	test(
		"populates all metadata (session_id, model, duration, tokens, cost, log_path)",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				await run5x(projectRoot, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					runId,
					"--record",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
				]);

				// Check the recorded step's metadata
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThanOrEqual(1);
				const step = steps[0] as Record<string, unknown>;

				// session_id must be a non-empty string
				expect(typeof step.session_id).toBe("string");
				expect((step.session_id as string).length).toBeGreaterThan(0);

				// model from sample provider config
				expect(step.model).toBe("sample/test-model");

				// duration_ms is a number
				expect(typeof step.duration_ms).toBe("number");

				// tokens
				expect(typeof step.tokens_in).toBe("number");
				expect(typeof step.tokens_out).toBe("number");

				// log_path is a non-empty string
				expect(typeof step.log_path).toBe("string");
				expect((step.log_path as string).length).toBeGreaterThan(0);

				// result_json is valid JSON containing the structured result
				const resultJson = JSON.parse(step.result_json as string) as Record<
					string,
					unknown
				>;
				expect(resultJson.result).toBe("complete");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 60000 },
	);

	test(
		"--phase flag passes phase to record",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				await run5x(projectRoot, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					runId,
					"--record",
					"--phase",
					"3",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=3",
					"--var",
					"user_notes=test",
				]);

				// Verify phase was recorded
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThanOrEqual(1);
				expect(steps[0]?.phase).toBe("3");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 60000 },
	);

	test(
		"--record still outputs JSON envelope to stdout (only one envelope)",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					runId,
					"--record",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
				]);

				// There should be exactly one JSON object on stdout
				const trimmed = result.stdout.trim();
				const json = JSON.parse(trimmed) as Record<string, unknown>;
				expect(json.ok).toBe(true);

				// Verify there's only one JSON object by checking
				// no additional { after the first object
				// (the output should be a single parseable JSON string)
				expect(() => JSON.parse(trimmed)).not.toThrow();

				// The data should be the invoke result, not the record result
				const data = json.data as Record<string, unknown>;
				expect(data).toHaveProperty("result");
				expect(data).toHaveProperty("session_id");
				expect(data).toHaveProperty("tokens");
				// Should NOT have recording fields like step_id, recorded
				expect(data).not.toHaveProperty("step_id");
				expect(data).not.toHaveProperty("recorded");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 60000 },
	);

	test(
		"invoke --run with missing run ID fails closed with RUN_NOT_FOUND",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, planPath } = await setupProjectWithRun(dir);

				// Use a non-existent run ID — invoke must fail closed,
				// consistent with quality/diff/run handlers.
				const fakeRunId = "run_nonexistent_12345";
				const result = await run5x(projectRoot, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					fakeRunId,
					"--record",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
				]);

				// Must be a hard error — ok:false with RUN_NOT_FOUND
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				expect(json.error).toBeDefined();
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("RUN_NOT_FOUND");

				// Exit code should be non-zero
				expect(result.exitCode).not.toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 60000 },
	);

	test(
		"--record without step name available emits warning to stderr, does not corrupt stdout",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Create a custom template in the override dir with a name NOT in
				// the step_name fallback map — this ensures stepName is null.
				const overrideDir = join(projectRoot, ".5x", "templates", "prompts");
				mkdirSync(overrideDir, { recursive: true });
				writeFileSync(
					join(overrideDir, "custom-author-task.md"),
					[
						"---",
						"name: custom-author-task",
						"version: 1",
						"variables: [plan_path]",
						"---",
						"Do something with {{plan_path}}.",
					].join("\n"),
				);

				const result = await run5x(projectRoot, [
					"invoke",
					"author",
					"custom-author-task",
					"--run",
					runId,
					"--record",
					"--var",
					`plan_path=${planPath}`,
				]);

				// Primary envelope should be the only JSON on stdout
				const trimmed = result.stdout.trim();
				const json = JSON.parse(trimmed) as Record<string, unknown>;
				expect(json.ok).toBe(true);

				// Verify there's exactly one JSON object (no second error envelope)
				expect(() => JSON.parse(trimmed)).not.toThrow();

				// The data should be the invoke result
				const data = json.data as Record<string, unknown>;
				expect(data).toHaveProperty("result");
				expect(data).toHaveProperty("session_id");
				// step_name should be null since template is not in the fallback map
				expect(data.step_name).toBeNull();

				// stderr should contain a warning about the missing step name
				expect(result.stderr).toContain("Warning");
				expect(result.stderr).toContain("step name");

				// Exit code should be non-zero
				expect(result.exitCode).not.toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 60000 },
	);
});
