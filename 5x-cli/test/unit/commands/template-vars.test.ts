/**
 * Unit tests for template-vars helpers.
 *
 * Phase 1, 022-orchestration-reliability: checkReviewPathMismatch warning.
 * Phase 1 review fix (P2.1): review-path re-rooting with worktreeRoot.
 */

import { describe, expect, test } from "bun:test";
import {
	checkReviewPathMismatch,
	isPlanReviewTemplate,
	resolveInternalTemplateVariables,
} from "../../../src/commands/template-vars.js";
import type { FiveXConfig } from "../../../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
	overrides: Partial<FiveXConfig["paths"]> = {},
): Pick<FiveXConfig, "paths"> {
	return {
		paths: {
			plans: "/project/docs/development",
			reviews: "/project/docs/development/reviews",
			archive: "/project/docs/archive",
			templates: {
				plan: "/project/docs/_implementation_plan_template.md",
				review: "/project/docs/development/reviews/_review_template.md",
			},
			...overrides,
		},
	};
}

// ---------------------------------------------------------------------------
// isPlanReviewTemplate
// ---------------------------------------------------------------------------

describe("isPlanReviewTemplate", () => {
	test("returns true for reviewer-plan", () => {
		expect(isPlanReviewTemplate("reviewer-plan")).toBe(true);
	});

	test("returns true for reviewer-plan-continued", () => {
		expect(isPlanReviewTemplate("reviewer-plan-continued")).toBe(true);
	});

	test("returns true for author-process-plan-review", () => {
		expect(isPlanReviewTemplate("author-process-plan-review")).toBe(true);
	});

	test("returns false for reviewer-commit", () => {
		expect(isPlanReviewTemplate("reviewer-commit")).toBe(false);
	});

	test("returns false for author-next-phase", () => {
		expect(isPlanReviewTemplate("author-next-phase")).toBe(false);
	});

	test("returns false for author-process-impl-review", () => {
		expect(isPlanReviewTemplate("author-process-impl-review")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// checkReviewPathMismatch
// ---------------------------------------------------------------------------

describe("checkReviewPathMismatch", () => {
	const projectRoot = "/project";

	test("returns null when explicit path is in configured review directory", () => {
		const config = makeConfig();
		const result = checkReviewPathMismatch(
			"/project/docs/development/reviews/my-review.md",
			"reviewer-plan",
			config,
			projectRoot,
		);
		expect(result).toBeNull();
	});

	test("returns warning when explicit path is outside configured review directory", () => {
		const config = makeConfig();
		const result = checkReviewPathMismatch(
			"/project/docs/development/wrong-place.md",
			"reviewer-plan",
			config,
			projectRoot,
		);
		expect(result).not.toBeNull();
		expect(result).toContain("resolves outside configured review directory");
		expect(result).toContain("Omit --var review_path");
	});

	test("plan-review template uses planReviews config when set", () => {
		const config = makeConfig({
			planReviews: "/project/plan-reviews",
		});

		// Path in planReviews → no warning
		const noWarning = checkReviewPathMismatch(
			"/project/plan-reviews/my-review.md",
			"reviewer-plan",
			config,
			projectRoot,
		);
		expect(noWarning).toBeNull();

		// Path in default reviews (not planReviews) → warning
		const warning = checkReviewPathMismatch(
			"/project/docs/development/reviews/my-review.md",
			"reviewer-plan",
			config,
			projectRoot,
		);
		expect(warning).not.toBeNull();
		expect(warning).toContain("resolves outside configured review directory");
	});

	test("plan-review template falls back to reviews when planReviews not set", () => {
		const config = makeConfig();

		// Path in default reviews → no warning
		const result = checkReviewPathMismatch(
			"/project/docs/development/reviews/my-review.md",
			"reviewer-plan",
			config,
			projectRoot,
		);
		expect(result).toBeNull();
	});

	test("impl-review template uses runReviews config when set", () => {
		const config = makeConfig({
			runReviews: "/project/run-reviews",
		});

		// Path in runReviews → no warning
		const noWarning = checkReviewPathMismatch(
			"/project/run-reviews/my-review.md",
			"reviewer-commit",
			config,
			projectRoot,
		);
		expect(noWarning).toBeNull();

		// Path in default reviews (not runReviews) → warning
		const warning = checkReviewPathMismatch(
			"/project/docs/development/reviews/my-review.md",
			"reviewer-commit",
			config,
			projectRoot,
		);
		expect(warning).not.toBeNull();
	});

	test("impl-review template falls back to reviews when runReviews not set", () => {
		const config = makeConfig();

		// Path in default reviews → no warning for reviewer-commit
		const result = checkReviewPathMismatch(
			"/project/docs/development/reviews/my-review.md",
			"reviewer-commit",
			config,
			projectRoot,
		);
		expect(result).toBeNull();
	});

	test("resolves relative paths against projectRoot", () => {
		const config = makeConfig();

		// Relative path that resolves to the configured directory
		const noWarning = checkReviewPathMismatch(
			"docs/development/reviews/my-review.md",
			"reviewer-plan",
			config,
			projectRoot,
		);
		expect(noWarning).toBeNull();

		// Relative path outside configured directory
		const warning = checkReviewPathMismatch(
			"docs/development/wrong-place.md",
			"reviewer-plan",
			config,
			projectRoot,
		);
		expect(warning).not.toBeNull();
	});

	test("warning includes the explicit path and configured directory", () => {
		const config = makeConfig();
		const result = checkReviewPathMismatch(
			"/other/dir/review.md",
			"reviewer-plan",
			config,
			projectRoot,
		);
		expect(result).not.toBeNull();
		expect(result).toContain("/other/dir/review.md");
	});
});

// ---------------------------------------------------------------------------
// resolveInternalTemplateVariables — review-path re-rooting
// ---------------------------------------------------------------------------

describe("resolveInternalTemplateVariables — review-path re-rooting", () => {
	const projectRoot = "/project";

	test("review_path without worktreeRoot resolves under projectRoot", () => {
		const config = makeConfig();
		const vars = resolveInternalTemplateVariables(
			["review_path"],
			{},
			config,
			projectRoot,
			"reviewer-plan",
			"run_abc123",
			undefined,
			"/project/docs/development/my-plan.md",
		);

		// Should resolve under the configured reviews directory (projectRoot-relative)
		expect(vars.review_path).toBeDefined();
		expect(vars.review_path).toContain("review.md");
		expect(vars.review_path).not.toContain(".5x/worktrees");
	});

	test("review_path with worktreeRoot is re-rooted to worktree", () => {
		const config = makeConfig();
		const worktreeRoot = "/project/.5x/worktrees/feature";
		const vars = resolveInternalTemplateVariables(
			["review_path"],
			{},
			config,
			projectRoot,
			"reviewer-plan",
			"run_abc123",
			undefined,
			"/project/docs/development/my-plan.md",
			worktreeRoot,
		);

		expect(vars.review_path).toBeDefined();
		// Should be re-rooted: /project/.5x/worktrees/feature/docs/development/reviews/...
		expect(vars.review_path).toStartWith(worktreeRoot);
		expect(vars.review_path).toContain("docs/development/reviews/");
		expect(vars.review_path).toContain("review.md");
	});

	test("plan-review with worktreeRoot re-roots planReviews path", () => {
		const config = makeConfig({
			planReviews: "/project/docs/development/plan-reviews",
		});
		const worktreeRoot = "/project/.5x/worktrees/feature";
		const vars = resolveInternalTemplateVariables(
			["review_path"],
			{},
			config,
			projectRoot,
			"reviewer-plan",
			"run_abc123",
			undefined,
			"/project/docs/development/my-plan.md",
			worktreeRoot,
		);

		expect(vars.review_path).toBeDefined();
		expect(vars.review_path).toStartWith(worktreeRoot);
		expect(vars.review_path).toContain("docs/development/plan-reviews/");
	});

	test("explicit review_path is NOT re-rooted (explicit always wins)", () => {
		const config = makeConfig();
		const worktreeRoot = "/project/.5x/worktrees/feature";
		const explicitPath = "/project/custom/review.md";
		const vars = resolveInternalTemplateVariables(
			["review_path"],
			{ review_path: explicitPath },
			config,
			projectRoot,
			"reviewer-plan",
			"run_abc123",
			undefined,
			"/project/docs/development/my-plan.md",
			worktreeRoot,
		);

		// Explicit review_path should be preserved as-is
		expect(vars.review_path).toBe(explicitPath);
	});

	test("impl-review review_path with worktreeRoot is re-rooted", () => {
		const config = makeConfig();
		const worktreeRoot = "/project/.5x/worktrees/feature";
		const vars = resolveInternalTemplateVariables(
			["review_path"],
			{},
			config,
			projectRoot,
			"reviewer-commit",
			"run_abc123",
			"2",
			"/project/docs/development/my-plan.md",
			worktreeRoot,
		);

		expect(vars.review_path).toBeDefined();
		expect(vars.review_path).toStartWith(worktreeRoot);
		expect(vars.review_path).toContain("run_abc123-phase-2-review.md");
	});

	test("run_id variable is populated when runId is provided", () => {
		const config = makeConfig();
		const vars = resolveInternalTemplateVariables(
			[],
			{},
			config,
			projectRoot,
			"author-next-phase",
			"run_xyz789",
		);

		expect(vars.run_id).toBe("run_xyz789");
	});

	test("run_id variable is absent when runId is not provided", () => {
		const config = makeConfig();
		const vars = resolveInternalTemplateVariables(
			[],
			{},
			config,
			projectRoot,
			"author-next-phase",
		);

		expect(vars.run_id).toBeUndefined();
	});
});
