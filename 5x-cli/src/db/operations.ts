import type { Database } from "bun:sqlite";
import type { StatusBlock, VerdictBlock } from "../parsers/signals.js";
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
	review_path: string | null;
	command: string;
	status: string;
	current_phase: string | null;
	current_state: string | null;
	started_at: string;
	completed_at: string | null;
}

export interface RunEventRow {
	id: number;
	run_id: string;
	event_type: string;
	phase: string | null;
	iteration: number | null;
	data: string | null;
	created_at: string;
}

export interface AgentResultRow {
	id: string;
	run_id: string;
	role: string;
	template_name: string;
	phase: string;
	iteration: number;
	exit_code: number;
	duration_ms: number;
	tokens_in: number | null;
	tokens_out: number | null;
	cost_usd: number | null;
	signal_type: string | null;
	signal_data: string | null;
	created_at: string;
}

export type AgentResultInput = Omit<AgentResultRow, "created_at">;

export interface QualityResultRow {
	id: string;
	run_id: string;
	phase: string;
	attempt: number;
	passed: number; // 0 or 1
	results: string; // JSON
	duration_ms: number;
	created_at: string;
}

export type QualityResultInput = Omit<QualityResultRow, "created_at">;

export interface RunSummary {
	id: string;
	plan_path: string;
	command: string;
	status: string;
	started_at: string;
	completed_at: string | null;
	current_phase: string | null;
	event_count: number;
	agent_count: number;
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

// --- Runs ---

export function createRun(
	db: Database,
	run: { id: string; planPath: string; command: string; reviewPath?: string },
): void {
	const canonical = canonicalizePlanPath(run.planPath);
	db.query(
		`INSERT INTO runs (id, plan_path, command, review_path)
     VALUES (?1, ?2, ?3, ?4)`,
	).run(run.id, canonical, run.command, run.reviewPath ?? null);
}

export function updateRunStatus(
	db: Database,
	runId: string,
	status: string,
	state?: string,
	phase?: string,
): void {
	db.query(
		`UPDATE runs SET
       status = ?1,
       current_state = COALESCE(?2, current_state),
       current_phase = COALESCE(?3, current_phase),
       completed_at = CASE WHEN ?1 IN ('completed','aborted','failed') THEN datetime('now') ELSE completed_at END
     WHERE id = ?4`,
	).run(status, state ?? null, phase ?? null, runId);
}

export function getActiveRun(db: Database, planPath: string): RunRow | null {
	return db
		.query(
			"SELECT * FROM runs WHERE plan_path = ?1 AND status = 'active' ORDER BY started_at DESC LIMIT 1",
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

// --- Events ---

export function appendRunEvent(
	db: Database,
	event: {
		runId: string;
		eventType: string;
		phase?: string;
		iteration?: number;
		data?: unknown;
	},
): void {
	db.query(
		`INSERT INTO run_events (run_id, event_type, phase, iteration, data)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
	).run(
		event.runId,
		event.eventType,
		event.phase ?? null,
		event.iteration ?? null,
		event.data != null ? JSON.stringify(event.data) : null,
	);
}

export function getRunEvents(db: Database, runId: string): RunEventRow[] {
	return db
		.query("SELECT * FROM run_events WHERE run_id = ?1 ORDER BY id ASC")
		.all(runId) as RunEventRow[];
}

/** Return only the most recent event for a run (optimized single-row fetch). */
export function getLastRunEvent(
	db: Database,
	runId: string,
): RunEventRow | null {
	return db
		.query(
			"SELECT * FROM run_events WHERE run_id = ?1 ORDER BY id DESC LIMIT 1",
		)
		.get(runId) as RunEventRow | null;
}

// --- Agent Results ---

/**
 * Upsert an agent result. The composite key (run_id, role, phase, iteration,
 * template_name) identifies the logical step. On conflict (resume), the row
 * is replaced entirely — including `id`, so the log file path tracks the
 * latest attempt.
 */
export function upsertAgentResult(
	db: Database,
	result: AgentResultInput,
): void {
	db.query(
		`INSERT INTO agent_results (id, run_id, role, template_name, phase, iteration,
       exit_code, duration_ms, tokens_in, tokens_out, cost_usd, signal_type, signal_data)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(run_id, role, phase, iteration, template_name) DO UPDATE SET
        id = excluded.id,
        exit_code = excluded.exit_code,
        duration_ms = excluded.duration_ms,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        cost_usd = excluded.cost_usd,
        signal_type = excluded.signal_type,
        signal_data = excluded.signal_data,
        created_at = datetime('now')`,
	).run(
		result.id,
		result.run_id,
		result.role,
		result.template_name,
		result.phase,
		result.iteration,
		result.exit_code,
		result.duration_ms,
		result.tokens_in ?? null,
		result.tokens_out ?? null,
		result.cost_usd ?? null,
		result.signal_type ?? null,
		result.signal_data ?? null,
	);
}

export function getAgentResults(
	db: Database,
	runId: string,
	phase?: string,
): AgentResultRow[] {
	if (phase !== undefined) {
		return db
			.query(
				"SELECT * FROM agent_results WHERE run_id = ?1 AND phase = ?2 ORDER BY iteration ASC",
			)
			.all(runId, phase) as AgentResultRow[];
	}
	return db
		.query(
			"SELECT * FROM agent_results WHERE run_id = ?1 ORDER BY phase ASC, iteration ASC",
		)
		.all(runId) as AgentResultRow[];
}

export function getLatestVerdict(
	db: Database,
	runId: string,
	phase: string,
): VerdictBlock | null {
	const row = db
		.query(
			`SELECT signal_data FROM agent_results
       WHERE run_id = ?1 AND phase = ?2 AND signal_type = 'verdict'
       ORDER BY iteration DESC LIMIT 1`,
		)
		.get(runId, phase) as { signal_data: string } | null;
	if (!row?.signal_data) return null;
	try {
		return JSON.parse(row.signal_data) as VerdictBlock;
	} catch {
		return null;
	}
}

export function getLatestStatus(
	db: Database,
	runId: string,
	phase: string,
): StatusBlock | null {
	const row = db
		.query(
			`SELECT signal_data FROM agent_results
       WHERE run_id = ?1 AND phase = ?2 AND signal_type = 'status'
       ORDER BY iteration DESC LIMIT 1`,
		)
		.get(runId, phase) as { signal_data: string } | null;
	if (!row?.signal_data) return null;
	try {
		return JSON.parse(row.signal_data) as StatusBlock;
	} catch {
		return null;
	}
}

/**
 * Get the maximum iteration number for a given run+phase.
 * Returns -1 if no results exist for that phase. Used by the orchestrator
 * on resume to compute the next deterministic iteration value.
 */
export function getMaxIterationForPhase(
	db: Database,
	runId: string,
	phase: string,
): number {
	const row = db
		.query(
			`SELECT MAX(iteration) as max_iter FROM agent_results
       WHERE run_id = ?1 AND phase = ?2`,
		)
		.get(runId, phase) as { max_iter: number | null } | null;
	return row?.max_iter ?? -1;
}

/**
 * Get the number of quality gate attempts for a given run+phase.
 * Used by the orchestrator on resume to restore the quality attempt counter.
 */
export function getQualityAttemptCount(
	db: Database,
	runId: string,
	phase: string,
): number {
	const row = db
		.query(
			`SELECT COUNT(*) as cnt FROM quality_results
       WHERE run_id = ?1 AND phase = ?2`,
		)
		.get(runId, phase) as { cnt: number };
	return row.cnt;
}

/**
 * Check if a step has already been completed (has a result in the DB).
 * Used by the orchestrator on resume to skip completed steps.
 */
export function hasCompletedStep(
	db: Database,
	runId: string,
	role: string,
	phase: string,
	iteration: number,
	templateName: string,
): boolean {
	const row = db
		.query(
			`SELECT 1 FROM agent_results
       WHERE run_id = ?1 AND role = ?2 AND phase = ?3 AND iteration = ?4 AND template_name = ?5
       LIMIT 1`,
		)
		.get(runId, role, phase, iteration, templateName);
	return row !== null;
}

// --- Quality Results ---

/**
 * Upsert a quality gate result. Composite key (run_id, phase, attempt).
 * On conflict (resume), replaces with new result.
 */
export function upsertQualityResult(
	db: Database,
	result: QualityResultInput,
): void {
	db.query(
		`INSERT INTO quality_results (id, run_id, phase, attempt, passed, results, duration_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(run_id, phase, attempt) DO UPDATE SET
        id = excluded.id,
        passed = excluded.passed,
        results = excluded.results,
        duration_ms = excluded.duration_ms,
        created_at = datetime('now')`,
	).run(
		result.id,
		result.run_id,
		result.phase,
		result.attempt,
		result.passed,
		result.results,
		result.duration_ms,
	);
}

export function getQualityResults(
	db: Database,
	runId: string,
	phase: string,
): QualityResultRow[] {
	return db
		.query(
			"SELECT * FROM quality_results WHERE run_id = ?1 AND phase = ?2 ORDER BY attempt ASC",
		)
		.all(runId, phase) as QualityResultRow[];
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
           (SELECT COUNT(*) FROM run_events WHERE run_id = r.id) as event_count,
           (SELECT COUNT(*) FROM agent_results WHERE run_id = r.id) as agent_count
         FROM runs r WHERE r.plan_path = ?1
         ORDER BY r.started_at DESC LIMIT ?2`,
			)
			.all(planPath, limit) as RunSummary[];
	}
	return db
		.query(
			`SELECT r.*,
         (SELECT COUNT(*) FROM run_events WHERE run_id = r.id) as event_count,
         (SELECT COUNT(*) FROM agent_results WHERE run_id = r.id) as agent_count
       FROM runs r
       ORDER BY r.started_at DESC LIMIT ?1`,
		)
		.all(limit) as RunSummary[];
}

export function getRunMetrics(db: Database, runId: string): RunMetrics {
	const agentStats = db
		.query(
			`SELECT
         COUNT(*) as total,
         SUM(CASE WHEN role = 'author' THEN 1 ELSE 0 END) as authors,
         SUM(CASE WHEN role = 'reviewer' THEN 1 ELSE 0 END) as reviewers,
         COALESCE(SUM(tokens_in), 0) as tokens_in,
         COALESCE(SUM(tokens_out), 0) as tokens_out,
         COALESCE(SUM(cost_usd), 0) as cost,
         COALESCE(SUM(duration_ms), 0) as duration
       FROM agent_results WHERE run_id = ?1`,
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
         SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
         SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failed
       FROM quality_results WHERE run_id = ?1`,
		)
		.get(runId) as { passed: number | null; failed: number | null };

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
