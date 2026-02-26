import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// Helpers — minimize process spawns to avoid contention under --concurrent
// ---------------------------------------------------------------------------

/** Run a shell command synchronously to avoid async scheduling contention. */
function sh(cmd: string, cwd: string) {
	Bun.spawnSync(["sh", "-c", cmd], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
		},
	});
}

/** Create a git repo with initial commit (single sync process). */
function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "5x-git-"));
	sh(
		"git init -b main && git config user.email test@test.com && git config user.name Test && echo init > README.md && git add . && git commit -m init",
		dir,
	);
	return dir;
}

function cleanup(dir: string) {
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

describe("checkGitSafety", () => {
	test("clean repo reports safe", async () => {
		const r = initRepo();
		try {
			const rpt = await checkGitSafety(r);
			expect(rpt.safe).toBe(true);
			expect(rpt.isDirty).toBe(false);
			expect(rpt.untrackedFiles).toHaveLength(0);
			expect(rpt.branch).toBe("main");
			expect(rpt.repoRoot).toBe(r);
		} finally {
			cleanup(r);
		}
	});

	test("dirty working tree reports unsafe", async () => {
		const r = initRepo();
		try {
			sh("echo x >> README.md", r);
			const rpt = await checkGitSafety(r);
			expect(rpt.safe).toBe(false);
			expect(rpt.isDirty).toBe(true);
		} finally {
			cleanup(r);
		}
	});

	test("untracked files reports unsafe", async () => {
		const r = initRepo();
		try {
			sh("echo new > untracked.txt", r);
			const rpt = await checkGitSafety(r);
			expect(rpt.safe).toBe(false);
			expect(rpt.untrackedFiles.length).toBeGreaterThan(0);
		} finally {
			cleanup(r);
		}
	});

	test("throws for non-git directory", async () => {
		const d = mkdtempSync(join(tmpdir(), "5x-nongit-"));
		try {
			await expect(checkGitSafety(d)).rejects.toThrow("Not a git repository");
		} finally {
			cleanup(d);
		}
	});
});

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

describe("getCurrentBranch", () => {
	test("returns branch name", async () => {
		const r = initRepo();
		try {
			expect(await getCurrentBranch(r)).toBe("main");
		} finally {
			cleanup(r);
		}
	});
});

describe("createBranch", () => {
	test("creates and switches to new branch", async () => {
		const r = initRepo();
		try {
			await createBranch("feature/test", r);
			expect(await getCurrentBranch(r)).toBe("feature/test");
		} finally {
			cleanup(r);
		}
	});

	test("throws if branch already exists", async () => {
		const r = initRepo();
		try {
			// Create branch in a single shell to avoid extra process spawns
			sh("git checkout -b feature/test && git checkout main", r);
			await expect(createBranch("feature/test", r)).rejects.toThrow();
		} finally {
			cleanup(r);
		}
	});
});

describe("getLatestCommit", () => {
	test("returns full commit hash", async () => {
		const r = initRepo();
		try {
			const hash = await getLatestCommit(r);
			expect(hash).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			cleanup(r);
		}
	});
});

describe("hasUncommittedChanges", () => {
	test("clean repo returns false", async () => {
		const r = initRepo();
		try {
			expect(await hasUncommittedChanges(r)).toBe(false);
		} finally {
			cleanup(r);
		}
	});

	test("dirty repo returns true", async () => {
		const r = initRepo();
		try {
			sh("echo x >> README.md", r);
			expect(await hasUncommittedChanges(r)).toBe(true);
		} finally {
			cleanup(r);
		}
	});
});

describe("listChangedFiles", () => {
	test("returns staged, unstaged, and untracked files", async () => {
		const r = initRepo();
		try {
			sh(
				"echo x >> README.md && echo staged > staged.txt && git add staged.txt && echo u > untracked.txt",
				r,
			);
			const files = await listChangedFiles(r);
			expect(files).toContain("README.md");
			expect(files).toContain("staged.txt");
			expect(files).toContain("untracked.txt");
		} finally {
			cleanup(r);
		}
	});
});

describe("commitFiles", () => {
	test("commits only specified files", async () => {
		const r = initRepo();
		try {
			sh("echo review > review.md && echo notes > notes.txt", r);
			const result = await commitFiles(r, ["review.md"], "docs: add review");
			expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

			const files = await listChangedFiles(r);
			expect(files).toContain("notes.txt");
			expect(files).not.toContain("review.md");
		} finally {
			cleanup(r);
		}
	});
});

describe("runWorktreeSetupCommand", () => {
	test("runs setup command in workdir", async () => {
		const r = initRepo();
		try {
			await runWorktreeSetupCommand(r, "touch .worktree-ready");
			expect(existsSync(join(r, ".worktree-ready"))).toBe(true);
		} finally {
			cleanup(r);
		}
	});

	test("throws when setup command exits non-zero", async () => {
		const r = initRepo();
		try {
			await expect(runWorktreeSetupCommand(r, "exit 7")).rejects.toThrow(
				"Worktree setup command failed",
			);
		} finally {
			cleanup(r);
		}
	});
});

describe("branchExists", () => {
	test("returns true for existing branch", async () => {
		const r = initRepo();
		try {
			expect(await branchExists("main", r)).toBe(true);
		} finally {
			cleanup(r);
		}
	});

	test("returns false for non-existent branch", async () => {
		const r = initRepo();
		try {
			expect(await branchExists("nonexistent", r)).toBe(false);
		} finally {
			cleanup(r);
		}
	});
});

describe("getBranchCommits", () => {
	test("returns commits since divergence", async () => {
		const r = initRepo();
		try {
			// Single shell: create branch + commit on it
			sh(
				"git checkout -b feature/x && echo a > a.txt && git add . && git commit -m 'add a'",
				r,
			);
			const commits = await getBranchCommits("main", r);
			expect(commits).toHaveLength(1);
			expect(commits[0]).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			cleanup(r);
		}
	});

	test("returns empty for no new commits", async () => {
		const r = initRepo();
		try {
			expect(await getBranchCommits("main", r)).toHaveLength(0);
		} finally {
			cleanup(r);
		}
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
	test("create and list worktree", async () => {
		const r = initRepo();
		try {
			const wtPath = join(r, "wt", "test");
			const info = await createWorktree(r, "wt-branch", wtPath);
			expect(info.path).toBe(wtPath);
			expect(info.branch).toBe("wt-branch");

			const trees = await listWorktrees(r);
			expect(trees.length).toBeGreaterThanOrEqual(2);
			const wt = trees.find((t) => t.branch === "wt-branch");
			expect(wt).toBeDefined();
		} finally {
			cleanup(r);
		}
	});

	test("create worktree with existing branch", async () => {
		const r = initRepo();
		try {
			sh("git branch existing-branch", r);
			const info = await createWorktree(
				r,
				"existing-branch",
				join(r, "wt", "e"),
			);
			expect(info.branch).toBe("existing-branch");
		} finally {
			cleanup(r);
		}
	});

	test("remove worktree", async () => {
		const r = initRepo();
		try {
			const wtPath = join(r, "wt", "rm");
			await createWorktree(r, "rm-branch", wtPath);
			await removeWorktree(r, wtPath);
			const trees = await listWorktrees(r);
			expect(trees.find((t) => t.branch === "rm-branch")).toBeUndefined();
		} finally {
			cleanup(r);
		}
	});
});

// ---------------------------------------------------------------------------
// Branch merge check
// ---------------------------------------------------------------------------

describe("isBranchMerged", () => {
	test("merged branch returns true", async () => {
		const r = initRepo();
		try {
			// Single shell: create branch, commit, checkout main, merge
			sh(
				"git checkout -b to-merge && echo m > m.txt && git add . && git commit -m merge && git checkout main && git merge to-merge",
				r,
			);
			expect(await isBranchMerged("to-merge", r)).toBe(true);
		} finally {
			cleanup(r);
		}
	});

	test("unmerged branch returns false", async () => {
		const r = initRepo();
		try {
			// Single shell: create branch, commit, checkout main (no merge)
			sh(
				"git checkout -b unmerged && echo u > u.txt && git add . && git commit -m unmerged && git checkout main",
				r,
			);
			expect(await isBranchMerged("unmerged", r)).toBe(false);
		} finally {
			cleanup(r);
		}
	});
});
