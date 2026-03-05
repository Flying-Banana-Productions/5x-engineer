/**
 * v1 Plan inspection command.
 *
 * `5x plan phases <path>`
 *
 * Parses a plan markdown file and returns its phases with
 * checklist completion status as a JSON envelope.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { outputError, outputSuccess } from "../output.js";
import { parsePlan } from "../parsers/plan.js";

const phasesCmd = defineCommand({
	meta: {
		name: "phases",
		description: "Parse a plan and return its phases",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan",
			required: true,
		},
	},
	async run({ args }) {
		const planPath = resolve(args.path);

		if (!existsSync(planPath)) {
			outputError("PLAN_NOT_FOUND", `Plan file not found: ${planPath}`);
		}

		const markdown = readFileSync(planPath, "utf-8");
		const plan = parsePlan(markdown);

		outputSuccess({
			phases: plan.phases.map((p) => ({
				id: p.number,
				title: p.title,
				done: p.isComplete,
				checklist_total: p.items.length,
				checklist_done: p.items.filter((i) => i.checked).length,
			})),
		});
	},
});

export default defineCommand({
	meta: {
		name: "plan",
		description: "Plan inspection operations",
	},
	subCommands: {
		phases: () => Promise.resolve(phasesCmd),
	},
});
