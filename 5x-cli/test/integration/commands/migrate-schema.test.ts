import { describe, expect, test } from "bun:test";
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
const STATUS = "**Status:** Draft";

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
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

function planMarkdown(): string {
	return `# Governance plan

${STATUS}

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Required behavior | 2 | 0 | - | - | Implements the requested behavior. |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Bind

**Completion gate:** The execution run is bound to the approved plan.

- [ ] Bind execution to the approved plan
`;
}

function selectivePlan(raw: string, status = "**Status:** Revised"): string {
	const interior = raw.replace(`${STATUS}\n`, "");
	return `<!-- 5x:plan-schema:1 -->\n${status}\n<!-- 5x:contract:start -->\n${interior}<!-- 5x:contract:end -->\n`;
}

const READY = {
	readiness: "ready",
	items: [],
	baselineAssessment: {
		independentEffortEstimate: 2,
		confidence: "high",
		reason: "The original scope is two points.",
	},
};

function parseEnvelope(result: { stdout: string; stderr: string }): {
	ok: boolean;
	data?: Record<string, unknown>;
	error?: { code: string; message: string };
} {
	const line =
		result.stdout
			.split("\n")
			.filter((entry) => entry.startsWith("{"))
			.at(-1) ?? "";
	try {
		return JSON.parse(line) as {
			ok: boolean;
			data?: Record<string, unknown>;
			error?: { code: string; message: string };
		};
	} catch {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
}

function runDir(dir: string, runId: string): string {
	return join(dir, "docs", "development", "runs", "governance", runId);
}

function payloads(dir: string, runId: string, stream: "budget" | "steps") {
	const path = join(runDir(dir, runId), `${stream}.jsonl`);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { payload?: Record<string, unknown> });
}

function migrations(dir: string, runId: string) {
	return payloads(dir, runId, "budget").filter(
		(line) => line.payload?.kind === "plan-schema-migration",
	);
}

function binding(dir: string, runId: string): Record<string, unknown> | null {
	const found = payloads(dir, runId, "budget").find(
		(line) => line.payload?.kind === "implementation-binding",
	);
	return found?.payload ?? null;
}

async function initRepo(): Promise<{ dir: string; planPath: string }> {
	const dir = mkdtempSync(join(tmpdir(), "5x-migrate-schema-"));
	git(dir, "init");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	const initialized = await cli(dir, ["init"]);
	if (initialized.exitCode !== 0) {
		throw new Error(`${initialized.stdout}\n${initialized.stderr}`);
	}
	writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "advisory"\n');
	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "governance.md");
	writeFileSync(planPath, planMarkdown());
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "fixture");
	return { dir, planPath };
}

async function startRun(
	dir: string,
	planPath: string,
	allowDirty = false,
): Promise<string> {
	const args = ["run", "init", "--plan", planPath];
	if (allowDirty) args.push("--allow-dirty");
	const runInit = await cli(dir, args);
	if (runInit.exitCode !== 0) {
		throw new Error(`${runInit.stdout}\n${runInit.stderr}`);
	}
	return JSON.parse(runInit.stdout).data.run_id as string;
}

async function approvePlan(dir: string, runId: string): Promise<void> {
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
		READY,
	);
	if (review.exitCode !== 0) {
		throw new Error(`${review.stdout}\n${review.stderr}`);
	}
}

async function completeRun(dir: string, runId: string): Promise<void> {
	const result = await cli(dir, [
		"run",
		"complete",
		"--run",
		runId,
		"--status",
		"completed",
	]);
	if (result.exitCode !== 0) {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
}

async function recordAuthor(dir: string, runId: string, iteration: string) {
	return cli(
		dir,
		[
			"protocol",
			"validate",
			"author",
			"--run",
			runId,
			"--record",
			"--step",
			"author:implement",
			"--phase",
			"1",
			"--iteration",
			iteration,
			"--no-phase-checklist-validate",
		],
		{ result: "complete", commit: "abc123def" },
	);
}

function commitPlan(dir: string, planPath: string, message: string): string {
	git(dir, "add", "--", planPath);
	git(dir, "commit", "-m", message);
	return git(dir, "rev-parse", "HEAD");
}

describe("5x review migrate-schema", () => {
	test("help has no snapshot flag", async () => {
		const { dir } = await initRepo();
		try {
			const help = await cli(dir, ["review", "migrate-schema", "--help"]);
			expect(help.exitCode).toBe(0);
			expect(help.stdout).toContain("--confirm-exclusions");
			expect(help.stdout).not.toContain("--snapshot");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(
		"recovers a changed status on a drift-blocked run and replays that migration",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const approved = planMarkdown();
				const approvalCommit = git(dir, "rev-parse", "HEAD");
				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				await completeRun(dir, sourceId);
				const executionId = await startRun(dir, planPath);
				const bound = await recordAuthor(dir, executionId, "1");
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				const beforeBinding = binding(dir, executionId);
				expect(beforeBinding?.planSchema).toBeUndefined();
				writeFileSync(
					planPath,
					approved.replace(STATUS, "**Status:** Revised"),
				);
				const drifted = await recordAuthor(dir, executionId, "2");
				expect(drifted.exitCode).not.toBe(0);
				expect(drifted.stderr).toContain("[IMPLEMENTATION_PLAN_DRIFT]");
				expect(drifted.stderr).toContain("ignoring checkbox state");
				expect(drifted.stderr).not.toContain("PLAN_SCHEMA_INVALID");
				const target = selectivePlan(approved);
				writeFileSync(planPath, target);
				const migratedCommit = commitPlan(dir, planPath, "schema 1");
				const dry = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					executionId,
					"--commit",
					migratedCommit,
					"--mode",
					"selective",
					"--dry-run",
				]);
				const preview = parseEnvelope(dry);
				expect(dry.exitCode).toBe(0);
				expect(preview.data?.created).toBe(false);
				expect(preview.data?.completionAuthorized).toBe(false);
				expect(preview.data?.authority).toBeUndefined();
				const exclusions = preview.data?.exclusions as Array<{
					id: string;
					approvedText: string;
				}>;
				expect(exclusions.map((entry) => entry.approvedText)).toEqual([STATUS]);
				const outside = preview.data?.nonGoverningText as Array<{
					text: string;
				}>;
				expect(outside.map((entry) => entry.text)).toContain(
					"**Status:** Revised",
				);
				const digest = String(preview.data?.proposalDigest);
				expect(migrations(dir, executionId)).toHaveLength(0);
				const stale = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					executionId,
					"--commit",
					migratedCommit,
					"--mode",
					"selective",
					"--confirm-exclusions",
					"sha256:stale",
				]);
				const staleError = parseEnvelope(stale);
				expect(stale.exitCode).not.toBe(0);
				expect(staleError.error?.code).toBe("PLAN_MIGRATION_STALE");
				expect(migrations(dir, executionId)).toHaveLength(0);
				const recorded = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					executionId,
					"--commit",
					migratedCommit,
					"--mode",
					"selective",
					"--confirm-exclusions",
					digest,
				]);
				const saved = parseEnvelope(recorded);
				expect(recorded.exitCode).toBe(0);
				expect(saved.data?.created).toBe(true);
				expect(saved.data?.authority).toBe("operator");
				expect(saved.data?.completionAuthorized).toBe(false);
				const receipt = saved.data?.migration as Record<string, unknown>;
				expect(receipt.authorizedPlanBytes).toBeUndefined();
				expect(receipt.afterCommit).toBe(migratedCommit);
				const admitted = await recordAuthor(dir, executionId, "2");
				if (admitted.exitCode !== 0) {
					throw new Error(`${admitted.stdout}\n${admitted.stderr}`);
				}
				const retry = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					executionId,
					"--commit",
					migratedCommit,
					"--mode",
					"selective",
					"--confirm-exclusions",
					digest,
				]);
				const winner = parseEnvelope(retry);
				expect(retry.exitCode).toBe(0);
				expect(winner.data?.created).toBe(false);
				expect(
					(winner.data?.migration as { id?: string } | undefined)?.id,
				).toBe((receipt as { id?: string }).id);
				writeFileSync(
					planPath,
					target.replace("**Status:** Revised", "**Status:** Later"),
				);
				const secondCommit = commitPlan(dir, planPath, "distinct");
				const distinct = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					executionId,
					"--commit",
					secondCommit,
					"--mode",
					"selective",
					"--confirm-exclusions",
					digest,
				]);
				const conflict = parseEnvelope(distinct);
				expect(distinct.exitCode).not.toBe(0);
				expect(conflict.error?.code).toBe("PLAN_MIGRATION_CONFLICT");
				expect(migrations(dir, executionId)).toHaveLength(1);
				const stored = migrations(dir, executionId)[0]?.payload ?? {};
				expect(stored.authority).toBe("operator");
				expect(stored.snapshotId).toBeUndefined();
				expect(stored.authorizedPlanBytes).toBe(target);
				expect(stored.priorApprovalCommit).toBe(approvalCommit);
				const afterBinding = binding(dir, executionId);
				expect(afterBinding?.planSchema).toBeUndefined();
				expect(afterBinding?.approvedPlanCommit).toBe(
					beforeBinding?.approvedPlanCommit,
				);
				expect(afterBinding?.sourceSnapshotId).toBe(
					beforeBinding?.sourceSnapshotId,
				);
				expect(afterBinding?.sourceBaselineId).toBe(
					beforeBinding?.sourceBaselineId,
				);
				const ledger = afterBinding?.ledger as {
					workItems?: Array<{ id: string; effort: number }>;
				};
				expect(ledger.workItems?.map((item) => item.id)).toEqual(["W1"]);
				expect(ledger.workItems?.[0]?.effort).toBe(2);
				const stepNames = payloads(dir, executionId, "steps").map(
					(line) => line.payload?.step_name,
				);
				expect(
					stepNames.filter((name) => name === "author:implement"),
				).toHaveLength(2);
				expect(
					stepNames.filter((name) => name === "schema-migration"),
				).toHaveLength(1);
				writeFileSync(planPath, approved);
				const missing = await recordAuthor(dir, executionId, "3");
				expect(missing.exitCode).not.toBe(0);
				expect(missing.stderr).toContain("PLAN_SCHEMA_INVALID");
				expect(missing.stderr).toContain("not a legacy fallback");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60_000 },
	);

	test(
		"copies one approved-source migration onto the next execution binding",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const approvalCommit = git(dir, "rev-parse", "HEAD");
				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				await completeRun(dir, sourceId);
				const target = selectivePlan(planMarkdown());
				writeFileSync(planPath, target);
				const migratedCommit = commitPlan(dir, planPath, "schema 1");
				const dry = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					sourceId,
					"--commit",
					migratedCommit,
					"--mode",
					"selective",
					"--dry-run",
				]);
				const preview = parseEnvelope(dry);
				expect(dry.exitCode).toBe(0);
				const digest = String(preview.data?.proposalDigest);
				const short = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					sourceId,
					"--commit",
					migratedCommit.slice(0, 7),
					"--mode",
					"selective",
					"--confirm-exclusions",
					digest,
				]);
				expect(parseEnvelope(short).error?.code).toBe("INVALID_ARGS");
				const recorded = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					sourceId,
					"--commit",
					migratedCommit,
					"--mode",
					"selective",
					"--confirm-exclusions",
					digest,
				]);
				const saved = parseEnvelope(recorded);
				expect(recorded.exitCode).toBe(0);
				expect(saved.data?.authority).toBe("operator");
				const executionId = await startRun(dir, planPath, true);
				const author = await recordAuthor(dir, executionId, "1");
				if (author.exitCode !== 0) {
					throw new Error(`${author.stdout}\n${author.stderr}`);
				}
				const copied = binding(dir, executionId);
				expect(copied?.planSchema).toBe(1);
				expect(copied?.approvedPlanCommit).toBe(migratedCommit);
				expect(copied?.predecessorPlanCommit).toBe(approvalCommit);
				expect(copied?.schemaMigrationId).toBe(
					(saved.data?.migration as { id?: string } | undefined)?.id,
				);
				expect(typeof copied?.sourceSnapshotId).toBe("string");
				expect(typeof copied?.sourceBaselineId).toBe("string");
				const second = await cli(dir, [
					"review",
					"migrate-schema",
					"--run",
					executionId,
					"--commit",
					migratedCommit,
					"--mode",
					"selective",
					"--confirm-exclusions",
					digest,
				]);
				expect(parseEnvelope(second).error?.code).toBe(
					"PLAN_MIGRATION_CONFLICT",
				);
				expect(migrations(dir, executionId)).toHaveLength(0);
				expect(migrations(dir, sourceId)).toHaveLength(1);
				writeFileSync(planPath, planMarkdown());
				const missing = await recordAuthor(dir, executionId, "2");
				expect(missing.exitCode).not.toBe(0);
				expect(missing.stderr).toContain("PLAN_SCHEMA_INVALID");
				expect(missing.stderr).toContain("not a legacy fallback");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60_000 },
	);

	test(
		"migrates a completed approval end to end through supported commands",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				await completeRun(dir, sourceId);
				const approvalHead = git(dir, "rev-parse", "HEAD");
				const migrate = (...extra: string[]) =>
					cli(dir, [
						"review",
						"migrate-schema",
						"--run",
						sourceId,
						"--mode",
						"equivalent",
						...extra,
					]);

				// plan migrate refuses the approved plan and names the prepare path.
				const refused = await cli(dir, [
					"plan",
					"migrate",
					"--plan",
					planPath,
					"--mode",
					"equivalent",
					"--write",
				]);
				const refusal = parseEnvelope(refused);
				expect(refusal.error?.code).toBe("PLAN_MIGRATION_CONFLICT");
				expect(refusal.error?.message).toContain(
					`migrate-schema --run ${sourceId}`,
				);
				expect(refusal.error?.message).toContain("--prepare");

				// The preview discloses the equivalent-mode consequence and writes nothing.
				const preview = parseEnvelope(await migrate("--prepare", "--dry-run"));
				expect(preview.ok).toBe(true);
				expect(preview.data?.commit).toBeNull();
				expect(preview.data?.governingBookkeeping).toEqual([
					expect.objectContaining({ text: STATUS }),
				]);
				expect(String(preview.data?.notice)).toContain(
					"cannot be revised later",
				);
				expect(readFileSync(planPath, "utf8")).toBe(planMarkdown());
				expect(git(dir, "rev-parse", "HEAD")).toBe(approvalHead);

				// Prepare writes the wrap and commits only the plan file.
				const prepared = parseEnvelope(await migrate("--prepare"));
				expect(prepared.ok).toBe(true);
				expect(prepared.data?.committed).toBe(true);
				const commit = String(prepared.data?.commit);
				expect(git(dir, "rev-parse", "HEAD")).toBe(commit);
				expect(
					git(dir, "diff-tree", "--no-commit-id", "--name-only", "-r", commit),
				).toBe("docs/development/plans/governance.md");
				expect(readFileSync(planPath, "utf8")).toContain(
					"<!-- 5x:contract:start -->",
				);
				expect(prepared.data?.proposalDigest).toBe(
					preview.data?.proposalDigest,
				);
				expect(migrations(dir, sourceId)).toHaveLength(0);
				const preparedAgain = parseEnvelope(await migrate("--prepare"));
				expect(preparedAgain.data?.committed).toBe(false);
				expect(preparedAgain.data?.commit).toBe(commit);

				// Dry-run, then record with the prepared commit.
				const dry = parseEnvelope(
					await migrate("--commit", commit, "--dry-run"),
				);
				expect(dry.data?.created).toBe(false);
				expect(dry.data?.proposalDigest).toBe(prepared.data?.proposalDigest);
				const recorded = parseEnvelope(await migrate("--commit", commit));
				expect(recorded.ok).toBe(true);
				expect(recorded.data?.created).toBe(true);
				expect(recorded.data?.authority).toBe("verified_equivalent");
				expect(recorded.data?.completionAuthorized).toBe(false);
				const checkpoint = recorded.data?.checkpoint as {
					committed: boolean;
					commit: string;
					path: string;
				};
				expect(checkpoint.committed).toBe(true);
				expect(git(dir, "rev-parse", "HEAD")).toBe(checkpoint.commit);
				expect(checkpoint.path).toBe(
					`docs/development/runs/governance/${sourceId}`,
				);

				// An identical retry returns the stored record and has nothing to checkpoint.
				const retry = parseEnvelope(await migrate("--commit", commit));
				expect(retry.data?.created).toBe(false);
				expect(retry.data?.checkpoint).toMatchObject({ committed: false });
				expect(migrations(dir, sourceId)).toHaveLength(1);
				expect(git(dir, "rev-parse", "HEAD")).toBe(checkpoint.commit);

				// The run stays completed and the worktree is clean.
				const state = parseEnvelope(
					await cli(dir, ["run", "state", "--run", sourceId]),
				);
				expect(
					(state.data?.run as { status?: string } | undefined)?.status,
				).toBe("completed");
				expect(git(dir, "status", "--porcelain")).toBe("");

				// A clean execution run binds the migrated approval.
				const executionId = await startRun(dir, planPath);
				const author = await recordAuthor(dir, executionId, "1");
				if (author.exitCode !== 0) {
					throw new Error(`${author.stdout}\n${author.stderr}`);
				}
				expect(binding(dir, executionId)?.planSchema).toBe(1);
				expect(binding(dir, executionId)?.approvedPlanCommit).toBe(commit);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 90_000 },
	);

	test(
		"a schema 0 run that never migrates still drifts on a status edit",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				await completeRun(dir, sourceId);
				const executionId = await startRun(dir, planPath);
				const bound = await recordAuthor(dir, executionId, "1");
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				writeFileSync(
					planPath,
					planMarkdown().replace(STATUS, "**Status:** Revised"),
				);
				const drifted = await recordAuthor(dir, executionId, "2");
				expect(drifted.exitCode).not.toBe(0);
				expect(drifted.stderr).toContain("[IMPLEMENTATION_PLAN_DRIFT]");
				expect(drifted.stderr).toContain("ignoring checkbox state");
				expect(drifted.stderr).not.toContain("PLAN_SCHEMA_INVALID");
				expect(migrations(dir, executionId)).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60_000 },
	);
});
