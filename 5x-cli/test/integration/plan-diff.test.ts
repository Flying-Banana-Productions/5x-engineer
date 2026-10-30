import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPlanReviewDiffContext,
	formatPlanReviewDiffContext,
	validateIntroducedBy,
} from "../../src/review-governance/plan-diff.js";
import {
	type ImportedCommit,
	importCommitSequence,
} from "../helpers/git-fixture.js";

const dirs: string[] = [];

afterAll(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

async function history(commits: readonly ImportedCommit[]): Promise<{
	dir: string;
	hashes: string[];
}> {
	const dir = mkdtempSync(join(tmpdir(), "5x-plan-diff-"));
	dirs.push(dir);
	const hashes = await importCommitSequence(dir, commits);
	return { dir, hashes };
}

describe("plan-only review diff evidence", () => {
	// --concurrent runs this file on one thread, so a started test's 15s budget
	// includes sibling git. test.serial starts that budget when the test runs.
	test.serial(
		"builds a top-level-relative plan diff from a subdirectory workdir",
		async () => {
			const { dir, hashes } = await history([
				{
					message: "initial",
					files: [{ path: "packages/app/plan.md", content: "old\n" }],
				},
				{
					message: "revise nested plan",
					files: [{ path: "packages/app/plan.md", content: "new\n" }],
				},
			]);
			const previous = hashes[0] ?? "";
			const current = hashes[1] ?? "";
			const workdir = join(dir, "packages", "app");

			const context = await buildPlanReviewDiffContext({
				workdir,
				planPath: join(workdir, "plan.md"),
				previousReviewCommit: previous,
				currentCommit: current,
			});
			expect(context.patch).toContain("-old");
			expect(context.patch).toContain("+new");
			expect(context.hunks).toHaveLength(1);
			expect(formatPlanReviewDiffContext(context)).toContain(
				"':(top)packages/app/plan.md'",
			);
		},
		{ timeout: 15000 },
	);

	test.serial(
		"accepts a pre-artifact end commit with an equivalent plan patch and exact hunk",
		async () => {
			const plan = "# Plan\n\nnew\n";
			const { dir, hashes } = await history([
				{
					message: "initial",
					files: [{ path: "plan.md", content: "# Plan\n\nold\n" }],
				},
				{
					message: "revise plan",
					files: [{ path: "plan.md", content: plan }],
				},
				{
					message: "add review",
					files: [
						{ path: "plan.md", content: plan },
						{ path: "review.md", content: "review artifact\n" },
					],
				},
			]);
			const previous = hashes[0] ?? "";
			const planCommit = hashes[1] ?? "";
			const artifactCommit = hashes[2] ?? "";

			const context = await buildPlanReviewDiffContext({
				workdir: dir,
				planPath: join(dir, "plan.md"),
				previousReviewCommit: previous,
				currentCommit: artifactCommit,
			});
			expect(context.equivalentPlanCommits).toContain(planCommit);
			expect(context.hunks).toHaveLength(1);
			expect(
				validateIntroducedBy(
					{
						commitRange: `${previous}..${planCommit}`,
						diffHunk: context.hunks[0]?.text ?? "",
						explanation: "The plan revision introduced this behavior.",
					},
					context,
				),
			).toMatchObject({ valid: true });

			const assembled = `${context.hunks[0]?.header}\n+not the real line`;
			expect(
				validateIntroducedBy(
					{
						commitRange: `${previous}..${artifactCommit}`,
						diffHunk: assembled,
						explanation: "Invalid assembled evidence.",
					},
					context,
				),
			).toMatchObject({ valid: false, code: "INTRODUCED_HUNK_NOT_FOUND" });
		},
		{ timeout: 15000 },
	);

	test.serial(
		"tracks renamed plans and documents omitted hunk retrieval",
		async () => {
			const original = `${Array.from({ length: 260 }, (_, index) => `line ${index}`).join("\n")}\n`;
			const lines = Array.from({ length: 260 }, (_, index) => `line ${index}`);
			lines[5] = "changed early";
			lines[240] = "changed late";
			const { dir, hashes } = await history([
				{
					message: "initial",
					files: [{ path: "old-plan.md", content: original }],
				},
				{
					message: "rename and revise",
					files: [{ path: "new plan.md", content: `${lines.join("\n")}\n` }],
				},
			]);
			const previous = hashes[0] ?? "";
			const current = hashes[1] ?? "";
			const context = await buildPlanReviewDiffContext({
				workdir: dir,
				planPath: join(dir, "new plan.md"),
				previousReviewCommit: previous,
				currentCommit: current,
			});
			expect(context.planPath).toBe("new plan.md");
			expect(context.hunks.length).toBeGreaterThanOrEqual(2);
			const rendered = formatPlanReviewDiffContext(context, 12);
			expect(rendered).toContain("Omitted hunk headers:");
			expect(rendered).toContain("git diff");
			expect(rendered).toContain("':(top)new plan.md'");
		},
		{ timeout: 15000 },
	);

	test.serial(
		"limits equivalent endpoints to the last plan-touching commit and later artifacts",
		async () => {
			const { dir, hashes } = await history([
				{
					message: "initial",
					files: [{ path: "plan.md", content: "base\n" }],
				},
				{
					message: "first plan revision",
					files: [{ path: "plan.md", content: "first revision\n" }],
				},
				{
					message: "first artifact",
					files: [
						{ path: "plan.md", content: "first revision\n" },
						{ path: "review-1.md", content: "first artifact\n" },
					],
				},
				{
					message: "final plan revision",
					files: [
						{ path: "plan.md", content: "final revision\n" },
						{ path: "review-1.md", content: "first artifact\n" },
					],
				},
				{
					message: "second artifact",
					files: [
						{ path: "plan.md", content: "final revision\n" },
						{ path: "review-1.md", content: "first artifact\n" },
						{ path: "review-2.md", content: "second artifact\n" },
					],
				},
				{
					message: "third artifact",
					files: [
						{ path: "plan.md", content: "final revision\n" },
						{ path: "review-1.md", content: "first artifact\n" },
						{ path: "review-2.md", content: "second artifact\n" },
						{ path: "review-3.md", content: "third artifact\n" },
					],
				},
			]);
			const previous = hashes[0] ?? "";
			const firstPlanCommit = hashes[1] ?? "";
			const firstArtifactCommit = hashes[2] ?? "";
			const lastPlanCommit = hashes[3] ?? "";
			const secondArtifactCommit = hashes[4] ?? "";
			const current = hashes[5] ?? "";

			const context = await buildPlanReviewDiffContext({
				workdir: dir,
				planPath: join(dir, "plan.md"),
				previousReviewCommit: previous,
				currentCommit: current,
			});
			expect(context.equivalentPlanCommits).toEqual([
				lastPlanCommit,
				secondArtifactCommit,
				current,
			]);
			expect(context.equivalentPlanCommits).not.toContain(firstPlanCommit);
			expect(context.equivalentPlanCommits).not.toContain(firstArtifactCommit);
		},
		{ timeout: 15000 },
	);

	test.serial(
		"returns an empty text context for no plan change and rejects binary plans",
		async () => {
			const { dir, hashes } = await history([
				{
					message: "initial",
					files: [{ path: "plan.md", content: "unchanged\n" }],
				},
				{
					message: "artifact",
					files: [
						{ path: "plan.md", content: "unchanged\n" },
						{ path: "notes.md", content: "artifact only\n" },
					],
				},
				{
					message: "binary plan",
					files: [
						{
							path: "plan.md",
							content: Buffer.from([0, 1, 2, 3, 0, 4]),
						},
						{ path: "notes.md", content: "artifact only\n" },
					],
				},
			]);
			const previous = hashes[0] ?? "";
			const artifact = hashes[1] ?? "";
			const binary = hashes[2] ?? "";
			const unchanged = await buildPlanReviewDiffContext({
				workdir: dir,
				planPath: join(dir, "plan.md"),
				previousReviewCommit: previous,
				currentCommit: artifact,
			});
			expect(unchanged.patch).toBe("");
			expect(unchanged.hunks).toEqual([]);

			await expect(
				buildPlanReviewDiffContext({
					workdir: dir,
					planPath: join(dir, "plan.md"),
					previousReviewCommit: artifact,
					currentCommit: binary,
				}),
			).rejects.toMatchObject({ code: "PLAN_DIFF_BINARY_UNSUPPORTED" });
		},
		{ timeout: 15000 },
	);
});
