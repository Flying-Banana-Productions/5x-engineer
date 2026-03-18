/**
 * Session continuity validation for agent invocations.
 *
 * When `continuePhaseSessions` is enabled for a role, enforce that
 * subsequent steps in the same (run, step_name, phase) group either
 * resume an existing session (--session) or explicitly start fresh
 * (--new-session).
 */

import type { Database } from "bun:sqlite";
import type { FiveXConfig } from "../config.js";
import { outputError } from "../output.js";
import { loadTemplate } from "../templates/loader.js";
import { isPlanReviewTemplate } from "./template-vars.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionCheckOptions {
	templateName: string;
	session?: string;
	newSession?: boolean;
	runId?: string;
	db?: Database;
	config: Pick<FiveXConfig, "author" | "reviewer">;
	explicitVars?: Record<string, string>;
}

type Role = "author" | "reviewer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the role from a template's step_name prefix.
 * `reviewer:*` → "reviewer", `author:*` → "author", else undefined.
 */
function inferRole(stepName: string | null): Role | undefined {
	if (!stepName) return undefined;
	if (stepName.startsWith("reviewer:")) return "reviewer";
	if (stepName.startsWith("author:")) return "author";
	return undefined;
}

/**
 * Derive the phase for session scoping.
 * Plan-review templates → "plan"; otherwise use explicit phase_number.
 */
function derivePhase(
	templateName: string,
	explicitVars?: Record<string, string>,
): string | null {
	if (isPlanReviewTemplate(templateName)) return "plan";
	return explicitVars?.phase_number ?? null;
}

/**
 * Count prior steps matching (run_id, step_name, phase) in the DB.
 */
function countPriorSteps(
	db: Database,
	runId: string,
	stepName: string,
	phase: string,
): number {
	const row = db
		.query(
			`SELECT COUNT(*) AS cnt FROM steps WHERE run_id = ?1 AND step_name = ?2 AND phase IS ?3`,
		)
		.get(runId, stepName, phase) as { cnt: number } | null;
	return row?.cnt ?? 0;
}

/**
 * Attempt to load a continued template variant. Returns true if it exists.
 */
function continuedTemplateExists(templateName: string): boolean {
	const continuedName = `${templateName}-continued`;
	try {
		loadTemplate(continuedName);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

/**
 * Validate session continuity constraints.
 *
 * When `continuePhaseSessions` is enabled for the role and prior steps
 * exist for the same (run, step_name, phase), enforce that the caller
 * provides either `--session` or `--new-session`.
 *
 * Throws via `outputError()` on validation failures.
 */
export function validateSessionContinuity(opts: SessionCheckOptions): void {
	const { templateName, session, newSession, runId, db, config, explicitVars } =
		opts;

	// 1. Mutual exclusivity
	if (session && newSession) {
		outputError(
			"INVALID_ARGS",
			"--session and --new-session are mutually exclusive. Use one or the other.",
		);
	}

	// 2. Early exit if no run context
	if (!runId || !db) return;

	// 3. Load template metadata for role inference
	let stepName: string | null;
	try {
		const loaded = loadTemplate(templateName);
		stepName = loaded.metadata.stepName;
	} catch {
		// Template doesn't exist — let downstream handle the error
		return;
	}

	const role = inferRole(stepName);
	if (!role) return;

	// 4. Check config flag
	if (!config[role].continuePhaseSessions) return;

	// 5. Derive phase
	const phase = derivePhase(templateName, explicitVars);
	if (!phase) return; // Can't scope the check

	// 6. Query prior steps
	const priorCount = countPriorSteps(db, runId, stepName as string, phase);
	if (priorCount === 0) return; // First step — no enforcement

	// 7. Prior steps exist — enforce
	if (newSession) {
		// --new-session is the recovery escape hatch — always uses full template,
		// no continued-template requirement
		return;
	}

	if (session) {
		// Verify continued template exists
		if (!continuedTemplateExists(templateName)) {
			outputError(
				"TEMPLATE_NOT_FOUND",
				`${role}.continuePhaseSessions is enabled and prior "${stepName}" steps exist for phase "${phase}", but no "${templateName}-continued" template was found.`,
			);
		}
		// Valid resumption
		return;
	}

	// Neither --session nor --new-session provided
	if (!continuedTemplateExists(templateName)) {
		outputError(
			"TEMPLATE_NOT_FOUND",
			`${role}.continuePhaseSessions is enabled and prior "${stepName}" steps exist for phase "${phase}", but no "${templateName}-continued" template was found.`,
		);
	}

	outputError(
		"SESSION_REQUIRED",
		`Template "${templateName}" has session continuity enabled and prior "${stepName}" steps exist for run "${runId}" phase "${phase}". Pass --session <id> to continue or --new-session to start fresh.`,
	);
}
