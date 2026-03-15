/**
 * Run execution context resolver.
 *
 * Given a run ID, resolves the effective working directory and plan path
 * by looking up the run's plan_path, finding the plan's worktree mapping,
 * and deriving a worktree-relative plan path when applicable.
 *
 * This module is the single source of truth for run-scoped context
 * resolution. All commands with `--run` should use this resolver to
 * derive both effective working directory and effective plan path.
 *
 * Context precedence (strict):
 * 1. Explicit CLI override (e.g. `--workdir`) wins.
 * 2. If run has mapped worktree, use mapped worktree.
 * 3. Fallback to controlPlaneRoot (current behavior).
 */

import type { Database } from "bun:sqlite";
import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunExecutionContext {
	/** Control-plane root (where the DB and state live). */
	controlPlaneRoot: string;
	/** Basic run info. */
	run: {
		id: string;
		plan_path: string;
		status: string;
	};
	/** Mapped worktree path from the plan, or null. */
	mappedWorktreePath: string | null;
	/** Effective directory to run commands in. */
	effectiveWorkingDirectory: string;
	/** Effective plan path (may be re-rooted into worktree). */
	effectivePlanPath: string;
	/** Whether the plan file exists at the worktree location. */
	planPathInWorktreeExists: boolean;
}

export type RunContextErrorCode =
	| "RUN_NOT_FOUND"
	| "PLAN_PATH_INVALID"
	| "WORKTREE_MISSING";

export interface RunContextError {
	code: RunContextErrorCode;
	message: string;
	detail?: {
		path?: string;
		remediation?: string;
	};
}

export type RunContextResult =
	| { ok: true; context: RunExecutionContext }
	| { ok: false; error: RunContextError };

// ---------------------------------------------------------------------------
// Row types (minimal — only what we need from DB)
// ---------------------------------------------------------------------------

interface RunRow {
	id: string;
	plan_path: string;
	status: string;
}

interface PlanRow {
	plan_path: string;
	worktree_path: string | null;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the execution context for a run-scoped command.
 *
 * @param db - Open database connection (control-plane DB)
 * @param runId - Run ID to resolve
 * @param opts.controlPlaneRoot - Resolved control-plane root path
 * @param opts.explicitWorkdir - Explicit `--workdir` override (wins over mapping)
 */
export function resolveRunExecutionContext(
	db: Database,
	runId: string,
	opts: {
		controlPlaneRoot: string;
		explicitWorkdir?: string;
	},
): RunContextResult {
	const { controlPlaneRoot, explicitWorkdir } = opts;

	// 1. Look up the run
	const run = db
		.query("SELECT id, plan_path, status FROM runs WHERE id = ?1")
		.get(runId) as RunRow | null;

	if (!run) {
		return {
			ok: false,
			error: {
				code: "RUN_NOT_FOUND",
				message: `Run "${runId}" not found.`,
			},
		};
	}

	// 2. Validate plan_path is under controlPlaneRoot
	const planPath = run.plan_path;
	if (!isPathUnder(planPath, controlPlaneRoot)) {
		return {
			ok: false,
			error: {
				code: "PLAN_PATH_INVALID",
				message: `Run plan path is outside the control-plane root.`,
				detail: {
					path: planPath,
					remediation:
						"Move the plan under the repository root, or re-create the run with a valid plan path.",
				},
			},
		};
	}

	// 3. Look up the plan's worktree mapping
	const plan = db
		.query("SELECT plan_path, worktree_path FROM plans WHERE plan_path = ?1")
		.get(planPath) as PlanRow | null;

	const mappedWorktreePath = plan?.worktree_path ?? null;

	// 4. Apply context precedence
	if (explicitWorkdir) {
		// Explicit --workdir wins
		return {
			ok: true,
			context: {
				controlPlaneRoot,
				run: { id: run.id, plan_path: run.plan_path, status: run.status },
				mappedWorktreePath,
				effectiveWorkingDirectory: explicitWorkdir,
				effectivePlanPath: planPath,
				planPathInWorktreeExists: false,
			},
		};
	}

	if (mappedWorktreePath) {
		// Check worktree accessibility
		if (!isAccessible(mappedWorktreePath)) {
			return {
				ok: false,
				error: {
					code: "WORKTREE_MISSING",
					message: `Mapped worktree is missing or unreadable.`,
					detail: {
						path: mappedWorktreePath,
						remediation:
							"Re-attach the worktree or remove the mapping with `5x worktree remove`.",
					},
				},
			};
		}

		// Derive worktree-relative plan path
		const relPlanPath = relative(controlPlaneRoot, planPath);
		const worktreePlanPath = join(mappedWorktreePath, relPlanPath);
		const planPathInWorktreeExists = existsSync(worktreePlanPath);

		return {
			ok: true,
			context: {
				controlPlaneRoot,
				run: { id: run.id, plan_path: run.plan_path, status: run.status },
				mappedWorktreePath,
				effectiveWorkingDirectory: mappedWorktreePath,
				effectivePlanPath: worktreePlanPath,
				planPathInWorktreeExists,
			},
		};
	}

	// 5. No mapping — fallback to controlPlaneRoot
	return {
		ok: true,
		context: {
			controlPlaneRoot,
			run: { id: run.id, plan_path: run.plan_path, status: run.status },
			mappedWorktreePath: null,
			effectiveWorkingDirectory: controlPlaneRoot,
			effectivePlanPath: planPath,
			planPathInWorktreeExists: false,
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if `childPath` is a descendant of `parentPath`.
 * Both paths should be absolute.
 */
function isPathUnder(childPath: string, parentPath: string): boolean {
	// Handle relative paths stored in DB (legacy data)
	if (!isAbsolute(childPath)) return false;
	const rel = relative(parentPath, childPath);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

/** Check if a directory is accessible (exists and readable). */
function isAccessible(dirPath: string): boolean {
	try {
		accessSync(dirPath, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
