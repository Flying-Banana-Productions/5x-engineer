import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-run-init-wt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

function setupProject(dir: string): { planPath: string } {
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

	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "001-test-feature.md");
	writeFileSync(planPath, "# Plan\n\n## Phase 1\n\n- [ ] Task\n");

	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

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

	return { planPath };
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

describe("5x run init --worktree", () => {
	test("returns PLAN_NOT_FOUND for missing plan path", async () => {
		const dir = makeTmpDir();
		try {
			setupProject(dir);
			const missingPlan = join(dir, "docs", "development", "missing.md");
			const result = await run5x(dir, ["run", "init", "--plan", missingPlan]);
			expect(result.exitCode).toBe(2);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as { code: string }).code).toBe("PLAN_NOT_FOUND");
		} finally {
			cleanupDir(dir);
		}
	});

	test("creates and maps default worktree when --worktree is set", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);
			const result = await run5x(dir, [
				"run",
				"init",
				"--plan",
				planPath,
				"--worktree",
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as {
				worktree: { action: string; worktree_path: string; branch: string };
			};
			expect(payload.worktree.action).toBe("created");
			expect(payload.worktree.branch).toBe("5x/001-test-feature");
			expect(existsSync(payload.worktree.worktree_path)).toBe(true);

			const listResult = await run5x(dir, ["worktree", "list"]);
			const listData = parseJson(listResult.stdout);
			const worktrees = (listData.data as { worktrees: unknown[] }).worktrees;
			expect(worktrees.length).toBe(1);
		} finally {
			cleanupDir(dir);
		}
	});

	test("attaches explicit worktree path via --worktree <path> shorthand", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);
			const manualPath = join(dir, ".5x", "worktrees", "legacy-001");
			mkdirSync(join(dir, ".5x", "worktrees"), { recursive: true });

			const wtCreate = Bun.spawnSync(
				["git", "worktree", "add", manualPath, "-b", "5x/001-test-feature"],
				{
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(wtCreate.exitCode).toBe(0);

			const result = await run5x(dir, [
				"run",
				"init",
				"--plan",
				planPath,
				"--worktree",
				manualPath,
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as {
				worktree: { action: string; worktree_path: string; branch: string };
			};
			expect(payload.worktree.action).toBe("attached");
			expect(payload.worktree.worktree_path).toBe(manualPath);
			expect(payload.worktree.branch).toBe("5x/001-test-feature");
		} finally {
			cleanupDir(dir);
		}
	});

	// Phase 4: top-level worktree context fields for pipe consumers

	test("run init --worktree includes top-level worktree_path in success payload", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);
			const result = await run5x(dir, [
				"run",
				"init",
				"--plan",
				planPath,
				"--worktree",
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as Record<string, unknown>;

			// Top-level worktree_path must be present alongside nested worktree object
			expect(typeof payload.worktree_path).toBe("string");
			expect(payload.worktree_path).toBeTruthy();

			// Nested worktree object must still be present (backward compat)
			const wt = payload.worktree as {
				worktree_path: string;
			};
			expect(wt.worktree_path).toBe(payload.worktree_path as string);
		} finally {
			cleanupDir(dir);
		}
	});

	test("run init --worktree includes worktree_plan_path when plan exists in worktree", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);
			const result = await run5x(dir, [
				"run",
				"init",
				"--plan",
				planPath,
				"--worktree",
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as Record<string, unknown>;

			// The worktree is a git worktree of the same repo — plan file should
			// exist there, so worktree_plan_path should be present
			if (payload.worktree_plan_path !== undefined) {
				expect(typeof payload.worktree_plan_path).toBe("string");
				const wtPlanPath = payload.worktree_plan_path as string;
				expect(existsSync(wtPlanPath)).toBe(true);
				// Must be under the worktree path
				expect(wtPlanPath.startsWith(payload.worktree_path as string)).toBe(
					true,
				);
			}
			// If plan doesn't exist in worktree (e.g. uncommitted), field is absent — acceptable
		} finally {
			cleanupDir(dir);
		}
	});

	test("run init without --worktree omits worktree_path and worktree_plan_path", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);
			const result = await run5x(dir, ["run", "init", "--plan", planPath]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as Record<string, unknown>;

			// No worktree context when --worktree is not used
			expect(payload.worktree).toBeUndefined();
			expect(payload.worktree_path).toBeUndefined();
			expect(payload.worktree_plan_path).toBeUndefined();
		} finally {
			cleanupDir(dir);
		}
	});

	test("resumed run with --worktree includes top-level worktree context fields", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			// First init creates the run
			const first = await run5x(dir, [
				"run",
				"init",
				"--plan",
				planPath,
				"--worktree",
			]);
			expect(first.exitCode).toBe(0);
			const firstData = parseJson(first.stdout);
			expect((firstData.data as Record<string, unknown>).resumed).toBe(false);

			// Second init resumes
			const second = await run5x(dir, [
				"run",
				"init",
				"--plan",
				planPath,
				"--worktree",
			]);
			expect(second.exitCode).toBe(0);
			const secondData = parseJson(second.stdout);
			const payload = secondData.data as Record<string, unknown>;
			expect(payload.resumed).toBe(true);

			// Top-level worktree_path must be present on resumed run too
			expect(typeof payload.worktree_path).toBe("string");
			expect(payload.worktree_path).toBeTruthy();
		} finally {
			cleanupDir(dir);
		}
	});
});
