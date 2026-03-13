import type { Database } from "bun:sqlite";
import { canonicalizePlanPath } from "../paths.js";

// --- Row types ---

export interface PlanRow {
	plan_path: string;
	worktree_path: string | null;
	branch: string | null;
	created_at: string;
	updated_at: string;
}

export interface RunRow {
	id: string;
	plan_path: string;
	status: string;
	config_json: string | null;
	created_at: string;
	updated_at: string;
}

export interface RunSummary {
	id: string;
	plan_path: string;
	status: string;
	created_at: string;
	updated_at: string;
	step_count: number;
}

export interface RunMetrics {
	run_id: string;
	total_agent_invocations: number;
	author_invocations: number;
	reviewer_invocations: number;
	total_tokens_in: number;
	total_tokens_out: number;
	total_cost_usd: number;
	total_duration_ms: number;
	quality_passed: number;
	quality_failed: number;
}

// --- Plans ---

/**
 * Upsert a plan record. Pass `worktreePath`/`branch` to set values.
 * Omit them (undefined) to preserve existing values.
 * Pass empty string `""` to explicitly clear them to NULL.
 */
export function upsertPlan(
	db: Database,
	plan: { planPath: string; worktreePath?: string; branch?: string },
): void {
	const canonical = canonicalizePlanPath(plan.planPath);
	// Distinguish "not provided" (undefined → preserve via COALESCE) from
	// "clear" (empty string → set NULL).
	const wt =
		plan.worktreePath === undefined
			? undefined // will be null in SQL → COALESCE preserves
			: plan.worktreePath === ""
				? null // explicit clear
				: plan.worktreePath;
	const br =
		plan.branch === undefined
			? undefined
			: plan.branch === ""
				? null
				: plan.branch;

	// When clearing, we must bypass COALESCE. Use a separate UPDATE path
	// for clarity: if the caller explicitly set a value (including null-clear),
	// use a direct assignment; otherwise COALESCE to preserve.
	const wtClear = plan.worktreePath !== undefined;
	const brClear = plan.branch !== undefined;

	if (wtClear || brClear) {
		// At least one field is being explicitly set/cleared.
		const wtSql = wtClear ? "?2" : "COALESCE(?2, worktree_path)";
		const brSql = brClear ? "?3" : "COALESCE(?3, branch)";
		db.query(
			`INSERT INTO plans (plan_path, worktree_path, branch, updated_at)
       VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT(plan_path) DO UPDATE SET
         worktree_path = ${wtSql},
         branch = ${brSql},
         updated_at = datetime('now')`,
		).run(canonical, wt ?? null, br ?? null);
	} else {
		db.query(
			`INSERT INTO plans (plan_path, worktree_path, branch, updated_at)
       VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT(plan_path) DO UPDATE SET
         worktree_path = COALESCE(?2, worktree_path),
         branch = COALESCE(?3, branch),
         updated_at = datetime('now')`,
		).run(canonical, null, null);
	}
}

export function getPlan(db: Database, planPath: string): PlanRow | null {
	return db
		.query("SELECT * FROM plans WHERE plan_path = ?1")
		.get(planPath) as PlanRow | null;
}

export function listPlansByWorktreePath(
	db: Database,
	worktreePath: string,
): PlanRow[] {
	return db
		.query("SELECT * FROM plans WHERE worktree_path = ?1 ORDER BY plan_path")
		.all(worktreePath) as PlanRow[];
}

// --- Runs ---

export function createRun(
	db: Database,
	run: { id: string; planPath: string },
): void {
	const canonical = canonicalizePlanPath(run.planPath);
	db.query(
		`INSERT INTO runs (id, plan_path)
     VALUES (?1, ?2)`,
	).run(run.id, canonical);
}

export function updateRunStatus(
	db: Database,
	runId: string,
	status: string,
	_state?: string,
	_phase?: string,
): void {
	db.query(
		`UPDATE runs SET
       status = ?1,
       updated_at = datetime('now')
     WHERE id = ?2`,
	).run(status, runId);
}

export function getActiveRun(db: Database, planPath: string): RunRow | null {
	return db
		.query(
			"SELECT * FROM runs WHERE plan_path = ?1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
		)
		.get(planPath) as RunRow | null;
}

export function getLatestRun(db: Database, planPath: string): RunRow | null {
	return db
		.query(
			"SELECT * FROM runs WHERE plan_path = ?1 ORDER BY rowid DESC LIMIT 1",
		)
		.get(planPath) as RunRow | null;
}

// --- Reporting ---

export function getRunHistory(
	db: Database,
	planPath?: string,
	limit: number = 20,
): RunSummary[] {
	if (planPath) {
		return db
			.query(
				`SELECT r.*,
           (SELECT COUNT(*) FROM steps WHERE run_id = r.id) as step_count
         FROM runs r WHERE r.plan_path = ?1
         ORDER BY r.created_at DESC LIMIT ?2`,
			)
			.all(planPath, limit) as RunSummary[];
	}
	return db
		.query(
			`SELECT r.*,
         (SELECT COUNT(*) FROM steps WHERE run_id = r.id) as step_count
       FROM runs r
       ORDER BY r.created_at DESC LIMIT ?1`,
		)
		.all(limit) as RunSummary[];
}

export function getRunMetrics(db: Database, runId: string): RunMetrics {
	const agentStats = db
		.query(
			`SELECT
         COUNT(*) as total,
         SUM(CASE WHEN step_name LIKE 'author:%' THEN 1 ELSE 0 END) as authors,
         SUM(CASE WHEN step_name LIKE 'reviewer:%' THEN 1 ELSE 0 END) as reviewers,
         COALESCE(SUM(tokens_in), 0) as tokens_in,
         COALESCE(SUM(tokens_out), 0) as tokens_out,
         COALESCE(SUM(cost_usd), 0) as cost,
         COALESCE(SUM(duration_ms), 0) as duration
       FROM steps WHERE run_id = ?1
         AND (step_name LIKE 'author:%' OR step_name LIKE 'reviewer:%')`,
		)
		.get(runId) as {
		total: number;
		authors: number;
		reviewers: number;
		tokens_in: number;
		tokens_out: number;
		cost: number;
		duration: number;
	};

	const qualityStats = db
		.query(
			`SELECT
         COUNT(*) as total,
         SUM(CASE WHEN json_extract(result_json, '$.passed') = 1 THEN 1 ELSE 0 END) as passed,
         SUM(CASE WHEN json_extract(result_json, '$.passed') = 0 THEN 1 ELSE 0 END) as failed
       FROM steps WHERE run_id = ?1 AND step_name = 'quality:check'`,
		)
		.get(runId) as {
		total: number;
		passed: number | null;
		failed: number | null;
	};

	return {
		run_id: runId,
		total_agent_invocations: agentStats.total,
		author_invocations: agentStats.authors,
		reviewer_invocations: agentStats.reviewers,
		total_tokens_in: agentStats.tokens_in,
		total_tokens_out: agentStats.tokens_out,
		total_cost_usd: agentStats.cost,
		total_duration_ms: agentStats.duration,
		quality_passed: qualityStats.passed ?? 0,
		quality_failed: qualityStats.failed ?? 0,
	};
}
