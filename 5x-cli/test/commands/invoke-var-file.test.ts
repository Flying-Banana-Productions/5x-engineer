/**
 * Tests for `--var key=@-` and `--var key=@path` (Phase 5).
 *
 * Validates that --var flags can read values from stdin (@-) and files (@path),
 * and that @- prevents upstream context reading.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasStdinVarFlag } from "../../src/commands/template-vars.js";
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-invoke-var-file-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

	// Configure sample provider with echo enabled so we can verify
	// that loaded @- and @path content reaches the rendered prompt.
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test-model"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = true\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
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

/**
 * Read the NDJSON log file and return the echoed prompt text.
 * The sample provider (echo=true) writes text events as
 * `[SampleProvider echo] <rendered prompt>`.
 * Returns the full text delta from the first "text" event.
 */
function readEchoedPromptFromLog(logPath: string): string {
	const lines = readFileSync(logPath, "utf-8").trim().split("\n");
	for (const line of lines) {
		const entry = JSON.parse(line) as Record<string, unknown>;
		if (entry.type === "text" && typeof entry.delta === "string") {
			return entry.delta;
		}
	}
	throw new Error(`No text event found in log: ${logPath}`);
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
// Unit tests for hasStdinVarFlag
// ---------------------------------------------------------------------------

describe("hasStdinVarFlag", () => {
	test("returns false for undefined vars", () => {
		expect(hasStdinVarFlag(undefined)).toBe(false);
	});

	test("returns false for empty array", () => {
		expect(hasStdinVarFlag([])).toBe(false);
	});

	test("returns false for normal vars", () => {
		expect(hasStdinVarFlag(["key=value", "other=stuff"])).toBe(false);
	});

	test("returns true when a var uses @- (stdin)", () => {
		expect(hasStdinVarFlag(["key=value", "diff=@-"])).toBe(true);
	});

	test("returns true for single string with @-", () => {
		expect(hasStdinVarFlag("diff=@-")).toBe(true);
	});

	test("returns false for @path (not stdin)", () => {
		expect(hasStdinVarFlag(["diff=@./file.txt"])).toBe(false);
	});

	test("returns false when @- appears in value but not as whole value", () => {
		expect(hasStdinVarFlag(["key=some@-value"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Integration tests for --var key=@- and --var key=@path
// ---------------------------------------------------------------------------

describe("--var key=@path (file read)", () => {
	test(
		"--var user_notes=@./fixture.txt reads value from file and reaches rendered prompt",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Create a fixture file with some content
				const fixturePath = join(projectRoot, "fixture.txt");
				writeFileSync(fixturePath, "These are notes from a file");

				const result = await run5x(projectRoot, [
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
					"user_notes=@./fixture.txt",
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);

				// Verify the file content actually reached the rendered prompt
				// by reading the NDJSON log (sample provider echoes the prompt)
				const logPath = data.log_path as string;
				const echoedPrompt = readEchoedPromptFromLog(logPath);
				expect(echoedPrompt).toContain("These are notes from a file");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--var user_notes=@./nonexistent.txt errors with clear message",
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
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=@./nonexistent.txt",
				]);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
				expect(error.message).toContain("Failed to read file");
				expect(error.message).toContain("nonexistent.txt");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"@path vars work alongside upstream context reading and content reaches prompt",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Create a fixture file
				const fixturePath = join(projectRoot, "notes.txt");
				writeFileSync(fixturePath, "Notes from file");

				// Pipe an upstream envelope AND use @path for a var —
				// @path does not consume stdin, so upstream context should work
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
						"user_notes=@./notes.txt",
					],
					envelope,
				);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				// run_id should come from piped upstream envelope
				expect(data.run_id).toBe(runId);

				// Verify the file content reached the rendered prompt
				const logPath = data.log_path as string;
				const echoedPrompt = readEchoedPromptFromLog(logPath);
				expect(echoedPrompt).toContain("Notes from file");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);
});

describe("--var key=@literal (backward compat — literal @-prefixed values)", () => {
	test(
		"--var user_notes=@username passes literal @username without file read",
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
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=@username",
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);

				// Verify @username was passed as a literal value, not treated as a file
				const logPath = data.log_path as string;
				const echoedPrompt = readEchoedPromptFromLog(logPath);
				expect(echoedPrompt).toContain("@username");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--var user_notes=@mention with no file prefix passes literal value",
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
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=@abc123",
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;

				// Verify @abc123 was passed literally
				const logPath = data.log_path as string;
				const echoedPrompt = readEchoedPromptFromLog(logPath);
				expect(echoedPrompt).toContain("@abc123");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--var user_notes=@ (bare @) passes literal value",
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
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=@",
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);
});

describe("--var key=@- (stdin read)", () => {
	test(
		"--var user_notes=@- reads value from piped stdin and reaches rendered prompt",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Pipe plain text content (not a JSON envelope) — this should be
				// consumed by --var user_notes=@-
				const stdinContent = "These are notes from stdin";
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
						"user_notes=@-",
					],
					stdinContent,
				);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);

				// Verify the stdin content actually reached the rendered prompt
				// by reading the NDJSON log (sample provider echoes the prompt)
				const logPath = data.log_path as string;
				const echoedPrompt = readEchoedPromptFromLog(logPath);
				expect(echoedPrompt).toContain("These are notes from stdin");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"multiple @- vars errors with clear message",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

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
						"phase_number=@-",
						"--var",
						"user_notes=@-",
					],
					"some stdin",
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
				expect(error.message).toContain("one --var can read from stdin");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"@- var prevents upstream context reading",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId, planPath } = await setupProjectWithRun(dir);

				// Pipe a valid envelope, but with --var user_notes=@-
				// The @- should consume stdin, preventing envelope parsing.
				// Without --run, this should fail with INVALID_ARGS.
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
				expect(error.message).toContain("--run");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});
