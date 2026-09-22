import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPlanReviewDiffContext,
	formatPlanReviewDiffContext,
	validateIntroducedBy,
} from "../../src/review-governance/plan-diff.js";
import { cleanGitEnv } from "../helpers/clean-env.js";

const dirs: string[] = [];

afterAll(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function commit(cwd: string, message: string): string {
	git(cwd, "add", "-A");
	git(
		cwd,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-m",
		message,
	);
	return git(cwd, "rev-parse", "HEAD");
}

describe("plan-only review diff evidence", () => {
	test(
		"accepts a pre-artifact end commit with an equivalent plan patch and exact hunk",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "5x-plan-diff-"));
			dirs.push(dir);
			git(dir, "init");
			writeFileSync(join(dir, "plan.md"), "# Plan\n\nold\n");
			const previous = commit(dir, "initial");
			writeFileSync(join(dir, "plan.md"), "# Plan\n\nnew\n");
			const planCommit = commit(dir, "revise plan");
			writeFileSync(join(dir, "review.md"), "review artifact\n");
			const artifactCommit = commit(dir, "add review");

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

	test(
		"tracks renamed plans and documents omitted hunk retrieval",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "5x-plan-rename-"));
			dirs.push(dir);
			git(dir, "init");
			writeFileSync(
				join(dir, "old-plan.md"),
				`${Array.from({ length: 260 }, (_, index) => `line ${index}`).join("\n")}\n`,
			);
			const previous = commit(dir, "initial");
			git(dir, "mv", "old-plan.md", "new plan.md");
			const lines = Array.from({ length: 260 }, (_, index) => `line ${index}`);
			lines[5] = "changed early";
			lines[240] = "changed late";
			writeFileSync(join(dir, "new plan.md"), `${lines.join("\n")}\n`);
			const current = commit(dir, "rename and revise");
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
			expect(rendered).toContain("'new plan.md'");
		},
		{ timeout: 15000 },
	);

	test(
		"returns an empty text context for no plan change and rejects binary plans",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "5x-plan-binary-"));
			dirs.push(dir);
			git(dir, "init");
			writeFileSync(join(dir, "plan.md"), "unchanged\n");
			const previous = commit(dir, "initial");
			writeFileSync(join(dir, "notes.md"), "artifact only\n");
			const artifact = commit(dir, "artifact");
			const unchanged = await buildPlanReviewDiffContext({
				workdir: dir,
				planPath: join(dir, "plan.md"),
				previousReviewCommit: previous,
				currentCommit: artifact,
			});
			expect(unchanged.patch).toBe("");
			expect(unchanged.hunks).toEqual([]);

			writeFileSync(join(dir, "plan.md"), Buffer.from([0, 1, 2, 3, 0, 4]));
			const binary = commit(dir, "binary plan");
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
