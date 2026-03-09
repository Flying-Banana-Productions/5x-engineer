import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import { recordStep } from "../../src/db/operations-v1.js";
import {
	_migrations,
	getSchemaVersion,
	runMigrations,
} from "../../src/db/schema.js";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "5x-db-schema-v4-"));
}

function getV4Migration() {
	const v4 = _migrations.find((m) => m.version === 4);
	if (!v4) throw new Error("v4 migration not found");
	return v4;
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

/** Run migrations up to a specific version (exclusive of `stopBefore`). */
function migrateUpTo(db: ReturnType<typeof getDb>, version: number): void {
	for (const m of _migrations) {
		if (m.version > version) break;
		db.exec("BEGIN TRANSACTION");
		m.up(db);
		db.exec(`INSERT INTO schema_version (version) VALUES (${m.version})`);
		db.exec("COMMIT");
	}
}

describe("migration v4: fresh DB", () => {
	test("fresh DB migrates to v4 successfully", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			expect(getSchemaVersion(db)).toBe(4);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("creates steps table with correct columns", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			const columns = db.query("PRAGMA table_info(steps)").all() as Array<{
				name: string;
				type: string;
				notnull: number;
			}>;
			const names = columns.map((c) => c.name);

			expect(names).toContain("id");
			expect(names).toContain("run_id");
			expect(names).toContain("step_name");
			expect(names).toContain("phase");
			expect(names).toContain("iteration");
			expect(names).toContain("result_json");
			expect(names).toContain("session_id");
			expect(names).toContain("model");
			expect(names).toContain("tokens_in");
			expect(names).toContain("tokens_out");
			expect(names).toContain("cost_usd");
			expect(names).toContain("duration_ms");
			expect(names).toContain("log_path");
			expect(names).toContain("created_at");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("v0 tables are dropped after migration", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			const tables = db
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as { name: string }[];
			const names = tables.map((t) => t.name);

			expect(names).toContain("steps");
			expect(names).toContain("runs");
			expect(names).toContain("plans");
			expect(names).toContain("schema_version");
			expect(names).not.toContain("agent_results");
			expect(names).not.toContain("quality_results");
			expect(names).not.toContain("run_events");
			expect(names).not.toContain("phase_progress");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("runs table has v1 columns after migration", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			const columns = db.query("PRAGMA table_info(runs)").all() as Array<{
				name: string;
			}>;
			const names = columns.map((c) => c.name);

			// v1 columns present
			expect(names).toContain("id");
			expect(names).toContain("plan_path");
			expect(names).toContain("status");
			expect(names).toContain("config_json");
			expect(names).toContain("created_at");
			expect(names).toContain("updated_at");

			// v0 columns removed
			expect(names).not.toContain("command");
			expect(names).not.toContain("current_state");
			expect(names).not.toContain("current_phase");
			expect(names).not.toContain("review_path");
			expect(names).not.toContain("started_at");
			expect(names).not.toContain("completed_at");
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
				 VALUES ('run1', 'author:impl:status', '1', 1, '{}')`,
			);

			// Duplicate should fail
			expect(() => {
				db.exec(
					`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
					 VALUES ('run1', 'author:impl:status', '1', 1, '{"different":true}')`,
				);
			}).toThrow();

			// Different iteration is allowed
			db.exec(
				`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
				 VALUES ('run1', 'author:impl:status', '1', 2, '{}')`,
			);

			// Different step_name is allowed
			db.exec(
				`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
				 VALUES ('run1', 'author:impl:verdict', '1', 1, '{}')`,
			);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v4: from v3 with existing data", () => {
	test("migrates agent_results to steps with correct step_name", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			// Run migrations 1-3
			migrateUpTo(db, 3);
			expect(getSchemaVersion(db)).toBe(3);

			// Insert v0 data
			db.exec(
				"INSERT INTO runs (id, plan_path, command, started_at) VALUES ('run1', '/plan.md', 'run', '2026-01-01 00:00:00')",
			);
			db.exec(
				`INSERT INTO agent_results (id, run_id, phase, iteration, role, template, result_type, result_json, duration_ms, tokens_in, tokens_out, cost_usd, session_id, model, log_path)
				 VALUES ('ar1', 'run1', '1', 0, 'author', 'author-next-phase', 'status', '{"result":"complete"}', 5000, 1000, 500, 0.05, 'sess1', 'gpt-4', '/logs/ar1.ndjson')`,
			);
			db.exec(
				`INSERT INTO agent_results (id, run_id, phase, iteration, role, template, result_type, result_json, duration_ms)
				 VALUES ('ar2', 'run1', '1', 0, 'author', 'author-next-phase', 'verdict', '{"readiness":"ready","items":[]}', 3000)`,
			);

			// Run v4 migration
			const v4 = _migrations.find((m) => m.version === 4);
			if (!v4) throw new Error("missing migration v4");
			db.exec("BEGIN TRANSACTION");
			v4.up(db);
			db.exec("INSERT INTO schema_version (version) VALUES (4)");
			db.exec("COMMIT");

			// Verify steps
			const steps = db
				.query(
					"SELECT * FROM steps WHERE run_id = 'run1' AND step_name LIKE 'author:%' ORDER BY step_name",
				)
				.all() as Array<{
				step_name: string;
				phase: string;
				iteration: number;
				result_json: string;
				session_id: string | null;
				model: string | null;
				tokens_in: number | null;
				tokens_out: number | null;
				cost_usd: number | null;
				duration_ms: number | null;
				log_path: string | null;
			}>;

			expect(steps).toHaveLength(2);

			// Both status and verdict rows should be distinct steps
			const stepNames = steps.map((s) => s.step_name).sort();
			expect(stepNames).toEqual([
				"author:author-next-phase:status",
				"author:author-next-phase:verdict",
			]);

			// Verify metadata carried over for the status step
			const statusStep = steps.find(
				(s) => s.step_name === "author:author-next-phase:status",
			);
			expect(statusStep).toBeDefined();
			expect(statusStep?.phase).toBe("1");
			expect(statusStep?.iteration).toBe(0);
			expect(statusStep?.session_id).toBe("sess1");
			expect(statusStep?.model).toBe("gpt-4");
			expect(statusStep?.tokens_in).toBe(1000);
			expect(statusStep?.tokens_out).toBe(500);
			expect(statusStep?.cost_usd).toBeCloseTo(0.05);
			expect(statusStep?.duration_ms).toBe(5000);
			expect(statusStep?.log_path).toBe("/logs/ar1.ndjson");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("migrates quality_results to steps", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			migrateUpTo(db, 3);

			db.exec(
				"INSERT INTO runs (id, plan_path, command) VALUES ('run1', '/plan.md', 'run')",
			);
			db.exec(
				`INSERT INTO quality_results (id, run_id, phase, attempt, passed, results, duration_ms)
				 VALUES ('qr1', 'run1', '1', 0, 1, '[{"command":"bun test","passed":true}]', 3000)`,
			);
			db.exec(
				`INSERT INTO quality_results (id, run_id, phase, attempt, passed, results, duration_ms)
				 VALUES ('qr2', 'run1', '1', 1, 0, '[{"command":"bun test","passed":false}]', 2000)`,
			);

			const v4 = getV4Migration();
			db.exec("BEGIN TRANSACTION");
			v4.up(db);
			db.exec("INSERT INTO schema_version (version) VALUES (4)");
			db.exec("COMMIT");

			const steps = db
				.query(
					"SELECT * FROM steps WHERE run_id = 'run1' AND step_name = 'quality:check' ORDER BY iteration",
				)
				.all() as Array<{
				step_name: string;
				phase: string;
				iteration: number;
				result_json: string;
				duration_ms: number | null;
			}>;

			expect(steps).toHaveLength(2);
			expect(steps[0]?.iteration).toBe(0);
			expect(steps[1]?.iteration).toBe(1);
			expect(steps[0]?.duration_ms).toBe(3000);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("migrates run_events to steps", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			migrateUpTo(db, 3);

			db.exec(
				"INSERT INTO runs (id, plan_path, command) VALUES ('run1', '/plan.md', 'run')",
			);
			db.exec(
				`INSERT INTO run_events (run_id, event_type, phase, iteration, data)
				 VALUES ('run1', 'phase_start', '1', 0, '{"msg":"starting"}')`,
			);
			db.exec(
				`INSERT INTO run_events (run_id, event_type, phase, data)
				 VALUES ('run1', 'agent_invoke', '1', NULL)`,
			);

			const v4 = getV4Migration();
			db.exec("BEGIN TRANSACTION");
			v4.up(db);
			db.exec("INSERT INTO schema_version (version) VALUES (4)");
			db.exec("COMMIT");

			const steps = db
				.query(
					"SELECT * FROM steps WHERE run_id = 'run1' AND step_name LIKE 'event:%' ORDER BY id",
				)
				.all() as Array<{
				step_name: string;
				phase: string | null;
				iteration: number;
				result_json: string;
			}>;

			expect(steps).toHaveLength(2);
			expect(steps[0]?.step_name).toBe("event:phase_start");
			expect(steps[0]?.result_json).toBe('{"msg":"starting"}');
			expect(steps[1]?.step_name).toBe("event:agent_invoke");
			expect(steps[1]?.result_json).toBe("{}"); // NULL data becomes '{}'
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("migrates phase_progress (approved) to steps", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			migrateUpTo(db, 3);

			// Need a plan for phase_progress FK
			db.exec("INSERT INTO plans (plan_path) VALUES ('/plan.md')");
			db.exec(
				"INSERT INTO runs (id, plan_path, command) VALUES ('run1', '/plan.md', 'run')",
			);
			db.exec(
				`INSERT INTO phase_progress (plan_path, phase, implementation_done, latest_review_readiness, review_approved, updated_at)
				 VALUES ('/plan.md', '1', 1, 'ready', 1, '2026-01-15 12:00:00')`,
			);
			// Non-approved phase should NOT be migrated
			db.exec(
				`INSERT INTO phase_progress (plan_path, phase, implementation_done, review_approved, updated_at)
				 VALUES ('/plan.md', '2', 1, 0, '2026-01-15 13:00:00')`,
			);

			const v4 = getV4Migration();
			db.exec("BEGIN TRANSACTION");
			v4.up(db);
			db.exec("INSERT INTO schema_version (version) VALUES (4)");
			db.exec("COMMIT");

			const steps = db
				.query("SELECT * FROM steps WHERE step_name = 'phase:complete'")
				.all() as Array<{
				run_id: string;
				step_name: string;
				phase: string;
				result_json: string;
			}>;

			expect(steps).toHaveLength(1);
			expect(steps[0]?.phase).toBe("1");
			expect(steps[0]?.run_id).toBe("run1");
			const result = JSON.parse(steps[0]?.result_json ?? "{}");
			expect(result.review_approved).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("runs table rebuild: started_at → created_at, completed_at → updated_at", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			migrateUpTo(db, 3);

			db.exec(
				`INSERT INTO runs (id, plan_path, command, status, started_at, completed_at)
				 VALUES ('run1', '/plan.md', 'run', 'completed', '2026-01-10 08:00:00', '2026-01-10 09:30:00')`,
			);
			db.exec(
				`INSERT INTO runs (id, plan_path, command, status, started_at)
				 VALUES ('run2', '/plan.md', 'run', 'active', '2026-01-11 10:00:00')`,
			);

			const v4 = getV4Migration();
			db.exec("BEGIN TRANSACTION");
			v4.up(db);
			db.exec("INSERT INTO schema_version (version) VALUES (4)");
			db.exec("COMMIT");

			const runs = db.query("SELECT * FROM runs ORDER BY id").all() as Array<{
				id: string;
				created_at: string;
				updated_at: string;
				status: string;
			}>;

			expect(runs).toHaveLength(2);

			// run1: started_at → created_at, completed_at → updated_at
			expect(runs[0]?.id).toBe("run1");
			expect(runs[0]?.created_at).toBe("2026-01-10 08:00:00");
			expect(runs[0]?.updated_at).toBe("2026-01-10 09:30:00");

			// run2: started_at → created_at, no completed_at → updated_at = started_at
			expect(runs[1]?.id).toBe("run2");
			expect(runs[1]?.created_at).toBe("2026-01-11 10:00:00");
			expect(runs[1]?.updated_at).toBe("2026-01-11 10:00:00");

			// Verify dropped columns are absent
			const columns = db.query("PRAGMA table_info(runs)").all() as Array<{
				name: string;
			}>;
			const names = columns.map((c) => c.name);
			expect(names).not.toContain("started_at");
			expect(names).not.toContain("completed_at");
			expect(names).not.toContain("current_state");
			expect(names).not.toContain("current_phase");
			expect(names).not.toContain("review_path");
			expect(names).toContain("config_json");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("migration with representative data (multiple runs, mixed result types)", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			migrateUpTo(db, 3);

			// Set up plans and runs
			db.exec("INSERT INTO plans (plan_path) VALUES ('/plan-a.md')");
			db.exec("INSERT INTO plans (plan_path) VALUES ('/plan-b.md')");
			db.exec(
				"INSERT INTO runs (id, plan_path, command, status, started_at, completed_at) VALUES ('run-a1', '/plan-a.md', 'run', 'completed', '2026-01-01 00:00:00', '2026-01-01 01:00:00')",
			);
			db.exec(
				"INSERT INTO runs (id, plan_path, command, status, started_at) VALUES ('run-a2', '/plan-a.md', 'run', 'active', '2026-01-02 00:00:00')",
			);
			db.exec(
				"INSERT INTO runs (id, plan_path, command, status, started_at) VALUES ('run-b1', '/plan-b.md', 'plan-review', 'active', '2026-01-03 00:00:00')",
			);

			// Agent results: multiple phases and iterations
			for (let i = 0; i < 3; i++) {
				db.exec(
					`INSERT INTO agent_results (id, run_id, phase, iteration, role, template, result_type, result_json, duration_ms)
					 VALUES ('ar-a2-${i}', 'run-a2', '${i + 1}', 0, 'author', 'author-next-phase', 'status', '{"result":"complete"}', ${1000 * (i + 1)})`,
				);
			}
			// Reviewer verdict
			db.exec(
				`INSERT INTO agent_results (id, run_id, phase, iteration, role, template, result_type, result_json, duration_ms)
				 VALUES ('ar-b1-v', 'run-b1', '-1', 0, 'reviewer', 'reviewer-plan', 'verdict', '{"readiness":"ready","items":[]}', 2000)`,
			);

			// Quality results
			db.exec(
				`INSERT INTO quality_results (id, run_id, phase, attempt, passed, results, duration_ms)
				 VALUES ('qr1', 'run-a2', '1', 0, 1, '[]', 500)`,
			);

			// Run events
			db.exec(
				`INSERT INTO run_events (run_id, event_type, phase, data)
				 VALUES ('run-a2', 'phase_start', '1', '{}')`,
			);

			// Phase progress
			db.exec(
				`INSERT INTO phase_progress (plan_path, phase, implementation_done, review_approved, updated_at)
				 VALUES ('/plan-a.md', '1', 1, 1, '2026-01-02 12:00:00')`,
			);
			db.exec(
				`INSERT INTO phase_progress (plan_path, phase, implementation_done, review_approved, updated_at)
				 VALUES ('/plan-a.md', '2', 0, 0, '2026-01-02 13:00:00')`,
			);

			// Count source rows before migration
			const agentCount = (
				db.query("SELECT COUNT(*) as c FROM agent_results").get() as {
					c: number;
				}
			).c;
			const qualityCount = (
				db.query("SELECT COUNT(*) as c FROM quality_results").get() as {
					c: number;
				}
			).c;
			const eventCount = (
				db.query("SELECT COUNT(*) as c FROM run_events").get() as { c: number }
			).c;
			const approvedPhaseCount = (
				db
					.query(
						"SELECT COUNT(*) as c FROM phase_progress WHERE review_approved = 1",
					)
					.get() as { c: number }
			).c;

			// Run migration
			const v4 = getV4Migration();
			db.exec("BEGIN TRANSACTION");
			v4.up(db);
			db.exec("INSERT INTO schema_version (version) VALUES (4)");
			db.exec("COMMIT");

			// Verify step counts
			const totalSteps = (
				db.query("SELECT COUNT(*) as c FROM steps").get() as { c: number }
			).c;
			expect(totalSteps).toBe(
				agentCount + qualityCount + eventCount + approvedPhaseCount,
			);

			// Verify all runs survived
			const runCount = (
				db.query("SELECT COUNT(*) as c FROM runs").get() as { c: number }
			).c;
			expect(runCount).toBe(3);

			// Verify plans survived
			const planCount = (
				db.query("SELECT COUNT(*) as c FROM plans").get() as { c: number }
			).c;
			expect(planCount).toBe(2);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("migration is idempotent via runMigrations", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);
			expect(getSchemaVersion(db)).toBe(4);

			// Second call should be no-op
			runMigrations(db);
			expect(getSchemaVersion(db)).toBe(4);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v4: recordStep INSERT OR IGNORE semantics", () => {
	test("first write wins — duplicate returns recorded=false", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			db.exec("INSERT INTO runs (id, plan_path) VALUES ('run1', '/plan.md')");

			const first = recordStep(db, {
				run_id: "run1",
				step_name: "author:impl:status",
				phase: "1",
				iteration: 1,
				result_json: '{"result":"complete"}',
				tokens_in: 1000,
			});
			expect(first.recorded).toBe(true);

			const second = recordStep(db, {
				run_id: "run1",
				step_name: "author:impl:status",
				phase: "1",
				iteration: 1,
				result_json: '{"result":"different"}',
				tokens_in: 2000,
			});
			expect(second.recorded).toBe(false);
			expect(second.step_id).toBe(first.step_id);

			// Verify the original data is preserved (first write wins)
			const row = db
				.query("SELECT result_json, tokens_in FROM steps WHERE id = ?1")
				.get(first.step_id) as { result_json: string; tokens_in: number };
			expect(row.result_json).toBe('{"result":"complete"}');
			expect(row.tokens_in).toBe(1000);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("auto-increment iteration works", () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			db.exec("INSERT INTO runs (id, plan_path) VALUES ('run1', '/plan.md')");

			const first = recordStep(db, {
				run_id: "run1",
				step_name: "author:impl:status",
				phase: "1",
				result_json: '{"result":"complete"}',
			});
			expect(first.iteration).toBe(1);

			const second = recordStep(db, {
				run_id: "run1",
				step_name: "author:impl:status",
				phase: "1",
				result_json: '{"result":"failed"}',
			});
			expect(second.iteration).toBe(2);
			expect(second.recorded).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});

describe("migration v4: computeRunSummary", () => {
	test("aggregates tokens, cost, duration, and phases completed", async () => {
		const tmp = makeTmp();
		try {
			const db = getDb(tmp);
			runMigrations(db);

			// We import computeRunSummary here since we need a v4 schema
			const { computeRunSummary } = await import(
				"../../src/db/operations-v1.js"
			);

			db.exec("INSERT INTO runs (id, plan_path) VALUES ('run1', '/plan.md')");

			// Author steps with token costs
			recordStep(db, {
				run_id: "run1",
				step_name: "author:impl:status",
				phase: "1",
				iteration: 1,
				result_json: '{"result":"complete"}',
				tokens_in: 1000,
				tokens_out: 500,
				cost_usd: 0.05,
				duration_ms: 5000,
			});

			recordStep(db, {
				run_id: "run1",
				step_name: "reviewer:review:verdict",
				phase: "1",
				iteration: 1,
				result_json: '{"readiness":"ready"}',
				tokens_in: 800,
				tokens_out: 300,
				cost_usd: 0.03,
				duration_ms: 3000,
			});

			// Phase complete step
			recordStep(db, {
				run_id: "run1",
				step_name: "phase:complete",
				phase: "1",
				iteration: 1,
				result_json: '{"approved":true}',
			});

			recordStep(db, {
				run_id: "run1",
				step_name: "phase:complete",
				phase: "2",
				iteration: 1,
				result_json: '{"approved":true}',
			});

			const summary = computeRunSummary(db, "run1");
			expect(summary.total_steps).toBe(4);
			expect(summary.total_tokens_in).toBe(1800);
			expect(summary.total_tokens_out).toBe(800);
			expect(summary.total_cost_usd).toBeCloseTo(0.08);
			expect(summary.total_duration_ms).toBe(8000);
			expect(summary.phases_completed).toEqual(["1", "2"]);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
