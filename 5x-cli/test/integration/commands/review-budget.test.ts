import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createReviewBudgetStore,
	createWorkingTreeRecordStore,
} from "../../../src/index.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const VALID_BUDGET = `# Test plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Deliver behavior | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Deliver

- [ ] Deliver behavior
`;
const NO_BUDGET =
	"# Test plan\n\n## Phase 1: Deliver\n\n- [ ] Deliver behavior\n";
const NEGATIVE_WITHOUT_EVIDENCE = VALID_BUDGET.replace(
	"| W1 | Deliver behavior | 2 | 0 | - | - | Required |",
	"| W1 | Deliver behavior | 2 | -1 | DC0 (`intrinsic`) | - | Required |",
);
const INITIAL_VERDICT = JSON.stringify({
	readiness: "ready",
	items: [],
	baselineAssessment: {
		independentEffortEstimate: 2,
		confidence: "high",
		reason: "Independent estimate",
	},
	creditAssessments: [],
});
const V1_VERDICT = JSON.stringify({ readiness: "ready", items: [] });
const HUMAN_VERDICT = JSON.stringify({
	readiness: "not_ready",
	items: [
		{
			id: "R1",
			title: "Architecture decision",
			action: "human_required",
			reason: "Needs an explicit decision",
			effortDelta: 8,
			architectureDelta: 5,
			scopeClass: "acceptance_required",
			coupling: "intrinsic",
			estimateConfidence: "high",
			failure: "The plan leaves the persistence architecture undecided.",
			lowestCostCorrection: "Select one persistence architecture.",
		},
	],
	baselineAssessment: {
		independentEffortEstimate: 2,
		confidence: "high",
		reason: "Independent estimate",
	},
	creditAssessments: [],
});

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function tempDir(): string {
	const dir = join(
		tmpdir(),
		`5x-review-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function run5x(
	cwd: string,
	args: string[],
	stdin?: string,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (stdin !== undefined) {
		if (!proc.stdin) throw new Error("stdin pipe unavailable");
		proc.stdin.write(stdin);
		proc.stdin.end();
	}
	const timer = setTimeout(() => proc.kill("SIGINT"), 20000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function git(cwd: string, ...args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function setup(
	plan = VALID_BUDGET,
	mode: "off" | "advisory" | "enforced" = "advisory",
): Promise<{ dir: string; planPath: string; runId: string }> {
	const dir = tempDir();
	git(dir, "init");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	const initialized = await run5x(dir, ["init"]);
	if (initialized.exitCode !== 0) throw new Error(initialized.stdout);
	writeFileSync(
		join(dir, "5x.toml"),
		`[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewBudget]\nmode = "${mode}"\n`,
	);
	const planPath = join(dir, "docs", "development", "test-plan.md");
	mkdirSync(join(dir, "docs", "development"), { recursive: true });
	writeFileSync(planPath, plan);
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "fixture");
	const initializedRun = await run5x(dir, ["run", "init", "--plan", planPath]);
	if (initializedRun.exitCode !== 0) throw new Error(initializedRun.stdout);
	const runId = (
		JSON.parse(initializedRun.stdout) as { data: { run_id: string } }
	).data.run_id;
	return { dir, planPath, runId };
}

function budgetStore(dir: string) {
	return createReviewBudgetStore(
		createWorkingTreeRecordStore({
			recordsRoot: join(dir, "docs", "development", "runs"),
		}),
	);
}

function lines(dir: string, runId: string, stream: "budget" | "steps") {
	return createWorkingTreeRecordStore({
		recordsRoot: join(dir, "docs", "development", "runs"),
	}).listLines(runId, stream);
}

describe("review-budget CLI integration", () => {
	test(
		"preserves the v1 emit/validate contract and rejects reviewer aggregates",
		async () => {
			const emitted = await run5x(process.cwd(), [
				"protocol",
				"emit",
				"reviewer",
				"--ready",
			]);
			expect(emitted.exitCode).toBe(0);
			expect(JSON.parse(emitted.stdout)).toEqual({
				readiness: "ready",
				items: [],
			});
			const validated = await run5x(
				process.cwd(),
				["protocol", "validate", "reviewer"],
				emitted.stdout,
			);
			expect(validated.exitCode).toBe(0);
			expect(
				(JSON.parse(validated.stdout) as { data: { result: unknown } }).data
					.result,
			).toEqual({ readiness: "ready", items: [] });

			const aggregate = await run5x(
				process.cwd(),
				["protocol", "validate", "reviewer"],
				JSON.stringify({
					readiness: "ready",
					items: [],
					budgetBand: "within_standard",
				}),
			);
			expect(aggregate.exitCode).not.toBe(0);
			expect(JSON.parse(aggregate.stdout).error.code).toBe(
				"INVALID_STRUCTURED_OUTPUT",
			);
		},
		{ timeout: 30000 },
	);

	test(
		"captures a record baseline, pairs decorated persistence, and rebuilds a wiped index",
		async () => {
			const ctx = await setup();
			try {
				const rendered = await run5x(ctx.dir, [
					"template",
					"render",
					"reviewer-plan",
					"--run",
					ctx.runId,
				]);
				expect(rendered.exitCode).toBe(0);
				expect(budgetStore(ctx.dir).getBaseline(ctx.runId)).toMatchObject({
					b0: 2,
					captureKind: "initial",
				});
				expect(lines(ctx.dir, ctx.runId, "budget")).toHaveLength(1);

				const recorded = await run5x(
					ctx.dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						ctx.runId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"plan",
						"--iteration",
						"0",
					],
					INITIAL_VERDICT,
				);
				expect(recorded.exitCode).toBe(0);
				const result = JSON.parse(recorded.stdout).data.result;
				expect(result.baselineAssessment.independentEffortEstimate).toBe(2);
				expect(result.budget).toMatchObject({ B0: 2, I: 2 });
				expect(lines(ctx.dir, ctx.runId, "steps")).toHaveLength(1);
				expect(lines(ctx.dir, ctx.runId, "budget")).toHaveLength(2);

				// A retry is an all-new-or-no-op repair, not a second snapshot.
				const retry = await run5x(
					ctx.dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						ctx.runId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"plan",
						"--iteration",
						"0",
					],
					INITIAL_VERDICT,
				);
				expect(retry.exitCode).toBe(0);
				expect(lines(ctx.dir, ctx.runId, "steps")).toHaveLength(1);
				expect(lines(ctx.dir, ctx.runId, "budget")).toHaveLength(2);

				const db = new Database(join(ctx.dir, ".5x", "5x.db"));
				db.exec(
					"DELETE FROM review_budget_snapshots; DELETE FROM review_budget_baselines;",
				);
				db.close();
				const state = await run5x(ctx.dir, [
					"run",
					"state",
					"--run",
					ctx.runId,
				]);
				expect(state.exitCode).toBe(0);
				expect(JSON.parse(state.stdout).data.review_budget).toMatchObject({
					status: "active",
					B0: 2,
					I: 2,
				});
				const rebuilt = new Database(join(ctx.dir, ".5x", "5x.db"));
				expect(
					rebuilt
						.query("SELECT count(*) AS n FROM review_budget_baselines")
						.get(),
				).toEqual({ n: 1 });
				expect(
					rebuilt
						.query("SELECT count(*) AS n FROM review_budget_snapshots")
						.get(),
				).toEqual({ n: 1 });
				rebuilt.close();

				writeFileSync(ctx.planPath, NO_BUDGET);
				const malformed = await run5x(
					ctx.dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						ctx.runId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"plan",
						"--iteration",
						"1",
					],
					V1_VERDICT,
				);
				expect(malformed.exitCode).not.toBe(0);
				expect(JSON.parse(malformed.stdout).error.code).toBe(
					"BUDGET_SECTION_MISSING",
				);
				expect(budgetStore(ctx.dir).getBaseline(ctx.runId)?.b0).toBe(2);
				expect(lines(ctx.dir, ctx.runId, "budget")).toHaveLength(2);
			} finally {
				rmSync(ctx.dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"fails closed at render for missing sections and incomplete debt evidence",
		async () => {
			for (const [plan, code] of [
				[NO_BUDGET, "BUDGET_SECTION_MISSING"],
				[NEGATIVE_WITHOUT_EVIDENCE, "BUDGET_DEBT_CLAIM_EVIDENCE_MISSING"],
			] as const) {
				const ctx = await setup(plan);
				try {
					const rendered = await run5x(ctx.dir, [
						"template",
						"render",
						"reviewer-plan",
						"--run",
						ctx.runId,
					]);
					expect(rendered.exitCode).not.toBe(0);
					expect(JSON.parse(rendered.stdout).error.code).toBe(code);
					expect(lines(ctx.dir, ctx.runId, "budget")).toHaveLength(0);
				} finally {
					rmSync(ctx.dir, { recursive: true, force: true });
				}
			}
		},
		{ timeout: 30000 },
	);

	test(
		"keeps mid-review runs v1-compatible until explicit opt-in",
		async () => {
			const ctx = await setup();
			try {
				const seeded = await run5x(ctx.dir, [
					"run",
					"record",
					"reviewer:review",
					"--run",
					ctx.runId,
					"--phase",
					"plan",
					"--iteration",
					"0",
					"--result",
					V1_VERDICT,
				]);
				expect(seeded.exitCode).toBe(0);
				const rendered = await run5x(ctx.dir, [
					"template",
					"render",
					"reviewer-plan",
					"--run",
					ctx.runId,
				]);
				expect(rendered.exitCode).toBe(0);
				expect(lines(ctx.dir, ctx.runId, "budget")).toHaveLength(0);

				const compatible = await run5x(
					ctx.dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						ctx.runId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"plan",
						"--iteration",
						"1",
					],
					V1_VERDICT,
				);
				expect(compatible.exitCode).toBe(0);
				expect(
					JSON.parse(compatible.stdout).data.result.budget,
				).toBeUndefined();
				expect(lines(ctx.dir, ctx.runId, "budget")).toHaveLength(0);

				const optedIn = await run5x(
					ctx.dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						ctx.runId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"plan",
						"--iteration",
						"2",
						"--opt-in-budget-baseline",
					],
					INITIAL_VERDICT,
				);
				expect(optedIn.exitCode).toBe(0);
				expect(budgetStore(ctx.dir).getBaseline(ctx.runId)).toMatchObject({
					captureKind: "opt_in",
				});
				expect(JSON.parse(optedIn.stdout).data.result.budget.B0).toBe(2);
				expect(lines(ctx.dir, ctx.runId, "budget")).toHaveLength(2);
			} finally {
				rmSync(ctx.dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"local mode off disables the full loop and implementation review stays v1",
		async () => {
			const off = await setup(NO_BUDGET);
			try {
				writeFileSync(
					join(off.dir, "5x.toml.local"),
					'[reviewBudget]\nmode = "off"\n',
				);
				const rendered = await run5x(off.dir, [
					"template",
					"render",
					"reviewer-plan",
					"--run",
					off.runId,
				]);
				expect(rendered.exitCode).toBe(0);
				const recorded = await run5x(
					off.dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						off.runId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"plan",
					],
					V1_VERDICT,
				);
				expect(recorded.exitCode).toBe(0);
				expect(JSON.parse(recorded.stdout).data.result.budget).toBeUndefined();
				expect(lines(off.dir, off.runId, "budget")).toHaveLength(0);
			} finally {
				rmSync(off.dir, { recursive: true, force: true });
			}

			const implementation = await setup();
			try {
				await run5x(implementation.dir, [
					"template",
					"render",
					"reviewer-plan",
					"--run",
					implementation.runId,
				]);
				const validated = await run5x(
					implementation.dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						implementation.runId,
						"--record",
						"--step",
						"reviewer:review",
						"--phase",
						"phase-1",
					],
					V1_VERDICT,
				);
				expect(validated.exitCode).toBe(0);
				expect(JSON.parse(validated.stdout).data.result).toEqual({
					readiness: "ready",
					items: [],
				});
				expect(
					lines(implementation.dir, implementation.runId, "budget"),
				).toHaveLength(1);
			} finally {
				rmSync(implementation.dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"enforced mode is pinned and derives governance routing without a legacy warning",
		async () => {
			for (const capture of ["render", "record"] as const) {
				const ctx = await setup(VALID_BUDGET, "enforced");
				try {
					const result =
						capture === "render"
							? await run5x(ctx.dir, [
									"template",
									"render",
									"reviewer-plan",
									"--run",
									ctx.runId,
								])
							: await run5x(
									ctx.dir,
									[
										"protocol",
										"validate",
										"reviewer",
										"--run",
										ctx.runId,
										"--record",
										"--step",
										"reviewer:review",
										"--phase",
										"plan",
									],
									HUMAN_VERDICT,
								);
					expect(result.exitCode).toBe(0);
					expect(result.stderr).not.toContain("enforcement is not implemented");
					expect(budgetStore(ctx.dir).getBaseline(ctx.runId)?.mode).toBe(
						"enforced",
					);
					if (capture === "record") {
						const verdict = JSON.parse(result.stdout).data.result;
						expect(verdict.readiness).toBe("not_ready");
						expect(verdict.budget.requiresHuman).toBe(true);
						expect(verdict.budget.budgetBand).toBe("over_absolute");
						expect(verdict.governance.route).toBe("human_gate");
					}
				} finally {
					rmSync(ctx.dir, { recursive: true, force: true });
				}
			}
		},
		{ timeout: 30000 },
	);
});
