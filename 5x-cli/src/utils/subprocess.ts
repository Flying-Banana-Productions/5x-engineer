/**
 * Subprocess execution helpers for git and shell commands.
 *
 * Exported as methods on a shared object so tests can `spyOn(subprocess, "execGit")`
 * to mock subprocess calls without spawning real processes.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

// ---------------------------------------------------------------------------
// Environment sanitization
// ---------------------------------------------------------------------------

/**
 * Git env vars that override repo discovery. When set (e.g. by a pre-push
 * hook running inside a worktree), they cause spawned git commands to
 * operate on the wrong index/work-tree. We strip them so git discovers
 * the repo from `cwd` instead.
 */
const GIT_ENV_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

/** Return a copy of `process.env` with git-override vars removed. */
function cleanEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const key of GIT_ENV_VARS) {
		delete env[key];
	}
	return env;
}

// ---------------------------------------------------------------------------
// Subprocess runner (spyable)
// ---------------------------------------------------------------------------

export const subprocess = {
	/**
	 * Execute a git command asynchronously.
	 * Spawns `git <args>` with the given working directory.
	 * Strips GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so git discovers
	 * the repo from `cwd`, not from inherited env vars.
	 */
	async execGit(args: string[], workdir: string): Promise<ExecResult> {
		const proc = Bun.spawn(["git", ...args], {
			cwd: workdir,
			env: cleanEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
	},

	/**
	 * Execute a shell command asynchronously.
	 * Spawns `sh -c <command>` with the given working directory.
	 * stdin is inherited so interactive commands work.
	 * Strips GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE for safety.
	 */
	async execShell(command: string, workdir: string): Promise<ExecResult> {
		const proc = Bun.spawn(["sh", "-c", command], {
			cwd: workdir,
			env: cleanEnv(),
			stdin: "inherit",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	},
};
