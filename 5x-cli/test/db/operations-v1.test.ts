import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import {
	completeRun,
	computeRunSummary,
	createRunV1,
	getActiveRunV1,
	getLatestStep,
	getRunV1,
	getSteps,
	getStepsByPhase,
	listRuns,
	nextIteration,
	recordStep,
	reopenRun,
} from "../../src/db/operations-v1.js";
import { runMigrations } from "../../src/db/schema.js";

let tmp: string;
let db: Database;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "5x-db-ops-v1-"));
	db = getDb(tmp);
	runMigrations(db);
});

afterEach(() => {
	closeDb();
	_resetForTest();
	rmSync(tmp, { recursive: true });
});

// --- Step operations ---

describe("recordStep", () => {
	test("records a new step and returns recorded=true", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		const result = recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 1,
			result_json: '{"result":"complete"}',
			tokens_in: 1000,
			tokens_out: 500,
			cost_usd: 0.05,
			duration_ms: 5000,
			session_id: "sess1",
			model: "gpt-4o",
			log_path: "/logs/agent-001.ndjson",
		});

		expect(result.recorded).toBe(true);
		expect(result.step_name).toBe("author:impl:status");
		expect(result.phase).toBe("1");
		expect(result.iteration).toBe(1);
		expect(result.step_id).toBeGreaterThan(0);
	});

	test("INSERT OR IGNORE: duplicate returns recorded=false with original step_id", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		const first = recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 1,
			result_json: '{"result":"complete"}',
		});

		const second = recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 1,
			result_json: '{"result":"different"}',
		});

		expect(second.recorded).toBe(false);
		expect(second.step_id).toBe(first.step_id);
	});

	test("auto-increments iteration when omitted", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		const r1 = recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			result_json: '{"iter":"first"}',
		});
		expect(r1.iteration).toBe(1);

		const r2 = recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			result_json: '{"iter":"second"}',
		});
		expect(r2.iteration).toBe(2);

		const r3 = recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			result_json: '{"iter":"third"}',
		});
		expect(r3.iteration).toBe(3);
	});

	test("auto-increment is scoped to (run_id, step_name, phase)", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			result_json: "{}",
		});

		// Different phase starts at 1
		const r = recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "2",
			result_json: "{}",
		});
		expect(r.iteration).toBe(1);

		// Different step_name starts at 1
		const r2 = recordStep(db, {
			run_id: "run1",
			step_name: "reviewer:review:verdict",
			phase: "1",
			result_json: "{}",
		});
		expect(r2.iteration).toBe(1);
	});

	test("step with null phase works", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		const r = recordStep(db, {
			run_id: "run1",
			step_name: "run:complete",
			result_json: '{"status":"completed"}',
		});
		expect(r.recorded).toBe(true);
		expect(r.phase).toBeNull();
	});

	test("optional fields default to null", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		const r = recordStep(db, {
			run_id: "run1",
			step_name: "event:test",
			iteration: 1,
			result_json: "{}",
		});

		const step = db
			.query("SELECT * FROM steps WHERE id = ?1")
			.get(r.step_id) as {
			session_id: string | null;
			model: string | null;
			tokens_in: number | null;
			tokens_out: number | null;
			cost_usd: number | null;
			duration_ms: number | null;
			log_path: string | null;
		};

		expect(step.session_id).toBeNull();
		expect(step.model).toBeNull();
		expect(step.tokens_in).toBeNull();
		expect(step.tokens_out).toBeNull();
		expect(step.cost_usd).toBeNull();
		expect(step.duration_ms).toBeNull();
		expect(step.log_path).toBeNull();
	});
});

describe("nextIteration", () => {
	test("returns 1 when no steps exist", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });
		expect(nextIteration(db, "run1", "author:impl:status", "1")).toBe(1);
	});

	test("returns max+1 after steps exist", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 3,
			result_json: "{}",
		});

		expect(nextIteration(db, "run1", "author:impl:status", "1")).toBe(4);
	});
});

describe("getSteps", () => {
	test("returns all steps ordered by id", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		recordStep(db, {
			run_id: "run1",
			step_name: "step-a",
			iteration: 1,
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "step-b",
			iteration: 1,
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "step-c",
			iteration: 1,
			result_json: "{}",
		});

		const steps = getSteps(db, "run1");
		expect(steps).toHaveLength(3);
		expect(steps.map((s) => s.step_name)).toEqual([
			"step-a",
			"step-b",
			"step-c",
		]);
	});

	test("--since-step returns only steps after the given ID", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		const r1 = recordStep(db, {
			run_id: "run1",
			step_name: "step-a",
			iteration: 1,
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "step-b",
			iteration: 1,
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "step-c",
			iteration: 1,
			result_json: "{}",
		});

		const steps = getSteps(db, "run1", { sinceStepId: r1.step_id });
		expect(steps).toHaveLength(2);
		expect(steps.map((s) => s.step_name)).toEqual(["step-b", "step-c"]);
	});

	test("--tail returns only the last N steps", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		for (let i = 0; i < 5; i++) {
			recordStep(db, {
				run_id: "run1",
				step_name: `step-${i}`,
				iteration: 1,
				result_json: "{}",
			});
		}

		const steps = getSteps(db, "run1", { tail: 2 });
		expect(steps).toHaveLength(2);
		expect(steps.map((s) => s.step_name)).toEqual(["step-3", "step-4"]);
	});

	test("returns empty array for unknown run", () => {
		expect(getSteps(db, "nonexistent")).toEqual([]);
	});
});

describe("getStepsByPhase", () => {
	test("returns steps for a specific phase", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 1,
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "2",
			iteration: 1,
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "quality:check",
			phase: "1",
			iteration: 1,
			result_json: "{}",
		});

		const phase1Steps = getStepsByPhase(db, "run1", "1");
		expect(phase1Steps).toHaveLength(2);

		const phase2Steps = getStepsByPhase(db, "run1", "2");
		expect(phase2Steps).toHaveLength(1);
	});
});

describe("getLatestStep", () => {
	test("returns the most recent step with given name", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 1,
			result_json: '{"iter":1}',
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 2,
			result_json: '{"iter":2}',
		});

		const latest = getLatestStep(db, "run1", "author:impl:status");
		expect(latest).not.toBeNull();
		expect(latest?.iteration).toBe(2);
		expect(latest?.result_json).toBe('{"iter":2}');
	});

	test("returns null when no matching step exists", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });
		expect(getLatestStep(db, "run1", "nonexistent")).toBeNull();
	});
});

// --- Run operations ---

describe("createRunV1", () => {
	test("creates a run with minimal fields", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		const run = getRunV1(db, "run1");
		expect(run).not.toBeNull();
		expect(run?.id).toBe("run1");
		expect(run?.status).toBe("active");
		expect(run?.command).toBeNull();
		expect(run?.config_json).toBeNull();
	});

	test("creates a run with all fields", () => {
		createRunV1(db, {
			id: "run1",
			planPath: "/plan.md",
			command: "run",
			configJson: '{"maxStepsPerRun":50}',
		});

		const run = getRunV1(db, "run1");
		expect(run).not.toBeNull();
		expect(run?.command).toBe("run");
		expect(run?.config_json).toBe('{"maxStepsPerRun":50}');
	});

	test("canonicalizes plan path", () => {
		const planFile = join(tmp, "plan.md");
		writeFileSync(planFile, "# Test Plan\n");
		const canonical = resolve(planFile);

		createRunV1(db, { id: "run1", planPath: planFile });

		const run = getRunV1(db, "run1");
		expect(run?.plan_path).toBe(canonical);
	});
});

describe("getRunV1", () => {
	test("returns null for non-existent run", () => {
		expect(getRunV1(db, "nonexistent")).toBeNull();
	});
});

describe("getActiveRunV1", () => {
	test("finds active run for a plan", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md", command: "run" });

		const active = getActiveRunV1(db, "/plan.md");
		expect(active).not.toBeNull();
		expect(active?.id).toBe("run1");
	});

	test("returns null after run is completed", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });
		completeRun(db, "run1", "completed");

		expect(getActiveRunV1(db, "/plan.md")).toBeNull();
	});

	test("returns most recent active run", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });
		completeRun(db, "run1", "completed");
		createRunV1(db, { id: "run2", planPath: "/plan.md" });

		const active = getActiveRunV1(db, "/plan.md");
		expect(active?.id).toBe("run2");
	});
});

describe("completeRun", () => {
	test("sets status to completed and updates updated_at", () => {
		// Manually set a known created_at in the past so updated_at differs
		db.exec(
			`INSERT INTO runs (id, plan_path, status, created_at, updated_at)
			 VALUES ('run1', '/plan.md', 'active', '2025-01-01 00:00:00', '2025-01-01 00:00:00')`,
		);

		completeRun(db, "run1", "completed");
		const after = getRunV1(db, "run1");
		expect(after).toBeDefined();

		expect(after?.status).toBe("completed");
		expect(after?.updated_at).not.toBe("2025-01-01 00:00:00");
	});

	test("sets status to aborted", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });
		completeRun(db, "run1", "aborted");

		const run = getRunV1(db, "run1");
		expect(run).toBeDefined();
		expect(run?.status).toBe("aborted");
	});
});

describe("reopenRun", () => {
	test("sets completed run back to active", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });
		completeRun(db, "run1", "completed");
		expect(getRunV1(db, "run1")?.status).toBe("completed");

		reopenRun(db, "run1");
		expect(getRunV1(db, "run1")?.status).toBe("active");
	});

	test("sets aborted run back to active", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });
		completeRun(db, "run1", "aborted");

		reopenRun(db, "run1");
		expect(getRunV1(db, "run1")?.status).toBe("active");
	});
});

describe("listRuns", () => {
	test("lists all runs with step counts", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md", command: "run" });
		createRunV1(db, { id: "run2", planPath: "/plan.md", command: "run" });

		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 1,
			result_json: "{}",
		});
		recordStep(db, {
			run_id: "run1",
			step_name: "quality:check",
			phase: "1",
			iteration: 1,
			result_json: "{}",
		});

		const runs = listRuns(db);
		expect(runs).toHaveLength(2);

		// Most recent first
		const run2 = runs.find((r) => r.id === "run2");
		const run1 = runs.find((r) => r.id === "run1");
		expect(run1).toBeDefined();
		expect(run2).toBeDefined();
		expect(run1?.step_count).toBe(2);
		expect(run2?.step_count).toBe(0);
	});

	test("filters by plan path", () => {
		createRunV1(db, { id: "run1", planPath: "/plan-a.md" });
		createRunV1(db, { id: "run2", planPath: "/plan-b.md" });

		const runs = listRuns(db, { planPath: "/plan-a.md" });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe("run1");
	});

	test("filters by status", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });
		createRunV1(db, { id: "run2", planPath: "/plan.md" });
		completeRun(db, "run1", "completed");

		const activeRuns = listRuns(db, { status: "active" });
		expect(activeRuns).toHaveLength(1);
		expect(activeRuns[0]?.id).toBe("run2");

		const completedRuns = listRuns(db, { status: "completed" });
		expect(completedRuns).toHaveLength(1);
		expect(completedRuns[0]?.id).toBe("run1");
	});

	test("respects limit", () => {
		for (let i = 0; i < 10; i++) {
			createRunV1(db, { id: `run-${i}`, planPath: "/plan.md" });
		}

		const runs = listRuns(db, { limit: 3 });
		expect(runs).toHaveLength(3);
	});
});

describe("computeRunSummary", () => {
	test("returns zeros for run with no steps", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		const summary = computeRunSummary(db, "run1");
		expect(summary.total_steps).toBe(0);
		expect(summary.phases_completed).toEqual([]);
		expect(summary.total_tokens_in).toBe(0);
		expect(summary.total_tokens_out).toBe(0);
		expect(summary.total_cost_usd).toBe(0);
		expect(summary.total_duration_ms).toBe(0);
	});

	test("aggregates across multiple steps", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		recordStep(db, {
			run_id: "run1",
			step_name: "author:impl:status",
			phase: "1",
			iteration: 1,
			result_json: "{}",
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
			result_json: "{}",
			tokens_in: 800,
			tokens_out: 300,
			cost_usd: 0.03,
			duration_ms: 3000,
		});

		recordStep(db, {
			run_id: "run1",
			step_name: "phase:complete",
			phase: "1",
			iteration: 1,
			result_json: "{}",
		});

		const summary = computeRunSummary(db, "run1");
		expect(summary.total_steps).toBe(3);
		expect(summary.total_tokens_in).toBe(1800);
		expect(summary.total_tokens_out).toBe(800);
		expect(summary.total_cost_usd).toBeCloseTo(0.08);
		expect(summary.total_duration_ms).toBe(8000);
		expect(summary.phases_completed).toEqual(["1"]);
	});

	test("phases_completed are ordered numerically", () => {
		createRunV1(db, { id: "run1", planPath: "/plan.md" });

		// Insert out of order
		for (const phase of ["3", "1", "2"]) {
			recordStep(db, {
				run_id: "run1",
				step_name: "phase:complete",
				phase,
				iteration: 1,
				result_json: "{}",
			});
		}

		const summary = computeRunSummary(db, "run1");
		expect(summary.phases_completed).toEqual(["1", "2", "3"]);
	});
});
