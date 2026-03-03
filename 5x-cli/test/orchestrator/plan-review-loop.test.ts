import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	getLatestRun,
	getRunEvents,
	updateRunStatus,
	upsertAgentResult,
} from "../../src/db/operations.js";
import { runMigrations } from "../../src/db/schema.js";
import {
	resolveReviewPath,
	runPlanReviewLoop,
} from "../../src/orchestrator/plan-review-loop.js";
import { canonicalizePlanPath } from "../../src/paths.js";
import type { AuthorStatus, ReviewerVerdict } from "../../src/protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAN_CONTENT = `# Test Implementation Plan

**Version:** 1.0
**Status:** Draft

## Phase 1: Foundation

- [ ] Set up project
- [ ] Add config
`;

function defaultConfig(): FiveXConfig {
	return {
		author: {},
		reviewer: {},
		qualityGates: [],
		worktree: {},
		paths: {
			plans: "docs/development",
			reviews: "docs/development/reviews",
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

/** Create an isolated test environment. */
function createTestEnv() {
	const tmp = mkdtempSync(join(tmpdir(), "5x-plan-review-loop-"));

	const dbDir = join(tmp, ".5x");
	mkdirSync(dbDir, { recursive: true });
	const db = new Database(join(dbDir, "5x.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);

	const plansDir = join(tmp, "docs", "development");
	mkdirSync(plansDir, { recursive: true });
	const planPath = join(plansDir, "001-test-plan.md");
	writeFileSync(planPath, PLAN_CONTENT);

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

/** A single mock response for the adapter queue. */
type MockResponse =
	| {
			type: "status";
			status: AuthorStatus;
			duration?: number;
			writeFile?: { path: string; content: string };
	  }
	| {
			type: "verdict";
			verdict: ReviewerVerdict;
			duration?: number;
			writeFile?: { path: string; content: string };
	  }
	| {
			type: "error";
			error: Error;
	  };

interface MockAdapterHooks {
	onStatusInvoke?: (opts: InvokeOptions) => void;
	onVerdictInvoke?: (opts: InvokeOptions) => void;
}

/** Build a mock adapter from a queue of responses. */
function createMockAdapter(
	responses: MockResponse[],
	hooks: MockAdapterHooks = {},
): AgentAdapter {
	let idx = 0;
	return {
		serverUrl: "http://127.0.0.1:51234",
		async invokeForStatus(_opts: InvokeOptions): Promise<InvokeStatus> {
			hooks.onStatusInvoke?.(_opts);
			const r = responses[idx++];
			if (!r) throw new Error(`Mock adapter exhausted after ${idx - 1} calls`);
			if (r.type === "error") throw r.error;
			if (r.type !== "status")
				throw new Error(`Expected status at index ${idx - 1}, got ${r.type}`);
			if (r.writeFile) writeFileSync(r.writeFile.path, r.writeFile.content);
			return {
				type: "status",
				status: r.status,
				duration: r.duration ?? 1000,
				sessionId: "mock-session",
			};
		},
		async invokeForVerdict(_opts: InvokeOptions): Promise<InvokeVerdict> {
			hooks.onVerdictInvoke?.(_opts);
			const r = responses[idx++];
			if (!r) throw new Error(`Mock adapter exhausted after ${idx - 1} calls`);
			if (r.type === "error") throw r.error;
			if (r.type !== "verdict")
				throw new Error(`Expected verdict at index ${idx - 1}, got ${r.type}`);
			if (r.writeFile) writeFileSync(r.writeFile.path, r.writeFile.content);
			return {
				type: "verdict",
				verdict: r.verdict,
				duration: r.duration ?? 1000,
				sessionId: "mock-session",
			};
		},
		async verify() {},
		async close() {},
	};
}

/** Human gate that always returns a fixed decision. */
function fixedHumanGate(decision: "continue" | "approve" | "abort") {
	return async () => decision;
}

/** Resume gate that always returns a fixed decision. */
function fixedResumeGate(decision: "resume" | "start-fresh" | "abort") {
	return async () => decision;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveReviewPath", () => {
	test("computes fresh path when no DB entry exists", () => {
		const { tmp, db, planPath, cleanup } = createTestEnv();
		try {
			const path = resolveReviewPath(
				db,
				planPath,
				join(tmp, "docs/development/reviews"),
			);
			const dateStr = new Date().toISOString().slice(0, 10);
			expect(path).toContain(`${dateStr}-001-test-plan-review.md`);
		} finally {
			cleanup();
		}
	});

	test("reuses review path from prior run in DB when under reviews dir", () => {
		const { tmp, db, planPath, cleanup } = createTestEnv();
		try {
			const canonicalPath = canonicalizePlanPath(planPath);
			const reviewsDir = join(tmp, "docs/development/reviews");
			const priorReviewPath = join(reviewsDir, "2026-01-01-prior-review.md");
			createRun(db, {
				id: "prior-run",
				planPath: canonicalPath,
				command: "plan-review",
				reviewPath: priorReviewPath,
			});
			updateRunStatus(db, "prior-run", "completed");

			const path = resolveReviewPath(db, planPath, reviewsDir);
			expect(path).toBe(priorReviewPath);
		} finally {
			cleanup();
		}
	});

	test("rejects DB review path outside configured reviews dir", () => {
		const { tmp, db, planPath, cleanup } = createTestEnv();
		try {
			const canonicalPath = canonicalizePlanPath(planPath);
			createRun(db, {
				id: "prior-run",
				planPath: canonicalPath,
				command: "plan-review",
				reviewPath: "/some/outside/review.md",
			});
			updateRunStatus(db, "prior-run", "completed");

			const path = resolveReviewPath(
				db,
				planPath,
				join(tmp, "docs/development/reviews"),
			);
			expect(path).not.toBe("/some/outside/review.md");
			const dateStr = new Date().toISOString().slice(0, 10);
			expect(path).toContain(`${dateStr}-001-test-plan-review.md`);
		} finally {
			cleanup();
		}
	});

	test("accepts DB review path under additional worktree review dir", () => {
		const { tmp, db, planPath, cleanup } = createTestEnv();
		try {
			const canonicalPath = canonicalizePlanPath(planPath);
			const reviewsDir = join(tmp, "docs/development/reviews");
			const worktreeReviewsDir = join(
				tmp,
				".5x/worktrees/feature/docs/development/reviews",
			);
			const priorReviewPath = join(
				worktreeReviewsDir,
				"2026-01-01-prior-review.md",
			);
			const warns: string[] = [];
			createRun(db, {
				id: "prior-run",
				planPath: canonicalPath,
				command: "plan-review",
				reviewPath: priorReviewPath,
			});
			updateRunStatus(db, "prior-run", "completed");

			const path = resolveReviewPath(db, planPath, reviewsDir, {
				additionalReviewDirs: [worktreeReviewsDir],
				warn: (message) => warns.push(message),
			});

			expect(path).toBe(priorReviewPath);
			expect(warns).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	test("reviewSuffix controls filename suffix for fresh paths", () => {
		const { tmp, db, planPath, cleanup } = createTestEnv();
		try {
			const reviewsDir = join(tmp, "docs/development/reviews");
			const dateStr = new Date().toISOString().slice(0, 10);

			const planReviewPath = resolveReviewPath(db, planPath, reviewsDir, {
				reviewSuffix: "plan-review",
			});
			expect(planReviewPath).toContain(
				`${dateStr}-001-test-plan-plan-review.md`,
			);

			const implReviewPath = resolveReviewPath(db, planPath, reviewsDir, {
				reviewSuffix: "review",
			});
			expect(implReviewPath).toContain(`${dateStr}-001-test-plan-review.md`);
		} finally {
			cleanup();
		}
	});

	test("command filter scopes DB lookup to matching command type", () => {
		const { tmp, db, planPath, cleanup } = createTestEnv();
		try {
			const canonicalPath = canonicalizePlanPath(planPath);
			const reviewsDir = join(tmp, "docs/development/reviews");
			const planReviewFile = join(reviewsDir, "2026-01-01-plan-review.md");
			const runReviewFile = join(reviewsDir, "2026-01-01-impl-review.md");

			createRun(db, {
				id: "pr-run",
				planPath: canonicalPath,
				command: "plan-review",
				reviewPath: planReviewFile,
			});
			updateRunStatus(db, "pr-run", "completed");

			createRun(db, {
				id: "run-run",
				planPath: canonicalPath,
				command: "run",
				reviewPath: runReviewFile,
			});
			updateRunStatus(db, "run-run", "completed");

			// Filtered to plan-review: gets plan review path
			const forPlan = resolveReviewPath(db, planPath, reviewsDir, {
				command: "plan-review",
			});
			expect(forPlan).toBe(planReviewFile);

			// Filtered to run: gets run review path
			const forRun = resolveReviewPath(db, planPath, reviewsDir, {
				command: "run",
			});
			expect(forRun).toBe(runReviewFile);
		} finally {
			cleanup();
		}
	});

	test("command filter computes fresh path when no matching command in DB", () => {
		const { tmp, db, planPath, cleanup } = createTestEnv();
		try {
			const canonicalPath = canonicalizePlanPath(planPath);
			const reviewsDir = join(tmp, "docs/development/reviews");

			// Only a plan-review run exists
			createRun(db, {
				id: "pr-run",
				planPath: canonicalPath,
				command: "plan-review",
				reviewPath: join(reviewsDir, "2026-01-01-plan-review.md"),
			});
			updateRunStatus(db, "pr-run", "completed");

			// Looking for a 'run' command — no match, so fresh path is computed
			const dateStr = new Date().toISOString().slice(0, 10);
			const path = resolveReviewPath(db, planPath, reviewsDir, {
				command: "run",
			});
			expect(path).toContain(`${dateStr}-001-test-plan-review.md`);
			expect(path).not.toBe(join(reviewsDir, "2026-01-01-plan-review.md"));
		} finally {
			cleanup();
		}
	});
});

describe("runPlanReviewLoop", () => {
	test("happy path: reviewer approves immediately (ready)", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(true);
			expect(result.iterations).toBe(1);
			expect(result.escalations).toHaveLength(0);

			const canonical = canonicalizePlanPath(planPath);
			const run = getLatestRun(db, canonical);
			expect(run).not.toBeNull();
			expect(run?.status).toBe("completed");
			expect(run?.command).toBe("plan-review");
		} finally {
			cleanup();
		}
	});

	test("two-iteration fix: ready_with_corrections → auto_fix → re-review → ready", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				// First review: corrections needed
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "P1.1",
								title: "Fix naming",
								action: "auto_fix",
								reason: "Inconsistent naming",
							},
						],
					},
				},
				// Author fix
				{ type: "status", status: { result: "complete" } },
				// Second review: approved
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(true);
			expect(result.iterations).toBe(3); // reviewer1 + author-fix + reviewer2
			expect(result.escalations).toHaveLength(0);

			const agentResults = getAgentResults(db, result.runId, "-1");
			expect(agentResults.length).toBe(3);
			expect(agentResults[0]?.role).toBe("reviewer");
			expect(agentResults[1]?.role).toBe("author");
			expect(agentResults[2]?.role).toBe("reviewer");
		} finally {
			cleanup();
		}
	});

	test("escalation: human_required items → human aborts", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				{
					type: "verdict",
					verdict: {
						readiness: "not_ready",
						items: [
							{
								id: "P0.1",
								title: "Architecture concern",
								action: "human_required",
								reason: "Needs human decision on data model",
							},
						],
					},
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(result.escalations[0]?.items).toHaveLength(1);
			expect(result.escalations[0]?.items?.[0]?.id).toBe("P0.1");
		} finally {
			cleanup();
		}
	});

	test("escalation: human approves override", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				{
					type: "verdict",
					verdict: {
						readiness: "not_ready",
						items: [
							{
								id: "P0.1",
								title: "Concern",
								action: "human_required",
								reason: "Needs decision",
							},
						],
					},
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("approve"), projectRoot: tmp },
			);

			expect(result.approved).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("escalation: human continues → author fix then re-review", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			let humanCalls = 0;
			const adapter = createMockAdapter([
				// First review: human_required
				{
					type: "verdict",
					verdict: {
						readiness: "not_ready",
						items: [
							{
								id: "P0.1",
								title: "Concern",
								action: "human_required",
								reason: "Needs decision",
							},
						],
					},
				},
				// Author fix after human guidance
				{ type: "status", status: { result: "complete" } },
				// Second review after human continues: approved
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: async () => {
						humanCalls++;
						return "continue";
					},
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			expect(humanCalls).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("escalation guidance is passed into the next author fix prompt", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			let authorPrompt = "";
			const adapter = createMockAdapter(
				[
					{
						type: "verdict",
						verdict: {
							readiness: "not_ready",
							items: [
								{
									id: "P2.1",
									title: "Remote bind policy",
									action: "human_required",
									reason: "Need explicit stance",
								},
							],
						},
					},
					{ type: "status", status: { result: "complete" } },
					{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				],
				{
					onStatusInvoke: (opts) => {
						authorPrompt = opts.prompt;
					},
				},
			);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: async () => ({
						action: "continue",
						guidance: "Require explicit --allow-remote opt-in.",
					}),
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			expect(authorPrompt).toContain("Require explicit --allow-remote opt-in.");
			expect(authorPrompt).not.toContain("(No additional notes)");
		} finally {
			cleanup();
		}
	});

	test("max iterations reached → escalation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const config = { ...defaultConfig(), maxReviewIterations: 1 };

			// Create enough responses for multiple cycles
			const adapter = createMockAdapter([
				// First review: corrections
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "P1.1",
								title: "Fix",
								action: "auto_fix",
								reason: "issue",
							},
						],
					},
				},
				// Author fix
				{ type: "status", status: { result: "complete" } },
				// Second review: still corrections (but will hit max iterations)
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "P1.1",
								title: "Fix",
								action: "auto_fix",
								reason: "issue",
							},
						],
					},
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				config,
				{ auto: true, projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(
				result.escalations.some((e) =>
					e.reason.includes("Maximum review iterations"),
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("auto mode: human_required escalates and best-judgment fixes", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
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
				{ type: "status", status: { result: "complete" } },
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ auto: true, projectRoot: tmp },
			);

			expect(result.approved).toBe(true);
			expect(result.escalations).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	test("auto mode: aborts after max auto escalation retries", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
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

			const config = defaultConfig();
			config.maxAutoRetries = 2;
			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				config,
				{ auto: true, projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(result.escalations.length).toBeGreaterThanOrEqual(3);
		} finally {
			cleanup();
		}
	});

	test("reviewer invocation failure → escalation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				{ type: "error", error: new Error("connection timeout") },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(
				result.escalations.some((e) => e.reason.includes("connection timeout")),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("author needs_human during fix → escalation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "P1.1",
								title: "Fix",
								action: "auto_fix",
								reason: "Simple fix",
							},
						],
					},
				},
				{
					type: "status",
					status: {
						result: "needs_human",
						reason: "Cannot determine the right approach",
					},
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(
				result.escalations.some(
					(e) =>
						e.reason.includes("Cannot determine") ||
						e.reason.includes("human input"),
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("events are recorded in DB", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			const events = getRunEvents(db, result.runId);
			expect(events.length).toBeGreaterThan(0);

			const eventTypes = events.map((e) => e.event_type);
			expect(eventTypes).toContain("plan_review_start");
			expect(eventTypes).toContain("agent_invoke");
			expect(eventTypes).toContain("verdict");
			expect(eventTypes).toContain("plan_review_complete");
		} finally {
			cleanup();
		}
	});

	test("P0.1 regression: ready_with_corrections + empty items → escalation (not approval)", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [], // invariant violation
					},
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(
				result.escalations.some((e) => e.reason.includes("items' is empty")),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("not_ready + empty items → escalation (not approval)", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				{
					type: "verdict",
					verdict: { readiness: "not_ready", items: [] },
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(
				result.escalations.some((e) => e.reason.includes("items' is empty")),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("log files created for REVIEW and AUTO_FIX sites", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const adapter = createMockAdapter([
				// REVIEW: corrections needed
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "P1.1",
								title: "Fix naming",
								action: "auto_fix",
								reason: "Inconsistent naming",
							},
						],
					},
				},
				// AUTO_FIX: author fixes
				{ type: "status", status: { result: "complete" } },
				// REVIEW: approved
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(true);

			// Agent results should have log_path set
			const agentResults = getAgentResults(db, result.runId, "-1");
			for (const ar of agentResults) {
				expect(ar.log_path).toBeDefined();
				expect(ar.log_path).toMatch(/agent-.+\.ndjson$/);
			}
		} finally {
			cleanup();
		}
	});

	test("resume detection: start-fresh marks old run as aborted", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const canonical = canonicalizePlanPath(planPath);

			createRun(db, {
				id: "old-run",
				planPath: canonical,
				command: "plan-review",
				reviewPath,
			});

			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					resumeGate: fixedResumeGate("start-fresh"),
					humanGate: fixedHumanGate("abort"),
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			expect(result.runId).not.toBe("old-run");

			// Old run should be aborted
			const allRuns = db
				.query(
					"SELECT * FROM runs WHERE plan_path = ?1 ORDER BY started_at ASC",
				)
				.all(canonical) as Array<{ id: string; status: string }>;
			const old = allRuns.find((r) => r.id === "old-run");
			expect(old?.status).toBe("aborted");
		} finally {
			cleanup();
		}
	});

	test("auto mode auto-resumes without calling interactive resume gate", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const canonical = canonicalizePlanPath(planPath);

			createRun(db, {
				id: "auto-resume-plan",
				planPath: canonical,
				command: "plan-review",
				reviewPath,
			});

			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			// auto=true, no resumeGate override → should auto-resume
			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ auto: true, projectRoot: tmp },
			);

			expect(result.runId).toBe("auto-resume-plan");
			expect(result.approved).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("auto mode still calls explicitly provided resumeGate override", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const canonical = canonicalizePlanPath(planPath);

			createRun(db, {
				id: "auto-gate-override",
				planPath: canonical,
				command: "plan-review",
				reviewPath,
			});

			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			let resumeGateCalled = false;
			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					auto: true,
					projectRoot: tmp,
					resumeGate: async () => {
						resumeGateCalled = true;
						return "start-fresh";
					},
				},
			);

			expect(resumeGateCalled).toBe(true);
			expect(result.runId).not.toBe("auto-gate-override");
			expect(result.approved).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("auto mode auto-resumes ESCALATE state", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const canonical = canonicalizePlanPath(planPath);
			const stuckRunId = "escalate-stuck-plan";

			createRun(db, {
				id: stuckRunId,
				planPath: canonical,
				command: "plan-review",
				reviewPath,
			});
			updateRunStatus(db, stuckRunId, "active", "ESCALATE");

			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			// auto=true, no resumeGate → should resume ESCALATE run
			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ auto: true, projectRoot: tmp },
			);

			expect(result.runId).toBe(stuckRunId);
			expect(result.approved).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("auto mode starts fresh instead of resuming ABORTED state", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const canonical = canonicalizePlanPath(planPath);
			const stuckRunId = "aborted-stuck-plan";

			createRun(db, {
				id: stuckRunId,
				planPath: canonical,
				command: "plan-review",
				reviewPath,
			});
			updateRunStatus(db, stuckRunId, "active", "ABORTED");

			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ auto: true, projectRoot: tmp },
			);

			expect(result.runId).not.toBe(stuckRunId);
			expect(result.approved).toBe(true);

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

	test("resume backward compat: PARSE_VERDICT mapped to REVIEW", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const canonical = canonicalizePlanPath(planPath);
			const runId = "resume-parse-verdict-plan";

			createRun(db, {
				id: runId,
				planPath: canonical,
				command: "plan-review",
				reviewPath,
			});
			updateRunStatus(db, runId, "active", "PARSE_VERDICT");

			// Reviewer at iteration 0 but verdict was unparseable
			upsertAgentResult(db, {
				id: "ar-reviewer-0",
				run_id: runId,
				phase: "-1",
				iteration: 0,
				role: "reviewer",
				template: "reviewer-plan",
				result_type: "verdict",
				result_json: "null",
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});

			const adapter = createMockAdapter([]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					resumeGate: fixedResumeGate("resume"),
					humanGate: fixedHumanGate("abort"),
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});

	test("no stdout writes from plan-review loop when quiet=true (TUI active regression)", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const logCalls: unknown[][] = [];
			const recorder = (...args: unknown[]) => {
				logCalls.push(args);
			};
			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: fixedHumanGate("abort"),
					projectRoot: tmp,
					quiet: true,
					_log: recorder,
				},
			);

			expect(logCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("plan-review loop does produce log output when quiet=false (regression sanity)", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const logCalls: unknown[][] = [];
			const recorder = (...args: unknown[]) => {
				logCalls.push(args);
			};
			const adapter = createMockAdapter([
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: fixedHumanGate("abort"),
					projectRoot: tmp,
					quiet: false,
					_log: recorder,
				},
			);

			expect(logCalls.length).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});

	// -----------------------------------------------------------------------
	// Session reuse — author continuation at escalation gate
	// -----------------------------------------------------------------------

	test("continue_session routes to AUTO_FIX and passes sessionId to author", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			let capturedSessionId: string | undefined;
			let capturedPrompt = "";
			let statusCallCount = 0;
			const adapter = createMockAdapter(
				[
					// Reviewer: auto_fix items
					{
						type: "verdict",
						verdict: {
							readiness: "ready_with_corrections",
							items: [
								{
									id: "P1.1",
									title: "Fix",
									action: "auto_fix",
									reason: "issue",
								},
							],
						},
					},
					// Author fix → needs_human (creates escalation with sessionId)
					{
						type: "status",
						status: { result: "needs_human", reason: "stuck" },
					},
					// Author fix via continue_session → complete
					{ type: "status", status: { result: "complete" } },
					// Final review: approved
					{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				],
				{
					onStatusInvoke: (opts) => {
						statusCallCount++;
						// Capture the second author call (the continuation)
						if (statusCallCount === 2) {
							capturedSessionId = opts.sessionId;
							capturedPrompt = opts.prompt;
						}
					},
				},
			);

			let humanCallCount = 0;
			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: async (event) => {
						humanCallCount++;
						if (humanCallCount === 1) {
							// Author needs_human should include sessionId
							expect(event.sessionId).toBe("mock-session");
							return { action: "continue_session", guidance: "Try again" };
						}
						return { action: "abort" };
					},
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			// Should have passed the session ID to the author
			expect(capturedSessionId).toBe("mock-session");
			// Should use continuation prompt with guidance
			expect(capturedPrompt).toContain("Continue the current session");
			expect(capturedPrompt).toContain("Try again");
		} finally {
			cleanup();
		}
	});

	test("continue_session clears continueSessionId after use", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const sessionIds: (string | undefined)[] = [];
			const adapter = createMockAdapter(
				[
					// Reviewer: auto_fix
					{
						type: "verdict",
						verdict: {
							readiness: "ready_with_corrections",
							items: [
								{
									id: "P1.1",
									title: "Fix",
									action: "auto_fix",
									reason: "issue",
								},
							],
						},
					},
					// Author fix → needs_human (triggers escalation with sessionId)
					{
						type: "status",
						status: { result: "needs_human", reason: "stuck" },
					},
					// Author fix via continue_session → needs_human again
					{
						type: "status",
						status: { result: "needs_human", reason: "still stuck" },
					},
					// Author fix fresh (no continuation)
					{ type: "status", status: { result: "complete" } },
					// Final review: approved
					{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				],
				{
					onStatusInvoke: (opts) => {
						sessionIds.push(opts.sessionId);
					},
				},
			);

			let humanCallCount = 0;
			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: async () => {
						humanCallCount++;
						// First call: continue_session; second call: plain continue
						if (humanCallCount === 1) {
							return { action: "continue_session" };
						}
						return { action: "continue" };
					},
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			// First author: no sessionId (fresh). Second: continuation. Third: cleared.
			expect(sessionIds[0]).toBeUndefined();
			expect(sessionIds[1]).toBe("mock-session");
			expect(sessionIds[2]).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("failed continuation suppresses sessionId on next escalation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const escalationSessionIds: (string | undefined)[] = [];
			const adapter = createMockAdapter([
				// Reviewer: auto_fix
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "P1.1",
								title: "Fix",
								action: "auto_fix",
								reason: "issue",
							},
						],
					},
				},
				// Author fix → needs_human (escalation with sessionId)
				{
					type: "status",
					status: { result: "needs_human", reason: "stuck" },
				},
				// Author fix via continue_session → failed
				{
					type: "status",
					status: { result: "failed", reason: "broken" },
				},
				// Author fix fresh after continue
				{ type: "status", status: { result: "complete" } },
				// Final review: approved
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			let humanCallCount = 0;
			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: async (event) => {
						humanCallCount++;
						escalationSessionIds.push(event.sessionId);
						if (humanCallCount === 1) {
							return { action: "continue_session" };
						}
						// Second escalation: sessionId should be suppressed
						return { action: "continue" };
					},
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			// First escalation (needs_human) should have sessionId
			expect(escalationSessionIds[0]).toBe("mock-session");
			// Second escalation: continuation failed → sessionId suppressed
			expect(escalationSessionIds[1]).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("needs_human preserves sessionId for multi-turn continuation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const escalationSessionIds: (string | undefined)[] = [];
			const adapter = createMockAdapter([
				// Reviewer: auto_fix
				{
					type: "verdict",
					verdict: {
						readiness: "ready_with_corrections",
						items: [
							{
								id: "P1.1",
								title: "Fix",
								action: "auto_fix",
								reason: "issue",
							},
						],
					},
				},
				// Author fix → needs_human (first escalation)
				{
					type: "status",
					status: { result: "needs_human", reason: "stuck" },
				},
				// Author fix via continue_session → needs_human again (second escalation)
				{
					type: "status",
					status: { result: "needs_human", reason: "still stuck" },
				},
				// Author fix via second continue_session → complete
				{ type: "status", status: { result: "complete" } },
				// Final review: approved
				{ type: "verdict", verdict: { readiness: "ready", items: [] } },
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: async (event) => {
						escalationSessionIds.push(event.sessionId);
						return { action: "continue_session" };
					},
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			// Both escalations should preserve sessionId (needs_human doesn't suppress)
			expect(escalationSessionIds[0]).toBe("mock-session");
			expect(escalationSessionIds[1]).toBe("mock-session");
		} finally {
			cleanup();
		}
	});

	// -----------------------------------------------------------------------
	// Session reuse — reviewer session reuse across review cycles
	// -----------------------------------------------------------------------

	test("reviewer session is reused across review cycles", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewerSessionIds: (string | undefined)[] = [];
			const reviewerPrompts: string[] = [];
			const adapter = createMockAdapter(
				[
					// First review: corrections
					{
						type: "verdict",
						verdict: {
							readiness: "ready_with_corrections",
							items: [
								{
									id: "P1.1",
									title: "Fix",
									action: "auto_fix",
									reason: "issue",
								},
							],
						},
					},
					// Author fix
					{ type: "status", status: { result: "complete" } },
					// Second review (should reuse session): approved
					{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				],
				{
					onVerdictInvoke: (opts) => {
						reviewerSessionIds.push(opts.sessionId);
						reviewerPrompts.push(opts.prompt);
					},
				},
			);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{ projectRoot: tmp },
			);

			expect(result.approved).toBe(true);
			// First review: no session reuse (new session)
			expect(reviewerSessionIds[0]).toBeUndefined();
			// Second review: reuses the session from first review
			expect(reviewerSessionIds[1]).toBe("mock-session");
			// Second review should use follow-up prompt
			expect(reviewerPrompts[1]).toContain("revised the plan");
			expect(reviewerPrompts[1]).not.toContain("reviewer-plan");
		} finally {
			cleanup();
		}
	});

	test("reviewer session cleared on invocation failure", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewerSessionIds: (string | undefined)[] = [];
			const adapter = createMockAdapter(
				[
					// First review: corrections
					{
						type: "verdict",
						verdict: {
							readiness: "ready_with_corrections",
							items: [
								{
									id: "P1.1",
									title: "Fix",
									action: "auto_fix",
									reason: "issue",
								},
							],
						},
					},
					// Author fix
					{ type: "status", status: { result: "complete" } },
					// Second review: fails
					{ type: "error", error: new Error("session lost") },
					// Third review (should NOT reuse): approved
					{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				],
				{
					onVerdictInvoke: (opts) => {
						reviewerSessionIds.push(opts.sessionId);
					},
				},
			);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: fixedHumanGate("continue"),
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			// First: no reuse; second: reuse from first; third: cleared after failure
			expect(reviewerSessionIds[0]).toBeUndefined();
			expect(reviewerSessionIds[1]).toBe("mock-session");
			expect(reviewerSessionIds[2]).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("reviewer session cleared on invalid verdict", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewerSessionIds: (string | undefined)[] = [];
			const adapter = createMockAdapter(
				[
					// First review: corrections (valid)
					{
						type: "verdict",
						verdict: {
							readiness: "ready_with_corrections",
							items: [
								{
									id: "P1.1",
									title: "Fix",
									action: "auto_fix",
									reason: "issue",
								},
							],
						},
					},
					// Author fix
					{ type: "status", status: { result: "complete" } },
					// Second review: invalid verdict (empty items on ready_with_corrections)
					{
						type: "verdict",
						verdict: {
							readiness: "ready_with_corrections",
							items: [],
						},
					},
					// Third review (should NOT reuse session): approved
					{ type: "verdict", verdict: { readiness: "ready", items: [] } },
				],
				{
					onVerdictInvoke: (opts) => {
						reviewerSessionIds.push(opts.sessionId);
					},
				},
			);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				adapter,
				defaultConfig(),
				{
					humanGate: fixedHumanGate("continue"),
					projectRoot: tmp,
				},
			);

			expect(result.approved).toBe(true);
			// First: no reuse; second: reuse; third: cleared after invalid verdict
			expect(reviewerSessionIds[0]).toBeUndefined();
			expect(reviewerSessionIds[1]).toBe("mock-session");
			expect(reviewerSessionIds[2]).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});
