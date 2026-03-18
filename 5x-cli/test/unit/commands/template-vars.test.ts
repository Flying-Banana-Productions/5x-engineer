/**
 * Unit tests for template-vars helpers.
 *
 * Phase 1, 022-orchestration-reliability: checkReviewPathMismatch warning.
 */

import { describe, expect, test } from "bun:test";
import {
	checkReviewPathMismatch,
	isPlanReviewTemplate,
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
