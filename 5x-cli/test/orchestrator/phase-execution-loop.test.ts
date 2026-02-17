import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentAdapter,
	AgentResult,
	InvokeOptions,
} from "../../src/agents/types.js";
import type { FiveXConfig } from "../../src/config.js";
import { getAgentResults, getRunEvents } from "../../src/db/operations.js";
import { runMigrations } from "../../src/db/schema.js";
import type {
	EscalationEvent,
	EscalationResponse,
	PhaseSummary,
} from "../../src/gates/human.js";
import { runPhaseExecutionLoop } from "../../src/orchestrator/phase-execution-loop.js";

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
		author: { adapter: "claude-code" },
		reviewer: { adapter: "claude-code" },
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

function verdictBlock(opts: {
	readiness: string;
	reviewPath: string;
	items?: Array<{
		id: string;
		title: string;
		action: string;
		reason: string;
	}>;
}): string {
	const items = opts.items ?? [];
	if (items.length === 0) {
		return `<!-- 5x:verdict
protocolVersion: 1
readiness: ${opts.readiness}
reviewPath: "${opts.reviewPath}"
items: []
-->`;
	}
	const itemsYaml = items
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

function statusBlock(opts: {
	result: string;
	commit?: string;
	phase?: number;
	reason?: string;
}): string {
	let yaml = `protocolVersion: 1\nresult: ${opts.result}`;
	if (opts.commit) yaml += `\ncommit: ${opts.commit}`;
	if (opts.phase !== undefined) yaml += `\nphase: ${opts.phase}`;
	if (opts.reason) yaml += `\nreason: "${opts.reason}"`;
	return `<!-- 5x:status\n${yaml}\n-->`;
}

function mockAdapter(
	name: string,
	responses: Array<{
		output: string;
		exitCode?: number;
		duration?: number;
		writeFile?: { path: string; content: string };
	}>,
): AgentAdapter {
	let callIndex = 0;
	return {
		name,
		async isAvailable() {
			return true;
		},
		async invoke(_opts: InvokeOptions): Promise<AgentResult> {
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({
						result: "completed",
						commit: "abc123",
						phase: 1,
					}),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "aaa", phase: 1 }),
				},
				{
					output: statusBlock({ result: "completed", commit: "bbb", phase: 2 }),
				},
				{
					output: statusBlock({ result: "completed", commit: "ccc", phase: 3 }),
				},
			]);
			const makeReviewer = () => ({
				output: verdictBlock({ readiness: "ready", reviewPath }),
				writeFile: {
					path: reviewPath,
					content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
				},
			});
			const reviewer = mockAdapter("reviewer", [
				makeReviewer(),
				makeReviewer(),
				makeReviewer(),
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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

			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
				{
					output: statusBlock({ result: "completed", commit: "def", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({
						readiness: "ready_with_corrections",
						reviewPath,
						items: [
							{
								id: "p1-1",
								title: "Missing test",
								action: "auto_fix",
								reason: "Add test",
							},
						],
					}),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({
							readiness: "ready_with_corrections",
							reviewPath,
							items: [
								{
									id: "p1-1",
									title: "Missing test",
									action: "auto_fix",
									reason: "Add test",
								},
							],
						})}`,
					},
				},
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({
						readiness: "not_ready",
						reviewPath,
						items: [
							{
								id: "p0-1",
								title: "API design",
								action: "human_required",
								reason: "Needs decision",
							},
						],
					}),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({
							readiness: "not_ready",
							reviewPath,
							items: [
								{
									id: "p0-1",
									title: "API design",
									action: "human_required",
									reason: "Needs decision",
								},
							],
						})}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({
						result: "needs_human",
						phase: 1,
						reason: "Ambiguous requirement",
					}),
				},
			]);
			const reviewer = mockAdapter("reviewer", []);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("Ambiguous requirement");
		} finally {
			cleanup();
		}
	});

	test("author failure escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const author = mockAdapter("author", [{ output: "error", exitCode: 1 }]);
			const reviewer = mockAdapter("reviewer", []);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("exited with code 1");
		} finally {
			cleanup();
		}
	});

	test("missing status block escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const author = mockAdapter("author", [
				{ output: "Did some work but forgot status block" },
			]);
			const reviewer = mockAdapter("reviewer", []);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("5x:status");
		} finally {
			cleanup();
		}
	});

	test("missing verdict block escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{ output: "Great work! No verdict block." },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations[0]?.reason).toContain("5x:verdict");
		} finally {
			cleanup();
		}
	});

	test("phase gate with human approval", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({
						result: "needs_human",
						phase: 1,
						reason: "Question",
					}),
				},
			]);
			const reviewer = mockAdapter("reviewer", []);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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

			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
			const makeReviewer = () => ({
				output: verdictBlock({ readiness: "ready", reviewPath }),
				writeFile: {
					path: reviewPath,
					content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
				},
			});
			const author = mockAdapter("author", [
				{
					output: statusBlock({ result: "completed", commit: "bbb", phase: 2 }),
				},
				{
					output: statusBlock({ result: "completed", commit: "ccc", phase: 3 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				makeReviewer(),
				makeReviewer(),
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, startPhase: "2" },
			);

			expect(result.phasesCompleted).toBe(3);
			expect(result.complete).toBe(true);
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
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				mockAdapter("author", []),
				mockAdapter("reviewer", []),
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.totalPhases).toBe(0);
			expect(result.phasesCompleted).toBe(0);
		} finally {
			cleanup();
		}
	});
});
