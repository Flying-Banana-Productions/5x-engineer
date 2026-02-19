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
	updateRunStatus,
	upsertAgentResult,
} from "../../src/db/operations.js";
import { runMigrations } from "../../src/db/schema.js";
import type {
	EscalationEvent,
	EscalationResponse,
	PhaseSummary,
} from "../../src/gates/human.js";
import { runPhaseExecutionLoop } from "../../src/orchestrator/phase-execution-loop.js";
import type { AuthorStatus, ReviewerVerdict } from "../../src/protocol.js";

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

function fixedPhaseGate(decision: "continue" | "review" | "abort") {
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
			expect(result.escalations[0]?.reason).toContain("human review");
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
		const planWithP1Complete = PLAN_CONTENT.replace(
			"- [ ] Set up project\n- [ ] Add config",
			"- [x] Set up project\n- [x] Add config",
		);
		const { tmp, db, reviewPath, planPath, cleanup } =
			createTestEnv(planWithP1Complete);
		try {
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
			expect(adapter.lastOpts?.quiet).toBe(true);
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
			let idx = 0;
			const adapter: AgentAdapter & { callCount: number } = {
				callCount: 0,
				serverUrl: "http://127.0.0.1:51234",
				async invokeForStatus(opts: InvokeOptions): Promise<InvokeStatus> {
					adapter.callCount++;
					quietPerCall.push(opts.quiet ?? false);
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
					quietPerCall.push(opts.quiet ?? false);
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
			// The quiet function is called both by the log helper and by adapter
			// invocations, so we track adapter calls via the adapter's callCount
			// and flip based on that — not on quiet function call count.
			let quietValue = true; // author call sees quiet=true (TUI active)
			await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					quiet: () => {
						// After the first adapter call completes, flip to false
						if (adapter.callCount > 0) quietValue = false;
						return quietValue;
					},
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
});
