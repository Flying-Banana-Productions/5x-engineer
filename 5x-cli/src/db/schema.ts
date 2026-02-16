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
          current_phase INTEGER,
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
          phase INTEGER,
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
          phase INTEGER NOT NULL DEFAULT -1,
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
          phase INTEGER NOT NULL,
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
