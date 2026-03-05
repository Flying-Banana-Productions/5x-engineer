import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-wt-v1-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
	// Init git repo
	Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});

	// Create plan file
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "001-test-feature.md");
	writeFileSync(
		planPath,
		"# Test Feature Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	// Create .5x directory
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	// Initial commit
	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
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

describe("5x worktree", () => {
	test("create: creates a new worktree and returns JSON", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			const result = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as {
				worktree_path: string;
				branch: string;
				created: boolean;
			};
			expect(payload.created).toBe(true);
			expect(payload.worktree_path).toContain("001-test-feature");
			expect(payload.branch).toBe("5x/001-test-feature");
			expect(existsSync(payload.worktree_path)).toBe(true);
		} finally {
			cleanupDir(dir);
		}
	});

	test("create: idempotent — returns existing worktree with created=false", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			// Create first time
			await run5x(dir, ["worktree", "create", "--plan", planPath]);

			// Create again — should be idempotent
			const result = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as {
				worktree_path: string;
				created: boolean;
			};
			expect(payload.created).toBe(false);
		} finally {
			cleanupDir(dir);
		}
	});

	test("create: accepts custom --branch name", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			const result = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				planPath,
				"--branch",
				"custom-branch",
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as { branch: string; created: boolean };
			expect(payload.branch).toBe("custom-branch");
			expect(payload.created).toBe(true);
		} finally {
			cleanupDir(dir);
		}
	});

	test("remove: removes an existing worktree", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			// Create worktree first
			const createResult = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				planPath,
			]);
			const createData = parseJson(createResult.stdout);
			const wtPath = (createData.data as { worktree_path: string })
				.worktree_path;
			expect(existsSync(wtPath)).toBe(true);

			// Remove it
			const result = await run5x(dir, [
				"worktree",
				"remove",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as { removed: boolean };
			expect(payload.removed).toBe(true);
			expect(existsSync(wtPath)).toBe(false);
		} finally {
			cleanupDir(dir);
		}
	});

	test("remove: returns error for plan with no worktree", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			const result = await run5x(dir, [
				"worktree",
				"remove",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(1);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			const error = data.error as { code: string };
			expect(error.code).toBe("WORKTREE_NOT_FOUND");
		} finally {
			cleanupDir(dir);
		}
	});

	test("remove: handles missing directory gracefully", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			// Create worktree
			const createResult = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				planPath,
			]);
			const createData = parseJson(createResult.stdout);
			const wtPath = (createData.data as { worktree_path: string })
				.worktree_path;

			// Manually remove the directory (simulating corruption)
			rmSync(wtPath, { recursive: true });

			// Remove should succeed gracefully
			const result = await run5x(dir, [
				"worktree",
				"remove",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as { removed: boolean };
			expect(payload.removed).toBe(true);
		} finally {
			cleanupDir(dir);
		}
	});

	test("list: returns empty array when no worktrees", async () => {
		const dir = makeTmpDir();
		try {
			setupProject(dir);

			const result = await run5x(dir, ["worktree", "list"]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as { worktrees: unknown[] };
			expect(payload.worktrees).toEqual([]);
		} finally {
			cleanupDir(dir);
		}
	});

	test("list: returns worktrees after creation", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			// Create worktree
			await run5x(dir, ["worktree", "create", "--plan", planPath]);

			const result = await run5x(dir, ["worktree", "list"]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as {
				worktrees: Array<{
					plan_path: string;
					worktree_path: string;
					branch: string | null;
					exists: boolean;
				}>;
			};
			expect(payload.worktrees.length).toBe(1);
			expect(payload.worktrees[0]?.worktree_path).toContain("001-test-feature");
			expect(payload.worktrees[0]?.branch).toBe("5x/001-test-feature");
			expect(payload.worktrees[0]?.exists).toBe(true);
		} finally {
			cleanupDir(dir);
		}
	});

	test("create: returns PLAN_NOT_FOUND for missing plan file", async () => {
		const dir = makeTmpDir();
		try {
			setupProject(dir);

			const missingPlan = join(dir, "docs", "development", "missing-plan.md");

			const result = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				missingPlan,
			]);
			expect(result.exitCode).toBe(2); // PLAN_NOT_FOUND exit code
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			const error = data.error as { code: string };
			expect(error.code).toBe("PLAN_NOT_FOUND");
		} finally {
			cleanupDir(dir);
		}
	});

	test("create: postCreate hook output does not contaminate stdout JSON", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			// Create a JS config file that sets worktree.postCreate to echo hook output
			const configPath = join(dir, "5x.config.mjs");
			writeFileSync(
				configPath,
				`export default { worktree: { postCreate: "echo 'hook output here'" } };\n`,
			);

			const result = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(0);

			// stdout must parse as valid JSON (no hook contamination)
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as {
				worktree_path: string;
				branch: string;
				created: boolean;
			};
			expect(payload.created).toBe(true);

			// Hook output should appear on stderr, not stdout
			expect(result.stderr).toContain("hook output here");
		} finally {
			cleanupDir(dir);
		}
	});

	test("create: failing postCreate hook is non-fatal with warnings in response", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			// Create a config with a failing postCreate hook
			const configPath = join(dir, "5x.config.mjs");
			writeFileSync(
				configPath,
				`export default { worktree: { postCreate: "exit 1" } };\n`,
			);

			const result = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				planPath,
			]);
			// Worktree creation succeeds even though hook fails
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as {
				worktree_path: string;
				created: boolean;
				warnings?: string[];
			};
			expect(payload.created).toBe(true);
			// warnings field should be present
			expect(payload.warnings).toBeDefined();
			expect(payload.warnings?.length).toBeGreaterThan(0);
			expect(payload.warnings?.[0]).toContain("postCreate hook failed");
		} finally {
			cleanupDir(dir);
		}
	});

	test("full lifecycle: create → list → remove → list empty", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath } = setupProject(dir);

			// Create
			const createResult = await run5x(dir, [
				"worktree",
				"create",
				"--plan",
				planPath,
			]);
			expect(createResult.exitCode).toBe(0);
			const createData = parseJson(createResult.stdout);
			expect((createData.data as { created: boolean }).created).toBe(true);

			// List — should have 1
			const listResult1 = await run5x(dir, ["worktree", "list"]);
			const listData1 = parseJson(listResult1.stdout);
			expect(
				(listData1.data as { worktrees: unknown[] }).worktrees.length,
			).toBe(1);

			// Remove
			const removeResult = await run5x(dir, [
				"worktree",
				"remove",
				"--plan",
				planPath,
				"--force",
			]);
			expect(removeResult.exitCode).toBe(0);

			// List — should have 0
			const listResult2 = await run5x(dir, ["worktree", "list"]);
			const listData2 = parseJson(listResult2.stdout);
			expect(
				(listData2.data as { worktrees: unknown[] }).worktrees.length,
			).toBe(0);
		} finally {
			cleanupDir(dir);
		}
	});
});
