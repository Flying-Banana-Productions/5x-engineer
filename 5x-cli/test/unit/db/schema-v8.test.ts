import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import {
	_migrations,
	getSchemaVersion,
	runMigrations,
} from "../../../src/db/schema.js";

const dirs: string[] = [];
afterEach(() => {
	closeDb();
	_resetForTest();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function database() {
	const dir = mkdtempSync(join(tmpdir(), "5x-schema-v8-"));
	dirs.push(dir);
	return getDb(dir);
}

function migrateTo(db: ReturnType<typeof getDb>, version: number): void {
	for (const migration of _migrations) {
		if (migration.version > version) break;
		db.exec("BEGIN");
		migration.up(db);
		db.exec(
			`INSERT INTO schema_version(version) VALUES (${migration.version})`,
		);
		db.exec("COMMIT");
	}
}

describe("migration v8 review-budget indexes", () => {
	test("fresh database has v8 tables and nullable baseline assessment", () => {
		const db = database();
		runMigrations(db);
		expect(getSchemaVersion(db)).toBe(10);
		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table'")
			.all() as Array<{ name: string }>;
		expect(tables.map((row) => row.name)).toContain("review_budget_baselines");
		expect(tables.map((row) => row.name)).toContain("review_budget_snapshots");
		const column = (
			db.query("PRAGMA table_info(review_budget_snapshots)").all() as Array<{
				name: string;
				notnull: number;
			}>
		).find((item) => item.name === "baseline_assessment_json");
		expect(column?.notnull).toBe(0);
	});

	test("v7 to v8 preserves invocations", () => {
		const db = database();
		migrateTo(db, 7);
		db.exec("INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md')");
		db.exec(`INSERT INTO invocations (
			id, run_id, role, provider_name, handle_json, cancellation_supported, status
		) VALUES ('inv1', 'run1', 'reviewer', 'test', '{}', 0, 'running')`);
		runMigrations(db);
		expect(getSchemaVersion(db)).toBe(10);
		expect(
			(db.query("SELECT count(*) AS n FROM invocations").get() as { n: number })
				.n,
		).toBe(1);
	});

	test("constraints enforce run/key uniqueness, positive b0, and run foreign keys", () => {
		const db = database();
		runMigrations(db);
		db.exec("INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md')");
		const insert = (id: string, runId: string, key: string, b0 = 4) =>
			db
				.query(`INSERT INTO review_budget_baselines (
				id, run_id, record_idempotency_key, capture_kind, b0, b,
				original_ledger_json, surface_snapshot_json, config_snapshot_json, created_at
			) VALUES (?, ?, ?, 'initial', ?, 4, '{}', '{}', '{}', 'now')`)
				.run(id, runId, key, b0);
		insert("b1", "run1", "key1");
		expect(() => insert("b2", "run1", "key2")).toThrow();
		db.exec("INSERT INTO runs(id, plan_path) VALUES ('run2', '/plan2.md')");
		expect(() => insert("b3", "run2", "key1")).toThrow();
		expect(() => insert("b4", "run2", "key4", 0)).toThrow();
		expect(() => insert("b5", "missing", "key5")).toThrow();
	});
});
