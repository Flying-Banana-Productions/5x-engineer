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
	syncWorktreeTemplates,
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
