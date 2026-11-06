import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const PLAN_REL = "docs/development/plans/finalize.md";

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString() || result.stdout.toString());
	}
	return result.stdout.toString().trim();
}

async function cli(cwd: string, args: string[], stdin?: unknown) {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: stdin === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (stdin !== undefined) {
		if (!proc.stdin) throw new Error("stdin pipe unavailable");
		proc.stdin.write(JSON.stringify(stdin));
		proc.stdin.end();
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function plan(options?: { w2Addresses?: string; w2Effort?: number }): string {
	return `# Finalization plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Foundation | 2 | 0 | - | - | Implements the foundation. |
| W2 | Follow-up | ${options?.w2Effort ?? 1} | 0 | - | ${options?.w2Addresses ?? "-"} | Implements the follow-up. |

### Surface Snapshot

- Subsystems: 1
- Production files: 2
- Persistent/external boundaries: 0

## Phase 1: Foundation

**Completion gate:** The foundation works.

- [ ] Build the foundation

## Phase 2: Follow-up

**Completion gate:** The follow-up works.

- [ ] Build the follow-up
`;
}

const CORRECTION = {
	id: "P1.1",
	title: "Name the follow-up's failure path",
	action: "auto_fix",
	reason: "W2 omits the recovery path the review asked for.",
	scopeClass: "acceptance_required",
	effortDelta: 0,
	architectureDelta: 0,
	coupling: "intrinsic",
	estimateConfidence: "high",
	failure: "The follow-up can fail without recovery.",
	lowestCostCorrection: "Record the recovery path on W2.",
};

async function initRepo(): Promise<{ dir: string; planPath: string }> {
	const dir = mkdtempSync(join(tmpdir(), "5x-finalize-"));
	git(dir, "init", "-b", "main");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "core.autocrlf", "false");
	const initialized = await cli(dir, ["init"]);
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
	writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "enforced"\n');
	const planPath = join(dir, PLAN_REL);
	mkdirSync(join(dir, "docs", "development", "plans"), { recursive: true });
	writeFileSync(planPath, plan());
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "fixture");
	return { dir, planPath };
}

function steps(dir: string, runId: string): Array<Record<string, unknown>> {
	const path = join(
		dir,
		"docs",
		"development",
		"runs",
		"finalize",
		runId,
		"steps.jsonl",
	);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(
			(line) =>
				(JSON.parse(line) as { payload: Record<string, unknown> }).payload,
		);
}

function budget(dir: string, runId: string): Array<Record<string, unknown>> {
	const path = join(
		dir,
		"docs",
		"development",
		"runs",
		"finalize",
		runId,
		"budget.jsonl",
	);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(
			(line) =>
				(JSON.parse(line) as { payload: Record<string, unknown> }).payload,
		);
}

/** Initial `ready_with_corrections` review admitting P1.1 as a final correction. */
async function reviewWithCorrection(dir: string, planPath: string) {
	const init = await cli(dir, ["run", "init", "--plan", planPath]);
	if (init.exitCode !== 0) throw new Error(`${init.stdout}\n${init.stderr}`);
	const runId = JSON.parse(init.stdout).data.run_id as string;
	const review = await cli(
		dir,
		[
			"protocol",
			"validate",
			"reviewer",
			"--run",
			runId,
			"--record",
			"--step",
			"reviewer:plan",
			"--phase",
			"plan",
			"--iteration",
			"0",
		],
		{
			readiness: "ready_with_corrections",
			items: [CORRECTION],
			baselineAssessment: {
				independentEffortEstimate: 3,
				confidence: "high",
				reason: "The original scope is three points.",
			},
		},
	);
	if (review.exitCode !== 0) {
		throw new Error(`review: ${review.stdout}\n${review.stderr}`);
	}
	expect(JSON.parse(review.stdout).data.result.governance.route).toBe(
		"final_corrections",
	);
	return runId;
}

/** The plan author's one-pass correction, committed and recorded. */
async function authorCorrection(
	dir: string,
	planPath: string,
	runId: string,
	markdown: string,
): Promise<string> {
	writeFileSync(planPath, markdown);
	git(dir, "add", planPath);
	git(dir, "commit", "-m", "apply final corrections");
	const commit = git(dir, "rev-parse", "HEAD");
	const recorded = await cli(
		dir,
		[
			"protocol",
			"validate",
			"author",
			"--run",
			runId,
			"--record",
			"--step",
			"author:process-plan-review",
			"--phase",
			"plan",
			"--no-phase-checklist-validate",
		],
		{ result: "complete", commit },
	);
	if (recorded.exitCode !== 0) {
		throw new Error(`author: ${recorded.stdout}\n${recorded.stderr}`);
	}
	return commit;
}

function blobHash(dir: string, commit: string): string {
	const bytes = git(dir, "show", `${commit}:${PLAN_REL}`);
	return `sha256:${createHash("sha256").update(`${bytes}\n`, "utf8").digest("hex")}`;
}

describe("final-corrections approval finalization", () => {
	test(
		"ready_with_corrections → author correction → completion → admission binds the committed ledger with one review",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await reviewWithCorrection(dir, planPath);
				const authorCommit = await authorCorrection(
					dir,
					planPath,
					sourceId,
					plan({ w2Addresses: "P1.1" }),
				);
				const completed = await cli(dir, [
					"run",
					"complete",
					"--run",
					sourceId,
				]);
				if (completed.exitCode !== 0) {
					throw new Error(`${completed.stdout}\n${completed.stderr}`);
				}
				const finalization = JSON.parse(completed.stdout).data
					.plan_approval_finalization;
				expect(finalization).toMatchObject({
					route: "final_corrections",
					final_commit: authorCommit,
					final_blob_hash: blobHash(dir, authorCommit),
					address_additions: [{ workItemId: "W2", findingIds: ["P1.1"] }],
					recorded: true,
				});
				expect(finalization.uncommitted_plan_changes).toBeUndefined();

				// One reviewer invocation; the record pairs with run:complete.
				const sourceSteps = steps(dir, sourceId);
				expect(
					sourceSteps.filter((step) =>
						String(step.step_name).startsWith("reviewer:"),
					),
				).toHaveLength(1);
				const complete = sourceSteps.find(
					(step) => step.step_name === "run:complete",
				);
				expect(complete?.head_commit).toBe(authorCommit);
				const records = budget(dir, sourceId).filter(
					(line) => line.kind === "plan-approval-finalization",
				);
				expect(records).toHaveLength(1);
				expect(records[0]).toMatchObject({
					finalCommit: authorCommit,
					completion: {
						stepName: "run:complete",
						iteration: complete?.iteration,
					},
					admittedFindingIds: ["P1.1"],
				});
				// The original reviewer snapshot is unchanged.
				const snapshot = budget(dir, sourceId).find(
					(line) => line.kind === "snapshot",
				) as { currentLedger: { workItems: Array<{ addresses: string[] }> } };
				expect(snapshot.currentLedger.workItems[1]?.addresses).toEqual([]);

				const execInit = await cli(dir, ["run", "init", "--plan", planPath]);
				if (execInit.exitCode !== 0) throw new Error(execInit.stderr);
				const execId = JSON.parse(execInit.stdout).data.run_id as string;
				const bound = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					execId,
					"--source-run",
					sourceId,
				]);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				const data = JSON.parse(bound.stdout).data;
				expect(data).toMatchObject({
					created: true,
					sourceRunId: sourceId,
					approvedPlanCommit: authorCommit,
					approvedPlanHash: blobHash(dir, authorCommit),
					approvalFinalization: {
						derivation: "recorded",
						finalizationId: records[0]?.id,
						finalCommit: authorCommit,
						addressAdditions: [{ workItemId: "W2", findingIds: ["P1.1"] }],
					},
				});
				const binding = budget(dir, execId).find(
					(line) => line.kind === "implementation-binding",
				) as {
					ledger: { workItems: Array<{ id: string; addresses: string[] }> };
					sourceSnapshotId: string;
				};
				expect(binding.ledger.workItems[1]).toMatchObject({
					id: "W2",
					addresses: ["P1.1"],
				});
				expect(binding.sourceSnapshotId).toBe(
					(snapshot as unknown as { id: string }).id,
				);
				expect(
					steps(dir, execId).filter((step) =>
						String(step.step_name).startsWith("reviewer:"),
					),
				).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60_000 },
	);

	test(
		"a substantive correction leaves the plan run active with a working same-run review remedy",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await reviewWithCorrection(dir, planPath);
				await authorCorrection(
					dir,
					planPath,
					sourceId,
					plan({ w2Addresses: "P1.1", w2Effort: 3 }),
				);
				const refused = await cli(dir, ["run", "complete", "--run", sourceId]);
				expect(refused.exitCode).not.toBe(0);
				const error = JSON.parse(refused.stdout).error;
				expect(error.code).toBe("PLAN_APPROVAL_FINALIZATION_DELTA");
				expect(error.message).toContain("W2 effort changed");
				expect(error.detail.changes).toEqual([
					expect.objectContaining({
						field: "effort",
						workItemId: "W2",
						before: 1,
						after: 3,
					}),
				]);
				expect(error.detail.next[0]).toBe(
					`5x template render reviewer-plan --run ${sourceId}`,
				);
				// Not sealed, no record: the run is still active.
				expect(
					steps(dir, sourceId).some(
						(step) => step.step_name === "run:complete",
					),
				).toBe(false);
				expect(
					budget(dir, sourceId).some(
						(line) => line.kind === "plan-approval-finalization",
					),
				).toBe(false);
				const state = await cli(dir, ["run", "state", "--run", sourceId]);
				expect(JSON.parse(state.stdout).data.run.status).toBe("active");

				// Same-run remedy: review the corrected plan on this run.
				const closure = await cli(
					dir,
					[
						"protocol",
						"validate",
						"reviewer",
						"--run",
						sourceId,
						"--record",
						"--step",
						"reviewer:plan",
						"--phase",
						"plan",
						"--iteration",
						"1",
					],
					{
						readiness: "ready",
						items: [],
						priorFindings: [{ id: "P1.1", status: "addressed" }],
					},
				);
				if (closure.exitCode !== 0) {
					throw new Error(`closure: ${closure.stdout}\n${closure.stderr}`);
				}
				const completed = await cli(dir, [
					"run",
					"complete",
					"--run",
					sourceId,
				]);
				if (completed.exitCode !== 0) {
					throw new Error(`${completed.stdout}\n${completed.stderr}`);
				}
				expect(
					JSON.parse(completed.stdout).data.plan_approval_finalization,
				).toMatchObject({ route: "complete", address_additions: [] });
				const execInit = await cli(dir, ["run", "init", "--plan", planPath]);
				if (execInit.exitCode !== 0) throw new Error(execInit.stderr);
				const execId = JSON.parse(execInit.stdout).data.run_id as string;
				const bound = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					execId,
					"--source-run",
					sourceId,
				]);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60_000 },
	);
});
