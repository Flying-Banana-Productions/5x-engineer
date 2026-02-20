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
			expect(getSchemaVersion(db)).toBe(3);
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
			expect(getSchemaVersion(db)).toBe(3);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("creates all expected tables", () => {
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
			expect(names).toContain("run_events");
			expect(names).toContain("agent_results");
			expect(names).toContain("quality_results");
			expect(names).toContain("phase_progress");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("agent_results uses corrected composite unique key", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			db.exec(
				"INSERT INTO runs (id, plan_path, command) VALUES ('run1', '/test.md', 'run')",
			);

			db.exec(
				`INSERT INTO agent_results (
           id, run_id, phase, iteration, role, template, result_type, result_json, duration_ms
         ) VALUES (
           'id1', 'run1', '1', 0, 'author', 'author-next-phase', 'status', '{"result":"complete"}', 100
         )`,
			);

			expect(() => {
				db.exec(
					`INSERT INTO agent_results (
             id, run_id, phase, iteration, role, template, result_type, result_json, duration_ms
           ) VALUES (
             'id2', 'run1', '1', 0, 'author', 'author-next-phase', 'status', '{"result":"failed"}', 100
           )`,
				);
			}).toThrow();

			// Same run/phase/iteration/role/template with different result_type is allowed.
			db.exec(
				`INSERT INTO agent_results (
           id, run_id, phase, iteration, role, template, result_type, result_json, duration_ms
         ) VALUES (
           'id3', 'run1', '1', 0, 'author', 'author-next-phase', 'verdict', '{"readiness":"ready","items":[]}', 100
         )`,
			);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("quality_results has composite unique constraint", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			db.exec(
				"INSERT INTO runs (id, plan_path, command) VALUES ('run1', '/test.md', 'run')",
			);

			db.exec(
				`INSERT INTO quality_results (id, run_id, phase, attempt, passed, results, duration_ms)
         VALUES ('qr1', 'run1', '1', 0, 1, '[]', 100)`,
			);

			expect(() => {
				db.exec(
					`INSERT INTO quality_results (id, run_id, phase, attempt, passed, results, duration_ms)
           VALUES ('qr2', 'run1', '1', 0, 0, '[]', 200)`,
				);
			}).toThrow();
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
				"DB schema version v999 is newer than this CLI's maximum known version v3",
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
			expect(getSchemaVersion(db)).toBe(3);

			const columns = db
				.query("PRAGMA table_info(agent_results)")
				.all() as Array<{ name: string }>;
			expect(columns.map((c) => c.name)).toContain("result_json");
			expect(columns.map((c) => c.name)).toContain("result_type");
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
