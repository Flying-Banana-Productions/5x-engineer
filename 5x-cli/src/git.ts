/**
 * Git operations, safety invariants, and worktree support.
 *
 * All functions shell out to `git` via the subprocess module and parse text
 * output. No libgit2 bindings. Tests mock `subprocess.execGit` to avoid
 * spawning real processes.
 */

import { resolve } from "node:path";
import { isPathUnder, planSlugFromPath, realpathExisting } from "./paths.js";
import { subprocess } from "./utils/subprocess.js";

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
	return subprocess.execGit(args, workdir);
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

interface PorcelainEntry {
	xy: string;
	paths: string[];
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * Ordinary entries: `XY PATH\0`.
 * Renames/copies: `XY to\0from\0` (v1) or `R100\0old\0new` (score form).
 */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
	if (!stdout) return [];
	const parts = stdout.split("\0");
	const entries: PorcelainEntry[] = [];
	let i = 0;
	while (i < parts.length) {
		const rec = parts[i];
		if (rec === undefined || rec === "") {
			i += 1;
			continue;
		}
		const scoreMatch = rec.match(/^([RC])(\d{3})$/);
		if (scoreMatch) {
			const oldPath = parts[i + 1] ?? "";
			const newPath = parts[i + 2] ?? "";
			entries.push({
				xy: `${scoreMatch[1]} `,
				paths: [oldPath, newPath].filter(Boolean),
			});
			i += 3;
			continue;
		}
		if (rec.length >= 2) {
			const xy = rec.slice(0, 2);
			const path = rec.length >= 3 ? rec.slice(3) : "";
			const paths = path ? [path] : [];
			const isRename = xy.includes("R") || xy.includes("C");
			if (isRename) {
				i += 1;
				const other = parts[i];
				if (other) paths.push(other);
			}
			entries.push({ xy, paths });
		}
		i += 1;
	}
	return entries;
}

function porcelainPathExempt(
	repoRoot: string,
	porcelainPath: string,
	exemptAbsRoots: string[],
): boolean {
	if (exemptAbsRoots.length === 0) return false;
	const abs = resolve(repoRoot, porcelainPath);
	return exemptAbsRoots.some((root) => isPathUnder(abs, root));
}

/**
 * Check git repository safety before agent invocation.
 * Returns a report including dirty state and branch info.
 *
 * `exemptRoots` are absolute directories whose dirty/untracked files are
 * ignored (used for the records root between `run record` and `5x commit`).
 */
export async function checkGitSafety(
	workdir: string,
	opts?: { exemptRoots?: string[] },
): Promise<GitSafetyReport> {
	// Get repo root
	const rootResult = await run(["rev-parse", "--show-toplevel"], workdir);
	if (rootResult.exitCode !== 0) {
		throw new Error(`Not a git repository: ${workdir}. ${rootResult.stderr}`);
	}
	const repoRoot = rootResult.stdout.trim();

	// Get current branch
	const branch = await getCurrentBranch(workdir);

	// `--untracked-files=all` lists each untracked file. Without it, a brand-new
	// records tree collapses to `?? docs/` and fails the path-scoped exemption.
	const statusResult = await run(
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		workdir,
	);
	const entries = parsePorcelainZ(statusResult.stdout);
	const exemptAbsRoots = (opts?.exemptRoots ?? []).map((root) =>
		realpathExisting(root),
	);

	const untrackedFiles: string[] = [];
	let isDirty = false;

	for (const entry of entries) {
		const nonExempt = entry.paths.filter(
			(p) => !porcelainPathExempt(repoRoot, p, exemptAbsRoots),
		);
		if (nonExempt.length === 0) continue;
		if (entry.xy === "??") {
			untrackedFiles.push(...nonExempt);
			isDirty = true;
		} else {
			isDirty = true;
		}
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

/**
 * Produce a bounded diff summary for a single file between two commits.
 * Returns empty string on any git failure (best-effort for prompt context).
 * Output is capped to `maxLines` lines; overflow is indicated with a trailing
 * `... (truncated, N more lines)` marker.
 */
export async function getFileDiffSummary(
	workdir: string,
	fromCommit: string,
	toCommit: string,
	filePath: string,
	maxLines = 200,
): Promise<string> {
	const result = await run(
		["diff", "--unified=3", `${fromCommit}..${toCommit}`, "--", filePath],
		workdir,
	);
	if (result.exitCode !== 0) return "";
	const out = result.stdout;
	if (!out) return "";
	const lines = out.split("\n");
	if (lines.length <= maxLines) return out;
	const kept = lines.slice(0, maxLines).join("\n");
	const remaining = lines.length - maxLines;
	return `${kept}\n... (truncated, ${remaining} more lines)`;
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
	// Use --relative so paths are relative to workdir, not the repo root.
	// Without this, monorepo subdirectories get a prefix (e.g. "5x-cli/src/...")
	// that breaks path comparisons in ensurePhaseCheckpointClean.
	const [unstaged, staged, untracked] = await Promise.all([
		run(["diff", "--relative", "--name-only"], workdir),
		run(["diff", "--cached", "--relative", "--name-only"], workdir),
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
 *
 * **stdout is redirected to stderr** so hook output never contaminates
 * the JSON envelope that the calling command writes to stdout.
 * stderr is inherited directly.
 */
export async function runWorktreeSetupCommand(
	workdir: string,
	command: string,
): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr, exitCode } = await subprocess.execShell(
		command,
		workdir,
	);

	// Forward hook output to stderr so it remains observable
	if (stdout) process.stderr.write(stdout);
	if (stderr) process.stderr.write(stderr);

	if (exitCode !== 0) {
		throw new Error(
			`Worktree setup command failed (exit ${exitCode}): ${command}`,
		);
	}

	return { stdout, stderr };
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
	return `5x/${planSlugFromPath(planPath)}`;
}

/**
 * Validate that a branch name is relevant to a plan.
 * Returns true if the branch name contains a recognizable slug from the plan path.
 */
export function isBranchRelevant(
	branchName: string,
	planPath: string,
): boolean {
	const planSlug = planSlugFromPath(planPath).toLowerCase();
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
 * If the branch already exists locally, reuses it. When requested, fetches
 * remotes and tracks a matching remote branch instead of branching from HEAD.
 */
export async function createWorktree(
	repoRoot: string,
	branch: string,
	path: string,
	options: { fetchRemotes?: boolean } = {},
): Promise<WorktreeInfo> {
	// Guard: git worktree add on a repo with no commits creates an orphan
	// worktree that is not enumerable by `git worktree list`, causing every
	// subsequent --run-scoped command to report WORKTREE_MISSING. Detect
	// this early and surface a clear remediation message.
	const headCheck = await run(["rev-parse", "HEAD"], repoRoot);
	if (headCheck.exitCode !== 0) {
		throw new Error(
			"Cannot create a worktree in a repository with no commits. " +
				"Create an initial commit first:\n\n" +
				"  git commit --allow-empty -m 'init'\n\n" +
				"Then re-run your 5x command.",
		);
	}

	const exists = await branchExists(branch, repoRoot);
	let remoteBranch: string | undefined;

	if (!exists && options.fetchRemotes) {
		const fetchResult = await run(["fetch", "--all"], repoRoot);
		if (fetchResult.exitCode !== 0) {
			throw new Error(
				`Failed to fetch remotes before creating branch "${branch}": ${fetchResult.stderr}`,
			);
		}

		const [remotesResult, refsResult] = await Promise.all([
			run(["remote"], repoRoot),
			run(["for-each-ref", "--format=%(refname)", "refs/remotes"], repoRoot),
		]);
		if (remotesResult.exitCode !== 0 || refsResult.exitCode !== 0) {
			throw new Error(`Failed to inspect remote branches for "${branch}"`);
		}

		const remoteRefs = new Set(refsResult.stdout.split("\n").filter(Boolean));
		const matchingRemotes = remotesResult.stdout
			.split("\n")
			.filter(Boolean)
			.filter((remote) => remoteRefs.has(`refs/remotes/${remote}/${branch}`));

		if (matchingRemotes.length === 1) {
			remoteBranch = `${matchingRemotes[0]}/${branch}`;
		} else if (matchingRemotes.length > 1) {
			const defaultRemoteResult = await run(
				["config", "--get", "checkout.defaultRemote"],
				repoRoot,
			);
			const defaultRemote = defaultRemoteResult.stdout;
			if (
				defaultRemoteResult.exitCode === 0 &&
				matchingRemotes.includes(defaultRemote)
			) {
				remoteBranch = `${defaultRemote}/${branch}`;
			} else {
				throw new Error(
					`Branch "${branch}" exists on multiple remotes (${matchingRemotes.join(", ")}). ` +
						"Set checkout.defaultRemote to select one.",
				);
			}
		}
	}

	const args = exists
		? ["worktree", "add", path, branch]
		: remoteBranch
			? ["worktree", "add", "--track", "-b", branch, path, remoteBranch]
			: ["worktree", "add", path, "-b", branch];
	const result = await run(args, repoRoot);

	if (result.exitCode !== 0) {
		throw new Error(`Failed to create worktree at "${path}": ${result.stderr}`);
	}

	return { path, branch };
}

/**
 * Check out an existing branch (or create it from `startPoint`) in a new
 * worktree. Does not fetch. Used by records backfill for `5x/<slug>` when
 * the mapped worktree is not already on that branch.
 */
export async function addWorktreeForBranch(
	repoRoot: string,
	path: string,
	branch: string,
	startPoint?: string,
): Promise<WorktreeInfo> {
	const exists = await branchExists(branch, repoRoot);
	const args = exists
		? ["worktree", "add", path, branch]
		: startPoint
			? ["worktree", "add", "-b", branch, path, startPoint]
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

// ---------------------------------------------------------------------------
// Record helpers (patch-id, numstat, show, log)
// ---------------------------------------------------------------------------

/**
 * `git patch-id --stable` of `git diff from to`. Returns null on any failure
 * (squash-safe; do not throw at record time).
 */
export async function computePatchId(
	workdir: string,
	fromCommit: string,
	toCommit: string,
): Promise<string | null> {
	const diff = await run(["diff", fromCommit, toCommit], workdir);
	if (diff.exitCode !== 0) return null;
	const patchId = await subprocess.execGitStdin(
		["patch-id", "--stable"],
		workdir,
		diff.stdout,
	);
	if (patchId.exitCode !== 0) return null;
	const id = patchId.stdout.trim().split(/\s+/)[0];
	return id ? id : null;
}

export interface NumstatSummary {
	files_changed: number;
	insertions: number;
	deletions: number;
}

/**
 * `git diff --numstat from to`. Returns null on any git failure.
 */
export async function computeDiffSummary(
	workdir: string,
	fromCommit: string,
	toCommit: string,
): Promise<NumstatSummary | null> {
	const result = await run(
		["diff", "--numstat", fromCommit, toCommit],
		workdir,
	);
	if (result.exitCode !== 0) return null;
	let files_changed = 0;
	let insertions = 0;
	let deletions = 0;
	if (result.stdout) {
		for (const line of result.stdout.split("\n")) {
			if (!line.trim()) continue;
			const parts = line.split("\t");
			const ins = parts[0];
			const del = parts[1];
			if (ins === undefined || del === undefined) continue;
			files_changed += 1;
			if (ins !== "-") insertions += Number.parseInt(ins, 10) || 0;
			if (del !== "-") deletions += Number.parseInt(del, 10) || 0;
		}
	}
	return { files_changed, insertions, deletions };
}

/** `git show commit:path`. Null if the path is missing at that commit. */
export async function gitShowFile(
	workdir: string,
	commit: string,
	path: string,
): Promise<string | null> {
	const result = await run(["show", `${commit}:${path}`], workdir);
	if (result.exitCode !== 0) return null;
	return result.stdout;
}

/** `git log -1 --format=%H ref -- paths`. Null if none / failure. */
export async function gitLogLastTouching(
	workdir: string,
	ref: string,
	paths: string[],
): Promise<string | null> {
	if (paths.length === 0) return null;
	const result = await run(
		["log", "-1", "--format=%H", ref, "--", ...paths],
		workdir,
	);
	if (result.exitCode !== 0 || !result.stdout) return null;
	return result.stdout;
}

export interface FiveXRemoteRef {
	remote: string;
	/** Short name, e.g. `origin/5x/<slug>`. */
	ref: string;
}

/**
 * Local `5x/<slug>` branches and remote-tracking `<remote>/5x/<slug>` refs.
 * Uses `git for-each-ref` on `refs/heads/5x/*` and remote `5x/*` patterns.
 */
export async function listFiveXRefs(workdir: string): Promise<{
	local: string[];
	remote: FiveXRemoteRef[];
}> {
	const result = await run(
		[
			"for-each-ref",
			"--format=%(refname)",
			"refs/heads/5x/*",
			"refs/remotes/*/5x/*",
		],
		workdir,
	);
	const local: string[] = [];
	const remote: FiveXRemoteRef[] = [];
	if (result.exitCode !== 0 || !result.stdout) return { local, remote };
	for (const line of result.stdout.split("\n")) {
		const refname = line.trim();
		if (!refname) continue;
		const head = refname.match(/^refs\/heads\/(5x\/.+)$/);
		if (head?.[1]) {
			local.push(head[1]);
			continue;
		}
		const rem = refname.match(/^refs\/remotes\/([^/]+)\/(5x\/.+)$/);
		if (rem?.[1] && rem[2]) {
			remote.push({ remote: rem[1], ref: `${rem[1]}/${rem[2]}` });
		}
	}
	return { local, remote };
}

/** `git merge-base --is-ancestor maybeAncestor commit`. */
export async function isAncestor(
	workdir: string,
	maybeAncestor: string,
	commit: string,
): Promise<boolean> {
	const result = await run(
		["merge-base", "--is-ancestor", maybeAncestor, commit],
		workdir,
	);
	return result.exitCode === 0;
}

/**
 * Fetch `refs/heads/5x/*` into remote-tracking branches.
 * Only called when `--fetch` is set.
 */
export async function fetchFiveXBranches(
	workdir: string,
	remote: string,
): Promise<void> {
	const result = await run(
		["fetch", remote, `+refs/heads/5x/*:refs/remotes/${remote}/5x/*`],
		workdir,
	);
	if (result.exitCode !== 0) {
		throw new Error(
			result.stderr || `git fetch ${remote} refs/heads/5x/* failed`,
		);
	}
}

/** `git remote`. */
export async function listRemotes(workdir: string): Promise<string[]> {
	const result = await run(["remote"], workdir);
	if (result.exitCode !== 0 || !result.stdout) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export interface GitRefTip {
	sha: string;
	refname: string;
	committerUnix: number | null;
}

/** `git for-each-ref --format=sha\\trefname\\tcommitterdate:unix patterns`. */
export async function listRefTips(
	workdir: string,
	patterns: string[],
): Promise<GitRefTip[]> {
	if (patterns.length === 0) return [];
	const result = await run(
		[
			"for-each-ref",
			"--format=%(objectname)%09%(refname)%09%(committerdate:unix)",
			...patterns,
		],
		workdir,
	);
	if (result.exitCode !== 0 || !result.stdout) return [];
	const tips: GitRefTip[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line) continue;
		const [sha, refname, unixRaw] = line.split("\t");
		if (!sha || !refname) continue;
		const unix = unixRaw ? Number.parseInt(unixRaw, 10) : Number.NaN;
		tips.push({
			sha,
			refname,
			committerUnix: Number.isFinite(unix) ? unix : null,
		});
	}
	return tips;
}

/** `git rev-parse --verify --quiet ref^{commit}`. */
export async function revParseCommit(
	workdir: string,
	ref: string,
): Promise<string | null> {
	const result = await run(
		["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
		workdir,
	);
	if (result.exitCode !== 0 || !result.stdout) return null;
	return result.stdout;
}

/** `git rev-list --parents tips...` for in-memory ancestor queries. */
export async function gitRevListParents(
	workdir: string,
	tips: string[],
): Promise<string> {
	if (tips.length === 0) return "";
	const result = await run(["rev-list", "--parents", ...tips], workdir);
	if (result.exitCode !== 0) return "";
	return result.stdout;
}

/** `git log --format=%H --name-only tips... -- paths`. */
export async function gitLogNameOnly(
	workdir: string,
	tips: string[],
	paths: string[],
): Promise<string> {
	if (tips.length === 0 || paths.length === 0) return "";
	const result = await run(
		["log", "--format=%H", "--name-only", ...tips, "--", ...paths],
		workdir,
	);
	if (result.exitCode !== 0) return "";
	return result.stdout;
}

/** `git ls-tree -r --name-only ref -- pathspec`. */
export async function gitLsTreePaths(
	workdir: string,
	ref: string,
	pathspec: string,
): Promise<string[]> {
	const result = await run(
		["ls-tree", "-r", "--name-only", ref, "--", pathspec],
		workdir,
	);
	if (result.exitCode !== 0 || !result.stdout) return [];
	return result.stdout.split("\n").filter(Boolean);
}
