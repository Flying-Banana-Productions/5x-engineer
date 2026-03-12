/**
 * Integration test for `5x protocol validate --record` E2E happy path.
 *
 * Validates that the CLI subprocess correctly reads stdin, validates the
 * structured output, records the step to the DB, and returns a valid
 * JSON envelope. This is the only test that needs a real subprocess;
 * all other protocol-validate tests are unit tests in
 * test/unit/commands/protocol-validate.test.ts.
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
	timeoutMs = 15000,
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
	const timer = setTimeout(() => proc.kill("SIGINT"), timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

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
// E2E: validate + record in one command
// ---------------------------------------------------------------------------

describe("5x protocol validate --record (E2E)", () => {
	test(
		"validates stdin, records step to DB, returns JSON envelope",
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
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.role).toBe("author");
				expect(data.valid).toBe(true);

				// Verify DB record directly (no second subprocess)
				const db = new Database(join(dir, ".5x", "5x.db"));
				const steps = db
					.query(
						"SELECT step_name, phase FROM steps WHERE run_id = ?1 ORDER BY id DESC LIMIT 1",
					)
					.all(runId) as Array<{ step_name: string; phase: string }>;
				db.close();
				expect(steps.length).toBe(1);
				expect(steps[0]?.step_name).toBe("author:implement");
				expect(steps[0]?.phase).toBe("Phase 1");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});
