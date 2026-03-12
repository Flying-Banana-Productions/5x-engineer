/**
 * Tests for the control-plane root resolver.
 *
 * Uses real git repos and worktrees in temp directories. All git commands
 * pass `env: cleanGitEnv()` to avoid inheriting GIT_DIR from hooks.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveControlPlaneRoot } from "../../src/commands/control-plane.js";
import { cleanGitEnv } from "../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const env = cleanGitEnv();

function makeTmpDir(prefix = "5x-cp-test"): string {
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
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString();
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr}`);
	}
}

function _gitOut(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString();
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr}`);
	}
	return result.stdout.toString().trim();
}

/** Initialize a bare git repo with one commit so worktrees work. */
function initRepo(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, "README.md"), "# Test\n");
	git(["add", "."], dir);
	git(["commit", "-m", "initial"], dir);
}

/** Create the .5x/5x.db file (empty file to simulate state DB). */
function createStateDb(rootDir: string, stateDir = ".5x"): void {
	const dir = join(rootDir, stateDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "5x.db"), "");
}

/** Write a 5x.toml config file. */
function writeConfig(rootDir: string, content: string): void {
	writeFileSync(join(rootDir, "5x.toml"), content, "utf-8");
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

describe("resolveControlPlaneRoot", () => {
	test(
		"from root checkout: returns root path, managed mode",
		() => {
			initRepo(tmp);
			createStateDb(tmp);

			const result = resolveControlPlaneRoot(tmp);
			expect(result.controlPlaneRoot).toBe(resolve(tmp));
			expect(result.mode).toBe("managed");
			expect(result.stateDir).toBe(".5x");
		},
		{ timeout: 15000 },
	);

	test(
		"from nested linked worktree: resolves to root state DB",
		() => {
			initRepo(tmp);
			createStateDb(tmp);

			// Create a linked worktree inside the repo tree
			const wtPath = join(tmp, ".5x", "worktrees", "feature-branch");
			git(["worktree", "add", wtPath, "-b", "feature-branch"], tmp);

			const result = resolveControlPlaneRoot(wtPath);
			expect(result.controlPlaneRoot).toBe(resolve(tmp));
			expect(result.mode).toBe("managed");
		},
		{ timeout: 15000 },
	);

	test(
		"from externally attached worktree: resolves to root state DB via git common-dir",
		() => {
			initRepo(tmp);
			createStateDb(tmp);

			// Create external worktree outside the repo tree
			const externalDir = makeTmpDir("5x-cp-ext");
			try {
				const wtPath = join(externalDir, "my-worktree");
				git(["worktree", "add", wtPath, "-b", "ext-branch"], tmp);

				const result = resolveControlPlaneRoot(wtPath);
				expect(result.controlPlaneRoot).toBe(resolve(tmp));
				expect(result.mode).toBe("managed");
			} finally {
				rmSync(externalDir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"worktree with local state DB but root DB also exists: managed mode wins",
		() => {
			initRepo(tmp);
			createStateDb(tmp);

			// Create worktree with its own state DB
			const externalDir = makeTmpDir("5x-cp-both");
			try {
				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "both-branch"], tmp);
				createStateDb(wtPath);

				const result = resolveControlPlaneRoot(wtPath);
				expect(result.controlPlaneRoot).toBe(resolve(tmp));
				expect(result.mode).toBe("managed");
			} finally {
				rmSync(externalDir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"worktree with local state DB and no root DB: isolated mode",
		() => {
			initRepo(tmp);
			// Do NOT create state DB at root

			const externalDir = makeTmpDir("5x-cp-isolated");
			try {
				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-branch"], tmp);
				createStateDb(wtPath);

				const result = resolveControlPlaneRoot(wtPath);
				expect(result.controlPlaneRoot).toBe(resolve(wtPath));
				expect(result.mode).toBe("isolated");
			} finally {
				rmSync(externalDir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"no git context: returns mode 'none'",
		() => {
			// tmp has no .git
			const result = resolveControlPlaneRoot(tmp);
			expect(result.mode).toBe("none");
			expect(result.stateDir).toBe(".5x");
		},
		{ timeout: 15000 },
	);

	test(
		"git repo with no state DB anywhere: returns mode 'none'",
		() => {
			initRepo(tmp);
			// No state DB created

			const result = resolveControlPlaneRoot(tmp);
			expect(result.mode).toBe("none");
			expect(result.controlPlaneRoot).toBe(resolve(tmp));
		},
		{ timeout: 15000 },
	);

	test(
		"custom db.path directory (non-default)",
		() => {
			initRepo(tmp);
			writeConfig(tmp, `[db]\npath = "custom-state"\n`);
			createStateDb(tmp, "custom-state");

			const result = resolveControlPlaneRoot(tmp);
			expect(result.controlPlaneRoot).toBe(resolve(tmp));
			expect(result.mode).toBe("managed");
			expect(result.stateDir).toBe("custom-state");
		},
		{ timeout: 15000 },
	);

	test(
		"absolute db.path: resolver finds DB at absolute path",
		() => {
			initRepo(tmp);
			const absStateDir = join(tmp, "abs-state");
			writeConfig(tmp, `[db]\npath = "${absStateDir}"\n`);
			mkdirSync(absStateDir, { recursive: true });
			writeFileSync(join(absStateDir, "5x.db"), "");

			const result = resolveControlPlaneRoot(tmp);
			expect(result.controlPlaneRoot).toBe(resolve(tmp));
			expect(result.mode).toBe("managed");
			expect(result.stateDir).toBe(absStateDir);
		},
		{ timeout: 15000 },
	);

	test(
		"legacy file-style db.path normalized (e.g. '.5x/5x.db' → '.5x')",
		() => {
			initRepo(tmp);
			writeConfig(tmp, `[db]\npath = ".5x/5x.db"\n`);
			createStateDb(tmp, ".5x");

			const result = resolveControlPlaneRoot(tmp);
			expect(result.controlPlaneRoot).toBe(resolve(tmp));
			expect(result.mode).toBe("managed");
			// stateDir should be normalized to '.5x', not '.5x/5x.db'
			expect(result.stateDir).toBe(".5x");
		},
		{ timeout: 15000 },
	);

	test(
		"relative git-common-dir resolved correctly relative to git-dir",
		() => {
			// This test verifies the case where git returns a relative common-dir.
			// In a standard linked worktree, --git-common-dir returns a relative path
			// from the worktree's .git directory.
			initRepo(tmp);
			createStateDb(tmp);

			const wtPath = join(tmp, ".5x", "worktrees", "rel-test");
			git(["worktree", "add", wtPath, "-b", "rel-test-branch"], tmp);

			// Verify the worktree resolves correctly
			const result = resolveControlPlaneRoot(wtPath);
			expect(result.controlPlaneRoot).toBe(resolve(tmp));
			expect(result.mode).toBe("managed");
		},
		{ timeout: 15000 },
	);

	test(
		"isolated mode: controlPlaneRoot is the checkout root, not main repo root",
		() => {
			initRepo(tmp);
			const externalDir = makeTmpDir("5x-cp-iso-root");
			try {
				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-root-branch"], tmp);
				createStateDb(wtPath);

				const result = resolveControlPlaneRoot(wtPath);
				// controlPlaneRoot should be the worktree, not the main repo
				expect(result.controlPlaneRoot).toBe(resolve(wtPath));
				expect(result.controlPlaneRoot).not.toBe(resolve(tmp));
				expect(result.mode).toBe("isolated");
			} finally {
				rmSync(externalDir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"isolated mode: db.path read from checkout root config, not main repo config",
		() => {
			initRepo(tmp);
			// Main repo has a config but NO state DB
			writeConfig(tmp, `[db]\npath = "main-state"\n`);

			const externalDir = makeTmpDir("5x-cp-iso-db");
			try {
				const wtPath = join(externalDir, "wt");
				git(["worktree", "add", wtPath, "-b", "iso-db-branch"], tmp);
				// Worktree has its own config with different db.path
				writeConfig(wtPath, `[db]\npath = "local-state"\n`);
				createStateDb(wtPath, "local-state");

				const result = resolveControlPlaneRoot(wtPath);
				expect(result.mode).toBe("isolated");
				expect(result.stateDir).toBe("local-state");
				expect(result.controlPlaneRoot).toBe(resolve(wtPath));
			} finally {
				rmSync(externalDir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"JS config db.path bootstrap extraction",
		() => {
			initRepo(tmp);
			// Write a JS config with custom db.path
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { db: { path: "js-state" } };\n`,
			);
			createStateDb(tmp, "js-state");

			const result = resolveControlPlaneRoot(tmp);
			expect(result.mode).toBe("managed");
			expect(result.stateDir).toBe("js-state");
		},
		{ timeout: 15000 },
	);

	test(
		"MJS config db.path bootstrap extraction",
		() => {
			initRepo(tmp);
			// Write an MJS config with custom db.path
			writeFileSync(
				join(tmp, "5x.config.mjs"),
				`export default { db: { path: "mjs-state" } };\n`,
			);
			createStateDb(tmp, "mjs-state");

			const result = resolveControlPlaneRoot(tmp);
			expect(result.mode).toBe("managed");
			expect(result.stateDir).toBe("mjs-state");
		},
		{ timeout: 15000 },
	);

	test(
		"TOML config takes precedence over JS config for db.path",
		() => {
			initRepo(tmp);
			// Write both TOML and JS configs
			writeConfig(tmp, `[db]\npath = "toml-state"\n`);
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { db: { path: "js-state" } };\n`,
			);
			// State DB exists at TOML's path
			createStateDb(tmp, "toml-state");

			const result = resolveControlPlaneRoot(tmp);
			expect(result.mode).toBe("managed");
			expect(result.stateDir).toBe("toml-state");
		},
		{ timeout: 15000 },
	);

	test(
		"TOML without db.path uses default state dir, ignoring JS config",
		() => {
			initRepo(tmp);
			// Write TOML without db.path and JS with db.path
			writeConfig(tmp, `[author]\nmodel = "test"\n`);
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { db: { path: "js-state" } };\n`,
			);
			// State DB at default location (since TOML has no db.path)
			createStateDb(tmp, ".5x");

			const result = resolveControlPlaneRoot(tmp);
			expect(result.mode).toBe("managed");
			// Should use default ".5x", not "js-state", because TOML takes precedence
			expect(result.stateDir).toBe(".5x");
		},
		{ timeout: 15000 },
	);

	test(
		"db.path read from root config only, not nearest sub-project config",
		() => {
			initRepo(tmp);
			// Root config uses default db.path (no [db] section)
			writeConfig(tmp, `[author]\nmodel = "test"\n`);
			createStateDb(tmp, ".5x");

			// Sub-project has its own 5x.toml with a different db.path
			const subDir = join(tmp, "sub-project");
			mkdirSync(subDir, { recursive: true });
			writeFileSync(
				join(subDir, "5x.toml"),
				`[db]\npath = "sub-state"\n`,
				"utf-8",
			);
			// Create a state DB at the sub-project's db.path (should be irrelevant)
			mkdirSync(join(tmp, "sub-state"), { recursive: true });
			writeFileSync(join(tmp, "sub-state", "5x.db"), "");

			// Resolve from sub-project directory — should still use root db.path
			const result = resolveControlPlaneRoot(subDir);
			expect(result.mode).toBe("managed");
			expect(result.controlPlaneRoot).toBe(resolve(tmp));
			// stateDir should be from root config (default ".5x"), not sub-project's "sub-state"
			expect(result.stateDir).toBe(".5x");
		},
		{ timeout: 15000 },
	);
});
