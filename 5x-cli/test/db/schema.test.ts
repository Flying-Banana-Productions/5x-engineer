import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import { getSchemaVersion, runMigrations } from "../../src/db/schema.js";

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
			const version = getSchemaVersion(db);
			expect(version).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("already-migrated DB is no-op", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			runMigrations(db); // second run should be no-op
			const version = getSchemaVersion(db);
			expect(version).toBe(1);
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
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("agent_results has composite unique constraint", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			// Insert a run first (FK requirement)
			db.exec(
				"INSERT INTO runs (id, plan_path, command) VALUES ('run1', '/test.md', 'run')",
			);

			// Insert an agent result
			db.exec(
				`INSERT INTO agent_results (id, run_id, role, template_name, phase, iteration, exit_code, duration_ms)
         VALUES ('id1', 'run1', 'author', 'tmpl', 1, 0, 0, 100)`,
			);

			// Same step identity with different id should conflict
			expect(() => {
				db.exec(
					`INSERT INTO agent_results (id, run_id, role, template_name, phase, iteration, exit_code, duration_ms)
           VALUES ('id2', 'run1', 'author', 'tmpl', 1, 0, 0, 200)`,
				);
			}).toThrow();
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
         VALUES ('qr1', 'run1', 1, 0, 1, '[]', 100)`,
			);

			expect(() => {
				db.exec(
					`INSERT INTO quality_results (id, run_id, phase, attempt, passed, results, duration_ms)
           VALUES ('qr2', 'run1', 1, 0, 0, '[]', 200)`,
				);
			}).toThrow();
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
			const version = getSchemaVersion(db);
			expect(version).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
