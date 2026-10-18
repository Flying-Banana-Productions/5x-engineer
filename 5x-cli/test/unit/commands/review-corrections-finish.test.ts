import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initScaffold } from "../../../src/commands/init.handler.js";
import type { ReviewBudgetCommandContext } from "../../../src/commands/review-budget-context.js";
import { finishImplementationCorrections } from "../../../src/commands/review-decision.handler.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import {
	createMemoryRecordStore,
	createReviewBudgetStore,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { CliError } from "../../../src/output.js";
import {
	encodeImplementationReviewObservationPayload,
	implementationReviewObservationKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";
import { TEST_ORIGIN } from "./review-budget-test-helpers.js";

const RUN = "run_corr_finish";

function git(dir: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

describe("review corrections finish handler", () => {
	test(
		"uses the layered quality directory and a real correction commit",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "5x-corr-finish-"));
			const dbPath = join(dir, ".5x", "5x.db");
			let db: Database | null = null;
			try {
				git(dir, ["init"]);
				git(dir, ["config", "user.email", "test@test.com"]);
				git(dir, ["config", "user.name", "Test"]);
				await initScaffold({ startDir: dir });
				writeFileSync(join(dir, "5x.toml"), 'qualityGates = ["echo root"]\n');
				const sub = join(dir, "packages", "api");
				mkdirSync(sub, { recursive: true });
				writeFileSync(
					join(sub, "5x.toml"),
					'qualityGates = ["echo layered"]\n',
				);
				writeFileSync(join(sub, "plan.md"), "# Plan\n");
				mkdirSync(join(dir, "src"), { recursive: true });
				writeFileSync(join(dir, "src", "fix.ts"), "export const n = 1;\n");
				git(dir, ["add", "-A"]);
				git(dir, ["commit", "-m", "reviewed"]);
				const reviewed = git(dir, ["rev-parse", "HEAD"]);
				writeFileSync(join(dir, "src", "fix.ts"), "export const n = 2;\n");
				git(dir, ["add", "src/fix.ts"]);
				git(dir, ["commit", "-m", "correction"]);
				const commit = git(dir, ["rev-parse", "HEAD"]);
				const planPath = join(sub, "plan.md");
				db = new Database(dbPath);
				createRunV1(db, { id: RUN, planPath });
				const recordStore = createMemoryRecordStore();
				recordStore.putRun({
					id: RUN,
					plan_path: planPath,
					config_json: null,
					created_at: "2026-09-23 00:00:00",
					sealed_at: null,
					status: "active",
					final_head_commit: null,
					cli_version: "0.0.0",
					format_version: RUN_RECORD_FORMAT_VERSION,
					creator: TEST_ORIGIN.recorder,
				});
				const store = createReviewBudgetStore(recordStore);
				const obs = {
					kind: "implementation-review" as const,
					version: 1 as const,
					id: "obs-handler",
					runId: RUN,
					stepKey: {
						stepName: "reviewer:review",
						phase: "6",
						iteration: 0,
					},
					bindingId: "bind-1",
					contextId: "ctx-1",
					domain: "implementation" as const,
					phase: "6",
					originalVerdict: {
						readiness: "ready_with_corrections" as const,
						items: [
							{
								id: "R1",
								title: "Off-by-one",
								action: "auto_fix" as const,
								reason: "The loop stops one short.",
								scopeClass: "implementation_defect" as const,
								priority: "P2" as const,
								effortDelta: 5,
								architectureDelta: 0,
								boundaryChanges: [],
								mechanicalExplanation: "Change the comparison operator.",
								planWorkItemIds: ["W1"],
							},
						],
					},
					outcomes: [],
					route: "author_revision" as const,
					nextAction: "author_revision" as const,
					diagnostics: [],
					claimObservations: [],
					gateCauses: [],
					telemetry: {
						reviewCycles: 1,
						fixCycles: 0,
						reviewOriginatedCommits: 0,
						qualityReruns: 0,
						classCounts: {
							implementation_defect: 1,
							plan_defect: 0,
							scope_expansion: 0,
							pre_existing: 0,
						},
						planAmendments: 0,
						addedPaths: [],
						boundaryInventory: [],
						effortVariance: 5,
						architectureVariance: 0,
					},
					budgetInvariant: { W: 5, R: 0, B: 5, D: 0 },
					completionAuthorized: false,
					createdAt: "2026-09-23 00:00:01",
				};
				recordStore.append({
					runId: RUN,
					stream: "budget",
					idempotencyKey: implementationReviewObservationKey(RUN, obs.stepKey),
					payload: encodeImplementationReviewObservationPayload(obs),
					createdAt: obs.createdAt,
					...recordedEnvelope(TEST_ORIGIN),
				});
				store.saveImplementationReviewContext(
					{
						kind: "implementation-review-context",
						version: 1,
						id: "ctx-1",
						executionRunId: RUN,
						bindingId: "bind-1",
						phase: "6",
						baseCommit: reviewed,
						reviewedCommit: reviewed,
						patchHash: "sha256:abc",
						excludedPaths: [".5x/"],
						hunks: [
							{
								oldPath: "src/fix.ts",
								newPath: "src/fix.ts",
								header: "@@ -1 +1 @@",
								text: "diff --git a/src/fix.ts b/src/fix.ts\n@@ -1 +1 @@\n-a\n+b\n",
								hash: "sha256:hunk",
							},
						],
						binaryPaths: [],
						createdAt: "2026-09-23 00:00:00",
					},
					TEST_ORIGIN,
				);
				store.saveImplementationBinding(
					{
						kind: "implementation-binding",
						version: 1,
						id: "bind-1",
						executionRunId: RUN,
						sourceRunId: "source",
						sourceSnapshotId: "snap",
						sourceBaselineId: "base",
						approvedPlanCommit: "c".repeat(40),
						approvedPlanHash: "sha256:plan",
						approvedPlanBytes: "# Plan\n",
						b0: 5,
						governingB: 5,
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
						phaseMap: [{ id: "6", heading: "Phase 6" }],
						debtTargets: [],
						ledgerHash: "ledger",
						decisionsHash: "decisions",
						createdAt: "2026-09-23 00:00:00",
					},
					TEST_ORIGIN,
				);
				recordStore.append({
					runId: RUN,
					stream: "steps",
					idempotencyKey: stepIdempotencyKey({
						runId: RUN,
						stepName: "reviewer:review",
						phase: "6",
						iteration: 0,
					}),
					payload: {
						step_name: "reviewer:review",
						phase: "6",
						iteration: 0,
						result_json: { result: "complete" },
						head_commit: reviewed,
						patch_id: null,
						diff_summary: null,
						duration_ms: null,
						tokens_in: null,
						tokens_out: null,
						cost_usd: null,
						model: null,
					},
					createdAt: "2026-09-23 00:00:01",
					...recordedEnvelope(TEST_ORIGIN),
				});
				recordStore.append({
					runId: RUN,
					stream: "steps",
					idempotencyKey: stepIdempotencyKey({
						runId: RUN,
						stepName: "author:impl",
						phase: "6",
						iteration: 1,
					}),
					payload: {
						step_name: "author:impl",
						phase: "6",
						iteration: 1,
						result_json: { result: "complete", commit },
						head_commit: commit,
						patch_id: null,
						diff_summary: null,
						duration_ms: null,
						tokens_in: null,
						tokens_out: null,
						cost_usd: null,
						model: null,
					},
					createdAt: "2026-09-23 00:00:02",
					...recordedEnvelope(TEST_ORIGIN),
				});
				const ctx = {
					db,
					config: FiveXConfigSchema.parse({}),
					recordStore,
					store,
					recordsRelPath: "records",
					recordsAbsPath: join(dir, "records"),
					executionContext: {
						controlPlaneRoot: dir,
						run: { id: RUN, plan_path: planPath, status: "active" as const },
						mappedWorktreePath: null,
						effectiveWorkingDirectory: dir,
						effectivePlanPath: planPath,
						planPathInWorktreeExists: true,
					},
					originFor: () => TEST_ORIGIN,
					redactedRecorder: () => TEST_ORIGIN.recorder,
				} as ReviewBudgetCommandContext;
				const first = await finishImplementationCorrections(
					{ runId: RUN, phase: "6", observationId: "obs-handler", commit },
					{ context: ctx },
				);
				expect(first.status).toBe("complete");
				if (first.status !== "complete") return;
				expect(first.resumed).toBe(false);
				expect(first.attempt.executionDirectory).toBe(sub);
				expect(first.attempt.qualityResults.map((row) => row.command)).toEqual([
					"echo layered",
				]);
				expect(first.attempt.changedPaths).toEqual(["src/fix.ts"]);
				const second = await finishImplementationCorrections(
					{ runId: RUN, phase: "6", observationId: "obs-handler", commit },
					{ context: ctx },
				);
				expect(second.status).toBe("complete");
				if (second.status === "complete") expect(second.resumed).toBe(true);
				await expect(
					finishImplementationCorrections(
						{
							runId: RUN,
							phase: "6",
							observationId: "missing",
							commit,
						},
						{ context: ctx },
					),
				).rejects.toBeInstanceOf(CliError);
			} finally {
				db?.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);
});
