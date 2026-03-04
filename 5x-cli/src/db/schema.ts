import type { Database } from "bun:sqlite";

export type Migration = {
	version: number;
	description: string;
	up: (db: Database) => void;
};

const migrations: Migration[] = [
	{
		version: 1,
		description:
			"Initial schema — plans, runs, events, agent_results, quality_results",
		up(db) {
			db.exec(`
        -- Schema version tracking
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Plan associations (worktree, branch, lock state)
        CREATE TABLE plans (
          plan_path TEXT PRIMARY KEY,
          worktree_path TEXT,
          branch TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Runs
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          plan_path TEXT NOT NULL,
          review_path TEXT,
          command TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          current_phase TEXT,
          current_state TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE INDEX idx_runs_plan_path ON runs(plan_path);
        CREATE INDEX idx_runs_status ON runs(status);

        -- Run events (append-only journal)
        CREATE TABLE run_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id),
          event_type TEXT NOT NULL,
          phase TEXT,
          iteration INTEGER,
          data TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_run_events_run_id ON run_events(run_id);

        -- Agent invocation results with parsed signal data.
        -- See implementation plan Phase 1.1.2 for full documentation of
        -- id lifecycle, iteration semantics, and upsert behavior.
        CREATE TABLE agent_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          role TEXT NOT NULL,
          template_name TEXT NOT NULL,
          phase TEXT NOT NULL DEFAULT '-1',
          iteration INTEGER NOT NULL DEFAULT 0,
          exit_code INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          tokens_in INTEGER,
          tokens_out INTEGER,
          cost_usd REAL,
          signal_type TEXT,
          signal_data TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(run_id, role, phase, iteration, template_name)
        );
        CREATE INDEX idx_agent_results_run ON agent_results(run_id);
        CREATE INDEX idx_agent_results_run_phase ON agent_results(run_id, phase);

        -- Quality gate results
        CREATE TABLE quality_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          phase TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          passed INTEGER NOT NULL,
          results TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(run_id, phase, attempt)
        );
        CREATE INDEX idx_quality_results_run ON quality_results(run_id, phase);
      `);
		},
	},
	{
		version: 2,
		description:
			"Rework agent_results for structured output (result_type/result_json)",
		up(db) {
			db.exec(`
        DROP TABLE IF EXISTS agent_results;

        CREATE TABLE agent_results (
          id          TEXT    NOT NULL PRIMARY KEY,
          run_id      TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          phase       TEXT    NOT NULL,
          iteration   INTEGER NOT NULL,
          role        TEXT    NOT NULL,
          template    TEXT    NOT NULL,
          result_type TEXT    NOT NULL CHECK(result_type IN ('status', 'verdict')),
          result_json TEXT    NOT NULL,
          duration_ms INTEGER NOT NULL,
          log_path    TEXT,
          session_id  TEXT,
          model       TEXT,
          tokens_in   INTEGER,
          tokens_out  INTEGER,
          cost_usd    REAL,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE(run_id, phase, iteration, role, template, result_type)
        );

        CREATE INDEX idx_agent_results_run ON agent_results(run_id);
        CREATE INDEX idx_agent_results_run_phase ON agent_results(run_id, phase);
      `);
		},
	},
	{
		version: 3,
		description:
			"Hard cutover: reset run tables and add phase_progress review state",
		up(db) {
			db.exec(`
        -- Hard cutover for local feature-branch development:
        -- reset orchestration state tables to avoid carrying forward
        -- run semantics tied to plan checkbox completion.
        DROP TABLE IF EXISTS run_events;
        DROP TABLE IF EXISTS quality_results;
        DROP TABLE IF EXISTS agent_results;
        DROP TABLE IF EXISTS runs;

        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          plan_path TEXT NOT NULL,
          review_path TEXT,
          command TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          current_phase TEXT,
          current_state TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE INDEX idx_runs_plan_path ON runs(plan_path);
        CREATE INDEX idx_runs_status ON runs(status);

        CREATE TABLE run_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id),
          event_type TEXT NOT NULL,
          phase TEXT,
          iteration INTEGER,
          data TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_run_events_run_id ON run_events(run_id);

        CREATE TABLE agent_results (
          id          TEXT    NOT NULL PRIMARY KEY,
          run_id      TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          phase       TEXT    NOT NULL,
          iteration   INTEGER NOT NULL,
          role        TEXT    NOT NULL,
          template    TEXT    NOT NULL,
          result_type TEXT    NOT NULL CHECK(result_type IN ('status', 'verdict')),
          result_json TEXT    NOT NULL,
          duration_ms INTEGER NOT NULL,
          log_path    TEXT,
          session_id  TEXT,
          model       TEXT,
          tokens_in   INTEGER,
          tokens_out  INTEGER,
          cost_usd    REAL,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE(run_id, phase, iteration, role, template, result_type)
        );
        CREATE INDEX idx_agent_results_run ON agent_results(run_id);
        CREATE INDEX idx_agent_results_run_phase ON agent_results(run_id, phase);

        CREATE TABLE quality_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          phase TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          passed INTEGER NOT NULL,
          results TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(run_id, phase, attempt)
        );
        CREATE INDEX idx_quality_results_run ON quality_results(run_id, phase);

        CREATE TABLE phase_progress (
          plan_path TEXT NOT NULL REFERENCES plans(plan_path) ON DELETE CASCADE,
          phase TEXT NOT NULL,
          implementation_done INTEGER NOT NULL DEFAULT 0,
          latest_review_readiness TEXT CHECK(latest_review_readiness IN ('ready', 'ready_with_corrections', 'not_ready')),
          review_approved INTEGER NOT NULL DEFAULT 0,
          blocked_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (plan_path, phase)
        );
        CREATE INDEX idx_phase_progress_plan ON phase_progress(plan_path);
        CREATE INDEX idx_phase_progress_approved ON phase_progress(plan_path, review_approved);
      `);
		},
	},
	{
		version: 4,
		description:
			"v1 schema: create steps table, migrate v0 data, rebuild runs, drop old tables",
		up(db) {
			// Step ordering is critical: rebuild `runs` BEFORE creating `steps`
			// so there are no FK references blocking the DROP TABLE.

			// 1. Rebuild runs table using SQLite table-rebuild pattern
			// Remove: current_state, current_phase, review_path
			// Rename: started_at → created_at, completed_at → updated_at (via COALESCE)
			// Add: config_json
			db.exec(`
				CREATE TABLE runs_new (
					id          TEXT PRIMARY KEY,
					plan_path   TEXT NOT NULL,
					command     TEXT,
					status      TEXT NOT NULL DEFAULT 'active',
					config_json TEXT,
					created_at  TEXT NOT NULL DEFAULT (datetime('now')),
					updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
				)
			`);
			db.exec(`
				INSERT INTO runs_new (id, plan_path, command, status, created_at, updated_at)
				SELECT
					id,
					plan_path,
					command,
					status,
					started_at,
					COALESCE(completed_at, started_at)
				FROM runs
			`);
			// Migrate data from v0 tables BEFORE dropping runs, since they
			// reference runs(id) via FK. We store into a temp table first
			// so we can drop runs cleanly.

			// 2a. Stage agent_results data into a temp table
			db.exec(`
				CREATE TEMP TABLE _mig_agent AS
				SELECT
					run_id,
					role || ':' || template || ':' || result_type AS step_name,
					phase,
					iteration,
					result_json,
					session_id,
					model,
					tokens_in,
					tokens_out,
					cost_usd,
					duration_ms,
					log_path,
					created_at
				FROM agent_results
			`);

			// 2b. Stage quality_results data
			db.exec(`
				CREATE TEMP TABLE _mig_quality AS
				SELECT
					run_id,
					'quality:check' AS step_name,
					phase,
					attempt AS iteration,
					results AS result_json,
					duration_ms,
					created_at
				FROM quality_results
			`);

			// 2c. Stage run_events data
			db.exec(`
				CREATE TEMP TABLE _mig_events AS
				SELECT
					run_id,
					'event:' || event_type AS step_name,
					phase,
					COALESCE(iteration, 1) AS iteration,
					COALESCE(data, '{}') AS result_json,
					created_at
				FROM run_events
			`);

			// 2d. Stage phase_progress data (approved only)
			db.exec(`
				CREATE TEMP TABLE _mig_phases AS
				SELECT
					r.id AS run_id,
					'phase:complete' AS step_name,
					pp.phase,
					1 AS iteration,
					json_object(
						'implementation_done', pp.implementation_done,
						'review_readiness', pp.latest_review_readiness,
						'review_approved', pp.review_approved
					) AS result_json,
					pp.updated_at AS created_at
				FROM phase_progress pp
				INNER JOIN runs r ON r.plan_path = pp.plan_path
				WHERE pp.review_approved = 1
				AND r.id = (
					SELECT r2.id FROM runs r2
					WHERE r2.plan_path = pp.plan_path
					ORDER BY r2.rowid DESC LIMIT 1
				)
			`);

			// 3. Drop old tables (now safe — data is staged in temp tables)
			db.exec("DROP TABLE IF EXISTS agent_results");
			db.exec("DROP TABLE IF EXISTS quality_results");
			db.exec("DROP TABLE IF EXISTS run_events");
			db.exec("DROP TABLE IF EXISTS phase_progress");

			// 4. Drop old runs and rename new
			db.exec("DROP TABLE runs");
			db.exec("ALTER TABLE runs_new RENAME TO runs");
			db.exec("CREATE INDEX idx_runs_plan_path ON runs(plan_path)");
			db.exec("CREATE INDEX idx_runs_status ON runs(status)");

			// 5. Create the steps table
			db.exec(`
				CREATE TABLE steps (
					id            INTEGER PRIMARY KEY AUTOINCREMENT,
					run_id        TEXT NOT NULL REFERENCES runs(id),
					step_name     TEXT NOT NULL,
					phase         TEXT,
					iteration     INTEGER NOT NULL DEFAULT 1,
					result_json   TEXT NOT NULL,
					session_id    TEXT,
					model         TEXT,
					tokens_in     INTEGER,
					tokens_out    INTEGER,
					cost_usd      REAL,
					duration_ms   INTEGER,
					log_path      TEXT,
					created_at    TEXT NOT NULL DEFAULT (datetime('now')),
					UNIQUE(run_id, step_name, phase, iteration)
				);
				CREATE INDEX idx_steps_run ON steps(run_id, created_at);
				CREATE INDEX idx_steps_phase ON steps(run_id, phase);
			`);

			// 6. Migrate staged data into steps
			db.exec(`
				INSERT INTO steps (run_id, step_name, phase, iteration, result_json,
					session_id, model, tokens_in, tokens_out, cost_usd, duration_ms, log_path, created_at)
				SELECT run_id, step_name, phase, iteration, result_json,
					session_id, model, tokens_in, tokens_out, cost_usd, duration_ms, log_path, created_at
				FROM _mig_agent
			`);

			db.exec(`
				INSERT INTO steps (run_id, step_name, phase, iteration, result_json,
					duration_ms, created_at)
				SELECT run_id, step_name, phase, iteration, result_json,
					duration_ms, created_at
				FROM _mig_quality
			`);

			db.exec(`
				INSERT INTO steps (run_id, step_name, phase, iteration, result_json, created_at)
				SELECT run_id, step_name, phase, iteration, result_json, created_at
				FROM _mig_events
			`);

			db.exec(`
				INSERT INTO steps (run_id, step_name, phase, iteration, result_json, created_at)
				SELECT run_id, step_name, phase, iteration, result_json, created_at
				FROM _mig_phases
			`);

			// 7. Clean up temp tables
			db.exec("DROP TABLE IF EXISTS _mig_agent");
			db.exec("DROP TABLE IF EXISTS _mig_quality");
			db.exec("DROP TABLE IF EXISTS _mig_events");
			db.exec("DROP TABLE IF EXISTS _mig_phases");
		},
	},
];

/**
 * Get the current schema version from the database.
 * Returns 0 if the schema_version table doesn't exist yet.
 */
export function getSchemaVersion(db: Database): number {
	try {
		const row = db
			.query("SELECT MAX(version) as v FROM schema_version")
			.get() as { v: number | null } | null;
		return row?.v ?? 0;
	} catch {
		// Table doesn't exist yet
		return 0;
	}
}

/**
 * Run all pending migrations in order. Each migration runs in a transaction.
 * Idempotent — skips already-applied migrations.
 */
export function runMigrations(db: Database): void {
	const currentVersion = getSchemaVersion(db);
	const maxKnownVersion = migrations[migrations.length - 1]?.version ?? 0;

	if (currentVersion > maxKnownVersion) {
		throw new Error(
			`DB schema version v${currentVersion} is newer than this CLI's maximum known version v${maxKnownVersion}. ` +
				"Upgrade the CLI or delete .5x/5x.db to reset.",
		);
	}

	for (const migration of migrations) {
		if (migration.version <= currentVersion) continue;

		db.exec("BEGIN TRANSACTION");
		try {
			migration.up(db);
			db.exec(
				`INSERT INTO schema_version (version) VALUES (${migration.version})`,
			);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Migration ${migration.version} (${migration.description}) failed: ${message}. ` +
					`Database may be in an inconsistent state. Delete the DB file to reset.`,
			);
		}
	}
}

/** Exported for testing only. */
export { migrations as _migrations };
