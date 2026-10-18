/**
 * Unit tests for invoke command internals.
 *
 * Tests cover pure functions called by the invoke handler — no subprocesses.
 * Template resolution, variable substitution, structured output validation,
 * NDJSON log helpers, schema contracts, exit codes, provider factory routing.
 *
 * CLI-level tests (exit codes from subprocess, arg parsing, stderr streaming)
 * remain in test/integration/commands/invoke.test.ts.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeImplementationReviewerRecord } from "../../../src/commands/implementation-review-context.js";
import { initScaffold } from "../../../src/commands/init.handler.js";
import { invokeAgent } from "../../../src/commands/invoke.handler.js";
import { RecordContextError } from "../../../src/commands/record-context.js";
import { templateRender } from "../../../src/commands/template.handler.js";
import { recordedEnvelope } from "../../../src/control-plane/record-types.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { createProvider } from "../../../src/providers/factory.js";
import type { AgentProvider } from "../../../src/providers/types.js";
import {
	encodeImplementationReviewObservationPayload,
	implementationReviewObservationKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	capturePhaseAuthorAdmission,
	hashPlanBytes,
	prepareImplementationReviewContext,
} from "../../../src/review-governance/implementation-state.js";
import { prepareTextAmendmentGuard } from "../../../src/review-governance/plan-amendment.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";
import {
	makeBudgetContext,
	pendingSnapshot,
	seedPromptGovernanceContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-invoke-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Per-test control-plane file. Never touches the process-wide getDb singleton. */
function openPrivateControlPlaneDb(dir: string): Database {
	const stateDir = join(dir, ".5x");
	mkdirSync(stateDir, { recursive: true });
	const db = new Database(join(stateDir, "5x.db"));
	db.exec("PRAGMA busy_timeout=5000");
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	runMigrations(db);
	return db;
}

function structuredProvider(structured: unknown): AgentProvider {
	const result = {
		text: "structured response",
		structured,
		sessionId: "session-governance",
		tokens: { in: 0, out: 0 },
		durationMs: 0,
	};
	const session = {
		id: result.sessionId,
		run: async () => result,
		async *runStreamed() {
			yield { type: "done" as const, result };
		},
	};
	return {
		startSession: async () => session,
		resumeSession: async () => session,
		close: async () => {},
	};
}

// ===========================================================================
// Template resolution
// ===========================================================================

describe("invoke — template resolution (unit)", () => {
	test("bundled template loads successfully", async () => {
		const { loadTemplate } = await import("../../../src/templates/loader.js");
		const result = loadTemplate("author-next-phase");
		expect(result.metadata.name).toBe("author-next-phase");
		expect(result.body).toBeTruthy();
		expect(result.metadata.variables.length).toBeGreaterThan(0);
	});

	test("template override takes precedence over bundled", async () => {
		const dir = makeTmpDir();
		try {
			const { loadTemplate, setTemplateOverrideDir } = await import(
				"../../../src/templates/loader.js"
			);

			const overrideDir = join(dir, "prompts");
			mkdirSync(overrideDir, { recursive: true });

			const overrideContent = [
				"---",
				"name: author-next-phase",
				"version: 99",
				"variables:",
				"  - plan_path",
				"  - phase_number",
				"  - user_notes",
				"---",
				"",
				"OVERRIDE TEMPLATE BODY {{plan_path}} {{phase_number}} {{user_notes}}",
			].join("\n");

			writeFileSync(join(overrideDir, "author-next-phase.md"), overrideContent);

			setTemplateOverrideDir(overrideDir);
			const result = loadTemplate("author-next-phase");
			expect(result.metadata.version).toBe(99);
			expect(result.body).toContain("OVERRIDE TEMPLATE BODY");

			setTemplateOverrideDir(null);
		} finally {
			cleanupDir(dir);
		}
	});

	test("unknown template throws appropriate error", async () => {
		const { loadTemplate } = await import("../../../src/templates/loader.js");
		expect(() => loadTemplate("nonexistent-template")).toThrow(
			/Unknown template/,
		);
	});
});

describe("invoke reviewer — plan read state", () => {
	const budgetPlan = `## Delivery Budget
- Estimate confidence: high
| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | Work | 2 | 0 | - | - | Needed |
### Surface Snapshot
- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0`;

	async function setupBudgetInvoke(dir: string, humanGate = false) {
		for (const args of [
			["init"],
			["config", "user.email", "test@test.com"],
			["config", "user.name", "Test"],
		] as const) {
			Bun.spawnSync(["git", ...args], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		}
		// Create the file first so initScaffold skips the process-wide singleton.
		const db = openPrivateControlPlaneDb(dir);
		try {
			await initScaffold({ startDir: dir });
			const planPath = join(dir, "plan.md");
			writeFileSync(planPath, "# Provider-visible plan\n");
			createRunV1(db, { id: "run1", planPath });
			const structured = humanGate
				? `[sample.structured]
readiness = "not_ready"
creditAssessments = []

[[sample.structured.items]]
id = "H1"
title = "Operator decision required"
action = "human_required"
reason = "The residual failure requires explicit acceptance."
scopeClass = "acceptance_required"
effortDelta = 0
architectureDelta = 0
estimateConfidence = "high"
failure = "A retry can duplicate the durable write."
lowestCostCorrection = "Require an operator decision."

[sample.structured.baselineAssessment]
independentEffortEstimate = 2
confidence = "high"
reason = "The original estimate remains sound."
`
				: `[sample.structured]
readiness = "ready"
items = []
creditAssessments = []

[sample.structured.baselineAssessment]
independentEffortEstimate = 2
confidence = "high"
reason = "estimate"
`;
			writeFileSync(
				join(dir, "5x.toml"),
				`[author]
provider = "sample"
model = "sample/test"

[reviewer]
provider = "sample"
model = "sample/test"

[sample]
echo = false

${structured}
`,
			);
			return { planPath, db };
		} catch (error) {
			db.close();
			throw error;
		}
	}

	async function invokeWithBudgetContext(
		dir: string,
		planPath: string,
		effectivePlanPath: string,
		db: Database,
		onCreateProvider?: () => never,
	) {
		const ctx = makeBudgetContext();
		ctx.executionContext.effectivePlanPath = effectivePlanPath;
		try {
			await invokeAgent(
				"reviewer",
				{
					template: "reviewer-plan",
					run: "run1",
					vars: [`plan_path=${planPath}`],
					phase: "plan",
					record: true,
					quiet: true,
					workdir: dir,
				},
				{
					db,
					createReviewBudgetContext: async () => ctx,
					...(onCreateProvider
						? { createProvider: async () => onCreateProvider() }
						: {}),
				},
			);
		} finally {
			ctx.db.close();
		}
	}

	test("empty readable plan reaches budget parsing", async () => {
		const dir = makeTmpDir();
		let db: Database | undefined;
		try {
			const setup = await setupBudgetInvoke(dir);
			db = setup.db;
			const emptyPath = join(dir, "empty.md");
			writeFileSync(emptyPath, "");
			let providerCreations = 0;
			await expect(
				invokeWithBudgetContext(
					dir,
					setup.planPath,
					emptyPath,
					setup.db,
					() => {
						providerCreations++;
						throw new Error("provider must not be created before preflight");
					},
				),
			).rejects.toMatchObject({
				code: "PLAN_REPAIR_REQUIRED",
				detail: {
					reviewRoute: "author_revision",
					diagnostic: { code: "BUDGET_SECTION_MISSING" },
				},
			});
			expect(providerCreations).toBe(0);
		} finally {
			db?.close();
			cleanupDir(dir);
		}
	});

	test("unreadable plan maps to PLAN_NOT_FOUND", async () => {
		const dir = makeTmpDir();
		let db: Database | undefined;
		try {
			const setup = await setupBudgetInvoke(dir);
			db = setup.db;
			await expect(
				invokeWithBudgetContext(
					dir,
					setup.planPath,
					join(dir, "missing.md"),
					setup.db,
				),
			).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
		} finally {
			db?.close();
			cleanupDir(dir);
		}
	});

	test("continued reviewer opt-in captures once before provider and records the step snapshot", async () => {
		const dir = makeTmpDir();
		const ctx = makeBudgetContext();
		let db: Database | undefined;
		try {
			const setup = await setupBudgetInvoke(dir);
			db = setup.db;
			const planPath = setup.planPath;
			writeFileSync(planPath, budgetPlan);
			ctx.executionContext.effectivePlanPath = planPath;
			ctx.db.run(
				"INSERT INTO steps(run_id, step_name, phase, iteration, result_json) VALUES ('run1', 'reviewer:custom-plan-review', 'plan', 1, '{}')",
			);

			let providerCreations = 0;
			await invokeAgent(
				"reviewer",
				{
					template: "reviewer-plan-continued",
					run: "run1",
					vars: [`plan_path=${planPath}`],
					phase: "plan",
					record: true,
					quiet: true,
					workdir: dir,
					optInBudgetBaseline: true,
				},
				{
					db,
					createReviewBudgetContext: async () => ctx,
					createProvider: async (role, config) => {
						providerCreations++;
						expect(ctx.store.getBaseline("run1")?.captureKind).toBe("opt_in");
						return createProvider(role, config);
					},
				},
			);

			expect(providerCreations).toBe(1);
			expect(ctx.store.getBaseline("run1")?.captureKind).toBe("opt_in");
			expect(
				ctx.recordStore
					.listLines("run1", "budget")
					.filter(
						(line) => (line.payload as { kind?: string }).kind === "baseline",
					),
			).toHaveLength(1);
			expect(ctx.store.listSnapshots("run1")).toHaveLength(1);
			expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(1);
		} finally {
			ctx.db.close();
			db?.close();
			cleanupDir(dir);
		}
	});

	test("recording stays enforced and opens a gate after live config flips to advisory", async () => {
		const dir = makeTmpDir();
		const ctx = makeBudgetContext({ mode: "enforced" });
		let db: Database | undefined;
		try {
			const setup = await setupBudgetInvoke(dir, true);
			db = setup.db;
			const planPath = setup.planPath;
			writeFileSync(planPath, budgetPlan);
			ctx.executionContext.effectivePlanPath = planPath;
			const seed = pendingSnapshot();
			ctx.store.captureBaseline({
				runId: "run1",
				captureKind: "initial",
				mode: "enforced",
				parsed: seed.currentLedger,
				configSnapshot: seed.derived.thresholds,
				origin: ctx.originFor({ kind: "system", role: "cli" }),
			});
			ctx.config.reviewBudget.mode = "advisory";

			await invokeAgent(
				"reviewer",
				{
					template: "reviewer-plan",
					run: "run1",
					vars: [`plan_path=${planPath}`],
					phase: "plan",
					record: true,
					quiet: true,
					workdir: dir,
				},
				{ db, createReviewBudgetContext: async () => ctx },
			);

			const line = ctx.recordStore.listLines("run1", "steps")[0];
			expect(line).toBeDefined();
			const result = (
				line?.payload as {
					result_json?: { governance?: { route?: string } };
				}
			)?.result_json;
			expect(ctx.store.getBaseline("run1")?.mode).toBe("enforced");
			expect(result?.governance?.route).toBe("human_gate");
			expect(ctx.db.query("SELECT count(*) AS n FROM prompts").get()).toEqual({
				n: 1,
			});
		} finally {
			ctx.db.close();
			db?.close();
			cleanupDir(dir);
		}
	});

	test("invoke and template handlers append byte-identical reviewer governance context", async () => {
		const dir = makeTmpDir();
		const ctx = makeBudgetContext({ mode: "enforced" });
		let db: Database | undefined;
		try {
			const setup = await setupBudgetInvoke(dir);
			db = setup.db;
			const planPath = setup.planPath;
			writeFileSync(planPath, budgetPlan);
			ctx.executionContext.effectivePlanPath = planPath;
			seedPromptGovernanceContext(ctx);
			let nativePrompt = "";
			let invokePrompt = "";
			let authorInvokePrompt = "";
			await templateRender(
				{
					template: "reviewer-plan",
					run: "run1",
					workdir: dir,
					newSession: true,
				},
				{
					db,
					createReviewBudgetContext: async () => ctx,
					onRenderedPrompt: (prompt) => {
						nativePrompt = prompt;
					},
				},
			);
			await invokeAgent(
				"reviewer",
				{
					template: "reviewer-plan",
					run: "run1",
					workdir: dir,
					newSession: true,
					quiet: true,
				},
				{
					db,
					createReviewBudgetContext: async () => ctx,
					createProvider: async () =>
						structuredProvider({
							readiness: "ready",
							items: [],
							priorFindings: [{ id: "P1.open", status: "addressed" }],
							creditAssessments: [],
						}),
					onRenderedPrompt: (prompt) => {
						invokePrompt = prompt;
					},
				},
			);
			await invokeAgent(
				"author",
				{
					template: "author-process-plan-review",
					run: "run1",
					workdir: dir,
					quiet: true,
				},
				{
					db,
					createReviewBudgetContext: async () => ctx,
					createProvider: async () =>
						structuredProvider({
							result: "needs_human",
							reason: "Prompt capture fixture.",
						}),
					onRenderedPrompt: (prompt) => {
						authorInvokePrompt = prompt;
					},
				},
			);
			const contextBlock = (prompt: string) => {
				const start = prompt.indexOf("## Plan-review governance context");
				expect(start).toBeGreaterThanOrEqual(0);
				const contextStart = prompt.indexOf("\n\n## Context\n", start);
				return prompt.slice(start, contextStart < 0 ? undefined : contextStart);
			};
			expect(contextBlock(invokePrompt)).toBe(contextBlock(nativePrompt));
			for (const prompt of [invokePrompt, nativePrompt]) {
				expect(prompt).toContain("Do **not** emit `baselineAssessment`");
				expect(prompt).not.toContain("this is the initial budget review");
			}
			expect(contextBlock(invokePrompt)).toContain(
				"Required prior-finding outcome IDs: P1.open",
			);
			expect(authorInvokePrompt).toContain("## Governing decisions");
			expect(authorInvokePrompt).toContain("P1.deferred (sha256:deferred)");
			expect(authorInvokePrompt).not.toContain(
				"## Plan-review governance context",
			);
		} finally {
			ctx.db.close();
			db?.close();
			cleanupDir(dir);
		}
	});

	test("provider schema follows the baselineAssessment contract the budget validator enforces", async () => {
		const dir = makeTmpDir();
		const ctx = makeBudgetContext();
		let db: Database | undefined;
		try {
			const setup = await setupBudgetInvoke(dir);
			db = setup.db;
			const planPath = setup.planPath;
			writeFileSync(planPath, budgetPlan);
			ctx.executionContext.effectivePlanPath = planPath;
			const schemas: Record<string, unknown>[] = [];
			const initialVerdict = {
				readiness: "ready",
				items: [],
				creditAssessments: [],
				baselineAssessment: {
					independentEffortEstimate: 2,
					confidence: "high",
					reason: "estimate",
				},
			};
			const invoke = (iteration: number) =>
				invokeAgent(
					"reviewer",
					{
						template: "reviewer-plan",
						run: "run1",
						vars: [`plan_path=${planPath}`],
						phase: "plan",
						record: true,
						recordStep: "reviewer:plan",
						iteration,
						quiet: true,
						workdir: dir,
						newSession: true,
					},
					{
						db,
						createReviewBudgetContext: async () => ctx,
						createProvider: async () => {
							const provider = structuredProvider(initialVerdict);
							const session = await provider.startSession({
								model: "m",
								workingDirectory: dir,
							});
							const streamed = session.runStreamed.bind(session);
							session.runStreamed = (prompt, opts) => {
								schemas.push(opts?.outputSchema as Record<string, unknown>);
								return streamed(prompt, opts);
							};
							return provider;
						},
					},
				);

			// Initial active review: the independent estimate is required.
			await invoke(1);
			expect(schemas[0]?.required).toContain("baselineAssessment");
			expect(ctx.store.listSnapshots("run1")).toHaveLength(1);

			// Closure review: the schema forbids what validation rejects, and
			// validation stays the final authority when the model ignores it.
			let rejection: unknown;
			await invoke(2).catch((err) => {
				rejection = err;
			});
			expect(schemas[1]?.properties).not.toHaveProperty("baselineAssessment");
			expect(schemas[1]?.not).toEqual({ required: ["baselineAssessment"] });
			expect(rejection).toMatchObject({
				code: "BASELINE_ASSESSMENT_UNEXPECTED",
				detail: {
					session_id: "session-governance",
					raw: { baselineAssessment: { independentEffortEstimate: 2 } },
					recovery: { step_name: "reviewer:plan", phase: "plan", iteration: 2 },
				},
			});
			expect(ctx.store.listSnapshots("run1")).toHaveLength(1);

			// A retry of the initial step may repeat its estimate.
			await invoke(1);
			const { reviewerVerdictSchemaFor } = await import(
				"../../../src/protocol.js"
			);
			expect(schemas[0]).toEqual(reviewerVerdictSchemaFor("required", "plan"));
			expect(schemas[1]).toEqual(
				reviewerVerdictSchemaFor("prohibited", "plan"),
			);
			expect(schemas[2]).toEqual(reviewerVerdictSchemaFor("optional", "plan"));
		} finally {
			ctx.db.close();
			db?.close();
			cleanupDir(dir);
		}
	});

	test("opt-in on an author invocation is rejected before provider creation", async () => {
		const dir = makeTmpDir();
		let db: Database | undefined;
		try {
			const setup = await setupBudgetInvoke(dir);
			db = setup.db;
			const planPath = setup.planPath;
			let providerCreations = 0;
			await expect(
				invokeAgent(
					"author",
					{
						template: "author-next-phase",
						run: "run1",
						vars: [`plan_path=${planPath}`, "phase_number=1", "user_notes="],
						quiet: true,
						workdir: dir,
						optInBudgetBaseline: true,
					},
					{
						db,
						createProvider: async () => {
							providerCreations++;
							throw new Error("provider must not be created");
						},
					},
				),
			).rejects.toMatchObject({ code: "BUDGET_BASELINE_OPT_IN_INVALID" });
			expect(providerCreations).toBe(0);
		} finally {
			db?.close();
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// Variable substitution
// ===========================================================================

describe("invoke — variable substitution (unit)", () => {
	test("renderTemplate substitutes variables correctly", async () => {
		const { renderTemplate } = await import("../../../src/templates/loader.js");
		const result = renderTemplate("author-next-phase", {
			plan_path: "/path/to/plan.md",
			phase_number: "1",
			user_notes: "test notes",
		});
		expect(result.name).toBe("author-next-phase");
		expect(result.prompt).toContain("/path/to/plan.md");
		expect(result.prompt).toContain("phase 1");
		expect(result.prompt).not.toContain("{{plan_path}}");
	});

	test("renderTemplate throws on missing required variables", async () => {
		const { renderTemplate } = await import("../../../src/templates/loader.js");
		expect(() => renderTemplate("author-next-phase", {})).toThrow(
			/missing required variables/,
		);
	});

	test("invoke resolves plan template path internally", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const { resolveInternalTemplateVariables } = await import(
			"../../../src/commands/template-vars.js"
		);

		// paths.* are always absolute after config loading — simulate that contract
		const rawConfig = FiveXConfigSchema.parse({});
		const config = {
			...rawConfig,
			paths: {
				...rawConfig.paths,
				templates: {
					plan: "/tmp/project/docs/_implementation_plan_template.md",
					review: "/tmp/project/docs/development/reviews/_review_template.md",
				},
			},
		};
		const vars = resolveInternalTemplateVariables(
			["prd_path", "plan_path", "plan_template_path"],
			{
				prd_path: "docs/requirements.md",
				plan_path: "docs/development/001-plan.md",
			},
			config,
			"/tmp/project",
		);

		expect(vars.plan_template_path).toBe(
			"/tmp/project/docs/_implementation_plan_template.md",
		);
	});

	test("invoke resolves review template path internally", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const { resolveInternalTemplateVariables } = await import(
			"../../../src/commands/template-vars.js"
		);

		// paths.* are always absolute after config loading — simulate that contract
		const rawConfig = FiveXConfigSchema.parse({});
		const config = {
			...rawConfig,
			paths: {
				...rawConfig.paths,
				templates: {
					plan: "/tmp/project/docs/_implementation_plan_template.md",
					review: "/tmp/project/docs/development/reviews/_review_template.md",
				},
			},
		};
		const vars = resolveInternalTemplateVariables(
			["commit_hash", "review_path", "plan_path", "review_template_path"],
			{
				commit_hash: "abc123",
				review_path: "docs/development/reviews/review.md",
				plan_path: "docs/development/001-plan.md",
			},
			config,
			"/tmp/project",
		);

		expect(vars.review_template_path).toBe(
			"/tmp/project/docs/development/reviews/_review_template.md",
		);
	});

	test("explicit template path vars override internal defaults", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const { resolveInternalTemplateVariables } = await import(
			"../../../src/commands/template-vars.js"
		);

		// paths.* are always absolute after config loading — simulate that contract
		const rawConfig = FiveXConfigSchema.parse({});
		const config = {
			...rawConfig,
			paths: {
				...rawConfig.paths,
				templates: {
					plan: "/tmp/project/docs/_implementation_plan_template.md",
					review: "/tmp/project/docs/development/reviews/_review_template.md",
				},
			},
		};
		const vars = resolveInternalTemplateVariables(
			["prd_path", "plan_path", "plan_template_path", "review_template_path"],
			{
				prd_path: "docs/requirements.md",
				plan_path: "docs/development/001-plan.md",
				plan_template_path: "/custom/plan.md",
				review_template_path: "/custom/review.md",
			},
			config,
			"/tmp/project",
		);

		expect(vars.plan_template_path).toBe("/custom/plan.md");
		expect(vars.review_template_path).toBe("/custom/review.md");
	});
});

// ===========================================================================
// Structured output validation
// ===========================================================================

describe("invoke — structured output validation (unit)", () => {
	test("valid AuthorStatus passes assertion", async () => {
		const { assertAuthorStatus } = await import("../../../src/protocol.js");
		assertAuthorStatus({ result: "complete", commit: "abc123" }, "test", {
			requireCommit: true,
		});
		assertAuthorStatus(
			{ result: "needs_human", reason: "needs input" },
			"test",
		);
		assertAuthorStatus({ result: "failed", reason: "error" }, "test");
	});

	test("invalid AuthorStatus throws on missing commit", async () => {
		const { assertAuthorStatus } = await import("../../../src/protocol.js");
		expect(() =>
			assertAuthorStatus({ result: "complete" }, "test", {
				requireCommit: true,
			}),
		).toThrow(/commit/);
	});

	test("invalid AuthorStatus throws on missing reason", async () => {
		const { assertAuthorStatus } = await import("../../../src/protocol.js");
		expect(() => assertAuthorStatus({ result: "needs_human" }, "test")).toThrow(
			/reason/,
		);
	});

	test("valid ReviewerVerdict passes assertion", async () => {
		const { assertReviewerVerdict } = await import("../../../src/protocol.js");
		assertReviewerVerdict({ readiness: "ready", items: [] }, "test");
		assertReviewerVerdict(
			{
				readiness: "not_ready",
				items: [
					{
						id: "P0.1",
						title: "Fix this",
						action: "auto_fix",
						reason: "broken",
					},
				],
			},
			"test",
		);
	});

	test("warns (not throws) for ReviewerVerdict with empty items for non-ready", async () => {
		const { assertReviewerVerdict } = await import("../../../src/protocol.js");
		const result = assertReviewerVerdict(
			{ readiness: "not_ready", items: [] },
			"test",
		);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("items");
	});

	test("invalid ReviewerVerdict throws on missing action", async () => {
		const { assertReviewerVerdict } = await import("../../../src/protocol.js");
		expect(() =>
			assertReviewerVerdict(
				{
					readiness: "not_ready",
					items: [
						{
							id: "P0.1",
							title: "Fix this",
							action: undefined as unknown as "auto_fix",
							reason: "broken",
						},
					],
				},
				"test",
			),
		).toThrow(/action/);
	});
});

// ===========================================================================
// Structured output error detection
// ===========================================================================

describe("invoke — structured output error detection (unit)", () => {
	test("isStructuredOutputError detects nested StructuredOutputError", async () => {
		const { isStructuredOutputError } = await import(
			"../../../src/protocol.js"
		);
		expect(
			isStructuredOutputError({
				data: {
					info: {
						error: { name: "StructuredOutputError", message: "oops" },
					},
				},
			}),
		).toBe(true);
	});

	test("isStructuredOutputError detects top-level error", async () => {
		const { isStructuredOutputError } = await import(
			"../../../src/protocol.js"
		);
		expect(
			isStructuredOutputError({
				error: { name: "StructuredOutputError", message: "oops" },
			}),
		).toBe(true);
	});

	test("isStructuredOutputError returns false for valid result", async () => {
		const { isStructuredOutputError } = await import(
			"../../../src/protocol.js"
		);
		expect(
			isStructuredOutputError({
				result: "complete",
				commit: "abc123",
			}),
		).toBe(false);
	});

	test("isStructuredOutputError detects object-typed error payloads (P0.2 regression)", async () => {
		const { isStructuredOutputError } = await import(
			"../../../src/protocol.js"
		);

		const objError = {
			data: {
				info: {
					error: {
						name: "StructuredOutputError",
						message: "Failed to parse structured output",
					},
				},
			},
			someOtherField: "value",
		};
		expect(typeof objError).toBe("object");
		expect(isStructuredOutputError(objError)).toBe(true);

		const msgError = {
			error: {
				name: "SomeError",
				message: "structured output parsing failed",
			},
		};
		expect(typeof msgError).toBe("object");
		expect(isStructuredOutputError(msgError)).toBe(true);
	});
});

// ===========================================================================
// NDJSON log helpers
// ===========================================================================

describe("invoke — NDJSON log helpers (unit)", () => {
	test("nextLogSequence returns 001 for empty directory", async () => {
		const dir = makeTmpDir();
		try {
			const { nextLogSequence } = await import(
				"../../../src/providers/log-writer.js"
			);
			const seq = nextLogSequence(dir);
			expect(seq).toBe("001");
		} finally {
			cleanupDir(dir);
		}
	});

	test("nextLogSequence increments from existing files", async () => {
		const dir = makeTmpDir();
		try {
			writeFileSync(join(dir, "agent-001.ndjson"), "");
			writeFileSync(join(dir, "agent-002.ndjson"), "");

			const { nextLogSequence } = await import(
				"../../../src/providers/log-writer.js"
			);
			const seq = nextLogSequence(dir);
			expect(seq).toBe("003");
		} finally {
			cleanupDir(dir);
		}
	});

	test("nextLogSequence returns 001 for nonexistent directory", async () => {
		const { nextLogSequence } = await import(
			"../../../src/providers/log-writer.js"
		);
		const seq = nextLogSequence("/nonexistent/dir/12345");
		expect(seq).toBe("001");
	});

	test("nextLogSequence handles non-3-digit legacy files (P2)", async () => {
		const dir = makeTmpDir();
		try {
			writeFileSync(join(dir, "agent-1.ndjson"), "");
			writeFileSync(join(dir, "agent-42.ndjson"), "");

			const { nextLogSequence } = await import(
				"../../../src/providers/log-writer.js"
			);
			const seq = nextLogSequence(dir);
			expect(seq).toBe("043");
		} finally {
			cleanupDir(dir);
		}
	});

	test("log directory structure and NDJSON format", () => {
		const dir = makeTmpDir();
		try {
			const logDir = join(dir, ".5x", "logs", "run_test123");
			mkdirSync(logDir, { recursive: true, mode: 0o700 });

			const logPath = join(logDir, "agent-001.ndjson");
			const events: Array<Record<string, unknown>> = [
				{ type: "text", delta: "Hello " },
				{ type: "text", delta: "world" },
				{ type: "usage", tokens: { in: 100, out: 50 }, costUsd: 0.005 },
				{
					type: "done",
					result: {
						text: "Hello world",
						structured: { result: "complete" },
						sessionId: "sess-1",
						tokens: { in: 100, out: 50 },
						costUsd: 0.005,
						durationMs: 1234,
					},
				},
			];

			for (const event of events) {
				const line = JSON.stringify({
					...event,
					ts: new Date().toISOString(),
				});
				writeFileSync(logPath, `${line}\n`, { flag: "a" });
			}

			expect(existsSync(logPath)).toBe(true);

			const content = readFileSync(logPath, "utf-8").trim();
			const lines = content.split("\n");
			expect(lines.length).toBe(4);

			for (const line of lines) {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				expect(parsed.type).toBeTruthy();
				expect(parsed.ts).toBeTruthy();
			}

			const firstLine = lines[0] ?? "";
			const first = JSON.parse(firstLine) as Record<string, unknown>;
			expect(first.type).toBe("text");
			expect(first.delta).toBe("Hello ");

			const lastLine = lines[lines.length - 1] ?? "";
			const last = JSON.parse(lastLine) as Record<string, unknown>;
			expect(last.type).toBe("done");
		} finally {
			cleanupDir(dir);
		}
	});

	test("log sequence numbers increment correctly", async () => {
		const dir = makeTmpDir();
		try {
			const logDir = join(dir, ".5x", "logs", "run_test456");
			mkdirSync(logDir, { recursive: true });

			writeFileSync(join(logDir, "agent-001.ndjson"), "");
			writeFileSync(join(logDir, "agent-002.ndjson"), "");

			const { nextLogSequence } = await import(
				"../../../src/providers/log-writer.js"
			);
			const seq = nextLogSequence(logDir);
			expect(seq).toBe("003");
		} finally {
			cleanupDir(dir);
		}
	});
});

// ===========================================================================
// Schema contracts
// ===========================================================================

describe("invoke — schema contracts (unit)", () => {
	test("AuthorStatusSchema has correct structure", async () => {
		const { AuthorStatusSchema } = await import("../../../src/protocol.js");
		expect(AuthorStatusSchema.type).toBe("object");
		expect(AuthorStatusSchema.required).toContain("result");
		expect(AuthorStatusSchema.properties.result.enum).toEqual([
			"complete",
			"needs_human",
			"failed",
		]);
	});

	test("ReviewerVerdictSchema has correct structure", async () => {
		const { ReviewerVerdictSchema } = await import("../../../src/protocol.js");
		expect(ReviewerVerdictSchema.type).toBe("object");
		expect(ReviewerVerdictSchema.required).toContain("readiness");
		expect(ReviewerVerdictSchema.required).toContain("items");
	});
});

// ===========================================================================
// CliError and exit codes
// ===========================================================================

describe("invoke — CliError and exit codes (unit)", () => {
	test("TEMPLATE_NOT_FOUND maps to exit code 2", async () => {
		const { exitCodeForError } = await import("../../../src/output.js");
		expect(exitCodeForError("TEMPLATE_NOT_FOUND")).toBe(2);
	});

	test("INVALID_STRUCTURED_OUTPUT maps to exit code 7", async () => {
		const { exitCodeForError } = await import("../../../src/output.js");
		expect(exitCodeForError("INVALID_STRUCTURED_OUTPUT")).toBe(7);
	});

	test("PROVIDER_NOT_FOUND maps to exit code 2", async () => {
		const { exitCodeForError } = await import("../../../src/output.js");
		expect(exitCodeForError("PROVIDER_NOT_FOUND")).toBe(2);
	});

	test("CliError produces correct JSON envelope", async () => {
		const { CliError } = await import("../../../src/output.js");
		const err = new CliError("TEMPLATE_NOT_FOUND", "Template foo not found");
		expect(err.code).toBe("TEMPLATE_NOT_FOUND");
		expect(err.exitCode).toBe(2);
		expect(err.message).toBe("Template foo not found");
	});

	test("CliError with INVALID_STRUCTURED_OUTPUT has exit code 7", async () => {
		const { CliError } = await import("../../../src/output.js");
		const err = new CliError("INVALID_STRUCTURED_OUTPUT", "Bad output", {
			raw: {},
		});
		expect(err.exitCode).toBe(7);
		expect(err.detail).toEqual({ raw: {} });
	});
});

// ===========================================================================
// Provider factory
// ===========================================================================

describe("invoke — provider factory (unit)", () => {
	test("factory defaults to opencode provider", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const config = FiveXConfigSchema.parse({});

		expect(config.author.provider).toBe("opencode");

		const externalConfig = {
			...config,
			opencode: { ...config.opencode, url: "http://127.0.0.1:1" },
		};
		const { createProvider } = await import(
			"../../../src/providers/factory.js"
		);
		let provider: Awaited<ReturnType<typeof createProvider>> | undefined;
		try {
			provider = await createProvider("author", externalConfig);
			expect(provider).toBeDefined();
		} catch (err) {
			if (err instanceof Error && "code" in err) {
				expect((err as { code: string }).code).not.toBe("PROVIDER_NOT_FOUND");
			}
		} finally {
			await provider?.close().catch(() => {});
		}
	});

	test("factory throws PROVIDER_NOT_FOUND for missing plugin", async () => {
		const { FiveXConfigSchema } = await import("../../../src/config.js");
		const config = FiveXConfigSchema.parse({});
		const configWithPlugin = {
			...config,
			author: { ...config.author, provider: "nonexistent-provider" },
		};

		const { createProvider, ProviderNotFoundError } = await import(
			"../../../src/providers/factory.js"
		);
		try {
			await createProvider("author", configWithPlugin);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ProviderNotFoundError);
		}
	});
});

// ===========================================================================
// Enriched output — renderTemplate stepName
// ===========================================================================

describe("invoke — enriched output fields (unit)", () => {
	test("renderTemplate returns stepName for all bundled templates", async () => {
		const { renderTemplate } = await import("../../../src/templates/loader.js");

		const r1 = renderTemplate("author-next-phase", {
			plan_path: "/plan.md",
			phase_number: "1",
			user_notes: "none",
		});
		expect(r1.stepName).toBe("author:implement");

		const r2 = renderTemplate("author-generate-plan", {
			prd_path: "prd.md",
			plan_path: "plan.md",
			plan_template_path: "tpl.md",
		});
		expect(r2.stepName).toBe("author:generate-plan");

		const r3 = renderTemplate("reviewer-commit", {
			commit_hash: "abc",
			review_path: "r.md",
			plan_path: "p.md",
			review_template_path: "t.md",
		});
		expect(r3.stepName).toBe("reviewer:commit");
	});
});

// ===========================================================================
// Worktree envelope fields (Phase 2)
// ===========================================================================

describe("invoke — worktree envelope fields (unit)", () => {
	test("output omits worktree_path and worktree_plan_path when no worktree mapping", async () => {
		const dir = makeTmpDir();
		try {
			// Setup: git repo, 5x init, plan file
			Bun.spawnSync(["git", "init"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			Bun.spawnSync(["git", "config", "user.name", "Test"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			const planDir = join(dir, "docs", "development");
			mkdirSync(planDir, { recursive: true });
			writeFileSync(
				join(planDir, "test-plan.md"),
				"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
			);

			// 5x init
			await initScaffold({ startDir: dir });

			// Create run directly in DB (no subprocess)
			const { Database } = await import("bun:sqlite");
			const dbPath = join(dir, ".5x", "5x.db");
			const db = new Database(dbPath);
			const planPath = join(dir, "docs", "development", "test-plan.md");
			const runId = "run_test_no_wt";
			db.exec(
				`INSERT INTO runs (id, plan_path, status, config_json, created_at, updated_at)
				 VALUES ('${runId}', '${planPath}', 'active', '{}', datetime('now'), datetime('now'))`,
			);
			db.close();

			// Config using sample provider (direct import, no dynamic resolution contention)
			writeFileSync(
				join(dir, "5x.toml"),
				'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
			);

			// Commit so worktree is clean
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			Bun.spawnSync(["git", "commit", "-m", "init"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			// Capture stdout from invokeAgent
			const originalLog = console.log;
			let capturedOutput = "";
			console.log = (msg: string) => {
				capturedOutput = msg;
			};

			// Change to temp dir so resolveControlPlaneRoot() finds the right DB
			const originalCwd = process.cwd();
			process.chdir(dir);

			try {
				// Call invokeAgent directly (single subprocess spawn avoided)
				await invokeAgent("author", {
					template: "author-next-phase",
					run: runId,
					vars: [`plan_path=${planPath}`, "phase_number=1", "user_notes=test"],
					quiet: true, // suppress stderr streaming
				});
			} finally {
				process.chdir(originalCwd);
			}

			// Restore console.log
			console.log = originalLog;

			// Parse and verify envelope
			const envelope = JSON.parse(capturedOutput) as {
				ok: boolean;
				data: Record<string, unknown>;
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.data.run_id).toBe(runId);
			// Key assertion: no worktree fields when not mapped
			expect(envelope.data.worktree_path).toBeUndefined();
			expect(envelope.data.worktree_plan_path).toBeUndefined();
		} finally {
			cleanupDir(dir);
		}
	});
});

describe("invoke implementation admission", () => {
	test("sqlite-only budgeted author invoke requires approval before a provider", async () => {
		const dir = makeTmpDir();
		let db: Database | undefined;
		try {
			Bun.spawnSync(["git", "init"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const planPath = join(dir, "plan.md");
			writeFileSync(
				planPath,
				`# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Bind | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Bind

- [ ] Bind
`,
			);
			writeFileSync(
				join(dir, "5x.toml"),
				'[reviewBudget]\nmode = "advisory"\n',
			);
			// Private file DB so concurrent unit tests never open or close the
			// process-wide singleton while another invoke still holds it.
			db = openPrivateControlPlaneDb(dir);
			createRunV1(db, { id: "run_admission01", planPath });
			let providerCalls = 0;
			await expect(
				invokeAgent(
					"author",
					{
						template: "author-next-phase",
						run: "run_admission01",
						workdir: dir,
						vars: [`plan_path=${planPath}`, "phase_number=1", "user_notes=x"],
					},
					{
						db,
						createReviewBudgetContext: async () => {
							throw new RecordContextError(
								"RECORDS_UNAVAILABLE",
								"sqlite-only run has no record home",
							);
						},
						createProvider: async () => {
							providerCalls += 1;
							throw new Error("provider should not be created");
						},
					},
				),
			).rejects.toMatchObject({ code: "IMPLEMENTATION_APPROVAL_REQUIRED" });
			expect(providerCalls).toBe(0);
		} finally {
			db?.close();
			cleanupDir(dir);
		}
	});
});

describe("invoke implementation review recording", () => {
	function gitHead(dir: string): string {
		const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	}

	function verdict() {
		return {
			readiness: "ready" as const,
			items: [],
			nonblocking: [
				{
					id: "n1",
					title: "Old note",
					reason: "Left from before.",
					scopeClass: "pre_existing" as const,
				},
			],
		};
	}

	async function preparedContext(dir: string) {
		const ctx = makeBudgetContext({ mode: "enforced" });
		ctx.executionContext.effectiveWorkingDirectory = dir;
		ctx.executionContext.effectivePlanPath = join(dir, "plan.md");
		ctx.store.saveImplementationBinding(
			{
				kind: "implementation-binding",
				version: 1,
				id: "binding-1",
				executionRunId: "run1",
				sourceRunId: "source",
				sourceSnapshotId: "snap",
				sourceBaselineId: "base",
				approvedPlanCommit: "c".repeat(40),
				approvedPlanHash: "sha256:plan",
				approvedPlanBytes: "# Plan\n",
				b0: 2,
				governingB: 2,
				mode: "enforced",
				thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
				ledger: {
					estimateConfidence: "high",
					workItems: [
						{
							id: "W1",
							title: "Work",
							effort: 2,
							architectureDelta: 0,
							debtClaim: null,
							addresses: [],
							rationale: "Required",
							line: 1,
						},
					],
					surface: {
						subsystems: 1,
						productionFiles: 1,
						persistentOrExternalBoundaries: 0,
					},
				},
				effectiveDecisions: [],
				phaseMap: [{ id: "1", heading: "Phase 1" }],
				debtTargets: [],
				ledgerHash: "ledger",
				decisionsHash: "decisions",
				createdAt: "2026-01-01 00:00:00",
			},
			TEST_ORIGIN,
		);
		const head = gitHead(dir);
		const captured = capturePhaseAuthorAdmission({
			recordStore: ctx.recordStore,
			origin: TEST_ORIGIN,
			executionRunId: "run1",
			bindingId: "binding-1",
			phase: "1",
			preAuthorCommit: head,
		});
		if (captured.status !== "captured") {
			throw new Error(`pre-author capture ${captured.status}`);
		}
		const prepared = await prepareImplementationReviewContext({
			store: ctx.store,
			recordStore: ctx.recordStore,
			origin: TEST_ORIGIN,
			executionRunId: "run1",
			bindingId: "binding-1",
			phase: "1",
			excludedPaths: [],
			workdir: dir,
		});
		if (prepared.status !== "ready") {
			throw new Error(`${prepared.code}: ${prepared.message}`);
		}
		return { ctx, head, prepared };
	}

	test("invoke records the durable observation and rejects a pair collision", async () => {
		const dir = makeTmpDir();
		let db: Database | undefined;
		try {
			for (const args of [
				["init"],
				["config", "user.email", "test@test.com"],
				["config", "user.name", "Test"],
			] as const) {
				Bun.spawnSync(["git", ...args], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
			}
			// Create the file first so initScaffold skips the process-wide singleton.
			db = openPrivateControlPlaneDb(dir);
			await initScaffold({ startDir: dir });
			writeFileSync(join(dir, "plan.md"), "# Provider-visible plan\n");
			createRunV1(db, { id: "run1", planPath: join(dir, "plan.md") });
			writeFileSync(
				join(dir, "5x.toml"),
				`[author]
provider = "sample"
model = "sample/test"

[reviewer]
provider = "sample"
model = "sample/test"
`,
			);
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			Bun.spawnSync(["git", "commit", "-m", "init"], {
				cwd: dir,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const { ctx, head, prepared } = await preparedContext(dir);
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (message?: unknown) => {
				logs.push(String(message));
			};
			try {
				await invokeAgent(
					"reviewer",
					{
						template: "reviewer-commit",
						run: "run1",
						phase: "1",
						iteration: 1,
						record: true,
						quiet: true,
						workdir: dir,
						vars: [
							`commit_hash=${head}`,
							`review_path=${join(dir, "docs/development/reviews/review.md")}`,
							`plan_path=${join(dir, "plan.md")}`,
							`review_template_path=${join(dir, "template.md")}`,
							"run_id=run1",
						],
					},
					{
						db,
						createReviewBudgetContext: async () => ctx,
						createProvider: async () => structuredProvider(verdict()),
					},
				);
			} finally {
				console.log = originalLog;
			}
			const envelope = JSON.parse(logs.at(-1) ?? "{}") as {
				data?: {
					result?: {
						governance?: { route?: string; completionAuthorized?: boolean };
					};
				};
			};
			expect(envelope.data?.result?.governance?.route).toBe("complete");
			expect(envelope.data?.result?.governance?.completionAuthorized).toBe(
				true,
			);
			expect(ctx.store.listImplementationReviews("run1")).toHaveLength(1);
			expect(
				ctx.recordStore.listLines("run1", "steps").filter((line) => {
					return (
						(line.payload as { step_name?: string }).step_name ===
						"reviewer:commit"
					);
				}),
			).toHaveLength(1);

			const composed = await composeImplementationReviewerRecord({
				ctx,
				runId: "run1",
				stepName: "reviewer:commit",
				phase: "1",
				iteration: 2,
				verdict: verdict(),
				contextId: prepared.context.id,
				codeContext: prepared.diff,
			});
			expect(composed.status).toBe("applied");
			if (composed.status !== "applied") return;
			ctx.recordStore.append({
				runId: "run1",
				stream: "budget",
				idempotencyKey: implementationReviewObservationKey("run1", {
					stepName: "reviewer:commit",
					phase: "1",
					iteration: 2,
				}),
				payload: {
					...composed.pending,
					completionAuthorized: false,
					createdAt: "2026-01-01 00:00:00",
				},
				createdAt: "2026-01-01 00:00:00",
				...recordedEnvelope(TEST_ORIGIN),
			});
			await expect(
				invokeAgent(
					"reviewer",
					{
						template: "reviewer-commit",
						run: "run1",
						phase: "1",
						iteration: 2,
						record: true,
						quiet: true,
						workdir: dir,
						vars: [
							`commit_hash=${head}`,
							`review_path=${join(dir, "docs/development/reviews/review.md")}`,
							`plan_path=${join(dir, "plan.md")}`,
							`review_template_path=${join(dir, "template.md")}`,
							"run_id=run1",
						],
					},
					{
						db,
						createReviewBudgetContext: async () => ctx,
						createProvider: async () => structuredProvider(verdict()),
					},
				),
			).rejects.toMatchObject({ code: "RECORD_PAIR_CORRUPT" });
			ctx.db.close();
		} finally {
			db?.close();
			cleanupDir(dir);
		}
	});
});

describe("invoke author text-amendment admission", () => {
	const approved = `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Bind | 2 | 0 | - | - | Required |

## Design Decisions

Keep the approved ledger.

## Phase 1: Bind

Bind execution to the approved plan.

- [ ] Complete the phase

## Acceptance

The binding is unchanged.
`;
	const outOfSpan = approved.replace(
		"Keep the approved ledger.",
		"Keep another ledger.",
	);

	function stableStringify(value: unknown): string {
		if (Array.isArray(value))
			return `[${value.map(stableStringify).join(",")}]`;
		if (value && typeof value === "object") {
			return `{${Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
				.join(",")}}`;
		}
		return JSON.stringify(value);
	}

	function git(dir: string, args: string[]): void {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) {
			throw new Error(
				result.stderr.toString() || `git ${args.join(" ")} failed`,
			);
		}
	}

	function gitHead(dir: string): string {
		const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	}

	async function setupAuthorInvoke(dir: string) {
		for (const args of [
			["init"],
			["config", "user.email", "test@test.com"],
			["config", "user.name", "Test"],
		] as const) {
			git(dir, [...args]);
		}
		const planPath = join(dir, "plan.md");
		writeFileSync(planPath, approved);
		writeFileSync(
			join(dir, "5x.toml"),
			`[author]
provider = "sample"
model = "sample/test"
`,
		);
		// Private file DB so concurrent unit tests never open or close the
		// process-wide singleton while another invoke still holds it.
		const db = openPrivateControlPlaneDb(dir);
		try {
			createRunV1(db, { id: "run1", planPath });
			git(dir, ["add", "-A"]);
			git(dir, ["commit", "-m", "approved plan"]);

			const ctx = makeBudgetContext({ mode: "enforced" });
			const ledger = {
				estimateConfidence: "high" as const,
				workItems: [
					{
						id: "W1",
						title: "Bind",
						effort: 2 as const,
						architectureDelta: 0 as const,
						debtClaim: null,
						addresses: [],
						rationale: "Required",
						line: 1,
					},
				],
				surface: {
					subsystems: 1,
					productionFiles: 1,
					persistentOrExternalBoundaries: 0,
				},
			};
			const binding = {
				kind: "implementation-binding" as const,
				version: 1 as const,
				id: "binding-1",
				executionRunId: "run1",
				sourceRunId: "source",
				sourceSnapshotId: "snap",
				sourceBaselineId: "base",
				approvedPlanCommit: "c".repeat(40),
				approvedPlanBytes: approved,
				approvedPlanHash: hashPlanBytes(approved),
				b0: 2,
				governingB: 2,
				mode: "enforced" as const,
				thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
				ledger,
				effectiveDecisions: [],
				phaseMap: [{ id: "1", heading: "Phase 1: Bind" }],
				debtTargets: [],
				ledgerHash: hashPlanBytes(stableStringify(ledger)),
				decisionsHash: hashPlanBytes(stableStringify([])),
				createdAt: "2026-01-01 00:00:00",
			};
			ctx.store.saveImplementationBinding(binding, TEST_ORIGIN);
			const stale = "Bind execution to the approved plan.";
			const staleAt = Buffer.from(approved, "utf8").indexOf(Buffer.from(stale));
			const prepared = prepareTextAmendmentGuard({
				id: "guard-1",
				anchorBytes: approved,
				anchorCommit: "a".repeat(40),
				parentLineageId: null,
				allowedSpans: [
					{
						itemId: "R1",
						heading: "Phase 1: Bind",
						staleText: stale,
						start: staleAt,
						end: staleAt + Buffer.byteLength(stale),
					},
				],
			});
			if (!prepared.ok) throw new Error(prepared.message);
			ctx.recordStore.append({
				runId: "run1",
				stream: "budget",
				idempotencyKey: implementationReviewObservationKey("run1", {
					stepName: "reviewer:review",
					phase: "1",
					iteration: 0,
				}),
				payload: encodeImplementationReviewObservationPayload({
					kind: "implementation-review",
					version: 1,
					id: "obs-1",
					runId: "run1",
					stepKey: {
						stepName: "reviewer:review",
						phase: "1",
						iteration: 0,
					},
					bindingId: binding.id,
					contextId: "ctx-1",
					domain: "implementation",
					phase: "1",
					originalVerdict: {
						readiness: "not_ready",
						items: [
							{
								id: "R1",
								title: "Stale wording",
								action: "auto_fix",
								reason: "The sentence is stale.",
								scopeClass: "plan_defect",
								priority: "P2",
								effortDelta: 0,
								architectureDelta: 0,
								planImpact: {
									kind: "text_only",
									locations: [
										{
											heading: "Phase 1: Bind",
											staleText: stale,
										},
									],
								},
							},
						],
					},
					outcomes: [],
					route: "author_revision",
					nextAction: "author_revision",
					diagnostics: [],
					claimObservations: [],
					gateCauses: [],
					telemetry: {
						reviewCycles: 1,
						fixCycles: 0,
						reviewOriginatedCommits: 0,
						qualityReruns: 0,
						classCounts: {
							implementation_defect: 0,
							plan_defect: 1,
							scope_expansion: 0,
							pre_existing: 0,
						},
						planAmendments: 0,
						addedPaths: [],
						boundaryInventory: [],
						effortVariance: 0,
						architectureVariance: 0,
					},
					budgetInvariant: { W: 2, R: 0, B: 2, D: 0 },
					completionAuthorized: false,
					textGuard: prepared.guard,
					createdAt: "2026-09-23 00:00:01",
				}),
				createdAt: "2026-09-23 00:00:01",
				...recordedEnvelope(TEST_ORIGIN),
			});
			ctx.executionContext.controlPlaneRoot = dir;
			ctx.executionContext.effectiveWorkingDirectory = dir;
			ctx.executionContext.effectivePlanPath = planPath;
			ctx.executionContext.planPathInWorktreeExists = true;
			ctx.executionContext.run.plan_path = planPath;
			return { ctx, planPath, db };
		} catch (error) {
			db.close();
			throw error;
		}
	}

	function providerThatCommitsOutOfSpan(
		dir: string,
		planPath: string,
		includeCommit: boolean,
	): AgentProvider {
		let authorCommit = "";
		const result = {
			text: "structured response",
			structured: {
				result: "needs_human" as const,
				reason: "amendment",
				...(includeCommit ? { commit: "" } : {}),
			},
			sessionId: "session-author-amendment",
			tokens: { in: 0, out: 0 },
			durationMs: 0,
		};
		const session = {
			id: result.sessionId,
			run: async () => {
				writeFileSync(planPath, outOfSpan);
				git(dir, ["add", "plan.md"]);
				git(dir, ["commit", "-m", "out of span"]);
				authorCommit = gitHead(dir);
				writeFileSync(planPath, approved);
				git(dir, ["add", "plan.md"]);
				git(dir, ["commit", "-m", "restore approved"]);
				writeFileSync(planPath, outOfSpan);
				result.structured = {
					result: "needs_human",
					reason: "amendment",
					...(includeCommit ? { commit: authorCommit } : {}),
				};
				return result;
			},
			async *runStreamed() {
				yield { type: "done" as const, result: await session.run() };
			},
		};
		return {
			startSession: async () => session,
			resumeSession: async () => session,
			close: async () => {},
		};
	}

	test("uses the author result commit and surfaces a typed amendment failure", async () => {
		const dir = makeTmpDir();
		const { ctx, planPath, db } = await setupAuthorInvoke(dir);
		try {
			await expect(
				invokeAgent(
					"author",
					{
						template: "author-next-phase",
						run: "run1",
						phase: "1",
						record: true,
						quiet: true,
						workdir: dir,
						vars: [
							`plan_path=${planPath}`,
							"phase_number=1",
							"user_notes=x",
							"run_id=run1",
						],
					},
					{
						db,
						createReviewBudgetContext: async () => ctx,
						createProvider: async () =>
							providerThatCommitsOutOfSpan(dir, planPath, true),
					},
				),
			).rejects.toMatchObject({ code: "PLAN_AMENDMENT_OUT_OF_SPAN" });
			expect(
				ctx.store.listImplementationTextAmendments("run1", "binding-1"),
			).toHaveLength(0);
		} finally {
			ctx.db.close();
			db.close();
			cleanupDir(dir);
		}
	}, 30000);

	test("falls back to HEAD when the author result omits commit", async () => {
		const dir = makeTmpDir();
		const { ctx, planPath, db } = await setupAuthorInvoke(dir);
		try {
			await expect(
				invokeAgent(
					"author",
					{
						template: "author-next-phase",
						run: "run1",
						phase: "1",
						record: true,
						quiet: true,
						workdir: dir,
						vars: [
							`plan_path=${planPath}`,
							"phase_number=1",
							"user_notes=x",
							"run_id=run1",
						],
					},
					{
						db,
						createReviewBudgetContext: async () => ctx,
						createProvider: async () =>
							providerThatCommitsOutOfSpan(dir, planPath, false),
					},
				),
			).rejects.toMatchObject({ code: "PLAN_AMENDMENT_DIRTY" });
		} finally {
			ctx.db.close();
			db.close();
			cleanupDir(dir);
		}
	}, 30000);
});
