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
		.description("Plan inspection operations");

	plan
		.command("phases")
		.summary("Parse a plan and return its phases")
		.description("Parse a plan and return its phases")
		.argument("<path>", "Path to implementation plan")
		.action(async (path) => {
			await planPhases({ path });
		});
}
