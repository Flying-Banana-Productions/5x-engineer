import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import {
	_migrations,
	getMaxKnownSchemaVersion,
	getSchemaVersion,
	runMigrations,
} from "../../../src/db/schema.js";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "5x-db-schema-v6-"));
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

/** Run migrations up to a specific version (inclusive of `version`). */
function migrateUpTo(db: ReturnType<typeof getDb>, version: number): void {
	for (const m of _migrations) {
		if (m.version > version) break;
		db.exec("BEGIN TRANSACTION");
		m.up(db);
		db.exec(`INSERT INTO schema_version (version) VALUES (${m.version})`);
		db.exec("COMMIT");
	}
}

function tableNames(db: ReturnType<typeof getDb>): string[] {
	const tables = db
		.query(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as { name: string }[];
	return tables.map((t) => t.name);
}

function promptIndexNames(db: ReturnType<typeof getDb>): string[] {
	const rows = db
		.query(
			"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='prompts'",
		)
		.all() as { name: string }[];
	return rows.map((r) => r.name);
}

describe("migration v6: fresh DB", () => {
	test("fresh DB migrates to version 6 with prompts table and indexes", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			expect(getSchemaVersion(db)).toBe(7);
			expect(getMaxKnownSchemaVersion()).toBe(7);
			expect(tableNames(db)).toContain("prompts");

			const indexNames = promptIndexNames(db);
			expect(indexNames).toContain("idx_prompts_open_run");
			expect(indexNames).toContain("idx_prompts_recent");

			const listed = db.query("PRAGMA index_list(prompts)").all() as Array<{
				name: string;
				partial: number;
			}>;
			const listedNames = listed.map((i) => i.name);
			expect(listedNames).toContain("idx_prompts_open_run");
			expect(listedNames).toContain("idx_prompts_recent");
			expect(
				listed.find((i) => i.name === "idx_prompts_open_run")?.partial,
			).toBe(1);

			const openSql = (
				db
					.query(
						"SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_prompts_open_run'",
					)
					.get() as { sql: string } | null
			)?.sql;
			expect(openSql).toContain("answered_at IS NULL");
			expect(openSql).toContain("abandoned_at IS NULL");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("does not alter runs, steps, or plans columns", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			const runCols = (
				db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>
			).map((c) => c.name);
			expect(runCols).toEqual([
				"id",
				"plan_path",
				"status",
				"config_json",
				"created_at",
				"updated_at",
			]);

			const stepCols = (
				db.query("PRAGMA table_info(steps)").all() as Array<{ name: string }>
			).map((c) => c.name);
			expect(stepCols).toEqual([
				"id",
				"run_id",
				"step_name",
				"phase",
				"iteration",
				"result_json",
				"session_id",
				"model",
				"tokens_in",
				"tokens_out",
				"cost_usd",
				"duration_ms",
				"log_path",
				"created_at",
				"head_commit",
			]);

			const planCols = (
				db.query("PRAGMA table_info(plans)").all() as Array<{ name: string }>
			).map((c) => c.name);
			expect(planCols).toEqual([
				"plan_path",
				"worktree_path",
				"branch",
				"created_at",
				"updated_at",
			]);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v6: from v5", () => {
	test("v5 DB gains prompts without dropping steps", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			migrateUpTo(db, 5);
			expect(getSchemaVersion(db)).toBe(5);
			expect(tableNames(db)).not.toContain("prompts");

			db.exec("INSERT INTO runs (id, plan_path) VALUES ('run1', '/plan.md')");
			db.exec(
				`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
				 VALUES ('run1', 'author:impl:status', '1', 1, '{"result":"complete"}')`,
			);

			runMigrations(db);
			expect(getSchemaVersion(db)).toBe(7);
			expect(tableNames(db)).toContain("prompts");
			expect(tableNames(db)).toContain("steps");

			const steps = db.query("SELECT * FROM steps WHERE run_id = 'run1'").all();
			expect(steps).toHaveLength(1);

			const indexNames = promptIndexNames(db);
			expect(indexNames).toContain("idx_prompts_open_run");
			expect(indexNames).toContain("idx_prompts_recent");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v6: FK", () => {
	test("inserting run_id that is not in runs throws; NULL run_id succeeds", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			expect(() => {
				db.exec(
					`INSERT INTO prompts (id, kind, message, run_id)
					 VALUES ('p-missing-run', 'choose', 'Pick one', 'run_does_not_exist')`,
				);
			}).toThrow(/FOREIGN KEY constraint failed/);

			db.exec(
				`INSERT INTO prompts (id, kind, message, run_id)
				 VALUES ('p-standalone', 'input', 'Type something', NULL)`,
			);
			const row = db
				.query("SELECT id, run_id FROM prompts WHERE id = 'p-standalone'")
				.get() as { id: string; run_id: string | null };
			expect(row.id).toBe("p-standalone");
			expect(row.run_id).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v6: CHECKs", () => {
	test("cannot set answered_at without answer/answered_by", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			expect(() => {
				db.exec(
					`INSERT INTO prompts (id, kind, message, answered_at)
					 VALUES ('p-partial-answer', 'choose', 'Pick', datetime('now'))`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("cannot set abandoned_at without abandon_reason; cannot set abandon_reason without abandoned_at", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			expect(() => {
				db.exec(
					`INSERT INTO prompts (id, kind, message, abandoned_at)
					 VALUES ('p-abandoned-at-only', 'confirm', 'OK?', datetime('now'))`,
				);
			}).toThrow(/CHECK constraint failed/);

			expect(() => {
				db.exec(
					`INSERT INTO prompts (id, kind, message, abandon_reason)
					 VALUES ('p-reason-only', 'confirm', 'OK?', 'timeout')`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("cannot set both answered and abandoned timestamps", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			expect(() => {
				db.exec(
					`INSERT INTO prompts (
						id, kind, message,
						answered_at, answer, answered_by,
						abandoned_at, abandon_reason
					) VALUES (
						'p-both', 'choose', 'Pick',
						datetime('now'), 'a', 'terminal',
						datetime('now'), 'timeout'
					)`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("cannot set an answered triple plus abandon_reason", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			expect(() => {
				db.exec(
					`INSERT INTO prompts (
						id, kind, message,
						answered_at, answer, answered_by,
						abandon_reason
					) VALUES (
						'p-answered-plus-reason', 'choose', 'Pick',
						datetime('now'), 'a', 'terminal',
						'timeout'
					)`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("open, answered, and abandoned rows that satisfy CHECKs insert successfully", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			db.exec(
				`INSERT INTO prompts (id, kind, message)
				 VALUES ('p-open', 'choose', 'Pick one')`,
			);
			db.exec(
				`INSERT INTO prompts (id, kind, message, answered_at, answer, answered_by)
				 VALUES ('p-answered', 'confirm', 'OK?', datetime('now'), 'true', 'default')`,
			);
			db.exec(
				`INSERT INTO prompts (id, kind, message, abandoned_at, abandon_reason)
				 VALUES ('p-abandoned', 'input', 'Type', datetime('now'), 'non-interactive')`,
			);

			const count = (
				db.query("SELECT COUNT(*) AS c FROM prompts").get() as { c: number }
			).c;
			expect(count).toBe(3);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
