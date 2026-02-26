/**
 * Git operations, safety invariants, and worktree support.
 *
 * All functions shell out to `git` via `Bun.spawn` / `Bun.spawnSync` and
 * parse text output. No libgit2 bindings.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitSafetyReport {
	repoRoot: string;
	branch: string;
	isDirty: boolean; // staged or unstaged changes
	untrackedFiles: string[];
	safe: boolean; // true if clean (or caller opts in with --allow-dirty)
}

export interface WorktreeInfo {
	path: string;
	branch: string;
}

export interface GitCommitResult {
	commit: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(
	args: string[],
	workdir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
}

function _runSync(
	args: string[],
	workdir: string,
): { stdout: string; stderr: string; exitCode: number } {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: workdir,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
		exitCode: result.exitCode,
	};
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

/**
 * Check git repository safety before agent invocation.
 * Returns a report including dirty state and branch info.
 */
export async function checkGitSafety(
	workdir: string,
): Promise<GitSafetyReport> {
	// Get repo root
	const rootResult = await run(["rev-parse", "--show-toplevel"], workdir);
	if (rootResult.exitCode !== 0) {
		throw new Error(`Not a git repository: ${workdir}. ${rootResult.stderr}`);
	}
	const repoRoot = rootResult.stdout;

	// Get current branch
	const branch = await getCurrentBranch(workdir);

	// Check porcelain status
	const statusResult = await run(["status", "--porcelain"], workdir);
	const lines = statusResult.stdout
		? statusResult.stdout.split("\n").filter(Boolean)
		: [];

	const untrackedFiles: string[] = [];
	let isDirty = false;

	for (const line of lines) {
		if (line.startsWith("??")) {
			untrackedFiles.push(line.slice(3));
		} else {
			isDirty = true;
		}
	}

	// Also mark dirty if there are untracked files (conservative)
	if (untrackedFiles.length > 0) {
		isDirty = true;
	}

	return {
		repoRoot,
		branch,
		isDirty,
		untrackedFiles,
		safe: !isDirty,
	};
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

/** Get the current branch name. Returns "HEAD" if detached. */
export async function getCurrentBranch(workdir: string): Promise<string> {
	const result = await run(["rev-parse", "--abbrev-ref", "HEAD"], workdir);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to get current branch: ${result.stderr}`);
	}
	return result.stdout;
}

/** Create a new branch (does not check it out in worktrees). */
export async function createBranch(
	name: string,
	workdir: string,
): Promise<void> {
	const result = await run(["checkout", "-b", name], workdir);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to create branch "${name}": ${result.stderr}`);
	}
}

/** Get the latest commit hash (short). */
export async function getLatestCommit(workdir: string): Promise<string> {
	const result = await run(["rev-parse", "HEAD"], workdir);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to get latest commit: ${result.stderr}`);
	}
	return result.stdout;
}

/** Check if there are uncommitted changes (staged or unstaged). */
export async function hasUncommittedChanges(workdir: string): Promise<boolean> {
	const result = await run(["status", "--porcelain"], workdir);
	return result.stdout.length > 0;
}

/**
 * List changed file paths (staged, unstaged, and untracked), relative to workdir.
 */
export async function listChangedFiles(workdir: string): Promise<string[]> {
	const [unstaged, staged, untracked] = await Promise.all([
		run(["diff", "--name-only"], workdir),
		run(["diff", "--cached", "--name-only"], workdir),
		run(["ls-files", "--others", "--exclude-standard"], workdir),
	]);

	const toLines = (value: string): string[] =>
		value
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);

	const files = new Set<string>([
		...toLines(unstaged.stdout),
		...toLines(staged.stdout),
		...toLines(untracked.stdout),
	]);

	return [...files];
}

/**
 * Commit specific files (relative paths) with a fixed message.
 */
export async function commitFiles(
	workdir: string,
	files: string[],
	message: string,
): Promise<GitCommitResult> {
	if (files.length === 0) {
		throw new Error("No files provided for commit");
	}

	const addResult = await run(["add", "--", ...files], workdir);
	if (addResult.exitCode !== 0) {
		throw new Error(`Failed to stage files: ${addResult.stderr}`);
	}

	const commitResult = await run(["commit", "-m", message], workdir);
	if (commitResult.exitCode !== 0) {
		throw new Error(`Failed to create commit: ${commitResult.stderr}`);
	}

	const commit = await getLatestCommit(workdir);
	return { commit };
}

/**
 * Run a shell command in a worktree after creation.
 * Stdout/stderr are inherited so setup progress is visible to users.
 */
export async function runWorktreeSetupCommand(
	workdir: string,
	command: string,
): Promise<void> {
	const proc = Bun.spawn(["sh", "-c", command], {
		cwd: workdir,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(
			`Worktree setup command failed (exit ${exitCode}): ${command}`,
		);
	}
}

/** Check if a branch exists locally. */
export async function branchExists(
	name: string,
	workdir: string,
): Promise<boolean> {
	const result = await run(
		["rev-parse", "--verify", `refs/heads/${name}`],
		workdir,
	);
	return result.exitCode === 0;
}

/**
 * Get commits on the current branch since it diverged from base.
 * Returns commit hashes (newest first).
 */
export async function getBranchCommits(
	base: string,
	workdir: string,
): Promise<string[]> {
	const result = await run(["log", `${base}..HEAD`, "--format=%H"], workdir);
	if (result.exitCode !== 0 || !result.stdout) return [];
	return result.stdout.split("\n").filter(Boolean);
}

/**
 * Generate a branch name from a plan path/title.
 * e.g. "docs/development/001-impl-5x-cli.md" → "5x/001-impl-5x-cli"
 */
export function branchNameFromPlan(planPath: string): string {
	const base = planPath
		.replace(/^.*\//, "") // strip directory
		.replace(/\.md$/, ""); // strip extension
	return `5x/${base}`;
}

/**
 * Validate that a branch name is relevant to a plan.
 * Returns true if the branch name contains a recognizable slug from the plan path.
 */
export function isBranchRelevant(
	branchName: string,
	planPath: string,
): boolean {
	const planSlug = planPath
		.replace(/^.*\//, "")
		.replace(/\.md$/, "")
		.toLowerCase();
	return branchName.toLowerCase().includes(planSlug);
}

/** Checkout an existing branch. */
export async function checkoutBranch(
	name: string,
	workdir: string,
): Promise<void> {
	const result = await run(["checkout", name], workdir);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to checkout branch "${name}": ${result.stderr}`);
	}
}

// ---------------------------------------------------------------------------
// Worktree operations
// ---------------------------------------------------------------------------

/**
 * Create a git worktree with a new branch.
 * If the branch already exists, reuses it.
 */
export async function createWorktree(
	repoRoot: string,
	branch: string,
	path: string,
): Promise<WorktreeInfo> {
	const exists = await branchExists(branch, repoRoot);

	const args = exists
		? ["worktree", "add", path, branch]
		: ["worktree", "add", path, "-b", branch];
	const result = await run(args, repoRoot);

	if (result.exitCode !== 0) {
		throw new Error(`Failed to create worktree at "${path}": ${result.stderr}`);
	}

	return { path, branch };
}

/** Remove a git worktree. */
export async function removeWorktree(
	repoRoot: string,
	path: string,
	force = false,
): Promise<void> {
	const args = ["worktree", "remove", path];
	if (force) args.push("--force");

	const result = await run(args, repoRoot);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to remove worktree "${path}": ${result.stderr}`);
	}
}

/** List all worktrees. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
	const result = await run(["worktree", "list", "--porcelain"], repoRoot);
	if (result.exitCode !== 0) return [];

	const worktrees: WorktreeInfo[] = [];
	let currentPath = "";
	let currentBranch = "";

	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			currentPath = line.slice(9);
		} else if (line.startsWith("branch ")) {
			currentBranch = line.slice(7).replace("refs/heads/", "");
		} else if (line === "") {
			if (currentPath && currentBranch) {
				worktrees.push({ path: currentPath, branch: currentBranch });
			}
			currentPath = "";
			currentBranch = "";
		}
	}

	// Handle last entry (if no trailing newline)
	if (currentPath && currentBranch) {
		worktrees.push({ path: currentPath, branch: currentBranch });
	}

	return worktrees;
}

/**
 * Check if a branch is fully merged into HEAD or its upstream.
 */
export async function isBranchMerged(
	branch: string,
	workdir: string,
): Promise<boolean> {
	const result = await run(["branch", "--merged", "HEAD"], workdir);
	if (result.exitCode !== 0) return false;

	const branches = result.stdout
		.split("\n")
		.map((l) => l.replace(/^\*?\s+/, "").trim())
		.filter(Boolean);

	return branches.includes(branch);
}

/** Delete a local branch. */
export async function deleteBranch(
	branch: string,
	workdir: string,
	force = false,
): Promise<void> {
	const flag = force ? "-D" : "-d";
	const result = await run(["branch", flag, branch], workdir);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to delete branch "${branch}": ${result.stderr}`);
	}
}
