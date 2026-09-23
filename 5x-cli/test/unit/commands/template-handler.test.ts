import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordContextError } from "../../../src/commands/record-context.js";
import { templateRender } from "../../../src/commands/template.handler.js";
import { _resetForTest, closeDb } from "../../../src/db/connection.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";
import {
	makeBudgetContext,
	seedPromptGovernanceContext,
} from "./review-budget-test-helpers.js";

describe("templateRender review-budget dependencies", () => {
	test("uses the injected context and plan reader for PLAN_NOT_FOUND", async () => {
		_resetForTest();
		const dir = join(
			tmpdir(),
			`5x-template-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		Bun.spawnSync(["git", "init"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		mkdirSync(join(dir, ".5x"), { recursive: true });
		const planPath = join(dir, "plan.md");
		writeFileSync(planPath, "# Plan\n");
		writeFileSync(join(dir, "5x.toml"), "");
		const db = new Database(join(dir, ".5x", "5x.db"));
		runMigrations(db);
		createRunV1(db, { id: "run1", planPath });
		db.close();

		const ctx = makeBudgetContext();
		ctx.executionContext.effectivePlanPath = planPath;
		let contextCalls = 0;
		let readPath: string | undefined;
		try {
			await expect(
				templateRender(
					{ template: "reviewer-plan", run: "run1", workdir: dir },
					{
						createReviewBudgetContext: async () => {
							contextCalls++;
							return ctx;
						},
						readPlan: (path) => {
							readPath = path;
							throw new Error("fixture unreadable");
						},
					},
				),
			).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
			expect(contextCalls).toBe(1);
			expect(readPath).toBe(planPath);
		} finally {
			ctx.db.close();
			closeDb();
			_resetForTest();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("renders reviewer and author governance blocks through the handler", async () => {
		_resetForTest();
		const dir = join(
			tmpdir(),
			`5x-template-governance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		Bun.spawnSync(["git", "init"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		mkdirSync(join(dir, ".5x"), { recursive: true });
		const planPath = join(dir, "plan.md");
		writeFileSync(planPath, "# Plan\n");
		writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "enforced"\n');
		const db = new Database(join(dir, ".5x", "5x.db"));
		runMigrations(db);
		createRunV1(db, { id: "run1", planPath });
		db.close();

		const ctx = makeBudgetContext({ mode: "enforced" });
		ctx.executionContext.effectivePlanPath = planPath;
		seedPromptGovernanceContext(ctx);
		const prompts = new Map<string, string>();
		const render = async (
			template: string,
			extra?: { newSession?: boolean },
		) => {
			await templateRender(
				{ template, run: "run1", workdir: dir, ...extra },
				{
					createReviewBudgetContext: async () => ctx,
					onRenderedPrompt: (prompt) => prompts.set(template, prompt),
				},
			);
		};
		try {
			await render("reviewer-plan", { newSession: true });
			await render("reviewer-plan-continued");
			await render("author-process-plan-review");
			for (const name of ["reviewer-plan", "reviewer-plan-continued"]) {
				const prompt = prompts.get(name) ?? "";
				expect(prompt).toContain("## Plan-review governance context");
				expect(prompt).toContain("Required prior-finding outcome IDs: P1.open");
				expect(prompt).toContain("P1.deferred (sha256:deferred)");
				expect(prompt).not.toContain(
					"Required prior-finding outcome IDs: P1.open; P1.deferred",
				);
			}
			const author = prompts.get("author-process-plan-review") ?? "";
			expect(author).toContain("## Governing decisions");
			expect(author).toContain("P1.deferred (sha256:deferred)");
			expect(author).not.toContain("## Plan-review governance context");
		} finally {
			ctx.db.close();
			closeDb();
			_resetForTest();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sqlite-only budgeted render requires approval and mode-off does not", async () => {
		_resetForTest();
		const dir = join(
			tmpdir(),
			`5x-template-admission-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		Bun.spawnSync(["git", "init"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		mkdirSync(join(dir, ".5x"), { recursive: true });
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
		writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "advisory"\n');
		const db = new Database(join(dir, ".5x", "5x.db"));
		runMigrations(db);
		createRunV1(db, { id: "run1", planPath });
		db.close();
		const missingRecords = async () => {
			throw new RecordContextError(
				"RECORDS_UNAVAILABLE",
				"sqlite-only run has no record home",
			);
		};
		try {
			await expect(
				templateRender(
					{
						template: "author-next-phase",
						run: "run1",
						workdir: dir,
						vars: [`plan_path=${planPath}`, "phase_number=1"],
					},
					{ createReviewBudgetContext: missingRecords },
				),
			).rejects.toMatchObject({ code: "IMPLEMENTATION_APPROVAL_REQUIRED" });

			writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "off"\n');
			await templateRender(
				{
					template: "author-next-phase",
					run: "run1",
					workdir: dir,
					vars: [`plan_path=${planPath}`, "phase_number=1"],
				},
				{ createReviewBudgetContext: missingRecords },
			);
		} finally {
			closeDb();
			_resetForTest();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
