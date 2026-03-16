import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
		const gitDir = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
			cwd,
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
			{ cwd, stderr: "ignore" },
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
			stderr: "ignore",
		})
			.stdout.toString()
			.trim();
		if (!toplevel) {
			worktreeReroot = null;
			return null;
		}

		worktreeReroot = {
			checkoutRoot: resolve(toplevel),
			mainRoot: resolve(mainRoot),
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

export function canonicalizePlanPath(rawPath: string): string {
	const abs = resolve(rawPath);
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		real = abs;
	}

	// If we're in a worktree and the path falls inside the worktree checkout,
	// re-root it to the main repo — but only if the file exists there.
	const reroot = detectWorktreeReroot();
	if (reroot) {
		const rel = relative(reroot.checkoutRoot, real);
		if (!rel.startsWith("..") && !isAbsolute(rel)) {
			const mainPath = join(reroot.mainRoot, rel);
			if (existsSync(mainPath)) {
				return mainPath;
			}
		}
	}

	return real;
}
