import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { getSchemaVersion, runMigrations } from "../../../src/db/schema.js";

test("v9 adds governance projections and versioned prompt context", () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		expect(getSchemaVersion(db)).toBe(10);
		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table'")
			.all() as Array<{ name: string }>;
		expect(tables.map((row) => row.name)).toContain("review_decision_index");
		expect(tables.map((row) => row.name)).toContain("review_gate_index");
		const promptColumns = db
			.query("PRAGMA table_info(prompts)")
			.all() as Array<{ name: string }>;
		expect(promptColumns.map((row) => row.name)).toContain("context_json");
		const baselineColumns = db
			.query("PRAGMA table_info(review_budget_baselines)")
			.all() as Array<{ name: string }>;
		expect(baselineColumns.map((row) => row.name)).toContain("mode");
		const snapshotColumns = db
			.query("PRAGMA table_info(review_budget_snapshots)")
			.all() as Array<{ name: string }>;
		expect(snapshotColumns.map((row) => row.name)).toContain(
			"prior_findings_json",
		);
		expect(snapshotColumns.map((row) => row.name)).toContain(
			"diagnostics_json",
		);
	} finally {
		db.close();
	}
});
