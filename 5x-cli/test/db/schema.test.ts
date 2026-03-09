import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import {
	_migrations,
	getSchemaVersion,
	runMigrations,
} from "../../src/db/schema.js";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "5x-db-schema-"));
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

describe("runMigrations", () => {
	test("fresh DB gets all migrations", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			expect(getSchemaVersion(db)).toBe(4);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("already-migrated DB is no-op", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			runMigrations(db);
			expect(getSchemaVersion(db)).toBe(4);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("creates all expected v1 tables", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			const tables = db
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as { name: string }[];
			const names = tables.map((t) => t.name).sort();

			expect(names).toContain("schema_version");
			expect(names).toContain("plans");
			expect(names).toContain("runs");
			expect(names).toContain("steps");

			// v0 tables should be dropped
			expect(names).not.toContain("run_events");
			expect(names).not.toContain("agent_results");
			expect(names).not.toContain("quality_results");
			expect(names).not.toContain("phase_progress");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("steps table has unique constraint on (run_id, step_name, phase, iteration)", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			db.exec("INSERT INTO runs (id, plan_path) VALUES ('run1', '/test.md')");

			db.exec(
				`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
				 VALUES ('run1', 'author:impl:status', '1', 1, '{"result":"complete"}')`,
			);

			expect(() => {
				db.exec(
					`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
					 VALUES ('run1', 'author:impl:status', '1', 1, '{"result":"failed"}')`,
				);
			}).toThrow();

			// Same step with different result_type qualifier is allowed
			db.exec(
				`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
				 VALUES ('run1', 'author:impl:verdict', '1', 1, '{}')`,
			);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("DB ahead of CLI throws clear schema mismatch error", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			db.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (999);
      `);

			expect(() => runMigrations(db)).toThrow(
				"DB schema version v999 is newer than this CLI's maximum known version v4",
			);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("DB behind CLI applies pending migrations without error", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			const migration1 = _migrations.find((m) => m.version === 1);
			if (!migration1) throw new Error("missing migration 1");

			migration1.up(db);
			db.exec("INSERT INTO schema_version (version) VALUES (1)");
			expect(getSchemaVersion(db)).toBe(1);

			runMigrations(db);
			expect(getSchemaVersion(db)).toBe(4);

			// v1 tables exist
			const columns = db.query("PRAGMA table_info(steps)").all() as Array<{
				name: string;
			}>;
			expect(columns.map((c) => c.name)).toContain("result_json");
			expect(columns.map((c) => c.name)).toContain("step_name");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("getSchemaVersion", () => {
	test("returns 0 for fresh DB", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			expect(getSchemaVersion(db)).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
