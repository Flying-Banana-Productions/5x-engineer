/**
 * Integration test for sub-project `5x run init` with relative paths.
 *
 * Validates that config path resolution correctly resolves relative paths
 * in sub-project configs against the sub-project directory, not the root.
 * (Phase 1, 019-orchestrator-improvements)
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
		`5x-subproj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
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

describe("5x run init with sub-project config", () => {
	test(
		"sub-project relative paths.plans resolves correctly",
		async () => {
			const dir = makeTmpDir();
			try {
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

				// Root 5x.toml — default plans path
				writeFileSync(
					join(dir, "5x.toml"),
					`[paths]\nplans = "docs/development"\n`,
				);

				// Sub-project 5x.toml with relative paths.plans
				const subDir = join(dir, "packages", "foo");
				mkdirSync(subDir, { recursive: true });
				writeFileSync(join(subDir, "5x.toml"), `[paths]\nplans = "docs/dev"\n`);

				// Create plan file under the sub-project's configured plans dir
				const planDir = join(subDir, "docs", "dev");
				mkdirSync(planDir, { recursive: true });
				const planPath = join(planDir, "some-plan.md");
				writeFileSync(
					planPath,
					"# Some Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
				);

				writeFileSync(join(dir, ".gitignore"), ".5x/\n");

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

				// Run `5x init` to create state DB
				const initResult = await run5x(dir, ["init"]);
				expect(initResult.exitCode).toBe(0);

				// Run `5x run init --plan packages/foo/docs/dev/some-plan.md`
				const result = await run5x(dir, ["run", "init", "--plan", planPath]);

				if (result.exitCode !== 0) {
					console.error("STDERR:", result.stderr);
					console.error("STDOUT:", result.stdout);
				}
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);

				const payload = data.data as Record<string, unknown>;
				expect(payload.run_id).toBeDefined();
				// plan_path should be absolute and under packages/foo/
				const storedPlanPath = payload.plan_path as string;
				expect(storedPlanPath).toContain("packages/foo/docs/dev/some-plan.md");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);
});
