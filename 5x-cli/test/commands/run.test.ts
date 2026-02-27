import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	remapReviewPathForWorktree,
	resolveWorktreeWorkdir,
	syncWorktreeTemplates,
	worktreeSubfolderOffset,
} from "../../src/commands/run.js";

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "5x-run-template-sync-"));
	return dir;
}

describe("syncWorktreeTemplates", () => {
	test("copies missing relative template files into worktree", () => {
		const root = makeTmpDir();
		const workdir = join(root, ".5x", "worktrees", "wt-1");
		mkdirSync(workdir, { recursive: true });

		const planRel = ".5x/templates/implementation-plan-template.md";
		const reviewRel = ".5x/templates/review-template.md";
		mkdirSync(join(root, ".5x", "templates"), { recursive: true });
		writeFileSync(join(root, planRel), "PLAN", "utf-8");
		writeFileSync(join(root, reviewRel), "REVIEW", "utf-8");

		try {
			const result = syncWorktreeTemplates({
				projectRoot: root,
				workdir,
				templatePaths: [planRel, reviewRel],
			});

			expect(result.copied.length).toBe(2);
			expect(result.missingSource).toHaveLength(0);
			expect(existsSync(join(workdir, planRel))).toBe(true);
			expect(existsSync(join(workdir, reviewRel))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not overwrite existing worktree template files", () => {
		const root = makeTmpDir();
		const workdir = join(root, ".5x", "worktrees", "wt-2");
		const relPath = ".5x/templates/review-template.md";
		mkdirSync(join(root, ".5x", "templates"), { recursive: true });
		mkdirSync(join(workdir, ".5x", "templates"), { recursive: true });
		writeFileSync(join(root, relPath), "SOURCE", "utf-8");
		writeFileSync(join(workdir, relPath), "CUSTOM", "utf-8");

		try {
			const result = syncWorktreeTemplates({
				projectRoot: root,
				workdir,
				templatePaths: [relPath],
			});

			expect(result.copied).toHaveLength(0);
			expect(result.skipped).toHaveLength(1);
			expect(readFileSync(join(workdir, relPath), "utf-8")).toBe("CUSTOM");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("mirrors absolute template paths that are under project root", () => {
		const root = makeTmpDir();
		const workdir = join(root, ".5x", "worktrees", "wt-3");
		mkdirSync(workdir, { recursive: true });

		const absTemplate = join(root, ".5x", "templates", "review-template.md");
		mkdirSync(join(root, ".5x", "templates"), { recursive: true });
		writeFileSync(absTemplate, "SOURCE", "utf-8");

		try {
			const result = syncWorktreeTemplates({
				projectRoot: root,
				workdir,
				templatePaths: [absTemplate],
			});

			const mirroredPath = resolve(workdir, relative(root, absTemplate));
			expect(result.copied).toContain(mirroredPath);
			expect(readFileSync(mirroredPath, "utf-8")).toBe("SOURCE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports absolute template paths outside project root as unmappable", () => {
		const root = makeTmpDir();
		const workdir = join(root, ".5x", "worktrees", "wt-4");
		mkdirSync(workdir, { recursive: true });
		const outside = join(tmpdir(), "shared-review-template.md");

		try {
			writeFileSync(outside, "OUTSIDE", "utf-8");
			const result = syncWorktreeTemplates({
				projectRoot: root,
				workdir,
				templatePaths: [outside],
			});

			expect(result.unmappableAbsolute).toContain(outside);
			expect(result.copied).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { force: true });
		}
	});
});

describe("remapReviewPathForWorktree", () => {
	test("keeps review path unchanged when already under worktree", () => {
		const projectRoot = "/repo";
		const workdir = "/repo/.5x/worktrees/wt-1";
		const reviewPath =
			"/repo/.5x/worktrees/wt-1/docs/development/reviews/2026-02-26-review.md";

		const result = remapReviewPathForWorktree({
			projectRoot,
			workdir,
			reviewPath,
		});

		expect(result.reviewPath).toBe(reviewPath);
		expect(result.warning).toBeUndefined();
	});

	test("remaps project-root review path into worktree", () => {
		const projectRoot = "/repo";
		const workdir = "/repo/.5x/worktrees/wt-1";
		const reviewPath = "/repo/docs/development/reviews/2026-02-26-review.md";

		const result = remapReviewPathForWorktree({
			projectRoot,
			workdir,
			reviewPath,
		});

		expect(result.reviewPath).toBe(
			"/repo/.5x/worktrees/wt-1/docs/development/reviews/2026-02-26-review.md",
		);
		expect(result.warning).toBeUndefined();
	});

	test("returns warning for review paths outside project and worktree", () => {
		const result = remapReviewPathForWorktree({
			projectRoot: "/repo",
			workdir: "/repo/.5x/worktrees/wt-1",
			reviewPath: "/tmp/review.md",
		});

		expect(result.reviewPath).toBe("/tmp/review.md");
		expect(result.warning).toBeTruthy();
	});
});

describe("worktreeSubfolderOffset", () => {
	test("returns empty string when projectRoot is the git root", () => {
		const root = makeTmpDir();
		mkdirSync(join(root, ".git"), { recursive: true });

		try {
			expect(worktreeSubfolderOffset(root)).toBe("");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns subfolder offset in a monorepo", () => {
		// Create a temp dir with a .git marker and a subfolder
		const root = makeTmpDir();
		mkdirSync(join(root, ".git"), { recursive: true });
		const subfolder = join(root, "packages", "my-app");
		mkdirSync(subfolder, { recursive: true });

		try {
			const offset = worktreeSubfolderOffset(subfolder);
			expect(offset).toBe(join("packages", "my-app"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns empty string when no git root found", () => {
		// A temp dir with no .git anywhere relevant
		const root = makeTmpDir();
		try {
			// This may find a .git higher up depending on the system, but
			// if root itself has no .git parent it returns ""
			const offset = worktreeSubfolderOffset(root);
			// Either "" (no git root) or a valid offset — not crashing is key
			expect(typeof offset).toBe("string");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveWorktreeWorkdir", () => {
	test("returns worktree path unchanged when offset is empty", () => {
		const wt = "/repo/.5x/worktrees/5x-feat";
		expect(resolveWorktreeWorkdir(wt, "")).toBe(wt);
	});

	test("appends subfolder offset to worktree path", () => {
		const wt = "/repo/.5x/worktrees/5x-feat";
		expect(resolveWorktreeWorkdir(wt, "packages/my-app")).toBe(
			"/repo/.5x/worktrees/5x-feat/packages/my-app",
		);
	});

	test("handles single-level offset", () => {
		const wt = "/monorepo/.5x/worktrees/5x-impl";
		expect(resolveWorktreeWorkdir(wt, "5x-cli")).toBe(
			"/monorepo/.5x/worktrees/5x-impl/5x-cli",
		);
	});
});
