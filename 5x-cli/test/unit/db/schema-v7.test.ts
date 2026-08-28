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
	return mkdtempSync(join(tmpdir(), "5x-db-schema-v7-"));
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

function invocationIndexNames(db: ReturnType<typeof getDb>): string[] {
	const rows = db
		.query(
			"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='invocations'",
		)
		.all() as { name: string }[];
	return rows.map((r) => r.name);
}

function invocationColumnNames(db: ReturnType<typeof getDb>): string[] {
	return (
		db.query("PRAGMA table_info(invocations)").all() as Array<{ name: string }>
	).map((c) => c.name);
}

function insertRun(db: ReturnType<typeof getDb>): void {
	db.exec("INSERT INTO runs (id, plan_path) VALUES ('run1', '/plan.md')");
}

const HANDLE_JSON = `'{"adapter":"test-remote","ref":"job-abc"}'`;

describe("migration v7: fresh DB", () => {
	test("fresh DB migrates to version 7 with invocations table and indexes", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			expect(getSchemaVersion(db)).toBe(7);
			expect(getMaxKnownSchemaVersion()).toBe(7);
			expect(tableNames(db)).toContain("invocations");

			const indexNames = invocationIndexNames(db);
			expect(indexNames).toContain("idx_invocations_run");
			expect(indexNames).toContain("idx_invocations_live");

			const listed = db.query("PRAGMA index_list(invocations)").all() as Array<{
				name: string;
				partial: number;
			}>;
			const listedNames = listed.map((i) => i.name);
			expect(listedNames).toContain("idx_invocations_run");
			expect(listedNames).toContain("idx_invocations_live");
			expect(
				listed.find((i) => i.name === "idx_invocations_live")?.partial,
			).toBe(1);
			expect(
				listed.find((i) => i.name === "idx_invocations_run")?.partial,
			).toBe(0);

			const liveSql = (
				db
					.query(
						"SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_invocations_live'",
					)
					.get() as { sql: string } | null
			)?.sql;
			expect(liveSql).toContain("status = 'running'");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("does not alter runs, steps, plans, or prompts columns", () => {
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

			const promptCols = (
				db.query("PRAGMA table_info(prompts)").all() as Array<{ name: string }>
			).map((c) => c.name);
			expect(promptCols).toEqual([
				"id",
				"run_id",
				"kind",
				"message",
				"options_json",
				"default_value",
				"created_at",
				"answered_at",
				"answer",
				"answered_by",
				"abandoned_at",
				"abandon_reason",
			]);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("PRAGMA table_info(invocations) has no pid column and handle_json is NOT NULL", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			const columns = db
				.query("PRAGMA table_info(invocations)")
				.all() as Array<{
				name: string;
				notnull: number;
			}>;
			expect(columns.map((c) => c.name)).not.toContain("pid");
			expect(invocationColumnNames(db)).not.toContain("pid");

			const handleCol = columns.find((c) => c.name === "handle_json");
			expect(handleCol).toBeDefined();
			expect(handleCol?.notnull).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v7: from v6", () => {
	test("v6 DB gains invocations without dropping prompts", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			migrateUpTo(db, 6);
			expect(getSchemaVersion(db)).toBe(6);
			expect(tableNames(db)).toContain("prompts");
			expect(tableNames(db)).not.toContain("invocations");

			db.exec("INSERT INTO runs (id, plan_path) VALUES ('run1', '/plan.md')");
			db.exec(
				`INSERT INTO prompts (id, kind, message, run_id)
				 VALUES ('p-keep', 'input', 'Type something', 'run1')`,
			);

			runMigrations(db);
			expect(getSchemaVersion(db)).toBe(7);
			expect(tableNames(db)).toContain("invocations");
			expect(tableNames(db)).toContain("prompts");

			const prompts = db
				.query("SELECT * FROM prompts WHERE id = 'p-keep'")
				.all();
			expect(prompts).toHaveLength(1);

			const indexNames = invocationIndexNames(db);
			expect(indexNames).toContain("idx_invocations_run");
			expect(indexNames).toContain("idx_invocations_live");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v7: FK", () => {
	test("inserting run_id that is not in runs throws", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			expect(() => {
				db.exec(
					`INSERT INTO invocations (
						id, run_id, role, provider_name, handle_json,
						cancellation_supported, status
					) VALUES (
						'inv-missing-run', 'run_does_not_exist', 'author', 'sample',
						${HANDLE_JSON}, 0, 'running'
					)`,
				);
			}).toThrow(/FOREIGN KEY constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v7: CHECKs", () => {
	test("cannot set cancellation_requested_at without cancellation_requested_by", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			insertRun(db);

			expect(() => {
				db.exec(
					`INSERT INTO invocations (
						id, run_id, role, provider_name, handle_json,
						cancellation_supported, status, cancellation_requested_at
					) VALUES (
						'inv-requested-at-only', 'run1', 'author', 'sample',
						${HANDLE_JSON}, 1, 'running', datetime('now')
					)`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("cannot set cancellation_outcome without cancellation_outcome_at", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			insertRun(db);

			expect(() => {
				db.exec(
					`INSERT INTO invocations (
						id, run_id, role, provider_name, handle_json,
						cancellation_supported, status, cancellation_outcome
					) VALUES (
						'inv-outcome-only', 'run1', 'author', 'sample',
						${HANDLE_JSON}, 1, 'running', 'succeeded'
					)`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("cannot set status='running' with terminal_at", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			insertRun(db);

			expect(() => {
				db.exec(
					`INSERT INTO invocations (
						id, run_id, role, provider_name, handle_json,
						cancellation_supported, status, terminal_at
					) VALUES (
						'inv-running-terminal', 'run1', 'author', 'sample',
						${HANDLE_JSON}, 0, 'running', datetime('now')
					)`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("cannot set status='abandoned' without abandon_reason", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			insertRun(db);

			expect(() => {
				db.exec(
					`INSERT INTO invocations (
						id, run_id, role, provider_name, handle_json,
						cancellation_supported, status, terminal_at
					) VALUES (
						'inv-abandoned-no-reason', 'run1', 'author', 'sample',
						${HANDLE_JSON}, 0, 'abandoned', datetime('now')
					)`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("cannot set status='completed' with abandon_reason", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			insertRun(db);

			expect(() => {
				db.exec(
					`INSERT INTO invocations (
						id, run_id, role, provider_name, handle_json,
						cancellation_supported, status, terminal_at, abandon_reason
					) VALUES (
						'inv-completed-abandoned', 'run1', 'author', 'sample',
						${HANDLE_JSON}, 0, 'completed', datetime('now'), 'stale-metadata'
					)`,
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("handle_json is NOT NULL", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			insertRun(db);

			expect(() => {
				db.exec(
					`INSERT INTO invocations (
						id, run_id, role, provider_name, handle_json,
						cancellation_supported, status
					) VALUES (
						'inv-null-handle', 'run1', 'author', 'sample',
						NULL, 0, 'running'
					)`,
				);
			}).toThrow(/NOT NULL constraint failed/);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("running, completed, and abandoned rows that satisfy CHECKs insert successfully", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			insertRun(db);

			db.exec(
				`INSERT INTO invocations (
					id, run_id, role, provider_name, handle_json,
					cancellation_supported, status
				) VALUES (
					'inv-running', 'run1', 'author', 'sample',
					${HANDLE_JSON}, 0, 'running'
				)`,
			);
			db.exec(
				`INSERT INTO invocations (
					id, run_id, role, provider_name, handle_json,
					cancellation_supported, status, terminal_at
				) VALUES (
					'inv-completed', 'run1', 'reviewer', 'sample',
					${HANDLE_JSON}, 0, 'completed', datetime('now')
				)`,
			);
			db.exec(
				`INSERT INTO invocations (
					id, run_id, role, provider_name, handle_json,
					cancellation_supported, status, terminal_at, abandon_reason
				) VALUES (
					'inv-abandoned', 'run1', 'author', 'sample',
					${HANDLE_JSON}, 0, 'abandoned', datetime('now'), 'stale-metadata'
				)`,
			);

			const count = (
				db.query("SELECT COUNT(*) AS c FROM invocations").get() as { c: number }
			).c;
			expect(count).toBe(3);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
