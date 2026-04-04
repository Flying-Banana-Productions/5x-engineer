/**
 * Control-plane root resolver.
 *
 * Resolves the canonical control-plane root from any checkout context
 * (root, nested linked worktree, externally attached worktree).
 *
 * The control-plane root is where `.5x/5x.db` (or a custom state dir)
 * lives. All run lifecycle, step recording, and artifact paths anchor
 * to this root.
 *
 * Two modes:
 * - **Managed:** root state DB exists at the git common-dir parent.
 *   All checkouts use this DB. Always wins over local state DBs.
 * - **Isolated:** no root state DB, but a local state DB exists in the
 *   current checkout. The checkout IS the control-plane root.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "@decimalturn/toml-patch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ControlPlaneMode = "managed" | "isolated" | "none";

export interface ControlPlaneResult {
	/** Absolute path to the control-plane root directory. */
	controlPlaneRoot: string;
	/** State directory path (relative to controlPlaneRoot, or absolute). Default: `.5x`. */
	stateDir: string;
	/** Operating mode. */
	mode: ControlPlaneMode;
}

// ---------------------------------------------------------------------------
// Git helpers (sync, minimal — only for bootstrap resolution)
// ---------------------------------------------------------------------------

/**
 * Run a synchronous git command. Returns stdout trimmed, or null on failure.
 */
function gitSync(
	args: string[],
	cwd: string,
	env?: Record<string, string | undefined>,
): string | null {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: env ?? sanitizedEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().trim();
}

/** Git env vars to strip so git discovers repo from cwd. */
const GIT_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

function sanitizedEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const key of GIT_ENV_VARS) {
		delete env[key];
	}
	return env;
}

// ---------------------------------------------------------------------------
// db.path resolution helpers
// ---------------------------------------------------------------------------

const DEFAULT_STATE_DIR = ".5x";
export const DB_FILENAME = "5x.db";

/** Config filenames in priority order (only need TOML for bootstrap). */
const CONFIG_FILENAMES = ["5x.toml", "5x.config.js", "5x.config.mjs"] as const;

/**
 * Read `db.path` from a config file at the given root.
 * Only reads the `db.path` field — does not parse the full config.
 * Returns the raw string value, or null if not found.
 */
function readDbPathFromConfig(rootDir: string): string | null {
	for (const filename of CONFIG_FILENAMES) {
		const configPath = join(rootDir, filename);
		if (!existsSync(configPath)) continue;

		// Config file found — stop searching (precedence: first match wins).
		// Only extract db.path if present; don't fall through to lower-priority configs.
		if (filename === "5x.toml") {
			try {
				const text = readFileSync(configPath, "utf-8");
				const parsed = parseToml(text) as Record<string, unknown>;
				const db = parsed.db;
				if (
					db &&
					typeof db === "object" &&
					"path" in db &&
					typeof (db as Record<string, unknown>).path === "string"
				) {
					return (db as Record<string, unknown>).path as string;
				}
			} catch {
				// Config parse error — fall through to return null below
			}
		} else if (filename === "5x.config.js" || filename === "5x.config.mjs") {
			// Simple regex extraction for JS/MJS configs during bootstrap.
			// This handles common patterns: db: { path: "..." } or db.path = "..."
			try {
				const text = readFileSync(configPath, "utf-8");
				// Match db: { path: "value" } or db: { path: 'value' }
				const match = text.match(/db\s*:\s*\{[^}]*path\s*:\s*["']([^"']+)["']/);
				if (match?.[1]) return match[1];
			} catch {
				// Config read error — fall through to return null below
			}
		}
		// Config file exists but no db.path found — stop searching (precedence).
		return null;
	}
	return null;
}

/**
 * Normalize `db.path` — it should be a directory path, not a file path.
 * Backward compat: if `path.basename(dbPath) === '5x.db'`, strip the
 * filename and use `path.dirname(dbPath)`.
 */
export function normalizeDbPath(dbPath: string): string {
	if (basename(dbPath) === DB_FILENAME) {
		return dirname(dbPath);
	}
	return dbPath;
}

/**
 * Resolve the state directory from a root dir and optional raw db.path.
 * Returns an absolute path to the state directory.
 */
function resolveStateDir(rootDir: string, rawDbPath: string | null): string {
	const dbPath = rawDbPath ? normalizeDbPath(rawDbPath) : DEFAULT_STATE_DIR;
	if (isAbsolute(dbPath)) return dbPath;
	return join(rootDir, dbPath);
}

/**
 * Get the state dir string (relative or absolute) for the result shape.
 * This is the normalized form used in the return value.
 */
function getStateDirValue(rawDbPath: string | null): string {
	if (!rawDbPath) return DEFAULT_STATE_DIR;
	return normalizeDbPath(rawDbPath);
}

/**
 * Check if a state DB exists at the given state directory.
 */
function stateDbExists(stateDir: string): boolean {
	return existsSync(join(stateDir, DB_FILENAME));
}

// ---------------------------------------------------------------------------
// Checkout root resolution
// ---------------------------------------------------------------------------

/**
 * Derive the checkout root from git-dir.
 * For main checkout: git-dir is `.git`, checkout root is parent.
 * For linked worktrees: git-dir is `.git/worktrees/<name>` or an absolute
 * path; we use `git rev-parse --show-toplevel` to get the checkout root.
 */
export function resolveCheckoutRoot(startDir: string): string | null {
	const toplevel = gitSync(["rev-parse", "--show-toplevel"], startDir);
	return toplevel ? resolve(toplevel) : null;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical control-plane root from the given directory.
 *
 * Algorithm:
 * 1. Run `git rev-parse --git-dir` and `--git-common-dir` from startDir.
 * 2. Resolve common-dir to absolute. If relative, resolve relative to
 *    the absolute git-dir path.
 * 3. Main repo root = dirname(absoluteCommonDir).
 * 4. Read db.path from root config → resolve state dir → check for DB.
 *    If found → managed mode.
 * 5. If no root DB, check current checkout root for local state DB →
 *    isolated mode.
 * 6. If neither → mode 'none'.
 */
export function resolveControlPlaneRoot(startDir?: string): ControlPlaneResult {
	const cwd = resolve(startDir ?? ".");

	// Step 1: get git-dir and git-common-dir
	const gitDir = gitSync(["rev-parse", "--git-dir"], cwd);
	if (!gitDir) {
		// Not inside a git repo
		return { controlPlaneRoot: cwd, stateDir: DEFAULT_STATE_DIR, mode: "none" };
	}

	const gitCommonDir = gitSync(["rev-parse", "--git-common-dir"], cwd);
	if (!gitCommonDir) {
		// Shouldn't happen if git-dir succeeded, but handle gracefully
		return { controlPlaneRoot: cwd, stateDir: DEFAULT_STATE_DIR, mode: "none" };
	}

	// Step 2: resolve common-dir to absolute path
	// git-dir may be absolute or relative to cwd depending on context.
	const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
	// git-common-dir is relative to cwd in main checkouts, but git may
	// return it in a different form (absolute vs relative) than git-dir
	// even when they point to the same directory. Resolve both to absolute
	// before comparing to detect main checkout vs linked worktree.
	const absoluteCommonDirViaCwd = isAbsolute(gitCommonDir)
		? gitCommonDir
		: resolve(cwd, gitCommonDir);

	let absoluteCommonDir: string;
	if (resolve(absoluteCommonDirViaCwd) === resolve(absoluteGitDir)) {
		// Main checkout: common-dir and git-dir resolve to the same path
		absoluteCommonDir = absoluteGitDir;
	} else {
		// Linked worktree: common-dir is relative to git-dir
		absoluteCommonDir = resolve(absoluteGitDir, gitCommonDir);
	}

	// Step 3: main repo root = parent of common-dir (.git)
	const mainRepoRoot = dirname(absoluteCommonDir);

	// Step 4: check for root state DB (managed mode)
	const rootRawDbPath = readDbPathFromConfig(mainRepoRoot);
	const rootStateDir = resolveStateDir(mainRepoRoot, rootRawDbPath);
	const rootStateDirValue = getStateDirValue(rootRawDbPath);

	if (stateDbExists(rootStateDir)) {
		return {
			controlPlaneRoot: mainRepoRoot,
			stateDir: rootStateDirValue,
			mode: "managed",
		};
	}

	// Step 5: check current checkout for local state DB (isolated mode)
	const checkoutRoot = resolveCheckoutRoot(cwd);
	if (checkoutRoot && checkoutRoot !== mainRepoRoot) {
		// We're in a linked worktree — check for local state DB
		const localRawDbPath = readDbPathFromConfig(checkoutRoot);
		const localStateDir = resolveStateDir(checkoutRoot, localRawDbPath);
		const localStateDirValue = getStateDirValue(localRawDbPath);

		if (stateDbExists(localStateDir)) {
			return {
				controlPlaneRoot: checkoutRoot,
				stateDir: localStateDirValue,
				mode: "isolated",
			};
		}
	} else if (checkoutRoot === mainRepoRoot) {
		// We're in the main checkout — no separate isolated check needed.
		// Root DB doesn't exist (checked above), so mode is 'none'.
	}

	// Step 6: no state DB found anywhere
	return {
		controlPlaneRoot: mainRepoRoot,
		stateDir: DEFAULT_STATE_DIR,
		mode: "none",
	};
}
