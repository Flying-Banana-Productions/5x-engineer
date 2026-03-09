import type { Database } from "bun:sqlite";
import { canonicalizePlanPath } from "../paths.js";

// --- Row types ---

export interface StepRow {
	id: number;
	run_id: string;
	step_name: string;
	phase: string | null;
	iteration: number;
	result_json: string;
	session_id: string | null;
	model: string | null;
	tokens_in: number | null;
	tokens_out: number | null;
	cost_usd: number | null;
	duration_ms: number | null;
	log_path: string | null;
	created_at: string;
}

export interface RecordStepInput {
	run_id: string;
	step_name: string;
	phase?: string;
	iteration?: number; // auto-increment if omitted
	result_json: string;
	session_id?: string;
	model?: string;
	tokens_in?: number;
	tokens_out?: number;
	cost_usd?: number;
	duration_ms?: number;
	log_path?: string;
}

export interface RecordStepResult {
	step_id: number;
	step_name: string;
	phase: string | null;
	iteration: number;
	recorded: boolean; // true=new, false=already existed
}

export interface RunRowV1 {
	id: string;
	plan_path: string;
	status: string;
	config_json: string | null;
	created_at: string;
	updated_at: string;
}

export interface RunSummaryV1 {
	id: string;
	plan_path: string;
	status: string;
	created_at: string;
	updated_at: string;
	step_count: number;
}

export interface RunSummaryComputed {
	total_steps: number;
	phases_completed: string[];
	total_tokens_in: number;
	total_tokens_out: number;
	total_cost_usd: number;
	total_duration_ms: number;
}

// --- Step operations ---

/**
 * Compute MAX(iteration) + 1 for auto-increment within a (run_id, step_name, phase) group.
 */
export function nextIteration(
	db: Database,
	runId: string,
	stepName: string,
	phase?: string,
): number {
	const row = db
		.query(
			`SELECT MAX(iteration) as max_iter FROM steps
			 WHERE run_id = ?1 AND step_name = ?2 AND phase IS ?3`,
		)
		.get(runId, stepName, phase ?? null) as {
		max_iter: number | null;
	} | null;
	return (row?.max_iter ?? 0) + 1;
}

/**
 * INSERT OR IGNORE a step. First write wins (immutable steps).
 * Returns the recorded step info; `recorded=false` if a duplicate existed.
 *
 * NOTE: The auto-increment path (iteration omitted) is not concurrency-safe.
 * Two concurrent writers can compute the same next iteration, and one INSERT
 * will be silently ignored. This is acceptable because 5x runs are
 * single-process (plan lock prevents concurrent orchestrators). If
 * multi-process writers are ever needed, callers should provide an explicit
 * iteration or use a retry-on-conflict loop.
 */
export function recordStep(
	db: Database,
	input: RecordStepInput,
): RecordStepResult {
	const phase = input.phase ?? null;
	const iteration =
		input.iteration ??
		nextIteration(db, input.run_id, input.step_name, phase ?? undefined);

	const result = db
		.query(
			`INSERT OR IGNORE INTO steps
			 (run_id, step_name, phase, iteration, result_json,
			  session_id, model, tokens_in, tokens_out, cost_usd, duration_ms, log_path)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
		)
		.run(
			input.run_id,
			input.step_name,
			phase,
			iteration,
			input.result_json,
			input.session_id ?? null,
			input.model ?? null,
			input.tokens_in ?? null,
			input.tokens_out ?? null,
			input.cost_usd ?? null,
			input.duration_ms ?? null,
			input.log_path ?? null,
		);

	if (result.changes > 0) {
		return {
			step_id: Number(result.lastInsertRowid),
			step_name: input.step_name,
			phase,
			iteration,
			recorded: true,
		};
	}

	// Duplicate — fetch existing row
	const existing = db
		.query(
			`SELECT id, step_name, phase, iteration FROM steps
			 WHERE run_id = ?1 AND step_name = ?2 AND phase IS ?3 AND iteration = ?4`,
		)
		.get(input.run_id, input.step_name, phase, iteration) as {
		id: number;
		step_name: string;
		phase: string | null;
		iteration: number;
	};

	return {
		step_id: existing.id,
		step_name: existing.step_name,
		phase: existing.phase,
		iteration: existing.iteration,
		recorded: false,
	};
}

/**
 * Get steps for a run, ordered by creation. Supports optional pagination.
 */
export function getSteps(
	db: Database,
	runId: string,
	opts?: {
		sinceStepId?: number; // return steps with id > sinceStepId
		tail?: number; // return only the last N steps
	},
): StepRow[] {
	if (opts?.sinceStepId !== undefined) {
		return db
			.query(
				`SELECT * FROM steps
				 WHERE run_id = ?1 AND id > ?2
				 ORDER BY id ASC`,
			)
			.all(runId, opts.sinceStepId) as StepRow[];
	}

	if (opts?.tail !== undefined) {
		return db
			.query(
				`SELECT * FROM (
					SELECT * FROM steps
					WHERE run_id = ?1
					ORDER BY id DESC
					LIMIT ?2
				 ) sub ORDER BY id ASC`,
			)
			.all(runId, opts.tail) as StepRow[];
	}

	return db
		.query(
			`SELECT * FROM steps
			 WHERE run_id = ?1
			 ORDER BY id ASC`,
		)
		.all(runId) as StepRow[];
}

/**
 * Get steps filtered by phase.
 */
export function getStepsByPhase(
	db: Database,
	runId: string,
	phase: string,
): StepRow[] {
	return db
		.query(
			`SELECT * FROM steps
			 WHERE run_id = ?1 AND phase = ?2
			 ORDER BY id ASC`,
		)
		.all(runId, phase) as StepRow[];
}

/**
 * Get the latest step with a given step_name for a run.
 */
export function getLatestStep(
	db: Database,
	runId: string,
	stepName: string,
): StepRow | null {
	return db
		.query(
			`SELECT * FROM steps
			 WHERE run_id = ?1 AND step_name = ?2
			 ORDER BY id DESC LIMIT 1`,
		)
		.get(runId, stepName) as StepRow | null;
}

// --- Run operations ---

/**
 * Create a run (simplified from v0 -- no review_path, no current_state).
 */
export function createRunV1(
	db: Database,
	run: {
		id: string;
		planPath: string;
		configJson?: string;
	},
): void {
	const canonical = canonicalizePlanPath(run.planPath);
	db.query(
		`INSERT INTO runs (id, plan_path, config_json)
		 VALUES (?1, ?2, ?3)`,
	).run(run.id, canonical, run.configJson ?? null);
}

/**
 * Get run by ID.
 */
export function getRunV1(db: Database, runId: string): RunRowV1 | null {
	return db
		.query("SELECT * FROM runs WHERE id = ?1")
		.get(runId) as RunRowV1 | null;
}

/**
 * Find active run for a plan.
 */
export function getActiveRunV1(
	db: Database,
	planPath: string,
): RunRowV1 | null {
	const canonical = canonicalizePlanPath(planPath);
	return db
		.query(
			`SELECT * FROM runs
			 WHERE plan_path = ?1 AND status = 'active'
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.get(canonical) as RunRowV1 | null;
}

/**
 * Update run status to completed or aborted.
 */
export function completeRun(
	db: Database,
	runId: string,
	status: "completed" | "aborted",
): void {
	db.query(
		`UPDATE runs SET
		   status = ?1,
		   updated_at = datetime('now')
		 WHERE id = ?2`,
	).run(status, runId);
}

/**
 * Reopen a completed/aborted run (set status back to active).
 */
export function reopenRun(db: Database, runId: string): void {
	db.query(
		`UPDATE runs SET
		   status = 'active',
		   updated_at = datetime('now')
		 WHERE id = ?1`,
	).run(runId);
}

/**
 * List runs with optional filters.
 */
export function listRuns(
	db: Database,
	opts?: {
		planPath?: string;
		status?: string;
		limit?: number;
	},
): RunSummaryV1[] {
	const conditions: string[] = [];
	const params: (string | number)[] = [];
	let paramIdx = 1;

	if (opts?.planPath) {
		const canonical = canonicalizePlanPath(opts.planPath);
		conditions.push(`r.plan_path = ?${paramIdx}`);
		params.push(canonical);
		paramIdx++;
	}

	if (opts?.status) {
		conditions.push(`r.status = ?${paramIdx}`);
		params.push(opts.status);
		paramIdx++;
	}

	const where =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = opts?.limit ?? 50;

	return db
		.query(
			`SELECT r.*,
			   (SELECT COUNT(*) FROM steps WHERE run_id = r.id) as step_count
			 FROM runs r
			 ${where}
			 ORDER BY r.created_at DESC
			 LIMIT ?${paramIdx}`,
		)
		.all(...params, limit) as RunSummaryV1[];
}

/**
 * Compute run summary from steps (phases completed, cost, tokens).
 */
export function computeRunSummary(
	db: Database,
	runId: string,
): RunSummaryComputed {
	const totals = db
		.query(
			`SELECT
			   COUNT(*) as total_steps,
			   COALESCE(SUM(tokens_in), 0) as total_tokens_in,
			   COALESCE(SUM(tokens_out), 0) as total_tokens_out,
			   COALESCE(SUM(cost_usd), 0) as total_cost_usd,
			   COALESCE(SUM(duration_ms), 0) as total_duration_ms
			 FROM steps WHERE run_id = ?1`,
		)
		.get(runId) as {
		total_steps: number;
		total_tokens_in: number;
		total_tokens_out: number;
		total_cost_usd: number;
		total_duration_ms: number;
	};

	const phases = db
		.query(
			`SELECT DISTINCT phase FROM steps
			 WHERE run_id = ?1 AND step_name = 'phase:complete' AND phase IS NOT NULL
			 ORDER BY CAST(phase AS REAL) ASC`,
		)
		.all(runId) as Array<{ phase: string }>;

	return {
		total_steps: totals.total_steps,
		phases_completed: phases.map((p) => p.phase),
		total_tokens_in: totals.total_tokens_in,
		total_tokens_out: totals.total_tokens_out,
		total_cost_usd: totals.total_cost_usd,
		total_duration_ms: totals.total_duration_ms,
	};
}
