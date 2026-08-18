import { existsSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

/** Git env vars that override repo discovery (hooks / inherited worktrees). */
const GIT_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

function sanitizedGitEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const key of GIT_ENV_VARS) {
		delete env[key];
	}
	return env;
}

/**
 * Resolve `rawPath` to an absolute path, realpath'ing the longest existing
 * prefix. Missing files still inherit the parent's realpath so macOS
 * `/var` vs `/private/var` (and `/tmp` vs `/private/tmp`) compare equal.
 */
export function realpathExisting(rawPath: string): string {
	const abs = resolve(rawPath);
	try {
		if (existsSync(abs)) return realpathSync(abs);

		const missing: string[] = [];
		let current = abs;
		while (true) {
			const parent = dirname(current);
			if (parent === current) {
				// Reached the filesystem root without an existing prefix.
				return abs;
			}
			missing.unshift(basename(current));
			if (existsSync(parent)) {
				return join(realpathSync(parent), ...missing);
			}
			current = parent;
		}
	} catch {
		// Fall through to the unresolved absolute path.
	}
	return abs;
}

/**
 * True when `childPath` is `parentPath` or a descendant after resolve/realpath.
 * Mixed symlink prefixes (`/var` vs `/private/var`) do not false-reject.
 */
export function isPathUnder(childPath: string, parentPath: string): boolean {
	// Relative stored paths (legacy DB rows) are not under any root.
	if (!isAbsolute(childPath)) return false;
	const child = realpathExisting(childPath);
	const parent = realpathExisting(parentPath);
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Worktree re-root detection (cached per process)
// ---------------------------------------------------------------------------

/**
 * When CWD is inside a git worktree (not the main checkout), relative paths
 * passed to canonicalizePlanPath() resolve into the worktree directory. Plan
 * paths should always reference the main repo copy so that DB entries are
 * stable regardless of which checkout the command runs from.
 *
 * This cache is computed lazily on first call. `undefined` = not yet computed,
 * `null` = not in a worktree (or detection failed).
 */
let worktreeReroot:
	| { checkoutRoot: string; mainRoot: string }
	| null
	| undefined;

function detectWorktreeReroot(): {
	checkoutRoot: string;
	mainRoot: string;
} | null {
	if (worktreeReroot !== undefined) return worktreeReroot;

	try {
		const cwd = process.cwd();
		const env = sanitizedGitEnv();
		const gitDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
			cwd,
			env,
			stderr: "ignore",
		})
			.stdout.toString()
			.trim();
		if (!gitDir) {
			worktreeReroot = null;
			return null;
		}

		const gitCommonDir = Bun.spawnSync(
			["git", "rev-parse", "--git-common-dir"],
			{ cwd, env, stderr: "ignore" },
		)
			.stdout.toString()
			.trim();
		if (!gitCommonDir || gitCommonDir === gitDir) {
			// Main checkout (not a worktree) or detection failed
			worktreeReroot = null;
			return null;
		}

		// We're in a linked worktree. Resolve main repo root.
		const absGitDir = isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
		const absCommonDir = isAbsolute(gitCommonDir)
			? gitCommonDir
			: resolve(absGitDir, gitCommonDir);
		const mainRoot = dirname(absCommonDir);

		const toplevel = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
			cwd,
			env,
			stderr: "ignore",
		})
			.stdout.toString()
			.trim();
		if (!toplevel) {
			worktreeReroot = null;
			return null;
		}

		worktreeReroot = {
			checkoutRoot: realpathExisting(toplevel),
			mainRoot: realpathExisting(mainRoot),
		};
		return worktreeReroot;
	} catch {
		worktreeReroot = null;
		return null;
	}
}

/**
 * Reset the cached worktree detection. Exposed for testing only.
 * @internal
 */
export function _resetWorktreeCache(): void {
	worktreeReroot = undefined;
}

// ---------------------------------------------------------------------------
// Plan path canonicalization
// ---------------------------------------------------------------------------

/**
 * Derive a stable plan slug from a path string.
 *
 * Uses string-level separator normalization rather than node:path basename()
 * so Windows-style paths are handled correctly even when tests run on
 * non-Windows hosts.
 */
export function planSlugFromPath(planPath: string): string {
	const normalized = planPath.replace(/\\/g, "/");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	return base.replace(/\.md$/i, "");
}

/**
 * Resolve a user-supplied plan argument to an absolute path.
 *
 * Resolution order:
 * 1. If `raw` resolves to an existing file relative to CWD, use that.
 * 2. If `join(plansDir, raw)` exists, use that (bare filename lookup).
 * 3. Fall back to CWD-relative `resolve(raw)`.
 */
export function resolvePlanArg(raw: string, plansDir: string): string {
	const resolved = resolve(raw);
	if (existsSync(resolved)) return resolved;

	const inPlansDir = join(plansDir, raw);
	if (existsSync(inPlansDir)) return resolve(inPlansDir);

	// Fall back — let downstream existence checks produce the error.
	return resolved;
}

export function canonicalizePlanPath(rawPath: string): string {
	const real = realpathExisting(rawPath);

	// If we're in a worktree and the path falls inside the worktree checkout,
	// re-root it to the main repo — but only if the file exists there.
	const reroot = detectWorktreeReroot();
	if (reroot && isPathUnder(real, reroot.checkoutRoot)) {
		const rel = relative(reroot.checkoutRoot, real);
		const mainPath = join(reroot.mainRoot, rel);
		if (existsSync(mainPath)) {
			return realpathExisting(mainPath);
		}
	}

	return real;
}
