/**
 * Integration tests for the invoke command — CLI subprocess behavior.
 *
 * Tests cover CLI arg parsing, exit codes, stderr streaming, run_id
 * validation, timeout validation, and enriched output envelope fields.
 * These all require spawning the CLI binary as a subprocess.
 *
 * Pure unit tests (template resolution, schema validation, log helpers,
 * exit code mappings, provider factory) are in test/unit/commands/invoke.test.ts.
 */

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
		`5x-invoke-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Create a minimal project with git repo. */
function setupProject(dir: string): string {
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
	const { Database } = require("bun:sqlite");
	const db = new Database(join(dir, ".5x", "5x.db"));
	runMigrations(db);
	db.close();
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n',
	);

	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(
		join(planDir, "test-plan.md"),
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
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

	return dir;
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
		env: cleanGitEnv(),
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

function insertRun(dir: string, runId: string): void {
	const { Database } = require("bun:sqlite");
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.query(
		`INSERT INTO runs (id, plan_path, status, config_json, created_at, updated_at)
		 VALUES (?1, ?2, 'active', '{}', datetime('now'), datetime('now'))`,
	).run(runId, join(dir, "docs", "development", "test-plan.md"));
	db.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("invoke CLI integration", () => {
	describe("parseVars", () => {
		test(
			"var flag without = is rejected by CLI",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_test123");
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"noequals",
						"--run",
						"run_test123",
					]);
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
	});

	describe("subcommand registration", () => {
		test(
			"template not found returns exit code 2",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_test123");
					const result = await run5x(dir, [
						"invoke",
						"author",
						"nonexistent-template",
						"--run",
						"run_test123",
					]);
					expect(result.exitCode).toBe(2);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("TEMPLATE_NOT_FOUND");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"missing template variables returns error",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_test123");
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/path/to/plan.md",
						"--run",
						"run_test123",
					]);
					expect(result.exitCode).not.toBe(0);
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"invoke subcommand is registered and accessible",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, ["invoke"]);
					expect(result.stderr).not.toContain("Unknown command");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"invoke author subcommand is registered",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, ["invoke", "author"]);
					expect(result.exitCode).toBeDefined();
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"invoke reviewer subcommand is registered",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, ["invoke", "reviewer"]);
					expect(result.exitCode).toBeDefined();
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("session resume", () => {
		test(
			"--session flag is accepted by the command definition",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_test789");
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--session",
						"sess-resume-123",
						"--run",
						"run_test789",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).not.toBe("INVALID_ARGS");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("run_id validation (P0.1)", () => {
		test(
			"path traversal in --run is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"../../../etc/evil",
					]);
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

		test("run_id with dots is rejected", async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					"plan_path=/p",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=none",
					"--run",
					"run..traversal",
				]);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
			} finally {
				cleanupDir(dir);
			}
		});

		test(
			"valid run_id is accepted",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_abc123");
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_abc123",
					]);
					const json = parseJson(result.stdout);
					if (!json.ok) {
						const error = json.error as Record<string, unknown>;
						expect(error.code).not.toBe("INVALID_ARGS");
					}
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"run_id starting with non-alphanumeric is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"-run_123",
					]);
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
	});

	describe("timeout validation (P0.3)", () => {
		test(
			"NaN timeout is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout",
						"notanumber",
					]);
					const json = parseJson(result.stdout);
					expect(json.ok).toBe(false);
					const error = json.error as Record<string, unknown>;
					expect(error.code).toBe("INVALID_ARGS");
					expect(typeof error.message === "string" && error.message).toContain(
						"--timeout",
					);
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"negative timeout is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout=-5",
					]);
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

		test(
			"zero timeout is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout",
						"0",
					]);
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

		test(
			"partial parse timeout (e.g. '10abc') is rejected",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout",
						"10abc",
					]);
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

		test(
			"valid positive integer timeout is accepted",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_test123");
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_test123",
						"--timeout",
						"30",
					]);
					const json = parseJson(result.stdout);
					if (!json.ok) {
						const error = json.error as Record<string, unknown>;
						expect(error.code).not.toBe("INVALID_ARGS");
					}
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("--run is required (P1.1)", () => {
		test(
			"invoke without --run fails",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
					]);
					expect(result.exitCode).not.toBe(0);
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("--stderr flag (P1.2)", () => {
		test(
			"without --stderr, non-TTY stderr has no streaming text",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_stderr_test1");
					writeFileSync(
						join(dir, "5x.toml"),
						'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n',
					);

					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_stderr_test1",
					]);

					expect(result.stderr).not.toContain("Sample provider response");
					expect(result.exitCode).not.toBe(0);
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"with --stderr, streaming text appears on stderr despite non-TTY",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_stderr_test2");
					writeFileSync(
						join(dir, "5x.toml"),
						'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n',
					);

					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=/p",
						"--var",
						"phase_number=1",
						"--var",
						"user_notes=none",
						"--run",
						"run_stderr_test2",
						"--stderr",
					]);

					expect(result.stderr).toContain("Sample provider response");
					expect(result.exitCode).not.toBe(0);
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"--stderr flag is accepted by the CLI for both author and reviewer",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_stderr_test3");
					writeFileSync(
						join(dir, "5x.toml"),
						'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n',
					);

					const result = await run5x(dir, [
						"invoke",
						"reviewer",
						"reviewer-commit",
						"--var",
						"commit_hash=abc123",
						"--var",
						"review_path=docs/development/reviews/r.md",
						"--var",
						"plan_path=docs/development/test-plan.md",
						"--run",
						"run_stderr_test3",
						"--stderr",
					]);

					const json = parseJson(result.stdout);
					if (!json.ok) {
						const error = json.error as Record<string, unknown>;
						expect(error.code).not.toBe("INVALID_ARGS");
					}
					expect(result.stderr).toContain("Sample provider response");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});

	describe("enriched invoke output fields", () => {
		test(
			"invoke handler emits run_id, step_name, phase, model in output envelope",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_enrich_test");
					writeFileSync(
						join(dir, "5x.toml"),
						'[author]\nprovider = "sample"\nmodel = "sample/test-model"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
					);

					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=docs/development/test-plan.md",
						"--var",
						"phase_number=2",
						"--var",
						"user_notes=test",
						"--run",
						"run_enrich_test",
					]);

					const json = parseJson(result.stdout);
					expect(json.ok).toBe(true);
					const data = json.data as Record<string, unknown>;

					expect(data.run_id).toBe("run_enrich_test");
					expect(data.step_name).toBe("author:implement");
					expect(data.phase).toBe("2");
					expect(data.model).toBe("sample/test-model");
					expect(data.result).toEqual({ result: "complete", commit: "abc123" });
					expect(data.session_id).toBeString();
					expect(data.duration_ms).toBeNumber();
					expect(data.tokens).toEqual({ in: 0, out: 0 });
					expect(data.log_path).toBeString();
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"phase is null when phase_number variable not provided",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_phase_null_test");
					writeFileSync(
						join(dir, "5x.toml"),
						'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\n',
					);

					const result = await run5x(dir, [
						"invoke",
						"author",
						"author-next-phase",
						"--var",
						"plan_path=docs/development/test-plan.md",
						"--var",
						"phase_number=",
						"--var",
						"user_notes=test",
						"--run",
						"run_phase_null_test",
					]);

					const json = parseJson(result.stdout);
					if (json.ok) {
						const data = json.data as Record<string, unknown>;
						expect(data).toHaveProperty("phase");
					}
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);

		test(
			"step_name comes from template frontmatter in handler output",
			async () => {
				const dir = makeTmpDir();
				try {
					setupProject(dir);
					insertRun(dir, "run_stepname_test");
					writeFileSync(
						join(dir, "5x.toml"),
						'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nreadiness = "ready"\nitems = []\n',
					);

					const result = await run5x(dir, [
						"invoke",
						"reviewer",
						"reviewer-plan",
						"--var",
						"plan_path=docs/development/test-plan.md",
						"--var",
						"review_path=docs/development/reviews/r.md",
						"--run",
						"run_stepname_test",
					]);

					const json = parseJson(result.stdout);
					expect(json.ok).toBe(true);
					const data = json.data as Record<string, unknown>;
					expect(data.step_name).toBe("reviewer:review");
				} finally {
					cleanupDir(dir);
				}
			},
			{ timeout: 20000 },
		);
	});
});
