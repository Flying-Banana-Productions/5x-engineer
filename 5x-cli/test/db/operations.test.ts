import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { VerdictItem } from "../../src/parsers/signals.js";
import { getDb, closeDb, _resetForTest } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/schema.js";
import {
  upsertPlan,
  getPlan,
  createRun,
  updateRunStatus,
  getActiveRun,
  getLatestRun,
  appendRunEvent,
  getRunEvents,
  upsertAgentResult,
  getAgentResults,
  getLatestVerdict,
  getLatestStatus,
  hasCompletedStep,
  upsertQualityResult,
  getQualityResults,
  getRunHistory,
  getRunMetrics,
} from "../../src/db/operations.js";

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
    const plan = getPlan(db, "/test/plan.md");
    expect(plan).not.toBeNull();
    expect(plan!.plan_path).toBe("/test/plan.md");
    expect(plan!.worktree_path).toBeNull();
    expect(plan!.branch).toBeNull();
  });

  test("upsert updates worktree/branch", () => {
    upsertPlan(db, { planPath: "/test/plan.md" });
    upsertPlan(db, {
      planPath: "/test/plan.md",
      worktreePath: "/tmp/wt",
      branch: "5x/test",
    });
    const plan = getPlan(db, "/test/plan.md");
    expect(plan!.worktree_path).toBe("/tmp/wt");
    expect(plan!.branch).toBe("5x/test");
  });

  test("get non-existent plan returns null", () => {
    expect(getPlan(db, "/nope.md")).toBeNull();
  });
});

// --- Runs ---

describe("runs", () => {
  test("create and get active run", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
    const run = getActiveRun(db, "/plan.md");
    expect(run).not.toBeNull();
    expect(run!.id).toBe("run1");
    expect(run!.status).toBe("active");
    expect(run!.command).toBe("run");
  });

  test("update run status to completed", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
    updateRunStatus(db, "run1", "completed", "DONE", 3);

    const run = getLatestRun(db, "/plan.md");
    expect(run!.status).toBe("completed");
    expect(run!.current_state).toBe("DONE");
    expect(run!.current_phase).toBe(3);
    expect(run!.completed_at).not.toBeNull();
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

    const latest = getLatestRun(db, "/plan.md");
    expect(latest!.id).toBe("run2");
  });

  test("create run with review_path", () => {
    createRun(db, {
      id: "run1",
      planPath: "/plan.md",
      command: "plan-review",
      reviewPath: "/reviews/review.md",
    });
    const run = getLatestRun(db, "/plan.md");
    expect(run!.review_path).toBe("/reviews/review.md");
  });
});

// --- Events ---

describe("events", () => {
  test("append and retrieve events", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
    appendRunEvent(db, { runId: "run1", eventType: "phase_start", phase: 1 });
    appendRunEvent(db, {
      runId: "run1",
      eventType: "agent_invoke",
      phase: 1,
      iteration: 0,
      data: { template: "author-next-phase" },
    });

    const events = getRunEvents(db, "run1");
    expect(events).toHaveLength(2);
    expect(events[0]!.event_type).toBe("phase_start");
    expect(events[1]!.event_type).toBe("agent_invoke");
    expect(JSON.parse(events[1]!.data!)).toEqual({
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
      role: "author",
      template_name: "author-next-phase",
      phase: 1,
      iteration: 0,
      exit_code: 0,
      duration_ms: 5000,
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 0.05,
      signal_type: "status",
      signal_data: JSON.stringify({ result: "completed", phase: 1 }),
      created_at: new Date().toISOString(),
    });

    const results = getAgentResults(db, "run1", 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.role).toBe("author");
    expect(results[0]!.exit_code).toBe(0);
  });

  test("upsert on conflict replaces id and data", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });

    // First insert
    upsertAgentResult(db, {
      id: "old-id",
      run_id: "run1",
      role: "author",
      template_name: "author-next-phase",
      phase: 1,
      iteration: 0,
      exit_code: 1,
      duration_ms: 5000,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      signal_type: null,
      signal_data: null,
      created_at: new Date().toISOString(),
    });

    // Upsert with same step identity, new id
    upsertAgentResult(db, {
      id: "new-id",
      run_id: "run1",
      role: "author",
      template_name: "author-next-phase",
      phase: 1,
      iteration: 0,
      exit_code: 0,
      duration_ms: 8000,
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 0.05,
      signal_type: "status",
      signal_data: JSON.stringify({ result: "completed" }),
      created_at: new Date().toISOString(),
    });

    const results = getAgentResults(db, "run1", 1);
    expect(results).toHaveLength(1);
    // id should be updated to the new one (log file tracks latest attempt)
    expect(results[0]!.id).toBe("new-id");
    expect(results[0]!.exit_code).toBe(0);
    expect(results[0]!.duration_ms).toBe(8000);
  });

  test("hasCompletedStep returns true after insert", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
    upsertAgentResult(db, {
      id: "ar1",
      run_id: "run1",
      role: "reviewer",
      template_name: "reviewer-commit",
      phase: 2,
      iteration: 1,
      exit_code: 0,
      duration_ms: 3000,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      signal_type: null,
      signal_data: null,
      created_at: new Date().toISOString(),
    });

    expect(
      hasCompletedStep(db, "run1", "reviewer", 2, 1, "reviewer-commit")
    ).toBe(true);
    expect(
      hasCompletedStep(db, "run1", "reviewer", 2, 2, "reviewer-commit")
    ).toBe(false);
    expect(
      hasCompletedStep(db, "run1", "author", 2, 1, "reviewer-commit")
    ).toBe(false);
  });

  test("getLatestVerdict returns parsed signal data", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
    const verdict = {
      protocolVersion: 1 as const,
      readiness: "ready" as const,
      reviewPath: "/review.md",
      items: [] as VerdictItem[],
    };
    upsertAgentResult(db, {
      id: "ar1",
      run_id: "run1",
      role: "reviewer",
      template_name: "reviewer-commit",
      phase: 1,
      iteration: 0,
      exit_code: 0,
      duration_ms: 3000,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      signal_type: "verdict",
      signal_data: JSON.stringify(verdict),
      created_at: new Date().toISOString(),
    });

    const result = getLatestVerdict(db, "run1", 1);
    expect(result).toEqual(verdict);
  });

  test("getLatestStatus returns parsed signal data", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
    const status = {
      protocolVersion: 1 as const,
      result: "completed" as const,
      phase: 1,
      commit: "abc123",
    };
    upsertAgentResult(db, {
      id: "ar1",
      run_id: "run1",
      role: "author",
      template_name: "author-next-phase",
      phase: 1,
      iteration: 0,
      exit_code: 0,
      duration_ms: 5000,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      signal_type: "status",
      signal_data: JSON.stringify(status),
      created_at: new Date().toISOString(),
    });

    const result = getLatestStatus(db, "run1", 1);
    expect(result).toEqual(status);
  });

  test("phase -1 sentinel works for plan-review", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "plan-review" });
    upsertAgentResult(db, {
      id: "ar1",
      run_id: "run1",
      role: "reviewer",
      template_name: "reviewer-plan",
      phase: -1,
      iteration: 0,
      exit_code: 0,
      duration_ms: 3000,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      signal_type: null,
      signal_data: null,
      created_at: new Date().toISOString(),
    });

    expect(hasCompletedStep(db, "run1", "reviewer", -1, 0, "reviewer-plan")).toBe(true);
    const results = getAgentResults(db, "run1", -1);
    expect(results).toHaveLength(1);
  });

  test("filter by phase returns only matching results", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
    for (const phase of [1, 1, 2]) {
      upsertAgentResult(db, {
        id: `ar-${phase}-${Math.random()}`,
        run_id: "run1",
        role: "author",
        template_name: "author-next-phase",
        phase,
        iteration: phase === 1 ? (getAgentResults(db, "run1", 1).length) : 0,
        exit_code: 0,
        duration_ms: 1000,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        signal_type: null,
        signal_data: null,
        created_at: new Date().toISOString(),
      });
    }

    expect(getAgentResults(db, "run1", 1)).toHaveLength(2);
    expect(getAgentResults(db, "run1", 2)).toHaveLength(1);
    expect(getAgentResults(db, "run1")).toHaveLength(3);
  });
});

// --- Quality Results ---

describe("quality results", () => {
  test("upsert and retrieve", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });
    upsertQualityResult(db, {
      id: "qr1",
      run_id: "run1",
      phase: 1,
      attempt: 0,
      passed: 1,
      results: JSON.stringify([{ command: "bun test", passed: true }]),
      duration_ms: 3000,
      created_at: new Date().toISOString(),
    });

    const results = getQualityResults(db, "run1", 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(1);
  });

  test("upsert on conflict replaces result", () => {
    createRun(db, { id: "run1", planPath: "/plan.md", command: "run" });

    upsertQualityResult(db, {
      id: "qr1",
      run_id: "run1",
      phase: 1,
      attempt: 0,
      passed: 0,
      results: JSON.stringify([{ command: "bun test", passed: false }]),
      duration_ms: 3000,
      created_at: new Date().toISOString(),
    });

    upsertQualityResult(db, {
      id: "qr2",
      run_id: "run1",
      phase: 1,
      attempt: 0,
      passed: 1,
      results: JSON.stringify([{ command: "bun test", passed: true }]),
      duration_ms: 4000,
      created_at: new Date().toISOString(),
    });

    const results = getQualityResults(db, "run1", 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("qr2");
    expect(results[0]!.passed).toBe(1);
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
    expect(history[0]!.event_count).toBe(2);
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
      role: "author",
      template_name: "author-next-phase",
      phase: 1,
      iteration: 0,
      exit_code: 0,
      duration_ms: 5000,
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 0.05,
      signal_type: "status",
      signal_data: "{}",
      created_at: new Date().toISOString(),
    });

    upsertAgentResult(db, {
      id: "ar2",
      run_id: "run1",
      role: "reviewer",
      template_name: "reviewer-commit",
      phase: 1,
      iteration: 1,
      exit_code: 0,
      duration_ms: 3000,
      tokens_in: 800,
      tokens_out: 400,
      cost_usd: 0.03,
      signal_type: "verdict",
      signal_data: "{}",
      created_at: new Date().toISOString(),
    });

    upsertQualityResult(db, {
      id: "qr1",
      run_id: "run1",
      phase: 1,
      attempt: 0,
      passed: 0,
      results: "[]",
      duration_ms: 2000,
      created_at: new Date().toISOString(),
    });

    upsertQualityResult(db, {
      id: "qr2",
      run_id: "run1",
      phase: 1,
      attempt: 1,
      passed: 1,
      results: "[]",
      duration_ms: 2000,
      created_at: new Date().toISOString(),
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
