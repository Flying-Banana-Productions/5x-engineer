import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadGitRecordForPlan,
	runV1State,
	semanticHumanRequiredFromSteps,
} from "../../../src/commands/run-v1.handler.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import {
	createReviewBudgetStore,
	createWorkingTreeRecordStore,
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { setOutputFormat } from "../../../src/output.js";
import { planSlugFromPath } from "../../../src/paths.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import { createReviewDecision } from "../../../src/review-governance/decisions.js";
import { createReviewGovernanceStore } from "../../../src/review-governance/store.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "33333333-3333-4333-8333-333333333333" },
	performer: { kind: "agent", role: "reviewer" },
};

const ledger = {
	estimateConfidence: "high" as const,
	workItems: [
		{
			id: "W1",
			title: "Feature",
			effort: 5 as const,
			architectureDelta: 0 as const,
			debtClaim: null,
			addresses: [],
			rationale: "required",
			line: 1,
		},
	],
	surface: {
		subsystems: 1,
		productionFiles: 2,
		persistentOrExternalBoundaries: 0,
	},
};

const planText = `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Feature | 5 | 0 | - | - | required |

### Surface Snapshot

- Subsystems: 1
- Production files: 2
- Persistent/external boundaries: 0
`;

const tempDirs: string[] = [];

afterEach(() => {
	setOutputFormat("json");
	for (const path of tempDirs.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

function setup(
	mode: "off" | "advisory" | "enforced" = "advisory",
	capturedMode: "advisory" | "enforced" = "advisory",
) {
	const root = mkdtempSync(join(tmpdir(), "5x-run-budget-state-"));
	tempDirs.push(root);
	const planPath = join(root, "plans", "plan.md");
	mkdirSync(join(root, "plans"));
	writeFileSync(planPath, planText);
	const db = new Database(":memory:");
	runMigrations(db);
	createRunV1(db, { id: "run1", planPath });
	const recordsRoot = join(root, "records");
	const records = createWorkingTreeRecordStore({ recordsRoot });
	records.putRun({
		id: "run1",
		plan_path: planPath,
		config_json: null,
		created_at: "2026-09-17 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "1.3.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: origin.recorder,
	});
	createReviewBudgetStore(records).captureBaseline({
		runId: "run1",
		captureKind: "initial",
		mode: capturedMode,
		parsed: ledger,
		configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
		origin,
	});
	const config = FiveXConfigSchema.parse({
		reviewBudget: { mode },
		paths: { records: recordsRoot },
	});
	return { root, planPath, db, recordsRoot, records, config };
}

async function captureState(
	ctx: ReturnType<typeof setup>,
	selector: { run?: string; plan?: string } = { run: "run1" },
	warn?: (message: string) => void,
): Promise<Record<string, unknown>> {
	setOutputFormat("json");
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => lines.push(String(args[0] ?? ""));
	try {
		await runV1State({
			...selector,
			warn,
			progressResolver: async () => ({
				state: "present",
				source: { kind: "worktree", label: "worktree" },
				markdown: planText,
				planPath: ctx.planPath,
				commit: null,
			}),
			startDir: ctx.root,
			dbContext: {
				projectRoot: ctx.root,
				db: ctx.db,
				config: ctx.config,
				controlPlane: {
					controlPlaneRoot: ctx.root,
					stateDir: join(ctx.root, ".5x"),
					mode: "none",
				},
			},
		});
	} finally {
		console.log = original;
	}
	return JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
}

function appendHumanReview(ctx: ReturnType<typeof setup>): void {
	const stepKey = stepIdempotencyKey({
		runId: "run1",
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
	});
	ctx.records.append({
		runId: "run1",
		stream: "steps",
		idempotencyKey: stepKey,
		payload: {
			step_name: "reviewer:plan",
			phase: "plan",
			iteration: 1,
			result_json: {
				items: [{ id: "H1", action: "human_required" }],
			},
			head_commit: null,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		...recordedEnvelope(origin),
	});
	createReviewBudgetStore(ctx.records).appendSnapshot({
		runId: "run1",
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: ledger,
		findings: [],
		assessments: [],
		baselineAssessment: {
			independentEffortEstimate: 5,
			confidence: "high",
			reason: "aligned",
		},
	});
}

describe("run state review-budget wiring", () => {
	test("runV1State includes active review_budget even after config changes to off", async () => {
		const advisory = setup();
		try {
			const envelope = (await captureState(advisory)) as {
				data?: { review_budget?: { status?: string; W?: number } };
			};
			expect(envelope.data?.review_budget).toMatchObject({
				status: "active",
				W: 5,
			});
		} finally {
			advisory.db.close();
		}

		const off = setup("off");
		try {
			const envelope = (await captureState(off)) as {
				data?: { review_budget?: unknown };
			};
			expect(envelope.data?.review_budget).toMatchObject({
				status: "active",
				mode: "advisory",
			});
		} finally {
			off.db.close();
		}
	});

	test("run state reports the captured mode after live config flips in either direction", async () => {
		for (const fixture of [
			{
				ctx: setup("off", "enforced"),
				expected: { mode: "enforced", enforcement_implemented: true },
			},
			{
				ctx: setup("enforced", "advisory"),
				expected: { mode: "advisory", enforcement_implemented: false },
			},
		] as const) {
			try {
				const envelope = (await captureState(fixture.ctx)) as {
					data?: { review_budget?: Record<string, unknown> };
				};
				expect(envelope.data?.review_budget).toMatchObject(fixture.expected);
			} finally {
				fixture.ctx.db.close();
			}
		}
	});

	test("runV1State recomputes semantic requires_human from the coupled step", async () => {
		const ctx = setup();
		try {
			appendHumanReview(ctx);
			const envelope = (await captureState(ctx)) as {
				data?: { review_budget?: { requires_human?: boolean } };
			};
			expect(envelope.data?.review_budget?.requires_human).toBe(true);
		} finally {
			ctx.db.close();
		}
	});

	test("git-record loader reads budget.jsonl and its coupled semantic step", async () => {
		const ctx = setup();
		try {
			appendHumanReview(ctx);
			const loaded = await loadGitRecordForPlan({
				workdir: ctx.root,
				commit: null,
				recordsRelPath: "records",
				slug: planSlugFromPath(ctx.planPath),
			});
			expect(loaded?.budgetLines.length).toBe(2);
			expect(loaded?.steps.length).toBe(1);
			const snapshot = createReviewBudgetStore(ctx.records).latestSnapshot(
				"run1",
			);
			if (!snapshot || !loaded) throw new Error("missing git record fixture");
			expect(semanticHumanRequiredFromSteps(snapshot, loaded.steps)).toBe(true);
		} finally {
			ctx.db.close();
		}
	});

	test("runV1State git-record path emits reconstructed budget telemetry", async () => {
		const ctx = setup();
		try {
			appendHumanReview(ctx);
			ctx.db.exec("DELETE FROM runs WHERE id = 'run1'");
			const envelope = (await captureState(ctx, {
				plan: ctx.planPath,
			})) as {
				data?: {
					review_budget?: { status?: string; requires_human?: boolean };
				};
			};
			expect(envelope.data?.review_budget).toMatchObject({
				status: "active",
				requires_human: true,
			});
		} finally {
			ctx.db.close();
		}
	});

	test("archived run state folds decisions into governing B", async () => {
		const ctx = setup();
		try {
			appendHumanReview(ctx);
			const snapshot = createReviewBudgetStore(ctx.records).latestSnapshot(
				"run1",
			);
			if (!snapshot) throw new Error("missing snapshot fixture");
			const decision = createReviewDecision({
				gateId: "gate-baseline",
				snapshotId: snapshot.id,
				choice: "adjust_baseline",
				findingRefs: [],
				rationale: "The independent estimate establishes the larger baseline.",
				evidence: [],
				approvedScope: { retained: [], removed: [] },
				governingBaselineChange: { from: 5, to: 8 },
				decisionId: "44444444-4444-4444-8444-444444444444",
				createdAt: "2026-09-17 00:00:02",
			});
			createReviewGovernanceStore(ctx.records).resolveGate({
				runId: "run1",
				decision,
				humanStep: {
					step_name: "human:review-governance",
					phase: "plan",
					iteration: 1,
					result_json: {
						decisionId: decision.decisionId,
						gateId: decision.gateId,
					},
					head_commit: null,
					patch_id: null,
					diff_summary: null,
					duration_ms: null,
					tokens_in: null,
					tokens_out: null,
					cost_usd: null,
					model: null,
				},
				origin: {
					...origin,
					performer: { kind: "human", role: "operator" },
				},
			});
			const liveEnvelope = (await captureState(ctx)) as {
				data?: {
					review_budget?: Record<string, unknown>;
					review_governance?: Record<string, unknown>;
				};
			};
			expect(liveEnvelope.data?.review_budget?.B).toBe(8);
			expect(liveEnvelope.data?.review_governance).toMatchObject({
				governing_baseline: 8,
			});
			expect(liveEnvelope.data?.review_governance?.diagnostics).toContainEqual(
				expect.stringContaining("legacy snapshot has no derived budget"),
			);
			ctx.db.exec("DELETE FROM runs WHERE id = 'run1'");
			const envelope = (await captureState(ctx, {
				plan: ctx.planPath,
			})) as {
				data?: {
					review_budget?: Record<string, unknown>;
					review_governance?: Record<string, unknown>;
				};
			};
			expect(envelope.data?.review_budget?.B).toBe(8);
			expect(envelope.data?.review_budget).toEqual(
				liveEnvelope.data?.review_budget,
			);
			expect(envelope.data?.review_governance).toEqual(
				liveEnvelope.data?.review_governance,
			);
		} finally {
			ctx.db.close();
		}
	});

	test("git-record loader surfaces malformed budget JSONL", async () => {
		const ctx = setup();
		try {
			const slug = planSlugFromPath(ctx.planPath);
			writeFileSync(
				join(ctx.recordsRoot, slug, "run1", "budget.jsonl"),
				"{not json}\n",
			);
			const loaded = await loadGitRecordForPlan({
				workdir: ctx.root,
				commit: null,
				recordsRelPath: "records",
				slug,
			});
			expect(loaded?.budgetLines).toEqual([]);
			expect(loaded?.budgetDecodeError).toBeString();
		} finally {
			ctx.db.close();
		}
	});

	test("runV1State warns and omits corrupt budget records", async () => {
		const ctx = setup();
		const warnings: string[] = [];
		try {
			const slug = planSlugFromPath(ctx.planPath);
			writeFileSync(
				join(ctx.recordsRoot, slug, "run1", "budget.jsonl"),
				"{not json}\n",
			);
			const envelope = (await captureState(ctx, { run: "run1" }, (message) =>
				warnings.push(message),
			)) as { data?: { review_budget?: unknown } };
			expect(envelope.data?.review_budget).toBeUndefined();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("omitting review_budget");

			warnings.length = 0;
			ctx.db.exec("DELETE FROM runs WHERE id = 'run1'");
			const gitEnvelope = (await captureState(
				ctx,
				{ plan: ctx.planPath },
				(message) => warnings.push(message),
			)) as { data?: { review_budget?: unknown } };
			expect(gitEnvelope.data?.review_budget).toBeUndefined();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("omitting review_budget");
		} finally {
			ctx.db.close();
		}
	});

	test("live and archived run state warn and omit governance for a malformed snapshot payload", async () => {
		const ctx = setup();
		const warnings: string[] = [];
		try {
			ctx.records.append({
				runId: "run1",
				stream: "budget",
				idempotencyKey: "budget:snapshot:run1:malformed:plan:1",
				payload: {
					kind: "snapshot",
					id: "malformed-snapshot",
					runId: "run1",
				},
				...recordedEnvelope(origin),
			});

			const live = (await captureState(ctx, { run: "run1" }, (message) =>
				warnings.push(message),
			)) as { data?: { review_governance?: unknown } };
			expect(live.data?.review_governance).toBeUndefined();
			expect(warnings).toContainEqual(
				expect.stringContaining(
					"Unable to read review governance records for run run1; omitting review_governance",
				),
			);

			warnings.length = 0;
			ctx.db.exec("DELETE FROM runs WHERE id = 'run1'");
			const archived = (await captureState(
				ctx,
				{ plan: ctx.planPath },
				(message) => warnings.push(message),
			)) as { data?: { review_governance?: unknown } };
			expect(archived.data?.review_governance).toBeUndefined();
			expect(warnings).toContainEqual(
				expect.stringContaining(
					"Unable to read review governance records for run run1; omitting review_governance",
				),
			);
		} finally {
			ctx.db.close();
		}
	});
});
