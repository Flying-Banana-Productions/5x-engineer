import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetForTest, closeDb } from "../../../src/db/connection.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-quality-v1-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

function setupProject(dir: string, qualityGates: string[] = []): void {
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

	// Create .5x directory
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

	// Write config with quality gates
	if (qualityGates.length > 0) {
		const configContent = `export default ${JSON.stringify({ qualityGates })};\n`;
		writeFileSync(join(dir, "5x.config.mjs"), configContent);
	}

	// Initial commit
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

describe("5x quality run", () => {
	test(
		"returns passed=true with empty quality gates",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir); // no quality gates configured
				const result = await run5x(dir, ["quality", "run"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { passed: boolean; results: unknown[] };
				expect(payload.passed).toBe(true);
				expect(payload.results).toEqual([]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"runs passing quality gate and returns results",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir, ["echo hello"]);
				const result = await run5x(dir, ["quality", "run"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					passed: boolean;
					results: Array<{
						command: string;
						passed: boolean;
						duration_ms: number;
						output: string;
					}>;
				};
				expect(payload.passed).toBe(true);
				expect(payload.results.length).toBe(1);
				expect(payload.results[0]?.command).toBe("echo hello");
				expect(payload.results[0]?.passed).toBe(true);
				expect(payload.results[0]?.output).toContain("hello");
				expect(typeof payload.results[0]?.duration_ms).toBe("number");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"runs failing quality gate and returns passed=false",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir, ["exit 1"]);
				const result = await run5x(dir, ["quality", "run"]);
				expect(result.exitCode).toBe(0); // CLI succeeds — the gate failed, not the CLI
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					passed: boolean;
					results: Array<{ command: string; passed: boolean }>;
				};
				expect(payload.passed).toBe(false);
				expect(payload.results[0]?.passed).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"runs multiple quality gates sequentially",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir, ["echo first", "echo second"]);
				const result = await run5x(dir, ["quality", "run"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					passed: boolean;
					results: Array<{ command: string; passed: boolean }>;
				};
				expect(payload.passed).toBe(true);
				expect(payload.results.length).toBe(2);
				expect(payload.results[0]?.command).toBe("echo first");
				expect(payload.results[1]?.command).toBe("echo second");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"mixed pass/fail reports overall passed=false",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir, ["echo ok", "exit 1"]);
				const result = await run5x(dir, ["quality", "run"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					passed: boolean;
					results: Array<{ command: string; passed: boolean }>;
				};
				expect(payload.passed).toBe(false);
				expect(payload.results[0]?.passed).toBe(true);
				expect(payload.results[1]?.passed).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Sub-project cwd tests (Phase 5 — quality gate execution directory)
// ---------------------------------------------------------------------------

describe("5x quality run --run with sub-project config", () => {
	afterEach(() => {
		try {
			closeDb();
			_resetForTest();
		} catch {}
	});

	test(
		"quality gates from sub-project 5x.toml execute in sub-project directory",
		async () => {
			const dir = makeTmpDir();
			try {
				// Set up monorepo git repo
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

				// Root config — no quality gates
				writeFileSync(join(dir, "5x.toml"), "skipQualityGates = true\n");

				// Sub-project with quality gates that reveal cwd and its own paths.plans
				const subDir = join(dir, "packages", "sub");
				mkdirSync(subDir, { recursive: true });
				writeFileSync(
					join(subDir, "5x.toml"),
					'qualityGates = ["pwd"]\n\n[paths]\nplans = "docs/dev"\n',
				);

				// Create plan in sub-project's configured plans dir
				const planDir = join(subDir, "docs", "dev");
				mkdirSync(planDir, { recursive: true });
				const planFile = join(planDir, "test-plan.md");
				writeFileSync(
					planFile,
					"# Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
				);

				mkdirSync(join(dir, ".5x"), { recursive: true });
				writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

				// Initial commit
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

				// Init 5x (creates DB)
				const initResult = await run5x(dir, ["init"]);
				expect(initResult.exitCode).toBe(0);

				// Init a run with the sub-project plan
				const runInitResult = await run5x(dir, [
					"run",
					"init",
					"--plan",
					planFile,
				]);
				expect(runInitResult.exitCode).toBe(0);
				const runInitData = parseJson(runInitResult.stdout);
				expect(runInitData.ok).toBe(true);
				const runId = (runInitData.data as { run_id: string }).run_id;

				// Run quality gates with --run
				const qualityResult = await run5x(dir, [
					"quality",
					"run",
					"--run",
					runId,
				]);

				expect(qualityResult.exitCode).toBe(0);
				const qualityData = parseJson(qualityResult.stdout);
				expect(qualityData.ok).toBe(true);

				const payload = qualityData.data as {
					passed: boolean;
					results: Array<{
						command: string;
						passed: boolean;
						output: string;
					}>;
				};
				expect(payload.passed).toBe(true);
				expect(payload.results.length).toBe(1);
				expect(payload.results[0]?.command).toBe("pwd");

				// The critical assertion: pwd output should contain the
				// sub-project path, NOT the monorepo root
				const pwdOutput = payload.results[0]?.output.trim();
				expect(pwdOutput).toContain(resolve(subDir));
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);
});
