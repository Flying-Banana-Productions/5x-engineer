/**
 * v1 Plan inspection command — commander adapter.
 *
 * `5x plan phases <path>`
 *
 * Business logic lives in plan-v1.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { planPhases } from "./plan-v1.handler.js";

export function registerPlan(parent: Command) {
	const plan = parent
		.command("plan")
		.summary("Plan inspection operations")
		.description(
			"Inspect and parse implementation plans. Plans are markdown documents that\n" +
				"define phases of work for the 5x workflow.",
		);

	plan
		.command("phases")
		.summary("Parse a plan and return its phases")
		.description(
			"Read an implementation plan file and extract its phase structure. Returns an\n" +
				"array of phases with their names, descriptions, and step counts. If the plan\n" +
				"has a mapped worktree copy, 5x prefers that file when it exists.",
		)
		.argument("<path>", "Path to implementation plan")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x plan phases docs/development/015-test-separation.md\n" +
				"  $ 5x plan phases ./plan.md | jq '.data.phases[].name'\n" +
				"  PS> $j = 5x plan phases .\\plan.md | ConvertFrom-Json\n" +
				"  PS> $j.data.phases\n\n" +
				"If you are outside the control-plane repo or worktree mapping cannot be resolved,\n" +
				"use the worktree plan path from `5x run state` (for example `worktree_plan_path`).",
		)
		.action(async (path) => {
			await planPhases({ path });
		});
}
