import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import {
	appendRunEvent,
	createRun,
	getActiveRun,
	getAgentResults,
	getLastRunEvent,
	getLatestRun,
	getLatestStatus,
	getLatestVerdict,
	getPlan,
	getQualityResults,
	getRunEvents,
	getRunHistory,
	getRunMetrics,
	hasCompletedStep,
	updateRunStatus,
	upsertAgentResult,
	upsertPlan,
	upsertQualityResult,
} from "../../src/db/operations.js";

function unwrap<T>(value: T | null): T {
	if (value === null) throw new Error("Expected value to be non-null");
	return value;
}

function unwrapDefined<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Expected value to be defined");
	return value;
}

import { runMigrations } from "../../src/db/schema.js";
import type { VerdictItem } from "../../src/protocol.js";

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
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		const run = unwrap(getActiveRun(db, "/plan.md"));
		expect(run.id).toBe("run1");
		expect(run.status).toBe("active");
		expect(run.command).toBe("run");
	});

	test("update run status to completed", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		updateRunStatus(db, "run1", "completed", "DONE", "3");

		const run = unwrap(getLatestRun(db, "/plan.md"));
		expect(run.status).toBe("completed");
		expect(run.current_state).toBe("DONE");
		expect(run.current_phase).toBe("3");
		expect(run.completed_at).not.toBeNull();
	});

	test("getActiveRun returns null after completion", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		updateRunStatus(db, "run1", "completed");
		expect(getActiveRun(db, "/plan.md")).toBeNull();
	});

	test("getLatestRun returns most recent", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "plan-review" });
		updateRunStatus(db, "run1", "completed");
		createRun(db, { id: "run2", planPath: "/plan.md", command: "run" });

		const latest = unwrap(getLatestRun(db, "/plan.md"));
		expect(latest.id).toBe("run2");
	});

	test("create run with review_path", () => {
		createRun(db, {
			id: "run1",
			planPath: "/plan.md",
			command: "plan-review",
			reviewPath: "/reviews/review.md",
		});
		const run = unwrap(getLatestRun(db, "/plan.md"));
		expect(run.review_path).toBe("/reviews/review.md");
	});
});

// --- Events ---

describe("events", () => {
	test("append and retrieve events", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		appendRunEvent(db, { runId: "run1", eventType: "phase_start", phase: "1" });
		appendRunEvent(db, {
			runId: "run1",
			eventType: "agent_invoke",
			phase: "1",
			iteration: 0,
			data: { template: "author-next-phase" },
		});

		const events = getRunEvents(db, "run1");
		expect(events).toHaveLength(2);
		const e0 = unwrapDefined(events[0]);
		const e1 = unwrapDefined(events[1]);
		expect(e0.event_type).toBe("phase_start");
		expect(e1.event_type).toBe("agent_invoke");
		const data = unwrapDefined(e1.data ?? undefined);
		expect(JSON.parse(data)).toEqual({
			template: "author-next-phase",
		});
	});

	test("events are ordered by insertion", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		appendRunEvent(db, { runId: "run1", eventType: "a" });
		appendRunEvent(db, { runId: "run1", eventType: "b" });
		appendRunEvent(db, { runId: "run1", eventType: "c" });
		const events = getRunEvents(db, "run1");
		expect(events.map((e) => e.event_type)).toEqual(["a", "b", "c"]);
	});
});

// --- Agent Results ---

describe("agent results", () => {
	test("upsert and retrieve", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		upsertAgentResult(db, {
			id: "ar1",
			run_id: "run1",
			phase: "1",
			iteration: 0,
			role: "author",
			template: "author-next-phase",
			result_type: "status",
			result_json: JSON.stringify({ result: "complete" }),
			duration_ms: 5000,
			tokens_in: 1000,
			tokens_out: 500,
			cost_usd: 0.05,
		});

		const results = getAgentResults(db, "run1", "1");
		expect(results).toHaveLength(1);
		const r0 = unwrapDefined(results[0]);
		expect(r0.role).toBe("author");
		expect(r0.result_type).toBe("status");
	});

	test("upsert on conflict replaces id and data", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });

		// First insert
		upsertAgentResult(db, {
			id: "old-id",
			run_id: "run1",
			phase: "1",
			iteration: 0,
			role: "author",
			template: "author-next-phase",
			result_type: "status",
			result_json: "null",
			duration_ms: 5000,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
		});

		// Upsert with same step identity, new id
		upsertAgentResult(db, {
			id: "new-id",
			run_id: "run1",
			phase: "1",
			iteration: 0,
			role: "author",
			template: "author-next-phase",
			result_type: "status",
			result_json: JSON.stringify({ result: "complete" }),
			duration_ms: 8000,
			tokens_in: 1000,
			tokens_out: 500,
			cost_usd: 0.05,
		});

		const results = getAgentResults(db, "run1", "1");
		expect(results).toHaveLength(1);
		// id should be updated to the new one (log file tracks latest attempt)
		const r0 = unwrapDefined(results[0]);
		expect(r0.id).toBe("new-id");
		expect(r0.result_type).toBe("status");
		expect(r0.duration_ms).toBe(8000);
	});

	test("hasCompletedStep returns true after insert", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		upsertAgentResult(db, {
			id: "ar1",
			run_id: "run1",
			phase: "2",
			iteration: 1,
			role: "reviewer",
			template: "reviewer-commit",
			result_type: "verdict",
			result_json: "null",
			duration_ms: 3000,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
		});

		expect(
			hasCompletedStep(
				db,
				"run1",
				"reviewer",
				"2",
				1,
				"reviewer-commit",
				"verdict",
			),
		).toBe(true);
		expect(
			hasCompletedStep(
				db,
				"run1",
				"reviewer",
				"2",
				2,
				"reviewer-commit",
				"verdict",
			),
		).toBe(false);
		expect(
			hasCompletedStep(
				db,
				"run1",
				"author",
				"2",
				1,
				"reviewer-commit",
				"verdict",
			),
		).toBe(false);
		// Wrong result_type should also return false
		expect(
			hasCompletedStep(
				db,
				"run1",
				"reviewer",
				"2",
				1,
				"reviewer-commit",
				"status",
			),
		).toBe(false);
	});

	test("getLatestVerdict returns parsed result JSON", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		const verdict = {
			readiness: "ready" as const,
			items: [] as VerdictItem[],
		};
		upsertAgentResult(db, {
			id: "ar1",
			run_id: "run1",
			phase: "1",
			iteration: 0,
			role: "reviewer",
			template: "reviewer-commit",
			result_type: "verdict",
			result_json: JSON.stringify(verdict),
			duration_ms: 3000,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
		});

		const result = getLatestVerdict(db, "run1", "1");
		expect(result).toEqual(verdict);
	});

	test("getLatestStatus returns parsed result JSON", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		const status = {
			result: "complete" as const,
			commit: "abc123",
		};
		upsertAgentResult(db, {
			id: "ar1",
			run_id: "run1",
			phase: "1",
			iteration: 0,
			role: "author",
			template: "author-next-phase",
			result_type: "status",
			result_json: JSON.stringify(status),
			duration_ms: 5000,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
		});

		const result = getLatestStatus(db, "run1", "1");
		expect(result).toEqual(status);
	});

	test("phase -1 sentinel works for plan-review", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "plan-review" });
		upsertAgentResult(db, {
			id: "ar1",
			run_id: "run1",
			phase: "-1",
			iteration: 0,
			role: "reviewer",
			template: "reviewer-plan",
			result_type: "verdict",
			result_json: "null",
			duration_ms: 3000,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
		});

		expect(
			hasCompletedStep(
				db,
				"run1",
				"reviewer",
				"-1",
				0,
				"reviewer-plan",
				"verdict",
			),
		).toBe(true);
		const results = getAgentResults(db, "run1", "-1");
		expect(results).toHaveLength(1);
	});

	test("filter by phase returns only matching results", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		for (const phase of ["1", "1", "2"]) {
			upsertAgentResult(db, {
				id: `ar-${phase}-${Math.random()}`,
				run_id: "run1",
				phase,
				iteration: phase === "1" ? getAgentResults(db, "run1", "1").length : 0,
				role: "author",
				template: "author-next-phase",
				result_type: "status",
				result_json: "null",
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});
		}

		expect(getAgentResults(db, "run1", "1")).toHaveLength(2);
		expect(getAgentResults(db, "run1", "2")).toHaveLength(1);
		expect(getAgentResults(db, "run1")).toHaveLength(3);
	});

	test("cross-phase ordering handles integer, decimal, and sentinel phases", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		// Insert phases out of numeric order to verify ordering
		const phases = ["10", "2", "1.1", "-1", "1", "2.3"];
		for (const phase of phases) {
			upsertAgentResult(db, {
				id: `ar-${phase}`,
				run_id: "run1",
				phase,
				iteration: 0,
				role: "author",
				template: "author-next-phase",
				result_type: "status",
				result_json: JSON.stringify({ result: "complete" }),
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});
		}

		const results = getAgentResults(db, "run1");
		const orderedPhases = results.map((r) => r.phase);
		expect(orderedPhases).toEqual(["-1", "1", "1.1", "2", "2.3", "10"]);
	});
});

// --- Quality Results ---

describe("quality results", () => {
	test("upsert and retrieve", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		upsertQualityResult(db, {
			id: "qr1",
			run_id: "run1",
			phase: "1",
			attempt: 0,
			passed: 1,
			results: JSON.stringify([{ command: "bun test", passed: true }]),
			duration_ms: 3000,
		});

		const results = getQualityResults(db, "run1", "1");
		expect(results).toHaveLength(1);
		const r0 = unwrapDefined(results[0]);
		expect(r0.passed).toBe(1);
	});

	test("upsert on conflict replaces result", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });

		upsertQualityResult(db, {
			id: "qr1",
			run_id: "run1",
			phase: "1",
			attempt: 0,
			passed: 0,
			results: JSON.stringify([{ command: "bun test", passed: false }]),
			duration_ms: 3000,
		});

		upsertQualityResult(db, {
			id: "qr2",
			run_id: "run1",
			phase: "1",
			attempt: 0,
			passed: 1,
			results: JSON.stringify([{ command: "bun test", passed: true }]),
			duration_ms: 4000,
		});

		const results = getQualityResults(db, "run1", "1");
		expect(results).toHaveLength(1);
		const r0 = unwrapDefined(results[0]);
		expect(r0.id).toBe("qr2");
		expect(r0.passed).toBe(1);
	});
});

// --- Reporting ---

describe("reporting", () => {
	test("getRunHistory returns runs with counts", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		appendRunEvent(db, { runId: "run1", eventType: "phase_start" });
		appendRunEvent(db, { runId: "run1", eventType: "agent_invoke" });

		const history = getRunHistory(db);
		expect(history).toHaveLength(1);
		const h0 = unwrapDefined(history[0]);
		expect(h0.event_count).toBe(2);
	});

	test("getRunHistory filters by plan path", () => {
		createRun(db, { id: "run1", planPath: "/plan-a.md", command: "run" });
		createRun(db, { id: "run2", planPath: "/plan-b.md", command: "run" });

		expect(getRunHistory(db, "/plan-a.md")).toHaveLength(1);
		expect(getRunHistory(db, "/plan-b.md")).toHaveLength(1);
		expect(getRunHistory(db)).toHaveLength(2);
	});

	test("getRunMetrics aggregates correctly", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });

		upsertAgentResult(db, {
			id: "ar1",
			run_id: "run1",
			phase: "1",
			iteration: 0,
			role: "author",
			template: "author-next-phase",
			result_type: "status",
			result_json: "{}",
			duration_ms: 5000,
			tokens_in: 1000,
			tokens_out: 500,
			cost_usd: 0.05,
		});

		upsertAgentResult(db, {
			id: "ar2",
			run_id: "run1",
			phase: "1",
			iteration: 1,
			role: "reviewer",
			template: "reviewer-commit",
			result_type: "verdict",
			result_json: "{}",
			duration_ms: 3000,
			tokens_in: 800,
			tokens_out: 400,
			cost_usd: 0.03,
		});

		upsertQualityResult(db, {
			id: "qr1",
			run_id: "run1",
			phase: "1",
			attempt: 0,
			passed: 0,
			results: "[]",
			duration_ms: 2000,
		});

		upsertQualityResult(db, {
			id: "qr2",
			run_id: "run1",
			phase: "1",
			attempt: 1,
			passed: 1,
			results: "[]",
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

		// Insert with relative-style path (resolve will make it absolute from cwd,
		// but we use the absolute tmp path to simulate)
		upsertPlan(db, { planPath: planFile });

		// Upsert again with the fully resolved absolute path
		upsertPlan(db, {
			planPath: absolutePath,
			worktreePath: "/tmp/wt",
			branch: "5x/test",
		});

		// Should be one row, not two
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

		// The stored path should be the canonical (real) path
		expect(rows[0]?.plan_path).toBe(resolve(planFile));
	});

	test("createRun deduplicates relative and absolute paths", () => {
		const planFile = join(tmp, "plan.md");
		writeFileSync(planFile, "# Test Plan\n");
		const absolutePath = resolve(planFile);

		createRun(db, { id: "run1", planPath: planFile, command: "run" });
		createRun(db, { id: "run2", planPath: absolutePath, command: "run" });

		// Both runs should store the same canonical plan_path
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

		createRun(db, { id: "run1", planPath: symlinkPath, command: "run" });

		const run = unwrap(getLatestRun(db, resolve(planFile)));
		expect(run.plan_path).toBe(resolve(planFile));
	});

	test("getActiveRun finds run created with non-canonical path when queried with canonical", () => {
		const planFile = join(tmp, "plan.md");
		writeFileSync(planFile, "# Test Plan\n");
		const absolutePath = resolve(planFile);

		// Create run with a path that will be canonicalized internally
		createRun(db, { id: "run1", planPath: planFile, command: "run" });

		// Query with canonical path should find it
		const active = getActiveRun(db, absolutePath);
		expect(active).not.toBeNull();
		expect(active?.id).toBe("run1");
	});
});

// --- getLastRunEvent ---

describe("getLastRunEvent", () => {
	test("returns the most recent event", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		appendRunEvent(db, { runId: "run1", eventType: "phase_start", phase: "1" });
		appendRunEvent(db, {
			runId: "run1",
			eventType: "agent_invoke",
			phase: "1",
			iteration: 0,
		});
		appendRunEvent(db, {
			runId: "run1",
			eventType: "verdict",
			phase: "1",
			iteration: 1,
		});

		const last = getLastRunEvent(db, "run1");
		expect(last).not.toBeNull();
		expect(last?.event_type).toBe("verdict");
	});

	test("returns null when no events exist", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
		const last = getLastRunEvent(db, "run1");
		expect(last).toBeNull();
	});

	test("returns null for non-existent run", () => {
		const last = getLastRunEvent(db, "nonexistent");
		expect(last).toBeNull();
	});
});

// --- Concurrent read (WAL) ---

describe("WAL concurrent access", () => {
	test("can read while write transaction is open", () => {
		createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });

		// Start a write via explicit transaction
		db.exec("BEGIN IMMEDIATE");
		appendRunEvent(db, { runId: "run1", eventType: "test" });

		// A separate read should still work due to WAL mode
		// (In WAL mode, readers don't block writers and vice versa)
		const run = getLatestRun(db, "/plan.md");
		expect(run).not.toBeNull();

		db.exec("COMMIT");
	});
});
