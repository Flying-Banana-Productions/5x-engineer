/**
 * Tests for Phase 6: Worktree Command Guards (Mode-Aware UX).
 *
 * Verifies:
 * - `worktree create` fails in linked-worktree context (WORKTREE_CONTEXT_INVALID)
 * - `worktree create --allow-nested` bypasses the guard
 * - `worktree remove` prevents removing current checkout worktree (WORKTREE_SELF_REMOVE)
 * - Isolated-mode warnings on `worktree attach/remove`
 * - Legacy split-brain detection (root DB + local state DB)
 *
 * NOTE: Each test creates its own temp directories and cleans up after itself
 * to avoid shared mutable state issues under `bun test --concurrent`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const env = cleanGitEnv();
const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(prefix = "5x-wt-guard"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().trim();
}

function initRepo(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	writeFileSync(join(dir, "README.md"), "# Test\n");
	git(["add", "."], dir);
	git(["commit", "-m", "initial"], dir);
}

function createStateDb(rootDir: string, stateDir = ".5x"): void {
	const dir = join(rootDir, stateDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "5x.db"), "");
}

function createPlan(rootDir: string): string {
	const planDir = join(rootDir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "001-test-feature.md");
	writeFileSync(
		planPath,
		"# Test Feature Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);
	git(["add", "."], rootDir);
	git(["commit", "-m", "add plan"], rootDir);
	return planPath;
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(cwd: string, args: string[]): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env,
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

/** Clean up directories, removing worktree externals first. */
function cleanup(dirs: string[]): void {
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
}

// ---------------------------------------------------------------------------
// worktree create — linked-worktree guard
// ---------------------------------------------------------------------------

describe("worktree create linked-worktree guard", () => {
	test(
		"fails with WORKTREE_CONTEXT_INVALID from a linked worktree",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-wt-ext");
			try {
				initRepo(tmp);
				const planPath = createPlan(tmp);

				await run5x(tmp, ["init"]);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "guard-branch"], tmp);

				const result = await run5x(wtPath, [
					"worktree",
					"create",
					"--plan",
					planPath,
				]);

				expect(result.exitCode).toBe(1);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string; message: string };
				expect(error.code).toBe("WORKTREE_CONTEXT_INVALID");
				expect(error.message).toContain("linked-worktree context");
				expect(error.message).toContain("--allow-nested");
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"succeeds with --allow-nested from a linked worktree",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-wt-nested");
			try {
				initRepo(tmp);
				const planPath = createPlan(tmp);

				await run5x(tmp, ["init"]);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "nested-branch"], tmp);

				const result = await run5x(wtPath, [
					"worktree",
					"create",
					"--plan",
					planPath,
					"--allow-nested",
				]);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { created: boolean };
				expect(payload.created).toBe(true);
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"succeeds from main checkout (no guard triggered)",
		async () => {
			const tmp = makeTmpDir();
			try {
				initRepo(tmp);
				const planPath = createPlan(tmp);

				await run5x(tmp, ["init"]);

				const result = await run5x(tmp, [
					"worktree",
					"create",
					"--plan",
					planPath,
				]);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { created: boolean };
				expect(payload.created).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"guard not triggered when mode is none (unmanaged repo)",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-wt-unmanaged");
			try {
				initRepo(tmp);
				const planPath = createPlan(tmp);
				// No 5x init — mode will be 'none'

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "unmanaged-branch"], tmp);

				const result = await run5x(wtPath, [
					"worktree",
					"create",
					"--plan",
					planPath,
				]);

				// In 'none' mode, resolveDbContext will trigger init prompt or fail,
				// but the WORKTREE_CONTEXT_INVALID guard should NOT fire.
				if (result.exitCode !== 0) {
					const data = parseJson(result.stdout);
					if (!data.ok) {
						const error = data.error as { code: string };
						expect(error.code).not.toBe("WORKTREE_CONTEXT_INVALID");
					}
				}
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// worktree remove — self-remove guard
// ---------------------------------------------------------------------------

describe("worktree remove self-remove guard", () => {
	test(
		"prevents removing worktree from inside that worktree",
		async () => {
			const tmp = makeTmpDir();
			try {
				initRepo(tmp);
				const planPath = createPlan(tmp);

				await run5x(tmp, ["init"]);
				const createResult = await run5x(tmp, [
					"worktree",
					"create",
					"--plan",
					planPath,
				]);
				expect(createResult.exitCode).toBe(0);
				const createData = parseJson(createResult.stdout);
				const wtPath = (createData.data as { worktree_path: string })
					.worktree_path;

				// Try to remove from inside the worktree
				const result = await run5x(wtPath, [
					"worktree",
					"remove",
					"--plan",
					planPath,
				]);

				expect(result.exitCode).toBe(1);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string; message: string };
				expect(error.code).toBe("WORKTREE_SELF_REMOVE");
				expect(error.message).toContain("currently inside");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"allows removing worktree from main checkout",
		async () => {
			const tmp = makeTmpDir();
			try {
				initRepo(tmp);
				const planPath = createPlan(tmp);

				await run5x(tmp, ["init"]);
				const createResult = await run5x(tmp, [
					"worktree",
					"create",
					"--plan",
					planPath,
				]);
				expect(createResult.exitCode).toBe(0);
				const createData = parseJson(createResult.stdout);
				const wtPath = (createData.data as { worktree_path: string })
					.worktree_path;
				expect(existsSync(wtPath)).toBe(true);

				// Remove from main checkout — should succeed
				const result = await run5x(tmp, [
					"worktree",
					"remove",
					"--plan",
					planPath,
					"--force",
				]);

				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { removed: boolean }).removed).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Split-brain detection warning
// ---------------------------------------------------------------------------

describe("legacy split-brain detection", () => {
	test(
		"emits warning when root DB exists and local state DB also exists",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-wt-split");
			try {
				initRepo(tmp);
				createPlan(tmp);

				await run5x(tmp, ["init"]);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "split-branch"], tmp);

				// Simulate pre-existing local state DB in the worktree
				createStateDb(wtPath);

				// Run worktree list from the linked worktree
				const result = await run5x(wtPath, ["worktree", "list"]);

				// Command should succeed (list is always safe)
				expect(result.exitCode).toBe(0);
				// Warning should appear on stderr
				expect(result.stderr).toContain("Local state DB at");
				expect(result.stderr).toContain("is being ignored");
				expect(result.stderr).toContain("managed mode");
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"no warning when no local state DB exists",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-wt-clean");
			try {
				initRepo(tmp);
				createPlan(tmp);

				await run5x(tmp, ["init"]);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "clean-branch"], tmp);

				// Run worktree list from the linked worktree
				const result = await run5x(wtPath, ["worktree", "list"]);

				expect(result.exitCode).toBe(0);
				// No split-brain warning on stderr
				expect(result.stderr).not.toContain("Local state DB at");
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"no warning from main checkout even if root DB exists",
		async () => {
			const tmp = makeTmpDir();
			try {
				initRepo(tmp);
				createPlan(tmp);

				await run5x(tmp, ["init"]);

				// Run worktree list from main checkout
				const result = await run5x(tmp, ["worktree", "list"]);

				expect(result.exitCode).toBe(0);
				expect(result.stderr).not.toContain("Local state DB at");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Isolated-mode warnings
// ---------------------------------------------------------------------------

describe("isolated-mode warnings", () => {
	test(
		"worktree attach emits isolated-mode warning",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-wt-iso-attach");
			try {
				initRepo(tmp);
				const planPath = createPlan(tmp);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-attach-branch"], tmp);

				// Initialize 5x in worktree (no root DB → isolated mode)
				await run5x(wtPath, ["init"]);

				// Create another worktree to attach
				const anotherWt = join(externalDir, "wt2");
				git(["worktree", "add", anotherWt, "-b", "iso-attach-2"], tmp);

				// Attempt to attach from isolated worktree
				const result = await run5x(wtPath, [
					"worktree",
					"attach",
					"--plan",
					planPath,
					"--path",
					anotherWt,
				]);

				// Check stderr for isolated-mode warning
				expect(result.stderr).toContain("isolated mode");
				expect(result.stderr).toContain("worktree attach");
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"worktree remove emits isolated-mode warning",
		async () => {
			const tmp = makeTmpDir();
			const externalDir = makeTmpDir("5x-wt-iso-rm");
			try {
				initRepo(tmp);
				const planPath = createPlan(tmp);

				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-rm-branch"], tmp);

				// Initialize 5x in worktree (no root DB → isolated mode)
				await run5x(wtPath, ["init"]);

				// worktree remove for a plan with no worktree will fail with
				// WORKTREE_NOT_FOUND, but the warning should still be emitted
				// before the error is raised.
				const result = await run5x(wtPath, [
					"worktree",
					"remove",
					"--plan",
					planPath,
				]);

				// The isolated-mode warning should be on stderr
				expect(result.stderr).toContain("isolated mode");
				expect(result.stderr).toContain("worktree remove");
			} finally {
				cleanup([externalDir, tmp]);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Help text / description
// ---------------------------------------------------------------------------

describe("worktree help text", () => {
	test(
		"worktree command definition includes --allow-nested flag",
		async () => {
			const { readFileSync } = await import("node:fs");
			const { resolve: pathResolve } = await import("node:path");
			const src = readFileSync(
				pathResolve(import.meta.dir, "../../../src/commands/worktree.ts"),
				"utf-8",
			);
			expect(src).toContain("--allow-nested");
			expect(src).toContain("allowNested");
		},
		{ timeout: 15000 },
	);
});
