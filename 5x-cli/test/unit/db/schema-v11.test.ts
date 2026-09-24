import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { getSchemaVersion, runMigrations } from "../../../src/db/schema.js";

test("v11 upgrades a v10 database with implementation projections", () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		expect(getSchemaVersion(db)).toBe(11);
		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table'")
			.all() as Array<{ name: string }>;
		const names = tables.map((row) => row.name);
		expect(names).toContain("implementation_binding_index");
		expect(names).toContain("implementation_observation_index");
		const decisionColumns = db
			.query("PRAGMA table_info(review_decision_index)")
			.all() as Array<{ name: string }>;
		expect(decisionColumns.map((row) => row.name)).toContain("domain");
		expect(decisionColumns.map((row) => row.name)).toContain("binding_id");
		const gateColumns = db
			.query("PRAGMA table_info(review_gate_index)")
			.all() as Array<{ name: string }>;
		expect(gateColumns.map((row) => row.name)).toContain("observation_id");
	} finally {
		db.close();
	}
});
