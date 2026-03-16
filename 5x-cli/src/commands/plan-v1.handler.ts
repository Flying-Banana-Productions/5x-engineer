/**
 * Plan inspection command handler — business logic for plan parsing.
 *
 * Framework-independent: no CLI framework imports.
 *
 * When a plan has a mapped worktree, `plan phases` reads the plan from
 * the worktree copy (where checklist items get checked by the author
 * agent). This ensures phase completion status is accurate when
 * orchestrating from the repo root.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { outputError, outputSuccess } from "../output.js";
import { parsePlan } from "../parsers/plan.js";
import { resolveControlPlaneRoot } from "./control-plane.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface PlanPhasesParams {
	path: string;
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

/**
 * Human-readable text formatter for `plan phases` output.
 *
 * Renders a checklist with checkbox notation and progress counts.
 */
function formatPhasesText(data: Record<string, unknown>): void {
	const phases = data.phases as Array<{
		id: number;
		title: string;
		done: boolean;
		checklist_total: number;
		checklist_done: number;
	}>;

	if (!phases || phases.length === 0) {
		console.log("(no phases)");
		return;
	}

	console.log("Phases:");
	for (const phase of phases) {
		const check = phase.done ? "x" : " ";
		console.log(
			`  [${check}] Phase ${phase.id}: ${phase.title} (${phase.checklist_done}/${phase.checklist_total})`,
		);
	}
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function planPhases(params: PlanPhasesParams): Promise<void> {
	const planPath = resolve(params.path);

	if (!existsSync(planPath)) {
		outputError("PLAN_NOT_FOUND", `Plan file not found: ${planPath}`);
	}

	// Try to resolve the plan through worktree mapping
	const worktreePlanPath = resolveWorktreePlanPath(planPath);
	const effectivePath = worktreePlanPath ?? planPath;

	const markdown = readFileSync(effectivePath, "utf-8");
	const plan = parsePlan(markdown);

	const result: Record<string, unknown> = {
		phases: plan.phases.map((p) => ({
			id: p.number,
			title: p.title,
			done: p.isComplete,
			checklist_total: p.items.length,
			checklist_done: p.items.filter((i) => i.checked).length,
		})),
		filePaths: worktreePlanPath
			? { root: planPath, worktree: worktreePlanPath }
			: { root: planPath },
	};

	outputSuccess(result, formatPhasesText);
}

// ---------------------------------------------------------------------------
// Worktree plan path resolution
// ---------------------------------------------------------------------------

const DB_FILENAME = "5x.db";

/**
 * If the plan has a mapped worktree, return the path to the plan file
 * in the worktree (if it exists there). Returns null if no mapping,
 * no DB, or the worktree copy doesn't exist.
 */
function resolveWorktreePlanPath(planPath: string): string | null {
	try {
		const cp = resolveControlPlaneRoot();
		if (cp.mode === "none") return null;

		const dbPath = join(cp.controlPlaneRoot, cp.stateDir, DB_FILENAME);
		if (!existsSync(dbPath)) return null;

		const db = getDb(cp.controlPlaneRoot, join(cp.stateDir, DB_FILENAME));
		runMigrations(db);

		const plan = db
			.query("SELECT worktree_path FROM plans WHERE plan_path = ?1")
			.get(planPath) as { worktree_path: string | null } | null;

		const worktreePath = plan?.worktree_path;
		if (!worktreePath) return null;

		// Re-root the plan path into the worktree
		const relPlanPath = relative(cp.controlPlaneRoot, planPath);
		const worktreePlanPath = join(worktreePath, relPlanPath);

		if (!existsSync(worktreePlanPath)) return null;

		return worktreePlanPath;
	} catch {
		// Any failure in DB/control-plane resolution is non-fatal —
		// fall back to reading the plan at the given path.
		return null;
	}
}
