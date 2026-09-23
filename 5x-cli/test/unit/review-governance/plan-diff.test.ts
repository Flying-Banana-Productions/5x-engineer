import { describe, expect, test } from "bun:test";
import {
	formatPlanReviewDiffContext,
	formatPlanReviewDiffFailure,
	validateIntroducedBy,
} from "../../../src/review-governance/plan-diff.js";
import type { PlanDiffContext } from "../../../src/review-governance/types.js";

const context: PlanDiffContext = {
	previousReviewCommit: "abc1111111111111111111111111111111111111",
	currentPlanCommit: "def2222222222222222222222222222222222222",
	planPath: "docs/plan.md",
	patch: "@@ -1 +1 @@\n-old\n+new",
	hunks: [
		{
			header: "@@ -1 +1 @@",
			text: "@@ -1 +1 @@\n-old\n+new",
			hash: "sha256:hunk",
		},
	],
	equivalentPlanCommits: ["def2222222222222222222222222222222222222"],
};

describe("validateIntroducedBy", () => {
	test("reports missing context and stale ranges with stable diagnostics", () => {
		const evidence = {
			commitRange: "abc1111..def2222",
			diffHunk: context.hunks[0]?.text ?? "",
			explanation: "The changed line introduces the failure.",
		};
		expect(validateIntroducedBy(evidence, undefined)).toMatchObject({
			valid: false,
			code: "PLAN_DIFF_CONTEXT_MISSING",
		});
		expect(
			validateIntroducedBy(
				{ ...evidence, commitRange: "9999999..def2222" },
				context,
			),
		).toMatchObject({ valid: false, code: "INTRODUCED_RANGE_MISMATCH" });
	});

	test("rejects ambiguous abbreviated endpoints", () => {
		const ambiguous: PlanDiffContext = {
			...context,
			currentPlanCommit: "def2222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			equivalentPlanCommits: [
				"def2222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"def2222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			],
		};
		expect(
			validateIntroducedBy(
				{
					commitRange: "abc1111..def2222",
					diffHunk: ambiguous.hunks[0]?.text ?? "",
					explanation: "Ambiguous end.",
				},
				ambiguous,
			),
		).toMatchObject({ valid: false, code: "INTRODUCED_RANGE_MISMATCH" });
	});

	test("normalizes only line endings and trailing whitespace", () => {
		const valid = validateIntroducedBy(
			{
				commitRange: "abc1111..def2222",
				diffHunk: "@@ -1 +1 @@  \r\n-old\r\n+new\t\r\n",
				explanation: "Transport-only differences.",
			},
			context,
		);
		expect(valid).toEqual({ valid: true, hunkHash: "sha256:hunk" });
		expect(
			validateIntroducedBy(
				{
					commitRange: "abc1111..def2222",
					diffHunk: "@@ -1 +1 @@\n+new\n-old",
					explanation: "Reordered lines are not transport normalization.",
				},
				context,
			),
		).toMatchObject({
			valid: false,
			code: "INTRODUCED_HUNK_NOT_FOUND",
			closestHunkHeader: "@@ -1 +1 @@",
		});
	});

	test("renders every omitted header and the exact retrieval command", () => {
		const rendered = formatPlanReviewDiffContext(
			{
				...context,
				patch: "preamble\n@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-a\n+b",
				hunks: [
					context.hunks[0] as PlanDiffContext["hunks"][number],
					{
						header: "@@ -20 +20 @@",
						text: "@@ -20 +20 @@\n-a\n+b",
						hash: "sha256:late",
					},
				],
			},
			4,
		);
		expect(rendered).toContain("@@ -20 +20 @@");
		expect(rendered).toContain(
			"git diff abc1111111111111111111111111111111111111..def2222222222222222222222222222222222222 -- ':(top)docs/plan.md'",
		);
	});

	test("lists a hunk whose body straddles the truncation boundary", () => {
		const hunk = {
			header: "@@ -1,5 +1,5 @@",
			text: "@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four",
			hash: "sha256:straddled",
		};
		const rendered = formatPlanReviewDiffContext(
			{
				...context,
				patch: `diff --git a/docs/plan.md b/docs/plan.md\n${hunk.text}\nfooter`,
				hunks: [hunk],
			},
			5,
		);
		expect(rendered).toContain("Omitted hunk headers:");
		expect(rendered).toContain("- `@@ -1,5 +1,5 @@`");
	});

	test("renders plan-diff failures with their machine code and reason", () => {
		const rendered = formatPlanReviewDiffFailure({
			previousReviewCommit: "abc",
			currentCommit: "def",
			error: {
				code: "PLAN_DIFF_BINARY_UNSUPPORTED",
				message: "The plan diff is binary.",
			},
		});
		expect(rendered).toContain("## Plan Diff Since Last Review");
		expect(rendered).toContain("PLAN_DIFF_BINARY_UNSUPPORTED");
		expect(rendered).toContain("The plan diff is binary.");
	});
});
