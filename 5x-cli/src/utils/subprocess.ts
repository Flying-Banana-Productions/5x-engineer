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
// Subprocess runner (spyable)
// ---------------------------------------------------------------------------

export const subprocess = {
	/**
	 * Execute a git command asynchronously.
	 * Spawns `git <args>` with the given working directory.
	 */
	async execGit(args: string[], workdir: string): Promise<ExecResult> {
		const proc = Bun.spawn(["git", ...args], {
			cwd: workdir,
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
	 */
	async execShell(command: string, workdir: string): Promise<ExecResult> {
		const proc = Bun.spawn(["sh", "-c", command], {
			cwd: workdir,
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
