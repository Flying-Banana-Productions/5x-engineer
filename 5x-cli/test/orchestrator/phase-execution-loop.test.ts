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
	LegacyAgentAdapter as AgentAdapter,
	AgentResult,
	LegacyInvokeOptions,
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

	test("QUALITY_RETRY missing status block escalates", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const cfg = defaultConfig(tmp);
			cfg.qualityGates = ["exit 1"]; // will fail, triggering QUALITY_RETRY

			const author = mockAdapter("author", [
				// EXECUTE: completes with status
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
				// QUALITY_RETRY: succeeds (exitCode 0) but no status block
				{ output: "Fixed things but forgot status block" },
			]);
			const reviewer = mockAdapter("reviewer", []);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
				cfg,
				{ workdir: tmp, auto: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			expect(result.escalations[0]?.reason).toContain(
				"did not produce a status block during quality fix",
			);
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

	test("resume from mid-phase restores state at QUALITY_CHECK", async () => {
		// Simulate: phase 1 author completed (EXECUTE done), interrupted before quality check.
		// On resume, should skip author EXECUTE and enter QUALITY_CHECK directly.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const runId = "resume-test-run-id-1234";
			// Create an "active" run at QUALITY_CHECK for phase 1
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

			// Author should NOT be called for EXECUTE (it was completed).
			// The reviewer WILL be called after quality check passes.
			const author = mockAdapter("author", []);
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
		// Simulate: phase 1 completed author+quality+review, interrupted at PHASE_GATE.
		// On resume, should skip all agents and enter PHASE_GATE directly.
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
					reviewPath,
					items: [],
				}),
				duration_ms: 1000,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
			});

			// No agents should be called — goes straight to PHASE_GATE.
			const author = mockAdapter("author", []);
			const reviewer = mockAdapter("reviewer", []);

			let phaseGateCalled = false;
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				reviewer,
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
		// Ensure iteration counter on resume uses per-phase max, not all-results count.
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
				mockAdapter("author", []),
				reviewer,
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
		// When projectRoot is provided, logs should go to projectRoot/.5x/logs/
		// not to dirname(planPath)/.5x/logs/ (which would be inside the worktree).
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		const fakeProjectRoot = join(tmp, "main-checkout");
		mkdirSync(join(fakeProjectRoot, ".5x"), { recursive: true });

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

	test("ndjson log files created for EXECUTE, REVIEW, and AUTO_FIX sites", async () => {
		// EXECUTE + REVIEW (needs fixes) + AUTO_FIX + REVIEW (ready) = 4 agent calls → 4 ndjson logs
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const author = mockAdapter("author", [
				// EXECUTE: initial author run
				{
					output: statusBlock({ result: "completed", commit: "abc", phase: 1 }),
				},
				// AUTO_FIX: author fixes review items
				{
					output: statusBlock({ result: "completed", commit: "ghi", phase: 1 }),
				},
			]);
			const reviewer = mockAdapter("reviewer", [
				// REVIEW: first review — needs fixes
				{
					output: verdictBlock({
						readiness: "ready_with_corrections",
						reviewPath,
						items: [
							{
								id: "p1-1",
								title: "Fix test",
								action: "auto_fix",
								reason: "Missing test",
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
									title: "Fix test",
									action: "auto_fix",
									reason: "Missing test",
								},
							],
						})}`,
					},
				},
				// REVIEW: second review after auto_fix — ready
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
				{ workdir: tmp, auto: true, projectRoot: tmp },
			);

			expect(result.complete).toBe(true);

			// Verify .ndjson log files exist for all invocation sites
			const logDir = join(tmp, ".5x", "logs", result.runId);
			expect(existsSync(logDir)).toBe(true);

			const { readdirSync } = await import("node:fs");
			const logFiles = readdirSync(logDir).filter((f) => f.endsWith(".ndjson"));
			// Should have 4 ndjson logs: EXECUTE + REVIEW(first) + AUTO_FIX + REVIEW(second)
			expect(logFiles.length).toBe(4);
		} finally {
			cleanup();
		}
	});

	test("onEvent called when quiet=false, not called when quiet=true", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			let onEventCallCount = 0;

			// Create a mock adapter that captures whether onEvent is being set
			const capturingAdapter: AgentAdapter = {
				name: "capture",
				isAvailable: async () => true,
				invoke: async (opts: LegacyInvokeOptions) => {
					if (opts.onEvent) {
						// Simulate an event being fired
						opts.onEvent({ type: "result", subtype: "success" }, "{}");
						onEventCallCount++;
					}
					return {
						output: statusBlock({
							result: "completed",
							commit: "abc",
							phase: 1,
						}),
						exitCode: 0,
						duration: 100,
					};
				},
			};

			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			// quiet=false: onEvent should be set
			onEventCallCount = 0;
			const result1 = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				capturingAdapter,
				reviewer,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, quiet: false },
			);
			expect(result1.complete).toBe(true);
			// onEvent was called at least once (EXECUTE + REVIEW)
			expect(onEventCallCount).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});

	test("quiet=true suppresses onEvent (no formatting calls)", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			let onEventWasSet = false;

			const capturingAdapter: AgentAdapter = {
				name: "capture-quiet",
				isAvailable: async () => true,
				invoke: async (opts: LegacyInvokeOptions) => {
					if (opts.onEvent) onEventWasSet = true;
					return {
						output: statusBlock({
							result: "completed",
							commit: "abc",
							phase: 1,
						}),
						exitCode: 0,
						duration: 100,
					};
				},
			};

			const reviewer = mockAdapter("reviewer", [
				{
					output: verdictBlock({ readiness: "ready", reviewPath }),
					writeFile: {
						path: reviewPath,
						content: `Review\n\n${verdictBlock({ readiness: "ready", reviewPath })}`,
					},
				},
			]);

			// quiet=true: onEvent should NOT be set
			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				capturingAdapter,
				reviewer,
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, quiet: true },
			);
			expect(result.complete).toBe(true);
			expect(onEventWasSet).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("escalation in quiet mode includes output snippet and log path", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const author = mockAdapter("author", [
				{
					output: "Agent failed with some output",
					exitCode: 1,
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				mockAdapter("reviewer", []),
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, quiet: true },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			const escalation = result.escalations[0];
			if (!escalation) throw new Error("Expected at least one escalation");
			// In quiet mode: reason should include log path AND output snippet
			expect(escalation.reason).toContain("Log:");
			expect(escalation.reason).toContain("Agent failed with some output");
			expect(escalation.logPath).toBeDefined();
		} finally {
			cleanup();
		}
	});

	test("escalation in non-quiet mode includes log path but NOT output snippet", async () => {
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const author = mockAdapter("author", [
				{
					output: "Agent failed with some output",
					exitCode: 1,
				},
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				mockAdapter("reviewer", []),
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, quiet: false },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			const escalation = result.escalations[0];
			if (!escalation) throw new Error("Expected at least one escalation");
			// In non-quiet mode: reason should include log path but NOT output snippet
			expect(escalation.reason).toContain("Log:");
			expect(escalation.reason).not.toContain("Agent failed with some output");
			expect(escalation.logPath).toBeDefined();
		} finally {
			cleanup();
		}
	});

	test("PARSE_AUTHOR_STATUS escalation includes logPath from preceding EXECUTE", async () => {
		// When author produces no status block, the escalation should carry the
		// NDJSON log path of the EXECUTE invocation that produced the bad output.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const author = mockAdapter("author", [
				{ output: "Did some work but forgot status block" },
			]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				mockAdapter("reviewer", []),
				defaultConfig(tmp),
				{ workdir: tmp, auto: true, projectRoot: tmp },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			const escalation = result.escalations[0];
			if (!escalation) throw new Error("Expected at least one escalation");
			// PARSE_AUTHOR_STATUS escalation must carry the EXECUTE log path.
			expect(escalation.logPath).toBeDefined();
			expect(escalation.logPath).toMatch(/agent-.+\.ndjson$/);
		} finally {
			cleanup();
		}
	});

	test("PARSE_VERDICT escalation includes logPath from preceding REVIEW", async () => {
		// When reviewer produces no verdict block, the escalation should carry the
		// NDJSON log path of the REVIEW invocation.
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
				{ workdir: tmp, auto: true, projectRoot: tmp },
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			const escalation = result.escalations[0];
			if (!escalation) throw new Error("Expected at least one escalation");
			// PARSE_VERDICT escalation must carry the REVIEW log path.
			expect(escalation.logPath).toBeDefined();
			expect(escalation.logPath).toMatch(/agent-.+\.ndjson$/);
		} finally {
			cleanup();
		}
	});

	test("exit-code escalation iteration matches agent result iteration (no off-by-one)", async () => {
		// When author exits non-zero, the escalation's iteration should equal the
		// iteration at which the agent was invoked (not post-increment).
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");

		try {
			const author = mockAdapter("author", [{ output: "error", exitCode: 1 }]);

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				author,
				mockAdapter("reviewer", []),
				defaultConfig(tmp),
				{ workdir: tmp, auto: true },
			);

			expect(result.escalations.length).toBeGreaterThan(0);
			const escalation = result.escalations[0];
			if (!escalation) throw new Error("Expected at least one escalation");
			// Author was invoked at iteration 0; escalation should be at iteration 0.
			expect(escalation.iteration).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("resume into PARSE_AUTHOR_STATUS uses correct lastInvokeIteration", async () => {
		// Simulate: author completed at iteration 0, then interrupted at PARSE_AUTHOR_STATUS.
		// On resume, escalation (missing status) should reference iteration 0, not 1.
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const runId = "resume-parse-status-1234";
			createRun(db, {
				id: runId,
				planPath,
				command: "run",
				reviewPath,
			});
			updateRunStatus(db, runId, "active", "PARSE_AUTHOR_STATUS", "1");

			// Author completed at iteration 0 but status was unparseable
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

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				mockAdapter("author", []),
				mockAdapter("reviewer", []),
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					resumeGate: async () => "resume",
				},
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			// Escalation should reference iteration 0 (the invocation that produced the result)
			expect(result.escalations[0]?.iteration).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("resume into PARSE_VERDICT uses correct lastInvokeIteration", async () => {
		// Simulate: author at iter 0, reviewer at iter 1, interrupted at PARSE_VERDICT.
		// On resume, escalation should reference iteration 1 (the reviewer invocation).
		const { tmp, db, reviewPath, cleanup } = createTestEnv(PLAN_ONE_PHASE);
		const planPath = join(tmp, "docs", "development", "001-test-plan.md");
		try {
			const runId = "resume-parse-verdict-1234";
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
			// Reviewer at iteration 1 but verdict was unparseable
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

			const result = await runPhaseExecutionLoop(
				planPath,
				reviewPath,
				db,
				mockAdapter("author", []),
				mockAdapter("reviewer", []),
				defaultConfig(tmp),
				{
					workdir: tmp,
					auto: true,
					resumeGate: async () => "resume",
				},
			);

			expect(result.complete).toBe(false);
			expect(result.escalations.length).toBeGreaterThan(0);
			// Escalation should reference iteration 1 (the reviewer invocation), not 2
			expect(result.escalations[0]?.iteration).toBe(1);
		} finally {
			cleanup();
		}
	});
});
