import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	LegacyAgentAdapter as AgentAdapter,
	AgentResult,
	LegacyInvokeOptions,
} from "../../src/agents/types.js";
import type { FiveXConfig } from "../../src/config.js";
import {
	createRun,
	getAgentResults,
	getLatestRun,
	getRunEvents,
	updateRunStatus,
} from "../../src/db/operations.js";
import { runMigrations } from "../../src/db/schema.js";
import {
	resolveReviewPath,
	runPlanReviewLoop,
} from "../../src/orchestrator/plan-review-loop.js";
import { canonicalizePlanPath } from "../../src/paths.js";

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

/** Create an isolated test environment. Returns { tmp, db, planPath, reviewPath, cleanup }. */
function createTestEnv() {
	const tmp = mkdtempSync(join(tmpdir(), "5x-plan-review-loop-"));

	// Use a direct DB connection (not the getDb singleton) to avoid concurrency
	// issues when test files run concurrently under `bun test --concurrent`.
	const dbDir = join(tmp, ".5x");
	mkdirSync(dbDir, { recursive: true });
	const db = new Database(join(dbDir, "5x.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);

	// Create plan file
	const plansDir = join(tmp, "docs", "development");
	mkdirSync(plansDir, { recursive: true });
	const planPath = join(plansDir, "001-test-plan.md");
	writeFileSync(planPath, PLAN_CONTENT);

	// Create reviews directory
	const reviewsDir = join(tmp, "docs", "development", "reviews");
	mkdirSync(reviewsDir, { recursive: true });
	const reviewPath = join(reviewsDir, "test-review.md");

	const cleanup = () => {
		try {
			db.close();
		} catch {}
		rmSync(tmp, { recursive: true, force: true });
	};

	return { tmp, db, planPath, reviewPath, cleanup };
}

/** Build a verdict HTML comment block. */
function verdictBlock(opts: {
	readiness: string;
	reviewPath: string;
	items: Array<{
		id: string;
		title: string;
		action: string;
		reason: string;
	}>;
}): string {
	if (opts.items.length === 0) {
		return `<!-- 5x:verdict
protocolVersion: 1
readiness: ${opts.readiness}
reviewPath: "${opts.reviewPath}"
items: []
-->`;
	}
	const itemsYaml = opts.items
		.map(
			(i) =>
				`  - id: "${i.id}"\n    title: "${i.title}"\n    action: ${i.action}\n    reason: "${i.reason}"`,
		)
		.join("\n");
	return `<!-- 5x:verdict
protocolVersion: 1
readiness: ${opts.readiness}
reviewPath: "${opts.reviewPath}"
items:
${itemsYaml}
-->`;
}

/** Build a status HTML comment block. */
function statusBlock(opts: { result: string; reason?: string }): string {
	let yaml = `protocolVersion: 1\nresult: ${opts.result}`;
	if (opts.reason) yaml += `\nreason: "${opts.reason}"`;
	return `<!-- 5x:status\n${yaml}\n-->`;
}

/** Create a mock adapter that returns predetermined results. */
function mockAdapter(
	name: string,
	responses: Array<{
		output: string;
		exitCode?: number;
		duration?: number;
		/** If provided, write this content to a file before returning. */
		writeFile?: { path: string; content: string };
	}>,
): AgentAdapter {
	let callIndex = 0;
	return {
		name,
		async isAvailable() {
			return true;
		},
		async invoke(_opts: LegacyInvokeOptions): Promise<AgentResult> {
			const response = responses[callIndex];
			if (!response) {
				throw new Error(
					`Mock adapter "${name}" exhausted responses (called ${callIndex + 1} times)`,
				);
			}
			callIndex++;

			if (response.writeFile) {
				writeFileSync(response.writeFile.path, response.writeFile.content);
			}

			return {
				output: response.output,
				exitCode: response.exitCode ?? 0,
				duration: response.duration ?? 1000,
			};
		},
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
			// Should compute fresh path, not reuse the outside path
			expect(path).not.toBe("/some/outside/review.md");
			const dateStr = new Date().toISOString().slice(0, 10);
			expect(path).toContain(`${dateStr}-001-test-plan-review.md`);
		} finally {
			cleanup();
		}
	});
});

describe("runPlanReviewLoop", () => {
	test("happy path: reviewer approves immediately (ready)", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Review complete.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready",
							reviewPath,
							items: [],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(true);
			expect(result.iterations).toBe(1); // reviewer called once
			expect(result.escalations).toHaveLength(0);

			// Verify DB state
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
			const reviewer = mockAdapter("reviewer", [
				// First review: corrections needed
				{
					output: "Corrections needed.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready_with_corrections",
							reviewPath,
							items: [
								{
									id: "P1.1",
									title: "Fix naming",
									action: "auto_fix",
									reason: "Inconsistent naming",
								},
							],
						})}`,
					},
				},
				// Second review: approved
				{
					output: "Looks good now.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready",
							reviewPath,
							items: [],
						})}`,
					},
				},
			]);

			const author = mockAdapter("author", [
				// Fix applied
				{
					output: `Fixed naming.\n${statusBlock({ result: "completed" })}`,
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(true);
			expect(result.iterations).toBe(3); // reviewer1 + author-fix + reviewer2
			expect(result.escalations).toHaveLength(0);

			// Verify agent results in DB
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
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Review complete.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "not_ready",
							reviewPath,
							items: [
								{
									id: "P0.1",
									title: "Architecture concern",
									action: "human_required",
									reason: "Needs human decision on data model",
								},
							],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Review complete.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "not_ready",
							reviewPath,
							items: [
								{
									id: "P0.1",
									title: "Concern",
									action: "human_required",
									reason: "Needs decision",
								},
							],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ humanGate: fixedHumanGate("approve"), projectRoot: tmp },
			);

			expect(result.approved).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("escalation: human continues → re-review", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			let humanCalls = 0;
			const reviewer = mockAdapter("reviewer", [
				// First review: human_required
				{
					output: "Issues found.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "not_ready",
							reviewPath,
							items: [
								{
									id: "P0.1",
									title: "Concern",
									action: "human_required",
									reason: "Needs decision",
								},
							],
						})}`,
					},
				},
				// Second review after human continues: approved
				{
					output: "Approved.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready",
							reviewPath,
							items: [],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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

	test("max iterations reached → escalation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			// Config with very low max iterations
			const config = { ...defaultConfig(), maxReviewIterations: 1 };

			// Create enough responses for 2 full cycles (reviewer + author fix each)
			const reviewerResponses = Array.from({ length: 4 }, () => ({
				output: "Corrections needed.",
				writeFile: {
					path: reviewPath,
					content: `# Review\n\n${verdictBlock({
						readiness: "ready_with_corrections",
						reviewPath,
						items: [
							{
								id: "P1.1",
								title: "Fix",
								action: "auto_fix",
								reason: "issue",
							},
						],
					})}`,
				},
			}));

			const authorResponses = Array.from({ length: 4 }, () => ({
				output: `Fixed.\n${statusBlock({ result: "completed" })}`,
			}));

			const reviewer = mockAdapter("reviewer", reviewerResponses);
			const author = mockAdapter("author", authorResponses);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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

	test("auto mode: auto_fix proceeds, human_required escalates and aborts", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Issues found.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "not_ready",
							reviewPath,
							items: [
								{
									id: "P0.1",
									title: "Architecture",
									action: "human_required",
									reason: "Needs decision",
								},
							],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ auto: true, projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});

	test("missing verdict block → escalation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewer = mockAdapter("reviewer", [
				{
					// Reviewer produces output but no verdict block
					output: "Some review text without a verdict block.",
					writeFile: {
						path: reviewPath,
						content: "# Review\n\nSome feedback but no verdict block.",
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(
				result.escalations.some((e) => e.reason.includes("5x:verdict")),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("author needs_human during fix → escalation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Corrections needed.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready_with_corrections",
							reviewPath,
							items: [
								{
									id: "P1.1",
									title: "Fix",
									action: "auto_fix",
									reason: "Simple fix",
								},
							],
						})}`,
					},
				},
			]);

			const author = mockAdapter("author", [
				{
					output: `I'm stuck.\n${statusBlock({
						result: "needs_human",
						reason: "Cannot determine the right approach",
					})}`,
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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

	test("reviewer non-zero exit code → escalation", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Error occurred",
					exitCode: 1,
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(
				result.escalations.some((e) => e.reason.includes("exited with code")),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("events are recorded in DB", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Approved.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready",
							reviewPath,
							items: [],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			// Simulate parser-dropped items: reviewer says ready_with_corrections
			// but all items had invalid actions, so parsed items array is empty.
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Corrections needed.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready_with_corrections",
							reviewPath,
							items: [], // All items dropped by parser
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(
				result.escalations.some((e) =>
					e.reason.includes("no auto-fixable items"),
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("not_ready + empty items → escalation (not approval)", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Not ready.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "not_ready",
							reviewPath,
							items: [],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(
				result.escalations.some((e) =>
					e.reason.includes("no auto-fixable items"),
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("ndjson log files created for REVIEW and AUTO_FIX sites", async () => {
		// reviewer → auto_fix → re-review = 3 agent calls → 3 ndjson log files
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const reviewer = mockAdapter("reviewer", [
				{
					output: "Corrections needed.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready_with_corrections",
							reviewPath,
							items: [
								{
									id: "P1.1",
									title: "Fix naming",
									action: "auto_fix",
									reason: "Inconsistent naming",
								},
							],
						})}`,
					},
				},
				{
					output: "Looks good now.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready",
							reviewPath,
							items: [],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", [
				{
					output: `Fixed.\n${statusBlock({ result: "completed" })}`,
				},
			]);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(),
				{ humanGate: fixedHumanGate("abort"), projectRoot: tmp },
			);

			expect(result.approved).toBe(true);

			// Verify .ndjson log files exist for both invocation sites
			const { existsSync, readdirSync } = await import("node:fs");
			const logDir = join(tmp, ".5x", "logs", result.runId);
			expect(existsSync(logDir)).toBe(true);

			const logFiles = readdirSync(logDir).filter((f) => f.endsWith(".ndjson"));
			// reviewer1 + author-fix + reviewer2 = 3 ndjson logs
			expect(logFiles.length).toBe(3);
		} finally {
			cleanup();
		}
	});

	test("resume detection: start-fresh marks old run as aborted", async () => {
		const { tmp, db, planPath, reviewPath, cleanup } = createTestEnv();
		try {
			const canonical = canonicalizePlanPath(planPath);

			// Simulate an interrupted run
			createRun(db, {
				id: "old-run",
				planPath: canonical,
				command: "plan-review",
				reviewPath,
			});

			const reviewer = mockAdapter("reviewer", [
				{
					output: "Approved.",
					writeFile: {
						path: reviewPath,
						content: `# Review\n\n${verdictBlock({
							readiness: "ready",
							reviewPath,
							items: [],
						})}`,
					},
				},
			]);
			const author = mockAdapter("author", []);

			const result = await runPlanReviewLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
});
