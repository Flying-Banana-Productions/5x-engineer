/**
 * Tests for `5x protocol validate` — Phase 1, 014-harness-native-subagent.
 *
 * Validates author/reviewer schema validation, --require-commit defaults,
 * auto-detect raw vs outputSuccess envelope input, stdin/file parsing,
 * and combined validate-and-record flow.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../../../src/db/schema.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-protocol-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
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

/** Create a minimal project with git repo and 5x config. */
function setupProject(dir: string): void {
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

	mkdirSync(join(dir, ".5x"), { recursive: true });
	const db = new Database(join(dir, ".5x", "5x.db"));
	runMigrations(db);
	db.close();

	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n',
	);

	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(
		join(planDir, "test-plan.md"),
		"# Test Plan\n\n## Phase 1\n\n- [ ] Do thing\n",
	);

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
}

function insertRun(dir: string, runId: string, planPath: string): void {
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.run(
		`INSERT INTO runs (id, plan_path, status, config_json, created_at, updated_at)
		 VALUES (?1, ?2, 'active', '{}', datetime('now'), datetime('now'))`,
		[runId, planPath],
	);
	db.close();
}

// ---------------------------------------------------------------------------
// Author validation tests
// ---------------------------------------------------------------------------

describe("5x protocol validate author", () => {
	test(
		"validates valid author complete result from stdin",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					result: "complete",
					commit: "abc123def",
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author"],
					input,
				);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.role).toBe("author");
				expect(data.valid).toBe(true);
				const res = data.result as Record<string, unknown>;
				expect(res.result).toBe("complete");
				expect(res.commit).toBe("abc123def");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--require-commit is true by default — rejects complete without commit",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					result: "complete",
					// no commit field
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author"],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_STRUCTURED_OUTPUT");
				expect(error.message).toContain("commit");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--no-require-commit allows complete without commit",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					result: "complete",
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author", "--no-require-commit"],
					input,
				);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"validates needs_human with reason",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					result: "needs_human",
					reason: "Stuck on complex logic",
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author"],
					input,
				);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"rejects needs_human without reason",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					result: "needs_human",
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author"],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_STRUCTURED_OUTPUT");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"reads input from --input file",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const inputPath = join(dir, "result.json");
				writeFileSync(
					inputPath,
					JSON.stringify({ result: "complete", commit: "def456" }),
				);

				const result = await run5x(dir, [
					"protocol",
					"validate",
					"author",
					"--input",
					inputPath,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				const res = data.result as Record<string, unknown>;
				expect(res.commit).toBe("def456");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});

// ---------------------------------------------------------------------------
// Auto-detect input format tests
// ---------------------------------------------------------------------------

describe("5x protocol validate — auto-detect input format", () => {
	test(
		"unwraps outputSuccess envelope (.data.result) automatically",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				// This is what `5x invoke` returns — an outputSuccess envelope
				const envelope = JSON.stringify({
					ok: true,
					data: {
						run_id: "run_abc",
						step_name: "author:implement",
						result: {
							result: "complete",
							commit: "abc123",
						},
						session_id: "sess_1",
						model: "test",
						duration_ms: 1000,
						tokens: { in: 100, out: 200 },
						cost_usd: 0.5,
						log_path: "/tmp/log",
					},
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author"],
					envelope,
				);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				const res = data.result as Record<string, unknown>;
				expect(res.result).toBe("complete");
				expect(res.commit).toBe("abc123");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"treats raw JSON (no ok field) as direct structured output",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const raw = JSON.stringify({
					readiness: "ready",
					items: [],
					summary: "Looks good",
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "reviewer"],
					raw,
				);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				const res = data.result as Record<string, unknown>;
				expect(res.readiness).toBe("ready");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});

// ---------------------------------------------------------------------------
// Reviewer validation tests
// ---------------------------------------------------------------------------

describe("5x protocol validate reviewer", () => {
	test(
		"validates valid reviewer ready verdict",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					readiness: "ready",
					items: [],
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "reviewer"],
					input,
				);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"validates not_ready with items",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					readiness: "not_ready",
					items: [
						{
							id: "P0.1",
							title: "Missing test",
							action: "auto_fix",
							reason: "No tests for the new function",
						},
					],
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "reviewer"],
					input,
				);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"rejects not_ready with empty items",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					readiness: "not_ready",
					items: [],
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "reviewer"],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_STRUCTURED_OUTPUT");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"rejects item without action",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					readiness: "ready_with_corrections",
					items: [
						{
							id: "P1.1",
							title: "Missing docs",
							// no action field
							reason: "Function lacks JSDoc",
						},
					],
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "reviewer"],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});

// ---------------------------------------------------------------------------
// Invalid input tests
// ---------------------------------------------------------------------------

describe("5x protocol validate — invalid input", () => {
	test(
		"rejects non-JSON input",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author"],
					"not json at all",
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_JSON");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"rejects non-object input",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author"],
					'"just a string"',
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_STRUCTURED_OUTPUT");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});

// ---------------------------------------------------------------------------
// Combined validate + record tests
// ---------------------------------------------------------------------------

describe("5x protocol validate --record", () => {
	test(
		"validates and records in one command",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_rec001";
				insertRun(dir, runId, planPath);

				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--run",
						runId,
						"--record",
						"--step",
						"author:implement",
						"--phase",
						"Phase 1",
						"--iteration",
						"0",
					],
					input,
				);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				// Verify the step was recorded by checking run state
				const stateResult = await run5x(dir, ["run", "state", "--run", runId]);
				const stateJson = parseJson(stateResult.stdout);
				expect(stateJson.ok).toBe(true);
				const stateData = stateJson.data as Record<string, unknown>;
				const steps = stateData.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThan(0);
				const lastStep = steps[steps.length - 1] as Record<string, unknown>;
				expect(lastStep.step_name).toBe("author:implement");
				expect(lastStep.phase).toBe("Phase 1");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--record without --run fails with error envelope (not double-output)",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author", "--record", "--step", "test"],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
				expect(error.message).toContain("--record requires --run");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--record without --step fails with error envelope (not double-output)",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_rec002";
				insertRun(dir, runId, planPath);

				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					["protocol", "validate", "author", "--run", runId, "--record"],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
				expect(error.message).toContain("--record requires --step");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--record with invalid run id fails with error (no stdout corruption)",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--record",
						"--run",
						"../bad-traversal",
						"--step",
						"test",
					],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				// Should be a single error envelope, not success + error
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});
