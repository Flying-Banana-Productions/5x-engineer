/**
 * Plan inspection command handler — business logic for plan parsing.
 *
 * Framework-independent: no citty imports.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { outputError, outputSuccess } from "../output.js";
import { parsePlan } from "../parsers/plan.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface PlanPhasesParams {
	path: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function planPhases(params: PlanPhasesParams): Promise<void> {
	const planPath = resolve(params.path);

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
}
