/**
 * Tests for `5x init` managed-mode guard.
 *
 * Verifies that `initScaffold` blocks init from a linked worktree when
 * the main repo is already 5x-managed. Uses subprocess execution to
 * test the actual init flow.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const env = cleanGitEnv();
const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(prefix = "5x-init-guard"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function git(args: string[], cwd: string): void {
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
}

function initRepo(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, "README.md"), "# Test\n");
	git(["add", "."], dir);
	git(["commit", "-m", "initial"], dir);
}

function createStateDb(rootDir: string, stateDir = ".5x"): void {
	const dir = join(rootDir, stateDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "5x.db"), "");
}

async function runInit(
	cwd: string,
	extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "init", ...extraArgs], {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill("SIGINT"), 10000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
	tmp = makeTmpDir();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("init managed-mode guard", () => {
	test(
		"init from main checkout succeeds when root state DB exists",
		async () => {
			initRepo(tmp);
			createStateDb(tmp);

			const result = await runInit(tmp);
			// Should succeed (exit 0) - init from the main checkout is allowed
			expect(result.exitCode).toBe(0);
		},
		{ timeout: 15000 },
	);

	test(
		"init from linked worktree when root DB exists: blocked",
		async () => {
			initRepo(tmp);
			createStateDb(tmp);

			// Create external worktree
			const externalDir = makeTmpDir("5x-init-ext");
			try {
				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "guard-branch"], tmp);

				const result = await runInit(wtPath);
				// Should fail with managed-mode error
				expect(result.exitCode).not.toBe(0);
				// Error is output as JSON envelope to stdout (not stderr)
				expect(result.stdout).toContain("managed by the control-plane");
			} finally {
				rmSync(externalDir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"init --force from linked worktree when root DB exists: still blocked",
		async () => {
			initRepo(tmp);
			createStateDb(tmp);

			const externalDir = makeTmpDir("5x-init-force");
			try {
				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "force-branch"], tmp);

				const result = await runInit(wtPath, ["--force"]);
				// --force does NOT bypass managed-mode guard
				expect(result.exitCode).not.toBe(0);
				// Error is output as JSON envelope to stdout (not stderr)
				expect(result.stdout).toContain("managed by the control-plane");
			} finally {
				rmSync(externalDir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"init from unmanaged worktree succeeds (no root DB)",
		async () => {
			initRepo(tmp);
			// Do NOT create state DB at root

			const externalDir = makeTmpDir("5x-init-unmanaged");
			try {
				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "unmanaged-branch"], tmp);

				const result = await runInit(wtPath);
				// Should succeed - no root state DB means not managed
				expect(result.exitCode).toBe(0);
				// Config should be created in the worktree
				expect(existsSync(join(wtPath, "5x.toml"))).toBe(true);
			} finally {
				rmSync(externalDir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"init from main checkout without root DB: succeeds normally",
		async () => {
			const testTmp = makeTmpDir();
			try {
				initRepo(testTmp);

				const result = await runInit(testTmp);
				expect(result.exitCode).toBe(0);
				expect(existsSync(join(testTmp, "5x.toml"))).toBe(true);
				expect(existsSync(join(testTmp, ".5x"))).toBe(true);
			} finally {
				rmSync(testTmp, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"init from subdirectory of main checkout scaffolds at repo root",
		async () => {
			const testTmp = makeTmpDir();
			try {
				initRepo(testTmp);
				const subDir = join(testTmp, "src", "lib");
				mkdirSync(subDir, { recursive: true });

				const result = await runInit(subDir);
				expect(result.exitCode).toBe(0);
				// Config and .5x should be at the repo root, not in the subdirectory
				expect(existsSync(join(testTmp, "5x.toml"))).toBe(true);
				expect(existsSync(join(testTmp, ".5x"))).toBe(true);
				// Should NOT create config in the subdirectory
				expect(existsSync(join(subDir, "5x.toml"))).toBe(false);
			} finally {
				rmSync(testTmp, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"init from subdirectory of managed main checkout succeeds",
		async () => {
			const testTmp = makeTmpDir();
			try {
				initRepo(testTmp);
				createStateDb(testTmp);
				const subDir = join(testTmp, "src");
				mkdirSync(subDir, { recursive: true });

				const result = await runInit(subDir);
				// Should succeed — subdirectory of main checkout is allowed
				expect(result.exitCode).toBe(0);
			} finally {
				rmSync(testTmp, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);
});
