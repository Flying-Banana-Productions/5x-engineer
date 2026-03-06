/**
 * Tests for git.ts — all subprocess calls are mocked via spyOn(subprocess).
 * No real git commands are spawned. No temp repos or filesystem side effects.
 */

import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import {
	branchExists,
	branchNameFromPlan,
	checkGitSafety,
	commitFiles,
	createBranch,
	createWorktree,
	getBranchCommits,
	getCurrentBranch,
	getLatestCommit,
	hasUncommittedChanges,
	isBranchMerged,
	isBranchRelevant,
	listChangedFiles,
	listWorktrees,
	removeWorktree,
	runWorktreeSetupCommand,
} from "../src/git.js";
import { subprocess } from "../src/utils/subprocess.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1) => ({
	stdout: "",
	stderr,
	exitCode,
});

let execGitSpy: Mock<typeof subprocess.execGit>;
let execShellSpy: Mock<typeof subprocess.execShell>;

afterEach(() => {
	execGitSpy?.mockRestore();
	execShellSpy?.mockRestore();
});

/**
 * Set up the git mock to respond based on command patterns.
 * Each entry is [matchFn, response]. First match wins.
 */
function mockGit(
	...rules: Array<
		[
			(args: string[]) => boolean,
			{ stdout: string; stderr: string; exitCode: number },
		]
	>
) {
	execGitSpy = spyOn(subprocess, "execGit").mockImplementation(
		async (args: string[], _workdir: string) => {
			for (const [match, response] of rules) {
				if (match(args)) return response;
			}
			return fail(`Unexpected git call: git ${args.join(" ")}`);
		},
	);
	return execGitSpy;
}

/** Match git subcommand by first N args. */
const cmd =
	(...prefix: string[]) =>
	(args: string[]) =>
		prefix.every((p, i) => args[i] === p);

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

describe("checkGitSafety", () => {
	test("clean repo reports safe", async () => {
		mockGit(
			[cmd("rev-parse", "--show-toplevel"), ok("/fake/repo")],
			[cmd("rev-parse", "--abbrev-ref", "HEAD"), ok("main")],
			[cmd("status", "--porcelain"), ok("")],
		);
		const rpt = await checkGitSafety("/fake/repo");
		expect(rpt.safe).toBe(true);
		expect(rpt.isDirty).toBe(false);
		expect(rpt.untrackedFiles).toHaveLength(0);
		expect(rpt.branch).toBe("main");
		expect(rpt.repoRoot).toBe("/fake/repo");
	});

	test("dirty working tree reports unsafe", async () => {
		mockGit(
			[cmd("rev-parse", "--show-toplevel"), ok("/fake/repo")],
			[cmd("rev-parse", "--abbrev-ref", "HEAD"), ok("main")],
			[cmd("status", "--porcelain"), ok(" M README.md")],
		);
		const rpt = await checkGitSafety("/fake/repo");
		expect(rpt.safe).toBe(false);
		expect(rpt.isDirty).toBe(true);
	});

	test("untracked files reports unsafe", async () => {
		mockGit(
			[cmd("rev-parse", "--show-toplevel"), ok("/fake/repo")],
			[cmd("rev-parse", "--abbrev-ref", "HEAD"), ok("main")],
			[cmd("status", "--porcelain"), ok("?? untracked.txt")],
		);
		const rpt = await checkGitSafety("/fake/repo");
		expect(rpt.safe).toBe(false);
		expect(rpt.untrackedFiles).toContain("untracked.txt");
	});

	test("throws for non-git directory", async () => {
		mockGit([
			cmd("rev-parse", "--show-toplevel"),
			fail("fatal: not a git repository"),
		]);
		await expect(checkGitSafety("/not/a/repo")).rejects.toThrow(
			"Not a git repository",
		);
	});
});

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

describe("getCurrentBranch", () => {
	test("returns branch name", async () => {
		mockGit([cmd("rev-parse", "--abbrev-ref", "HEAD"), ok("main")]);
		expect(await getCurrentBranch("/r")).toBe("main");
	});

	test("returns HEAD when detached", async () => {
		mockGit([cmd("rev-parse", "--abbrev-ref", "HEAD"), ok("HEAD")]);
		expect(await getCurrentBranch("/r")).toBe("HEAD");
	});
});

describe("createBranch", () => {
	test("creates and switches to new branch", async () => {
		mockGit([cmd("checkout", "-b", "feature/test"), ok("")]);
		// Should not throw
		await createBranch("feature/test", "/r");
		expect(execGitSpy).toHaveBeenCalledWith(
			["checkout", "-b", "feature/test"],
			"/r",
		);
	});

	test("throws if branch already exists", async () => {
		mockGit([
			cmd("checkout", "-b", "feature/test"),
			fail("fatal: a branch named 'feature/test' already exists"),
		]);
		await expect(createBranch("feature/test", "/r")).rejects.toThrow(
			'Failed to create branch "feature/test"',
		);
	});
});

describe("getLatestCommit", () => {
	test("returns full commit hash", async () => {
		const hash = "abc123def456".repeat(4).slice(0, 40);
		mockGit([cmd("rev-parse", "HEAD"), ok(hash)]);
		expect(await getLatestCommit("/r")).toBe(hash);
	});

	test("throws on failure", async () => {
		mockGit([cmd("rev-parse", "HEAD"), fail("fatal: bad default revision")]);
		await expect(getLatestCommit("/r")).rejects.toThrow(
			"Failed to get latest commit",
		);
	});
});

describe("hasUncommittedChanges", () => {
	test("clean repo returns false", async () => {
		mockGit([cmd("status", "--porcelain"), ok("")]);
		expect(await hasUncommittedChanges("/r")).toBe(false);
	});

	test("dirty repo returns true", async () => {
		mockGit([cmd("status", "--porcelain"), ok(" M file.txt")]);
		expect(await hasUncommittedChanges("/r")).toBe(true);
	});
});

describe("listChangedFiles", () => {
	test("returns staged, unstaged, and untracked files", async () => {
		mockGit(
			[cmd("diff", "--relative", "--name-only"), ok("modified.txt")],
			[cmd("diff", "--cached", "--relative", "--name-only"), ok("staged.txt")],
			[cmd("ls-files", "--others", "--exclude-standard"), ok("untracked.txt")],
		);
		const files = await listChangedFiles("/r");
		expect(files).toContain("modified.txt");
		expect(files).toContain("staged.txt");
		expect(files).toContain("untracked.txt");
	});

	test("deduplicates files across categories", async () => {
		mockGit(
			[cmd("diff", "--relative", "--name-only"), ok("same.txt")],
			[cmd("diff", "--cached", "--relative", "--name-only"), ok("same.txt")],
			[cmd("ls-files", "--others", "--exclude-standard"), ok("")],
		);
		const files = await listChangedFiles("/r");
		expect(files).toEqual(["same.txt"]);
	});

	test("handles empty output", async () => {
		mockGit(
			[cmd("diff", "--relative", "--name-only"), ok("")],
			[cmd("diff", "--cached", "--relative", "--name-only"), ok("")],
			[cmd("ls-files", "--others", "--exclude-standard"), ok("")],
		);
		const files = await listChangedFiles("/r");
		expect(files).toHaveLength(0);
	});
});

describe("commitFiles", () => {
	test("stages files, commits, returns hash", async () => {
		const hash = "a1b2c3d4e5f6".repeat(4).slice(0, 40);
		mockGit(
			[cmd("add", "--"), ok("")],
			[cmd("commit", "-m"), ok("")],
			[cmd("rev-parse", "HEAD"), ok(hash)],
		);
		const result = await commitFiles("/r", ["file.txt"], "test commit");
		expect(result.commit).toBe(hash);
		expect(execGitSpy).toHaveBeenCalledWith(["add", "--", "file.txt"], "/r");
		expect(execGitSpy).toHaveBeenCalledWith(
			["commit", "-m", "test commit"],
			"/r",
		);
	});

	test("throws on empty file list", async () => {
		await expect(commitFiles("/r", [], "msg")).rejects.toThrow(
			"No files provided",
		);
	});

	test("throws on stage failure", async () => {
		mockGit([cmd("add", "--"), fail("fatal: pathspec 'x' did not match")]);
		await expect(commitFiles("/r", ["x"], "msg")).rejects.toThrow(
			"Failed to stage files",
		);
	});

	test("throws on commit failure", async () => {
		mockGit(
			[cmd("add", "--"), ok("")],
			[cmd("commit", "-m"), fail("nothing to commit")],
		);
		await expect(commitFiles("/r", ["f.txt"], "msg")).rejects.toThrow(
			"Failed to create commit",
		);
	});
});

describe("runWorktreeSetupCommand", () => {
	test("runs shell command and returns output", async () => {
		execShellSpy = spyOn(subprocess, "execShell").mockResolvedValue({
			stdout: "setup done\n",
			stderr: "",
			exitCode: 0,
		});
		const result = await runWorktreeSetupCommand("/wt", "echo setup done");
		expect(result.stdout).toBe("setup done\n");
		expect(execShellSpy).toHaveBeenCalledWith("echo setup done", "/wt");
	});

	test("throws when command exits non-zero", async () => {
		execShellSpy = spyOn(subprocess, "execShell").mockResolvedValue({
			stdout: "",
			stderr: "error\n",
			exitCode: 7,
		});
		await expect(runWorktreeSetupCommand("/wt", "exit 7")).rejects.toThrow(
			"Worktree setup command failed",
		);
	});
});

describe("branchExists", () => {
	test("returns true for existing branch", async () => {
		mockGit([cmd("rev-parse", "--verify"), ok("abc123")]);
		expect(await branchExists("main", "/r")).toBe(true);
	});

	test("returns false for non-existent branch", async () => {
		mockGit([cmd("rev-parse", "--verify"), fail("fatal: not a valid ref")]);
		expect(await branchExists("nonexistent", "/r")).toBe(false);
	});
});

describe("getBranchCommits", () => {
	test("returns commits since divergence", async () => {
		const hash = "a".repeat(40);
		mockGit([cmd("log"), ok(hash)]);
		const commits = await getBranchCommits("main", "/r");
		expect(commits).toEqual([hash]);
	});

	test("returns empty for no new commits", async () => {
		mockGit([cmd("log"), ok("")]);
		const commits = await getBranchCommits("main", "/r");
		expect(commits).toHaveLength(0);
	});

	test("parses multiple commits", async () => {
		const h1 = "a".repeat(40);
		const h2 = "b".repeat(40);
		mockGit([cmd("log"), ok(`${h1}\n${h2}`)]);
		const commits = await getBranchCommits("main", "/r");
		expect(commits).toEqual([h1, h2]);
	});
});

// ---------------------------------------------------------------------------
// Branch naming (pure, no I/O)
// ---------------------------------------------------------------------------

describe("branchNameFromPlan", () => {
	test("generates name from plan path", () => {
		expect(branchNameFromPlan("docs/development/001-impl-5x-cli.md")).toBe(
			"5x/001-impl-5x-cli",
		);
	});
	test("handles nested paths", () => {
		expect(branchNameFromPlan("deep/nested/path/002-feature.md")).toBe(
			"5x/002-feature",
		);
	});
});

describe("isBranchRelevant", () => {
	test("matching branch", () => {
		expect(
			isBranchRelevant(
				"5x/001-impl-5x-cli",
				"docs/development/001-impl-5x-cli.md",
			),
		).toBe(true);
	});
	test("partial match", () => {
		expect(
			isBranchRelevant(
				"001-impl-5x-cli",
				"docs/development/001-impl-5x-cli.md",
			),
		).toBe(true);
	});
	test("unrelated branch", () => {
		expect(
			isBranchRelevant(
				"feature/auth-redesign",
				"docs/development/001-impl-5x-cli.md",
			),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Worktree operations
// ---------------------------------------------------------------------------

describe("worktree operations", () => {
	test("create worktree with new branch", async () => {
		mockGit(
			[cmd("rev-parse", "--verify"), fail("not found")], // branch doesn't exist
			[cmd("worktree", "add"), ok("Preparing worktree")],
		);
		const info = await createWorktree("/repo", "wt-branch", "/repo/wt/test");
		expect(info.path).toBe("/repo/wt/test");
		expect(info.branch).toBe("wt-branch");
		// Should use -b flag for new branch
		expect(execGitSpy).toHaveBeenCalledWith(
			["worktree", "add", "/repo/wt/test", "-b", "wt-branch"],
			"/repo",
		);
	});

	test("create worktree with existing branch", async () => {
		mockGit(
			[cmd("rev-parse", "--verify"), ok("abc123")], // branch exists
			[cmd("worktree", "add"), ok("Preparing worktree")],
		);
		const info = await createWorktree("/repo", "existing-branch", "/repo/wt/e");
		expect(info.branch).toBe("existing-branch");
		// Should NOT use -b flag for existing branch
		expect(execGitSpy).toHaveBeenCalledWith(
			["worktree", "add", "/repo/wt/e", "existing-branch"],
			"/repo",
		);
	});

	test("list worktrees parses porcelain output", async () => {
		mockGit([
			cmd("worktree", "list", "--porcelain"),
			ok(
				[
					"worktree /repo",
					"HEAD abc123",
					"branch refs/heads/main",
					"",
					"worktree /repo/wt/test",
					"HEAD def456",
					"branch refs/heads/wt-branch",
					"",
				].join("\n"),
			),
		]);
		const trees = await listWorktrees("/repo");
		expect(trees).toHaveLength(2);
		expect(trees[0]).toEqual({ path: "/repo", branch: "main" });
		expect(trees[1]).toEqual({
			path: "/repo/wt/test",
			branch: "wt-branch",
		});
	});

	test("remove worktree", async () => {
		mockGit([cmd("worktree", "remove"), ok("")]);
		await removeWorktree("/repo", "/repo/wt/rm");
		expect(execGitSpy).toHaveBeenCalledWith(
			["worktree", "remove", "/repo/wt/rm"],
			"/repo",
		);
	});

	test("remove worktree with force", async () => {
		mockGit([cmd("worktree", "remove"), ok("")]);
		await removeWorktree("/repo", "/repo/wt/rm", true);
		expect(execGitSpy).toHaveBeenCalledWith(
			["worktree", "remove", "/repo/wt/rm", "--force"],
			"/repo",
		);
	});
});

// ---------------------------------------------------------------------------
// Branch merge check
// ---------------------------------------------------------------------------

describe("isBranchMerged", () => {
	test("merged branch returns true", async () => {
		mockGit([cmd("branch", "--merged", "HEAD"), ok("  main\n  to-merge")]);
		expect(await isBranchMerged("to-merge", "/r")).toBe(true);
	});

	test("current branch (with asterisk) returns true", async () => {
		mockGit([cmd("branch", "--merged", "HEAD"), ok("* main\n  feature")]);
		expect(await isBranchMerged("main", "/r")).toBe(true);
	});

	test("unmerged branch returns false", async () => {
		mockGit([cmd("branch", "--merged", "HEAD"), ok("  main")]);
		expect(await isBranchMerged("unmerged", "/r")).toBe(false);
	});

	test("handles git failure gracefully", async () => {
		mockGit([cmd("branch", "--merged", "HEAD"), fail("error")]);
		expect(await isBranchMerged("any", "/r")).toBe(false);
	});
});
