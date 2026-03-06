/**
 * Sanitized environment for spawning subprocesses in tests.
 *
 * ## Why this exists
 *
 * Bun has a bug where `delete process.env.X` removes the key from the
 * JavaScript object but does NOT call `unsetenv()` at the C level.
 * Child processes spawned via `Bun.spawnSync` / `Bun.spawn` without an
 * explicit `env` option inherit the **C-level** environment, so they
 * still see the deleted variable.
 *
 * When tests run inside a git hook (e.g. pre-push from a worktree), git
 * sets `GIT_DIR` which leaks into every child process. This causes
 * `git init` / `git add -A` in temp dirs to operate on the **real**
 * repo's index, corrupting the working tree.
 *
 * The fix: every `Bun.spawnSync` and `Bun.spawn` call that runs git
 * (or spawns a process that will run git) must pass `env: cleanGitEnv()`
 * to explicitly exclude these variables.
 */

const GIT_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

/** Return a copy of `process.env` with git-override vars removed. */
export function cleanGitEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const key of GIT_ENV_VARS) {
		delete env[key];
	}
	return env;
}
