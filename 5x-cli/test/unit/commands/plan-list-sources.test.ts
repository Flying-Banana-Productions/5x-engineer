import { expect, test } from "bun:test";
import {
	formatPlanListSources,
	type PlanListEntry,
} from "../../../src/commands/plan-v1.handler.js";

function plan(overrides: Partial<PlanListEntry> = {}): PlanListEntry {
	return {
		plan_path: "docs/plans/example.md",
		name: "example",
		file: "example.md",
		title: "Example",
		status: "incomplete",
		completion_pct: 0,
		phases_done: 0,
		phases_total: 1,
		active_run: null,
		runs_total: 0,
		source: "HEAD",
		...overrides,
	};
}

test("local working copies retain dirty state without repeating paths", () => {
	expect(
		formatPlanListSources([
			plan({ source_kind: "working-copy", source_path: "/long/local/path.md" }),
			plan({ source_kind: "working-copy", source_dirty: true }),
			plan(),
			plan({ source: "diverged", diverged: true }),
		]),
	).toEqual({
		labels: ["local (clean)", "local (dirty)", "HEAD", "diverged"],
		details: [],
	});
});

test("worktrees and long refs share stable numbered details in row order", () => {
	const ref = `origin/5x/${"long-feature-name-".repeat(4)}`;
	const worktree = {
		source: "worktree",
		source_kind: "working-copy" as const,
		source_path: "/very/long/worktree/docs/plans/example.md",
	};
	const plans = [
		plan(worktree),
		plan({ source: ref, source_kind: "git-ref" }),
		plan({
			...worktree,
			plan_path: "docs/plans/other.md",
			source_path: "/very/long/worktree/docs/plans/other.md",
			source_dirty: true,
		}),
		plan({ source: ref }),
		plan({
			...worktree,
			source_path: "/another/worktree/docs/plans/example.md",
		}),
		plan({ source: "x".repeat(32) }),
	];
	const before = JSON.stringify(plans);
	expect(formatPlanListSources(plans)).toEqual({
		labels: [
			"worktree [1] (clean)",
			"ref [2]",
			"worktree [1] (dirty)",
			"ref [2]",
			"worktree [3] (clean)",
			"x".repeat(32),
		],
		details: ["/very/long/worktree", ref, "/another/worktree"],
	});
	expect(JSON.stringify(plans)).toBe(before);
});

test("worktree paths without a matching plan suffix remain identifiable", () => {
	expect(
		formatPlanListSources([
			plan({
				source: "worktree",
				source_kind: "working-copy",
				source_path: "/external/plan.md",
			}),
		]),
	).toEqual({
		labels: ["worktree [1] (clean)"],
		details: ["/external/plan.md"],
	});
});
