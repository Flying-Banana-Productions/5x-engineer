import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import {
	createRun,
	getActiveRun,
	getLatestRun,
	getPlan,
	getRunHistory,
	getRunMetrics,
	updateRunStatus,
	upsertPlan,
} from "../../src/db/operations.js";
import { recordStep } from "../../src/db/operations-v1.js";

function unwrap<T>(value: T | null): T {
	if (value === null) throw new Error("Expected value to be non-null");
	return value;
}

import { runMigrations } from "../../src/db/schema.js";

let tmp: string;
let db: Database;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "5x-db-ops-"));
	db = getDb(tmp);
	runMigrations(db);
});

afterEach(() => {
	closeDb();
	_resetForTest();
	rmSync(tmp, { recursive: true });
});

// --- Plans ---

describe("plans", () => {
	test("upsert and get plan", () => {
		upsertPlan(db, { planPath: "/test/plan.md" });
		const plan = unwrap(getPlan(db, "/test/plan.md"));
		expect(plan.plan_path).toBe("/test/plan.md");
		expect(plan.worktree_path).toBeNull();
		expect(plan.branch).toBeNull();
	});

	test("upsert updates worktree/branch", () => {
		upsertPlan(db, { planPath: "/test/plan.md" });
		upsertPlan(db, {
			planPath: "/test/plan.md",
			worktreePath: "/tmp/wt",
			branch: "5x/test",
		});
		const plan = unwrap(getPlan(db, "/test/plan.md"));
		expect(plan.worktree_path).toBe("/tmp/wt");
		expect(plan.branch).toBe("5x/test");
	});

	test("get non-existent plan returns null", () => {
		expect(getPlan(db, "/nope.md")).toBeNull();
	});

	test("upsertPlan with empty string clears worktree/branch", () => {
		upsertPlan(db, {
			planPath: "/test/plan.md",
			worktreePath: "/tmp/wt",
			branch: "5x/test",
		});
		const before = unwrap(getPlan(db, "/test/plan.md"));
		expect(before.worktree_path).toBe("/tmp/wt");
		expect(before.branch).toBe("5x/test");

		// Pass empty string to explicitly clear
		upsertPlan(db, { planPath: "/test/plan.md", worktreePath: "", branch: "" });
		const after = unwrap(getPlan(db, "/test/plan.md"));
		expect(after.worktree_path).toBeNull();
		expect(after.branch).toBeNull();
	});

	test("upsertPlan with undefined preserves existing values", () => {
		upsertPlan(db, {
			planPath: "/test/plan.md",
			worktreePath: "/tmp/wt",
			branch: "5x/test",
		});

		// Omit worktreePath/branch — should preserve existing
		upsertPlan(db, { planPath: "/test/plan.md" });
		const plan = unwrap(getPlan(db, "/test/plan.md"));
		expect(plan.worktree_path).toBe("/tmp/wt");
		expect(plan.branch).toBe("5x/test");
	});
});

// --- Runs ---

describe("runs", () => {
	test("create and get active run", () => {
		createRun(db, { id: "run1", planPath: "/plan.md" });
		const run = unwrap(getActiveRun(db, "/plan.md"));
		expect(run.id).toBe("run1");
		expect(run.status).toBe("active");
	});

	test("update run status to completed", () => {
		createRun(db, { id: "run1", planPath: "/plan.md" });
		updateRunStatus(db, "run1", "completed");

		const run = unwrap(getLatestRun(db, "/plan.md"));
		expect(run.status).toBe("completed");
	});

	test("getActiveRun returns null after completion", () => {
		createRun(db, { id: "run1", planPath: "/plan.md" });
		updateRunStatus(db, "run1", "completed");
		expect(getActiveRun(db, "/plan.md")).toBeNull();
	});

	test("getLatestRun returns most recent", () => {
		createRun(db, { id: "run1", planPath: "/plan.md" });
		updateRunStatus(db, "run1", "completed");
		createRun(db, { id: "run2", planPath: "/plan.md" });

		const latest = unwrap(getLatestRun(db, "/plan.md"));
		expect(latest.id).toBe("run2");
	});
});

// --- Reporting ---

describe("reporting", () => {
	test("getRunHistory returns runs with step counts", () => {
		createRun(db, { id: "run1", planPath: "/plan.md" });
		recordStep(db, {
			run_id: "run1",
			step_name: "event:phase_start",
			iteration: 1,
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			iteration: 1,
			result_json: "{}",
		});

		const history = getRunHistory(db);
		expect(history).toHaveLength(1);
		expect(history[0]?.step_count).toBe(2);
	});

	test("getRunHistory filters by plan path", () => {
		createRun(db, { id: "run1", planPath: "/plan-a.md" });
		createRun(db, { id: "run2", planPath: "/plan-b.md" });

		expect(getRunHistory(db, "/plan-a.md")).toHaveLength(1);
		expect(getRunHistory(db, "/plan-b.md")).toHaveLength(1);
		expect(getRunHistory(db)).toHaveLength(2);
	});

	test("getRunMetrics aggregates correctly", () => {
		createRun(db, { id: "run1", planPath: "/plan.md" });

		recordStep(db, {
			run_id: "run1",
			step_name: "author:author-next-phase:status",
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
			step_name: "reviewer:reviewer-commit:verdict",
			phase: "1",
			iteration: 1,
			result_json: '{"readiness":"ready"}',
			tokens_in: 800,
			tokens_out: 400,
			cost_usd: 0.03,
			duration_ms: 3000,
		});

		recordStep(db, {
			run_id: "run1",
			step_name: "quality:check",
			phase: "1",
			iteration: 1,
			result_json: '{"passed":0}',
			duration_ms: 2000,
		});

		recordStep(db, {
			run_id: "run1",
			step_name: "quality:check",
			phase: "1",
			iteration: 2,
			result_json: '{"passed":1}',
			duration_ms: 2000,
		});

		const metrics = getRunMetrics(db, "run1");
		expect(metrics.total_agent_invocations).toBe(2);
		expect(metrics.author_invocations).toBe(1);
		expect(metrics.reviewer_invocations).toBe(1);
		expect(metrics.total_tokens_in).toBe(1800);
		expect(metrics.total_tokens_out).toBe(900);
		expect(metrics.total_cost_usd).toBeCloseTo(0.08);
		expect(metrics.quality_passed).toBe(1);
		expect(metrics.quality_failed).toBe(1);
	});
});

// --- Canonical path deduplication (P1 regression) ---

describe("canonical path enforcement", () => {
	test("upsertPlan deduplicates relative and absolute paths to same file", () => {
		// Create a real file so canonicalization resolves it
		const planFile = join(tmp, "plan.md");
		writeFileSync(planFile, "# Test Plan\n");
		const absolutePath = resolve(planFile);

		upsertPlan(db, { planPath: planFile });
		upsertPlan(db, {
			planPath: absolutePath,
			worktreePath: "/tmp/wt",
			branch: "5x/test",
		});

		const rows = db.query("SELECT * FROM plans").all() as Array<{
			plan_path: string;
		}>;
		expect(rows).toHaveLength(1);

		const plan = unwrap(getPlan(db, absolutePath));
		expect(plan.worktree_path).toBe("/tmp/wt");
	});

	test("upsertPlan deduplicates symlink paths to same canonical file", () => {
		const planFile = join(tmp, "real-plan.md");
		writeFileSync(planFile, "# Test Plan\n");
		const symlinkPath = join(tmp, "link-plan.md");
		symlinkSync(planFile, symlinkPath);

		upsertPlan(db, { planPath: planFile });
		upsertPlan(db, { planPath: symlinkPath, branch: "5x/symlink" });

		const rows = db.query("SELECT * FROM plans").all() as Array<{
			plan_path: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.plan_path).toBe(resolve(planFile));
	});

	test("createRun deduplicates relative and absolute paths", () => {
		const planFile = join(tmp, "plan.md");
		writeFileSync(planFile, "# Test Plan\n");
		const absolutePath = resolve(planFile);

		createRun(db, { id: "run1", planPath: planFile });
		createRun(db, { id: "run2", planPath: absolutePath });

		const run1 = unwrap(getLatestRun(db, absolutePath));
		expect(run1.plan_path).toBe(absolutePath);

		const runs = db.query("SELECT * FROM runs ORDER BY rowid").all() as Array<{
			plan_path: string;
		}>;
		expect(runs[0]?.plan_path).toBe(runs[1]?.plan_path);
	});

	test("createRun deduplicates symlink paths", () => {
		const planFile = join(tmp, "real-plan.md");
		writeFileSync(planFile, "# Test Plan\n");
		const symlinkPath = join(tmp, "link-plan.md");
		symlinkSync(planFile, symlinkPath);

		createRun(db, { id: "run1", planPath: symlinkPath });

		const run = unwrap(getLatestRun(db, resolve(planFile)));
		expect(run.plan_path).toBe(resolve(planFile));
	});

	test("getActiveRun finds run created with non-canonical path when queried with canonical", () => {
		const planFile = join(tmp, "plan.md");
		writeFileSync(planFile, "# Test Plan\n");
		const absolutePath = resolve(planFile);

		createRun(db, { id: "run1", planPath: planFile });

		const active = getActiveRun(db, absolutePath);
		expect(active).not.toBeNull();
		expect(active?.id).toBe("run1");
	});
});

// --- Concurrent read (WAL) ---

describe("WAL concurrent access", () => {
	test("can read while write transaction is open", () => {
		createRun(db, { id: "run1", planPath: "/plan.md" });

		db.exec("BEGIN IMMEDIATE");
		recordStep(db, {
			run_id: "run1",
			step_name: "event:test",
			iteration: 1,
			result_json: "{}",
		});

		const run = getLatestRun(db, "/plan.md");
		expect(run).not.toBeNull();

		db.exec("COMMIT");
	});
});
