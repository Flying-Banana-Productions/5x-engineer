import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentAdapter,
	InvokeOptions,
	InvokeStatus,
	InvokeVerdict,
} from "../../src/agents/types.js";
import type { FiveXConfig } from "../../src/config.js";
import {
	createRun,
	getAgentResults,
	getRunEvents,
	setPhaseReviewApproved,
	updateRunStatus,
	upsertAgentResult,
} from "../../src/db/operations.js";
import { runMigrations } from "../../src/db/schema.js";
import type {
	EscalationEvent,
	EscalationResponse,
	PhaseSummary,
} from "../../src/gates/human.js";
import {
	resolvePhaseReviewPath,
	runPhaseExecutionLoop,
} from "../../src/orchestrator/phase-execution-loop.js";
import type { AuthorStatus, ReviewerVerdict } from "../../src/protocol.js";
import type { TuiController } from "../../src/tui/controller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAN_CONTENT = `# Test Plan

**Version:** 1.0
**Status:** Draft

## Phase 1: Foundation

**Completion gate:** All items done.

- [ ] Set up project
- [ ] Add config

## Phase 2: Features

**Completion gate:** Features work.

- [ ] Add feature A
- [ ] Add feature B

## Phase 3: Polish

**Completion gate:** Everything polished.

- [ ] Polish UI
`;

const PLAN_ONE_PHASE = `# Simple Plan

**Version:** 1.0
**Status:** Draft

## Phase 1: Only Phase

- [ ] Do the thing
`;

/** Create an isolated test environment. Returns { tmp, db, planPath, reviewPath, cleanup }. */
function createTestEnv(planContent: string = PLAN_CONTENT) {
	const tmp = mkdtempSync(join(tmpdir(), "5x-pe-"));
	const dbPath = join(tmp, ".5x", "5x.db");
	mkdirSync(join(tmp, ".5x"), { recursive: true });

	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);

	const plansDir = join(tmp, "docs", "development");
	mkdirSync(plansDir, { recursive: true });
	const planPath = join(plansDir, "001-test-plan.md");
	writeFileSync(planPath, planContent);

	const reviewsDir = join(tmp, "docs", "development", "reviews");
	mkdirSync(reviewsDir, { recursive: true });
	const reviewPath = join(reviewsDir, "test-review.md");
	// Create review file so audit record append doesn't fail
	writeFileSync(reviewPath, "");

	const cleanup = () => {
		try {
			db.close();
		} catch {}
		rmSync(tmp, { recursive: true, force: true });
	};

	return { tmp, db, planPath, reviewPath, cleanup };
}

function defaultConfig(tmp: string): FiveXConfig {
	return {
		author: {},
		reviewer: {},
		qualityGates: [],
		worktree: {},
		paths: {
			plans: "docs/development",
			reviews: join(tmp, "docs", "development", "reviews"),
			archive: "docs/archive",
			templates: {
				plan: "docs/_implementation_plan_template.md",
				review: "docs/development/reviews/_review_template.md",
			},
		},
		db: { path: ".5x/5x.db" },
		maxReviewIterations: 5,
		maxQualityRetries: 3,
		maxAutoIterations: 10,
		maxAutoRetries: 3,
	};
}

/** A single mock response for the adapter queue. */
type MockResponse =
	| {
			type: "status";
			status: AuthorStatus;
			duration?: number;
			sessionId?: string;
			writeFile?: { path: string; content: string };
	  }
	| {
			type: "verdict";
			verdict: ReviewerVerdict;
			duration?: number;
			sessionId?: string;
			writeFile?: { path: string; content: string };
	  }
	| {
			type: "error";
			error: Error;
	  };

/** Build a mock adapter from a queue of responses (called in order). */
function createMockAdapter(
	responses: MockResponse[],
): AgentAdapter & { callCount: number; lastOpts?: InvokeOptions } {
	let idx = 0;
	const adapter = {
		callCount: 0,
		lastOpts: undefined as InvokeOptions | undefined,
		serverUrl: "http://127.0.0.1:51234",
		async invokeForStatus(opts: InvokeOptions): Promise<InvokeStatus> {
			adapter.callCount++;
			adapter.lastOpts = opts;
			const r = responses[idx++];
			if (!r) throw new Error(`Mock adapter exhausted after ${idx - 1} calls`);
			if (r.type === "error") throw r.error;
			if (r.type !== "status")
				throw new Error(
					`Expected status response at index ${idx - 1}, got ${r.type}`,
				);
			if (r.writeFile) writeFileSync(r.writeFile.path, r.writeFile.content);
			return {
				type: "status",
				status: r.status,
				duration: r.duration ?? 1000,
				sessionId: r.sessionId ?? "mock-session",
			};
		},
		async invokeForVerdict(opts: InvokeOptions): Promise<InvokeVerdict> {
			adapter.callCount++;
			adapter.lastOpts = opts;
			const r = responses[idx++];
			if (!r) throw new Error(`Mock adapter exhausted after ${idx - 1} calls`);
			if (r.type === "error") throw r.error;
			if (r.type !== "verdict")
				throw new Error(
					`Expected verdict response at index ${idx - 1}, got ${r.type}`,
				);
			if (r.writeFile) writeFileSync(r.writeFile.path, r.writeFile.content);
			return {
				type: "verdict",
				verdict: r.verdict,
				duration: r.duration ?? 1000,
				sessionId: r.sessionId ?? "mock-session",
			};
		},
		async verify() {},
		async close() {},
	};
	return adapter;
}

function resolveQuietOpt(quiet: InvokeOptions["quiet"]): boolean {
	if (typeof quiet === "function") return quiet();
	return quiet ?? false;
}

function fixedPhaseGate(decision: "continue" | "exit" | "abort") {
	return async (_summary: PhaseSummary) => decision;
}

function fixedEscalationGate(action: "continue" | "approve" | "abort") {
	return async (_event: EscalationEvent): Promise<EscalationResponse> => ({
		action,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPhaseExecutionLoop", () => {
	test("resolvePhaseReviewPath defaults to per-phase filenames", () => {
		const base = "/tmp/reviews/2026-02-20-001-test-plan-review.md";
		expect(resolvePhaseReviewPath(base, "1")).toBe(
			"/tmp/reviews/2026-02-20-001-test-plan-phase-1-review.md",
		);
		expect(resolvePhaseReviewPath(base, "1.1")).toBe(
			"/tmp/reviews/2026-02-20-001-test-plan-phase-1.1-review.md",
		);
	});

	test("resolvePhaseReviewPath always produces per-phase paths even when base exists", () => {
		const { reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		try {
			expect(existsSync(reviewPath)).toBe(true);
			// Even when the base review file exists on disk, per-phase paths are produced.
			// This prevents implementation reviews from being appended to plan review files.
			const expected = reviewPath.replace(
				"test-review.md",
				"test-phase-2-review.md",
			);
			expect(resolvePhaseReviewPath(reviewPath, "2")).toBe(expected);
		} finally {
			cleanup();
		}
	});

	test("resolvePhaseReviewPath supports {phase} token", () => {
		const template = "/tmp/reviews/plan-{phase}-review.md";
		expect(resolvePhaseReviewPath(template, "3")).toBe(
			"/tmp/reviews/plan-3-review.md",
		);
	});

	test("phase execution does not rely on checklist completion for gating", async () => {
		const checkedPlan = `# Simple Plan

## Phase 1: Only Phase

- [x] Do the thing
`;
		const { tmp, db, reviewPath, planPath, cleanup } =
			createTestEnv(checkedPlan);
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(adapter.callCount).toBe(2);
			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("single-phase happy path: author->review->ready->complete", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc123" } },
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(result.phasesCompleted).toBe(1);
			expect(result.totalPhases).toBe(1);
			expect(result.escalations).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	test("multi-phase progression in auto mode", async () => {
		const { tmp, db, reviewPath, planPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				// Phase 1: author + reviewer
				{ type: "status", status: { result: "complete", commit: "aaa" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				// Phase 2: author + reviewer
				{ type: "status", status: { result: "complete", commit: "bbb" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				// Phase 3: author + reviewer
				{ type: "status", status: { result: "complete", commit: "ccc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(result.phasesCompleted).toBe(3);
			expect(result.totalPhases).toBe(3);
		} finally {
			cleanup();
		}
	});

	test("recomputes pending phases after plan grows mid-run", async () => {
		const { tmp, db, reviewPath, planPath, cleanup } =
			createTestEnv(PLAN_ONE_PHASE);
		const expandedPlan = `# Simple Plan

**Version:** 1.0
**Status:** Draft

## Phase 1: Only Phase

- [x] Do the thing

## Phase 2: Follow-up

- [ ] Add follow-up work
`;
		try {
			const adapter = createMockAdapter([
				{
					type: "status",
					status: { result: "complete", commit: "abc123" },
					writeFile: { path: planPath, content: expandedPlan },
				},
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				{ type: "status", status: { result: "complete", commit: "def456" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(result.phasesCompleted).toBe(2);
			expect(result.totalPhases).toBe(2);
			expect(adapter.callCount).toBe(4);
		} finally {
			cleanup();
		}
	});

	test("aborts when plan phase IDs are renumbered mid-run", async () => {
		const initialPlan = `# Plan

## Phase 1: First

- [ ] Do one

## Phase 2: Second

- [ ] Do two
`;
		const renumberedPlan = `# Plan

## Phase 1: First

- [x] Do one

## Phase 20: Second

- [ ] Do two
`;
		const { tmp, db, reviewPath, planPath, cleanup } =
			createTestEnv(initialPlan);
		try {
			const adapter = createMockAdapter([
				{
					type: "status",
					status: { result: "complete", commit: "abc123" },
					writeFile: { path: planPath, content: renumberedPlan },
				},
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.aborted).toBe(true);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(result.escalations[0]?.reason).toContain("Plan phase IDs changed");
			expect(adapter.callCount).toBe(2);
		} finally {
			cleanup();
		}
	});

	test("quality gate with passing command succeeds", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const cfg = defaultConfig(tmp);
			cfg.qualityGates = ["echo pass"];

			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				cfg,
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("review auto-fix cycle", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				// EXECUTE: author completes
				{ type: "status", status: { result: "complete", commit: "abc" } },
				// REVIEW: needs corrections
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "p1-1",
								title: "Missing test",
								action: "auto_fix",
								reason: "Add test",
							},
						],
					},
				},
				// AUTO_FIX: author fixes
				{ type: "status", status: { result: "complete", commit: "def" } },
				// REVIEW (second): ready
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(result.phasesCompleted).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("human_required items escalate in auto mode", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{
					type: "verdict",
					verdict: {
						readiness: "not_ready",
						items: [
							{
								id: "p0-1",
								title: "API design",
								action: "human_required",
								reason: "Needs decision",
							},
						],
					},
				},
				{ type: "status", status: { result: "complete", commit: "def" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(result.aborted).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(result.escalations[0]?.reason).toContain("human review");
		} finally {
			cleanup();
		}
	});

	test("auto mode aborts when escalation retries are exhausted", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{
					type: "verdict",
					verdict: {
						readiness: "not_ready",
						items: [
							{
								id: "P0.1",
								title: "Architecture",
								action: "human_required",
								reason: "Needs decision",
							},
						],
					},
				},
				{
					type: "status",
					status: { result: "needs_human", reason: "Still ambiguous" },
				},
				{
					type: "status",
					status: { result: "needs_human", reason: "Still ambiguous" },
				},
			]);

			const cfg = defaultConfig(tmp);
			cfg.maxAutoRetries = 2;
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				cfg,
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.aborted).toBe(true);
			expect(result.escalations.length).toBeGreaterThanOrEqual(3);
		} finally {
			cleanup();
		}
	});

	test("human_required review escalation continue routes to AUTO_FIX", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{
					type: "verdict",
					verdict: {
						readiness: "not_ready",
						items: [
							{
								id: "P0.1",
								title: "Needs architecture decision",
								action: "human_required",
								reason: "Pick callback shape",
							},
						],
					},
				},
				// Continue from escalation should invoke author fix next (AUTO_FIX)
				{ type: "status", status: { result: "complete", commit: "def" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async () => ({
						action: "continue",
						guidance: "Use onSessionCreated callback",
					}),
					phaseGate: fixedPhaseGate("continue"),
				},
			);

			expect(result.complete).toBe(true);
			expect(adapter.callCount).toBe(4);
		} finally {
			cleanup();
		}
	});

	test("author needs_human escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{
					type: "status",
					status: {
						result: "needs_human",
						reason: "Ambiguous requirement",
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("Ambiguous requirement");
		} finally {
			cleanup();
		}
	});

	test("author invocation failure escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "error", error: new Error("connection refused") },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("connection refused");
		} finally {
			cleanup();
		}
	});

	test("reviewer invocation failure escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "error", error: new Error("timeout exceeded") },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("timeout exceeded");
		} finally {
			cleanup();
		}
	});

	test("assertAuthorStatus invariant violation escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			// complete but no commit → invariant violation
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete" } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("invariant violation");
			expect(result.escalations[0]?.reason).toContain("commit");
		} finally {
			cleanup();
		}
	});

	test("assertReviewerVerdict invariant violation escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			// not_ready but empty items → invariant violation
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{
					type: "verdict",
					verdict: { readiness: "not_ready", items: [] },
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("items' is empty");
		} finally {
			cleanup();
		}
	});

	test("phase gate with human approval", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, phaseGate: fixedPhaseGate("continue") },
			);

			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("phase gate abort stops execution", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, phaseGate: fixedPhaseGate("abort") },
			);

			expect(result.complete).toBe(false);
			expect(result.aborted).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("phase gate exit pauses run at checkpoint", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, phaseGate: fixedPhaseGate("exit") },
			);

			expect(result.complete).toBe(false);
			expect(result.aborted).toBe(false);
			expect(result.paused).toBe(true);

			const run = db
				.query("SELECT status, current_state FROM runs WHERE id = ? LIMIT 1")
				.get(result.runId) as
				| { status: string; current_state: string | null }
				| undefined;
			expect(run?.status).toBe("active");
			expect(run?.current_state).toBe("PHASE_GATE");
		} finally {
			cleanup();
		}
	});

	test("escalation gate approve continues", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{
					type: "status",
					status: { result: "needs_human", reason: "Question" },
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: fixedEscalationGate("approve"),
					phaseGate: fixedPhaseGate("continue"),
				},
			);

			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("DB events are recorded", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			const events = getRunEvents(db, result.runId);
			const eventTypes = events.map((e) => e.event_type);
			expect(eventTypes).toContain("run_start");
			expect(eventTypes).toContain("phase_start");
			expect(eventTypes).toContain("agent_invoke");
			expect(eventTypes).toContain("verdict");
			expect(eventTypes).toContain("phase_complete");
			expect(eventTypes).toContain("run_complete");
		} finally {
			cleanup();
		}
	});

	test("agent results are stored in DB", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			const agentResults = getAgentResults(db, result.runId);
			expect(agentResults.length).toBeGreaterThanOrEqual(2);
			expect(
				agentResults.filter((r) => r.role === "author").length,
			).toBeGreaterThan(0);
			expect(
				agentResults.filter((r) => r.role === "reviewer").length,
			).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});

	test("skipQuality option bypasses quality gates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const cfg = defaultConfig(tmp);
			cfg.qualityGates = ["exit 1"]; // would fail

			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				cfg,
				{ workdir: tmp, auto: true, skipQuality: true },
			);

			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("starts from specified phase", async () => {
		const { tmp, db, reviewPath, planPath, cleanup } = createTestEnv();
		try {
			setPhaseReviewApproved(db, planPath, "1", true);

			const adapter = createMockAdapter([
				// Phase 2
				{ type: "status", status: { result: "complete", commit: "bbb" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				// Phase 3
				{ type: "status", status: { result: "complete", commit: "ccc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, startPhase: "2" },
			);

			expect(result.phasesCompleted).toBe(3);
			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("resume from mid-phase restores state at QUALITY_CHECK", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const runId = "resume-test-run-id-1234";
			createRun(db, {
				id: runId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, runId, "active", "QUALITY_CHECK", "1");

			// Record that author EXECUTE step was already completed (iteration 0)
			upsertAgentResult(db, {
				id: "ar-author-0",
				run_id: runId,
				phase: "1",
				iteration: 0,
				role: "author",
				template: "author-next-phase",
				result_type: "status",
				result_json: JSON.stringify({
					result: "complete",
					commit: "abc123",
				}),
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});

			// Author should NOT be called (step completed). Reviewer WILL be called.
			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					resumeGate: async () => "resume",
				},
			);

			expect(result.complete).toBe(true);
			expect(result.phasesCompleted).toBe(1);
			expect(result.runId).toBe(runId);
		} finally {
			cleanup();
		}
	});

	test("resume at EXECUTE skips re-author when checklist already complete", async () => {
		const checkedPlan = `# Simple Plan

## Phase 1: Only Phase

- [x] Do the thing
`;
		const { tmp, db, reviewPath, planPath, cleanup } =
			createTestEnv(checkedPlan);
		try {
			const runId = "resume-execute-complete-1234";
			createRun(db, {
				id: runId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, runId, "active", "EXECUTE", "1");

			// Reviewer should be called directly after EXECUTE is skipped.
			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					resumeGate: async () => "resume",
				},
			);

			expect(result.complete).toBe(true);
			expect(result.runId).toBe(runId);
			expect(adapter.callCount).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("resume from PHASE_GATE enters gate directly", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const runId = "resume-gate-test-1234";
			createRun(db, {
				id: runId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, runId, "active", "PHASE_GATE", "1");

			// Record completed steps
			upsertAgentResult(db, {
				id: "ar-author-0",
				run_id: runId,
				phase: "1",
				iteration: 0,
				role: "author",
				template: "author-next-phase",
				result_type: "status",
				result_json: JSON.stringify({
					result: "complete",
					commit: "abc123",
				}),
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});
			upsertAgentResult(db, {
				id: "ar-reviewer-0",
				run_id: runId,
				phase: "1",
				iteration: 1,
				role: "reviewer",
				template: "reviewer-commit",
				result_type: "verdict",
				result_json: JSON.stringify({
					readiness: "ready",
					items: [],
				}),
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});

			// No agents should be called — goes straight to PHASE_GATE.
			const adapter = createMockAdapter([]);

			let phaseGateCalled = false;
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					resumeGate: async () => "resume",
					phaseGate: async () => {
						phaseGateCalled = true;
						return "continue";
					},
				},
			);

			expect(result.complete).toBe(true);
			expect(phaseGateCalled).toBe(true);
			expect(result.runId).toBe(runId);
		} finally {
			cleanup();
		}
	});

	test("resume derives iteration from DB max, not global count", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const runId = "resume-iter-test-1234";
			createRun(db, {
				id: runId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, runId, "active", "REVIEW", "1");

			// Author at iteration 0 completed
			upsertAgentResult(db, {
				id: "ar-author-0",
				run_id: runId,
				phase: "1",
				iteration: 0,
				role: "author",
				template: "author-next-phase",
				result_type: "status",
				result_json: JSON.stringify({
					result: "complete",
					commit: "def456",
				}),
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});

			// Reviewer should be called (at iteration >= 1)
			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					resumeGate: async () => "resume",
				},
			);

			expect(result.complete).toBe(true);
			// The reviewer result should be stored with iteration 1 (max(0) + 1)
			const results = getAgentResults(db, runId, "1");
			const reviewerResult = results.find((r) => r.role === "reviewer");
			expect(reviewerResult).toBeDefined();
			expect(reviewerResult?.iteration).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("auto mode auto-resumes without calling interactive resume gate", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			// Create an active run at QUALITY_CHECK to trigger resume detection
			const oldRunId = "auto-resume-test-1234";
			createRun(db, {
				id: oldRunId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, oldRunId, "active", "QUALITY_CHECK", "1");

			// Record completed author step (iteration 0)
			upsertAgentResult(db, {
				id: "ar-author-0",
				run_id: oldRunId,
				phase: "1",
				iteration: 0,
				role: "author",
				template: "author-next-phase",
				result_type: "status",
				result_json: JSON.stringify({
					result: "complete",
					commit: "abc123",
				}),
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});

			// Resume enters QUALITY_CHECK → skips (no gates) → REVIEW → verdict
			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			// auto=true, no resumeGate override → should auto-resume (not prompt)
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			// Should have resumed the existing run, not created a new one
			expect(result.runId).toBe(oldRunId);
			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("auto mode still calls explicitly provided resumeGate override", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const oldRunId = "auto-gate-override-1234";
			createRun(db, {
				id: oldRunId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, oldRunId, "active", "EXECUTE", "1");

			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			let resumeGateCalled = false;
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					resumeGate: async () => {
						resumeGateCalled = true;
						return "start-fresh";
					},
				},
			);

			// Explicit resumeGate should still be called even in auto mode
			expect(resumeGateCalled).toBe(true);
			// start-fresh → new run ID
			expect(result.runId).not.toBe(oldRunId);
			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("auto mode auto-resumes ESCALATE state", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			// Create an active run stuck at ESCALATE
			const stuckRunId = "escalate-stuck-1234";
			createRun(db, {
				id: stuckRunId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, stuckRunId, "active", "ESCALATE", "1");

			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc123" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			// auto=true, no resumeGate → should resume ESCALATE run
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.runId).toBe(stuckRunId);
			expect(result.complete).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("auto mode starts fresh instead of resuming ABORTED state", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const stuckRunId = "aborted-stuck-5678";
			createRun(db, {
				id: stuckRunId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, stuckRunId, "active", "ABORTED", "1");

			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc123" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.runId).not.toBe(stuckRunId);
			expect(result.complete).toBe(true);

			const events = getRunEvents(db, stuckRunId);
			const freshEvent = events.find(
				(e) => e.event_type === "auto_start_fresh",
			);
			expect(freshEvent).toBeDefined();
			const data = JSON.parse(freshEvent?.data as string);
			expect(data.reason).toContain("ABORTED");
		} finally {
			cleanup();
		}
	});

	test("worktree mode: logBaseDir anchored to projectRoot, not planPath", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		const fakeProjectRoot = join(tmp, "main-checkout");
		mkdirSync(join(fakeProjectRoot, ".5x"), { recursive: true });

		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc123" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					projectRoot: fakeProjectRoot,
				},
			);

			expect(result.complete).toBe(true);

			// Logs should be under projectRoot, not under dirname(planPath)
			const logDir = join(fakeProjectRoot, ".5x", "logs", result.runId);
			expect(existsSync(logDir)).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("empty plan returns gracefully", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(
			"# No Phases\n\nNothing to do.\n",
		);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([]);
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.totalPhases).toBe(0);
			expect(result.phasesCompleted).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("log path always populated on escalation", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			// Author invocation throws
			const adapter = createMockAdapter([
				{ type: "error", error: new Error("boom") },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, projectRoot: tmp },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			const escalation = result.escalations[0];
			if (!escalation) throw new Error("Expected at least one escalation");
			// Log path should be populated (computed before invocation)
			expect(escalation.logPath).toBeDefined();
			expect(escalation.logPath).toMatch(/agent-.+\.ndjson$/);
		} finally {
			cleanup();
		}
	});

	test("quiet flag passed through to adapter", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, quiet: true },
			);

			// The adapter should have received quiet=true
			expect(resolveQuietOpt(adapter.lastOpts?.quiet)).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("passes session titles and emits toasts at current phase boundaries", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const callSessionTitles: Array<string | undefined> = [];
			const selectedSessions: string[] = [];
			const toasts: Array<{ message: string; variant: string }> = [];

			const adapter: AgentAdapter = {
				serverUrl: "http://127.0.0.1:51234",
				async invokeForStatus(opts: InvokeOptions): Promise<InvokeStatus> {
					callSessionTitles.push(opts.sessionTitle);
					if (opts.onSessionCreated) {
						await opts.onSessionCreated("sess-author");
					}
					return {
						type: "status",
						status: { result: "complete", commit: "abc" },
						duration: 1000,
						sessionId: "sess-author",
					};
				},
				async invokeForVerdict(opts: InvokeOptions): Promise<InvokeVerdict> {
					callSessionTitles.push(opts.sessionTitle);
					if (opts.onSessionCreated) {
						await opts.onSessionCreated("sess-review");
					}
					return {
						type: "verdict",
						verdict: { readiness: "ready", items: [] },
						duration: 1000,
						sessionId: "sess-review",
					};
				},
				async verify() {},
				async close() {},
			};

			const tui: TuiController = {
				active: true,
				attached: true,
				selectSession: async (sessionID: string) => {
					selectedSessions.push(sessionID);
				},
				showToast: async (message, variant) => {
					toasts.push({ message, variant });
				},
				onExit: () => () => {},
				kill: () => {},
			};

			await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, quiet: true, tui },
			);

			expect(callSessionTitles).toEqual([
				"Phase 1 — author",
				"Phase 1 — review 1",
			]);
			expect(selectedSessions).toEqual(["sess-author", "sess-review"]);
			expect(toasts).toEqual([
				{ message: "Starting Phase 1 — Only Phase", variant: "info" },
				{ message: "Phase 1 complete — continuing", variant: "success" },
			]);
		} finally {
			cleanup();
		}
	});

	test("quiet function form is re-evaluated at each adapter invocation (P1.4)", async () => {
		// Verify that the quiet function is resolved fresh at each adapter call.
		// Flips the return value after the first call to prove re-evaluation
		// (simulates TUI exiting mid-run).
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			// Record quiet value for every adapter call
			const quietPerCall: boolean[] = [];
			const responses: MockResponse[] = [
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			];
			let quietValue = true;
			let idx = 0;
			const adapter: AgentAdapter & { callCount: number } = {
				callCount: 0,
				serverUrl: "http://127.0.0.1:51234",
				async invokeForStatus(opts: InvokeOptions): Promise<InvokeStatus> {
					adapter.callCount++;
					quietPerCall.push(resolveQuietOpt(opts.quiet));
					quietValue = false;
					const r = responses[idx++];
					if (!r || r.type !== "status") throw new Error("unexpected mock");
					return {
						type: "status",
						status: r.status,
						duration: 1000,
						sessionId: "mock-session",
					};
				},
				async invokeForVerdict(opts: InvokeOptions): Promise<InvokeVerdict> {
					adapter.callCount++;
					quietPerCall.push(resolveQuietOpt(opts.quiet));
					const r = responses[idx++];
					if (!r || r.type !== "verdict") throw new Error("unexpected mock");
					return {
						type: "verdict",
						verdict: r.verdict,
						duration: 1000,
						sessionId: "mock-session",
					};
				},
				async verify() {},
				async close() {},
			};

			// Flip quietValue after the first adapter call (simulates TUI exiting).
			await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					quiet: () => quietValue,
				},
			);

			// Author call received quiet=true, reviewer call received quiet=false
			expect(quietPerCall.length).toBe(2);
			expect(quietPerCall[0]).toBe(true); // TUI was still active
			expect(quietPerCall[1]).toBe(false); // TUI exited before reviewer
		} finally {
			cleanup();
		}
	});

	test("no stdout writes from orchestrator when quiet=true (TUI active regression)", async () => {
		// When quiet is true (TUI active), the orchestrator must not write to
		// stdout — only to log files and DB. Uses _log DI to avoid mutating
		// the global console object (safe under concurrent test execution).
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const logCalls: unknown[][] = [];
			const recorder = (...args: unknown[]) => {
				logCalls.push(args);
			};
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, quiet: true, _log: recorder },
			);

			// No log output should have been produced when quiet=true.
			expect(logCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("orchestrator does produce log output when quiet=false (regression sanity)", async () => {
		// Companion to the quiet=true test above: verifies that with quiet=false
		// the orchestrator DOES produce log output, proving the quiet=true test
		// isn't passing vacuously.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const logCalls: unknown[][] = [];
			const recorder = (...args: unknown[]) => {
				logCalls.push(args);
			};
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, quiet: false, _log: recorder },
			);

			// When quiet=false, orchestrator MUST produce at least some log output
			// (phase headers, author status, verdict, etc.).
			expect(logCalls.length).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});

	test("escalation includes logPath from invocation", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			// Author needs_human → escalation should include logPath
			const adapter = createMockAdapter([
				{
					type: "status",
					status: { result: "needs_human", reason: "help me" },
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, projectRoot: tmp },
			);

			expect(result.complete).toBe(false);
			const escalation = result.escalations[0];
			expect(escalation?.logPath).toBeDefined();
			expect(escalation?.logPath).toMatch(/agent-.+\.ndjson$/);
		} finally {
			cleanup();
		}
	});

	test("QUALITY_RETRY: author needs_human during quality fix escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const cfg = defaultConfig(tmp);
			cfg.qualityGates = ["exit 1"]; // will fail

			const adapter = createMockAdapter([
				// EXECUTE: completes
				{ type: "status", status: { result: "complete", commit: "abc" } },
				// QUALITY_RETRY: author reports needs_human
				{
					type: "status",
					status: { result: "needs_human", reason: "stuck on quality fix" },
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				cfg,
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(result.escalations[0]?.reason).toContain("stuck on quality fix");
		} finally {
			cleanup();
		}
	});

	test("resume backward compat: PARSE_AUTHOR_STATUS mapped to EXECUTE", async () => {
		// Simulate: old run interrupted at PARSE_AUTHOR_STATUS with a stored
		// result. Should be mapped to EXECUTE and route based on stored result.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const runId = "resume-legacy-parse-1234";
			createRun(db, {
				id: runId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, runId, "active", "PARSE_AUTHOR_STATUS", "1");

			// Author completed at iteration 0 but status was null (unparseable)
			upsertAgentResult(db, {
				id: "ar-author-0",
				run_id: runId,
				phase: "1",
				iteration: 0,
				role: "author",
				template: "author-next-phase",
				result_type: "status",
				result_json: "null",
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});

			const adapter = createMockAdapter([]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					resumeGate: async () => "resume",
				},
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			// Escalation should reference iteration 0
			expect(result.escalations[0]?.iteration).toBe(0);
		} finally {
			cleanup();
		}
	});

	// ─── Session continuation tests (Phase 3 of 007) ───────────────────

	test("continue_session routes to correct resumeState and passes sessionId to adapter", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: needs_human with sessionId
				{
					type: "status",
					status: { result: "needs_human", reason: "Need clarification" },
					sessionId: "session-abc",
				},
				// Continue session: author completes
				{
					type: "status",
					status: { result: "complete", commit: "def456" },
					sessionId: "session-abc",
				},
				// Review: ready
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			// Intercept opts to verify sessionId propagation
			const origInvokeForStatus = adapter.invokeForStatus.bind(adapter);
			adapter.invokeForStatus = async (opts: InvokeOptions) => {
				capturedOpts.push({ ...opts });
				return origInvokeForStatus(opts);
			};

			let escalationCallCount = 0;
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async (event) => {
						escalationCallCount++;
						// First escalation: continue_session
						expect(event.sessionId).toBe("session-abc");
						return { action: "continue_session" };
					},
					phaseGate: fixedPhaseGate("continue"),
				},
			);

			expect(result.complete).toBe(true);
			expect(escalationCallCount).toBe(1);
			// Second invokeForStatus call should have sessionId set
			expect(capturedOpts.length).toBe(2);
			expect(capturedOpts[1]?.sessionId).toBe("session-abc");
			// Prompt should be the continuation prompt
			expect(capturedOpts[1]?.prompt).toContain("Continue the current session");
		} finally {
			cleanup();
		}
	});

	test("continue_session clears continueSessionId after use", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: needs_human with sessionId
				{
					type: "status",
					status: { result: "needs_human", reason: "help" },
					sessionId: "session-abc",
				},
				// Continue session: also needs_human again
				{
					type: "status",
					status: { result: "needs_human", reason: "still need help" },
					sessionId: "session-abc",
				},
				// User chooses "continue" (fresh) this time
				{
					type: "status",
					status: { result: "complete", commit: "abc" },
					sessionId: "session-def",
				},
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const origInvokeForStatus = adapter.invokeForStatus.bind(adapter);
			adapter.invokeForStatus = async (opts: InvokeOptions) => {
				capturedOpts.push({ ...opts });
				return origInvokeForStatus(opts);
			};

			let callNum = 0;
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async () => {
						callNum++;
						if (callNum === 1) return { action: "continue_session" };
						return { action: "continue" };
					},
					phaseGate: fixedPhaseGate("continue"),
				},
			);

			expect(result.complete).toBe(true);
			// Call 1: initial execute (no sessionId)
			expect(capturedOpts[0]?.sessionId).toBeUndefined();
			// Call 2: continuation (has sessionId)
			expect(capturedOpts[1]?.sessionId).toBe("session-abc");
			// Call 3: fresh session (sessionId cleared)
			expect(capturedOpts[2]?.sessionId).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("failed continuation suppresses sessionId on next escalation", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				// EXECUTE: needs_human with sessionId
				{
					type: "status",
					status: { result: "needs_human", reason: "help" },
					sessionId: "session-abc",
				},
				// Continue session: fails
				{
					type: "status",
					status: { result: "failed", reason: "session broken" },
					sessionId: "session-abc",
				},
			]);

			const escalationEvents: EscalationEvent[] = [];
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async (event) => {
						escalationEvents.push(event);
						if (escalationEvents.length === 1) {
							return { action: "continue_session" };
						}
						return { action: "abort" };
					},
				},
			);

			expect(result.complete).toBe(false);
			expect(escalationEvents.length).toBe(2);
			// First escalation: has sessionId (eligible for continuation)
			expect(escalationEvents[0]?.sessionId).toBe("session-abc");
			// Second escalation: sessionId suppressed (failed continuation)
			expect(escalationEvents[1]?.sessionId).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("needs_human after continuation preserves sessionId (multi-turn)", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				// EXECUTE: needs_human with sessionId
				{
					type: "status",
					status: { result: "needs_human", reason: "help" },
					sessionId: "session-abc",
				},
				// Continue session: needs_human again (healthy session)
				{
					type: "status",
					status: { result: "needs_human", reason: "need more input" },
					sessionId: "session-abc",
				},
				// Continue session again: complete
				{
					type: "status",
					status: { result: "complete", commit: "xyz" },
					sessionId: "session-abc",
				},
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const escalationEvents: EscalationEvent[] = [];
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async (event) => {
						escalationEvents.push(event);
						return { action: "continue_session" };
					},
					phaseGate: fixedPhaseGate("continue"),
				},
			);

			expect(result.complete).toBe(true);
			expect(escalationEvents.length).toBe(2);
			// Both escalations should have sessionId (multi-turn continuation)
			expect(escalationEvents[0]?.sessionId).toBe("session-abc");
			expect(escalationEvents[1]?.sessionId).toBe("session-abc");
		} finally {
			cleanup();
		}
	});

	test("author needs_human sets sessionId on escalation event", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{
					type: "status",
					status: { result: "needs_human", reason: "help" },
					sessionId: "session-xyz",
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(result.escalations[0]?.sessionId).toBe("session-xyz");
		} finally {
			cleanup();
		}
	});

	test("reviewer-originated escalations do not set sessionId", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				// Reviewer: human_required items → escalation
				{
					type: "verdict",
					verdict: {
						readiness: "not_ready",
						items: [
							{
								id: "P0.1",
								title: "Need decision",
								action: "human_required",
								reason: "Architecture choice",
							},
						],
					},
					sessionId: "reviewer-session-999",
				},
			]);

			const escalationEvents: EscalationEvent[] = [];
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async (event) => {
						escalationEvents.push(event);
						return { action: "abort" };
					},
				},
			);

			expect(result.complete).toBe(false);
			expect(escalationEvents.length).toBe(1);
			// Reviewer escalation should NOT have sessionId (reviewer sessions aren't continuable)
			expect(escalationEvents[0]?.sessionId).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("continue_session with guidance includes guidance in prompt", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				{
					type: "status",
					status: { result: "needs_human", reason: "help" },
					sessionId: "session-abc",
				},
				{
					type: "status",
					status: { result: "complete", commit: "abc" },
					sessionId: "session-abc",
				},
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const origInvokeForStatus = adapter.invokeForStatus.bind(adapter);
			adapter.invokeForStatus = async (opts: InvokeOptions) => {
				capturedOpts.push({ ...opts });
				return origInvokeForStatus(opts);
			};

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async () => ({
						action: "continue_session",
						guidance: "Focus on the error handler",
					}),
					phaseGate: fixedPhaseGate("continue"),
				},
			);

			expect(result.complete).toBe(true);
			// Second call should have the guidance in the prompt
			expect(capturedOpts[1]?.prompt).toContain("Focus on the error handler");
			expect(capturedOpts[1]?.prompt).toContain("additional guidance");
		} finally {
			cleanup();
		}
	});

	test("continue_session without sessionId falls back to fresh session", async () => {
		// Test the defensive invariant: continue_session when lastEscalation.sessionId is absent.
		// This happens when the escalation originated from an error path (e.g. invocation threw)
		// rather than an agent result — no sessionId is set on the event.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: throws error (error path doesn't set sessionId on escalation)
				{ type: "error", error: new Error("connection reset") },
				// After continue_session (with no sessionId): fresh session author completes
				{
					type: "status",
					status: { result: "complete", commit: "abc" },
				},
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const origInvokeForStatus = adapter.invokeForStatus.bind(adapter);
			adapter.invokeForStatus = async (opts: InvokeOptions) => {
				capturedOpts.push({ ...opts });
				return origInvokeForStatus(opts);
			};

			const traceEvents: string[] = [];
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async () => ({
						action: "continue_session",
					}),
					phaseGate: fixedPhaseGate("continue"),
					trace: (event) => traceEvents.push(event),
				},
			);

			expect(result.complete).toBe(true);
			// Second call should have undefined sessionId (error path doesn't provide one)
			expect(capturedOpts[1]?.sessionId).toBeUndefined();
			// Trace should record the defensive fallback
			expect(
				traceEvents.some((e) => e.includes("continue_session.no_session_id")),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("resume backward compat: PARSE_VERDICT mapped to REVIEW", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const runId = "resume-legacy-verdict-1234";
			createRun(db, {
				id: runId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, runId, "active", "PARSE_VERDICT", "1");

			// Author completed at iteration 0
			upsertAgentResult(db, {
				id: "ar-author-0",
				run_id: runId,
				phase: "1",
				iteration: 0,
				role: "author",
				template: "author-next-phase",
				result_type: "status",
				result_json: JSON.stringify({ result: "complete", commit: "abc" }),
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});
			// Reviewer at iteration 1 but verdict was null
			upsertAgentResult(db, {
				id: "ar-reviewer-1",
				run_id: runId,
				phase: "1",
				iteration: 1,
				role: "reviewer",
				template: "reviewer-commit",
				result_type: "verdict",
				result_json: "null",
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});

			const adapter = createMockAdapter([]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					resumeGate: async () => "resume",
				},
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			// Escalation should reference iteration 1 (the reviewer invocation)
			expect(result.escalations[0]?.iteration).toBe(1);
		} finally {
			cleanup();
		}
	});

	// ─── Reviewer session reuse tests (Phase 1 of 008) ─────────────────

	test("first REVIEW creates new session (no sessionId in InvokeOptions)", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedVerdictOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				{ type: "status", status: { result: "complete", commit: "abc" } },
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-sess-1",
				},
			]);

			const origInvokeForVerdict = adapter.invokeForVerdict.bind(adapter);
			adapter.invokeForVerdict = async (opts: InvokeOptions) => {
				capturedVerdictOpts.push({ ...opts });
				return origInvokeForVerdict(opts);
			};

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(capturedVerdictOpts.length).toBe(1);
			// First review should not pass a sessionId
			expect(capturedVerdictOpts[0]?.sessionId).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("second REVIEW of same phase passes reviewerSessionId via InvokeOptions.sessionId", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedVerdictOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: author completes
				{ type: "status", status: { result: "complete", commit: "abc" } },
				// REVIEW 1: needs corrections → auto_fix
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "p1-1",
								title: "Fix test",
								action: "auto_fix",
								reason: "Add test",
							},
						],
					},
					sessionId: "reviewer-sess-1",
				},
				// AUTO_FIX: author fixes
				{ type: "status", status: { result: "complete", commit: "def" } },
				// REVIEW 2: ready (should reuse session)
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-sess-1",
				},
			]);

			const origInvokeForVerdict = adapter.invokeForVerdict.bind(adapter);
			adapter.invokeForVerdict = async (opts: InvokeOptions) => {
				capturedVerdictOpts.push({ ...opts });
				return origInvokeForVerdict(opts);
			};

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(capturedVerdictOpts.length).toBe(2);
			// First review: no sessionId (new session)
			expect(capturedVerdictOpts[0]?.sessionId).toBeUndefined();
			// Second review: should pass the reviewer session from first review
			expect(capturedVerdictOpts[1]?.sessionId).toBe("reviewer-sess-1");
		} finally {
			cleanup();
		}
	});

	test("reviewerSessionId is cleared at start of new phase", async () => {
		const { tmp, db, reviewPath, planPath, cleanup } = createTestEnv();
		try {
			const capturedVerdictOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// Phase 1: author + reviewer
				{ type: "status", status: { result: "complete", commit: "aaa" } },
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-phase1-sess",
				},
				// Phase 2: author + reviewer
				{ type: "status", status: { result: "complete", commit: "bbb" } },
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-phase2-sess",
				},
				// Phase 3: author + reviewer
				{ type: "status", status: { result: "complete", commit: "ccc" } },
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-phase3-sess",
				},
			]);

			const origInvokeForVerdict = adapter.invokeForVerdict.bind(adapter);
			adapter.invokeForVerdict = async (opts: InvokeOptions) => {
				capturedVerdictOpts.push({ ...opts });
				return origInvokeForVerdict(opts);
			};

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(capturedVerdictOpts.length).toBe(3);
			// Each phase's first review should not have a sessionId
			// (reviewerSessionId cleared at phase boundary)
			expect(capturedVerdictOpts[0]?.sessionId).toBeUndefined();
			expect(capturedVerdictOpts[1]?.sessionId).toBeUndefined();
			expect(capturedVerdictOpts[2]?.sessionId).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("reviewerSessionId cleared on assertReviewerVerdict failure (invalid verdict)", async () => {
		// P1.2 of review: when assertReviewerVerdict throws (e.g. not_ready with
		// empty items), the reviewerSessionId must be cleared so the next review
		// attempt uses a fresh session rather than reusing a potentially bad one.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedVerdictOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: author completes
				{ type: "status", status: { result: "complete", commit: "abc" } },
				// REVIEW 1: auto_fix needed (valid verdict, captures session)
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "p1-1",
								title: "Fix",
								action: "auto_fix",
								reason: "Fix it",
							},
						],
					},
					sessionId: "reviewer-sess-1",
				},
				// AUTO_FIX: author fixes
				{ type: "status", status: { result: "complete", commit: "def" } },
				// REVIEW 2: invalid verdict (not_ready with empty items → invariant violation)
				// preEscalateState = REVIEW, so escalation "continue" loops back to REVIEW
				{
					type: "verdict",
					verdict: { readiness: "not_ready", items: [] },
					sessionId: "reviewer-sess-1",
				},
				// REVIEW 3: escalation resumes at REVIEW → still invalid (exhaust one retry)
				{
					type: "verdict",
					verdict: { readiness: "not_ready", items: [] },
					sessionId: "reviewer-sess-bad",
				},
				// REVIEW 4: finally valid — should use fresh session
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-sess-2",
				},
			]);

			const origInvokeForVerdict = adapter.invokeForVerdict.bind(adapter);
			adapter.invokeForVerdict = async (opts: InvokeOptions) => {
				capturedVerdictOpts.push({ ...opts });
				return origInvokeForVerdict(opts);
			};

			const cfg = defaultConfig(tmp);
			cfg.maxAutoRetries = 3; // allow enough retries

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				cfg,
				{
					workdir: tmp,
					auto: true,
				},
			);

			expect(result.complete).toBe(true);
			expect(capturedVerdictOpts.length).toBe(4);
			// First review: no sessionId (new session)
			expect(capturedVerdictOpts[0]?.sessionId).toBeUndefined();
			// Second review: reuses session from first review
			expect(capturedVerdictOpts[1]?.sessionId).toBe("reviewer-sess-1");
			// Third review: sessionId cleared after invariant failure → fresh session
			expect(capturedVerdictOpts[2]?.sessionId).toBeUndefined();
			// Fourth review: sessionId cleared after second invariant failure → still fresh
			expect(capturedVerdictOpts[3]?.sessionId).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	// ─── Reviewer follow-up prompt tests (Phase 2 of 008) ────────────────

	test("follow-up prompt contains commit hash and review path (not full template)", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedVerdictOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: author completes
				{ type: "status", status: { result: "complete", commit: "abc123" } },
				// REVIEW 1: needs corrections → auto_fix
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "p1-1",
								title: "Fix test",
								action: "auto_fix",
								reason: "Add test",
							},
						],
					},
					sessionId: "reviewer-sess-1",
				},
				// AUTO_FIX: author fixes
				{
					type: "status",
					status: { result: "complete", commit: "def456" },
				},
				// REVIEW 2: ready (should use follow-up prompt)
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-sess-1",
				},
			]);

			const origInvokeForVerdict = adapter.invokeForVerdict.bind(adapter);
			adapter.invokeForVerdict = async (opts: InvokeOptions) => {
				capturedVerdictOpts.push({ ...opts });
				return origInvokeForVerdict(opts);
			};

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(capturedVerdictOpts.length).toBe(2);

			// First review: full template (contains review dimensions, etc.)
			const firstPrompt = capturedVerdictOpts[0]?.prompt ?? "";
			expect(firstPrompt).toContain("Staff Engineer");
			expect(firstPrompt).toContain("Correctness");
			expect(firstPrompt).toContain("Architecture");
			expect(firstPrompt).toContain("Issue Classification");

			// Second review: follow-up prompt (short, only commit + review path)
			const followUpPrompt = capturedVerdictOpts[1]?.prompt ?? "";
			expect(followUpPrompt).toContain("def456"); // commit hash
			expect(followUpPrompt).toContain("review feedback");
			expect(followUpPrompt).toContain("addendum");
			// Should contain the phase review path
			expect(followUpPrompt).toContain("phase-1-review");

			// Follow-up prompt should NOT contain full template content
			expect(followUpPrompt).not.toContain("Staff Engineer");
			expect(followUpPrompt).not.toContain("Correctness");
			expect(followUpPrompt).not.toContain("Architecture");
			expect(followUpPrompt).not.toContain("Issue Classification");
			expect(followUpPrompt).not.toContain("Review Perspective");
		} finally {
			cleanup();
		}
	});

	test("follow-up prompt uses HEAD when lastCommit is undefined", async () => {
		// Edge case: if lastCommit is somehow undefined, follow-up prompt
		// should use "HEAD" as the fallback commit reference.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedVerdictOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: author completes (no commit in status — fallback via getLatestCommit which may fail)
				{
					type: "status",
					status: { result: "complete", commit: "first-commit" },
				},
				// REVIEW 1: needs corrections
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "p1-1",
								title: "Fix",
								action: "auto_fix",
								reason: "Fix it",
							},
						],
					},
					sessionId: "reviewer-sess-1",
				},
				// AUTO_FIX: author fixes (commit field present)
				{
					type: "status",
					status: { result: "complete", commit: "second-commit" },
				},
				// REVIEW 2: ready (follow-up prompt should reference second-commit)
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-sess-1",
				},
			]);

			const origInvokeForVerdict = adapter.invokeForVerdict.bind(adapter);
			adapter.invokeForVerdict = async (opts: InvokeOptions) => {
				capturedVerdictOpts.push({ ...opts });
				return origInvokeForVerdict(opts);
			};

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(true);
			expect(capturedVerdictOpts.length).toBe(2);
			// Second review should reference the auto-fix commit
			const followUpPrompt = capturedVerdictOpts[1]?.prompt ?? "";
			expect(followUpPrompt).toContain("second-commit");
		} finally {
			cleanup();
		}
	});

	test("first review after session cleared uses full template again", async () => {
		// When reviewerSessionId is cleared (e.g., after failure), the next
		// review should go back to using the full reviewer-commit template.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedVerdictOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: author completes
				{ type: "status", status: { result: "complete", commit: "abc" } },
				// REVIEW 1: auto_fix needed (captures session)
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "p1-1",
								title: "Fix",
								action: "auto_fix",
								reason: "Fix it",
							},
						],
					},
					sessionId: "reviewer-sess-1",
				},
				// AUTO_FIX: author fixes
				{ type: "status", status: { result: "complete", commit: "def" } },
				// REVIEW 2: fails (clears reviewerSessionId)
				{ type: "error", error: new Error("context window exhausted") },
				// Escalation → continue → REVIEW 3: should use full template
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-sess-2",
				},
			]);

			const origInvokeForVerdict = adapter.invokeForVerdict.bind(adapter);
			adapter.invokeForVerdict = async (opts: InvokeOptions) => {
				capturedVerdictOpts.push({ ...opts });
				return origInvokeForVerdict(opts);
			};

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async () => ({ action: "continue" }),
					phaseGate: fixedPhaseGate("continue"),
				},
			);

			expect(result.complete).toBe(true);
			expect(capturedVerdictOpts.length).toBe(3);

			// Review 1: full template (no session yet)
			expect(capturedVerdictOpts[0]?.prompt).toContain("Staff Engineer");
			// Review 2: follow-up prompt (session reuse) — but this one threw
			expect(capturedVerdictOpts[1]?.prompt).toContain("review feedback");
			expect(capturedVerdictOpts[1]?.prompt).not.toContain("Staff Engineer");
			// Review 3: full template again (session cleared after error)
			expect(capturedVerdictOpts[2]?.prompt).toContain("Staff Engineer");
			expect(capturedVerdictOpts[2]?.sessionId).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("reviewerSessionId cleared on REVIEW failure when set", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const capturedVerdictOpts: InvokeOptions[] = [];
			const adapter = createMockAdapter([
				// EXECUTE: author completes
				{ type: "status", status: { result: "complete", commit: "abc" } },
				// REVIEW 1: auto_fix needed
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "p1-1",
								title: "Fix",
								action: "auto_fix",
								reason: "Fix it",
							},
						],
					},
					sessionId: "reviewer-sess-1",
				},
				// AUTO_FIX: author fixes
				{ type: "status", status: { result: "complete", commit: "def" } },
				// REVIEW 2: fails (session exhausted, etc.)
				{ type: "error", error: new Error("context window exhausted") },
				// After escalation continue → REVIEW 3: should use fresh session
				{
					type: "verdict",
					verdict: { readiness: "ready", items: [] },
					sessionId: "reviewer-sess-2",
				},
			]);

			const origInvokeForVerdict = adapter.invokeForVerdict.bind(adapter);
			adapter.invokeForVerdict = async (opts: InvokeOptions) => {
				capturedVerdictOpts.push({ ...opts });
				return origInvokeForVerdict(opts);
			};

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					escalationGate: async () => {
						return { action: "continue" };
					},
					phaseGate: fixedPhaseGate("continue"),
				},
			);

			expect(result.complete).toBe(true);
			expect(capturedVerdictOpts.length).toBe(3);
			// First review: no sessionId
			expect(capturedVerdictOpts[0]?.sessionId).toBeUndefined();
			// Second review: reuses session from first review
			expect(capturedVerdictOpts[1]?.sessionId).toBe("reviewer-sess-1");
			// Third review: sessionId cleared after failure → fresh session
			expect(capturedVerdictOpts[2]?.sessionId).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});
