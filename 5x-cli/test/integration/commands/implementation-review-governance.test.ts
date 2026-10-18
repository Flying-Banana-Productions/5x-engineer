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

function planMarkdown(checked = false): string {
	const box = checked ? "x" : " ";
	return `# Governance plan

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

- [${box}] Bind execution to the approved plan
`;
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

async function initRepo(): Promise<{ dir: string; planPath: string }> {
	const dir = mkdtempSync(join(tmpdir(), "5x-impl-bind-"));
	git(dir, "init");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	const initialized = await cli(dir, ["init"]);
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
	writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "advisory"\n');
	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "governance.md");
	writeFileSync(planPath, planMarkdown());
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "fixture");
	return { dir, planPath };
}

async function startRun(dir: string, planPath: string): Promise<string> {
	const runInit = await cli(dir, ["run", "init", "--plan", planPath]);
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
		throw new Error(`review: ${review.stdout}\n${review.stderr}`);
	}
	expect(JSON.parse(review.stdout).data.result.governance.route).toBe(
		"complete",
	);
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

async function reopenRun(dir: string, runId: string): Promise<void> {
	const result = await cli(dir, ["run", "reopen", "--run", runId]);
	if (result.exitCode !== 0) {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
}

async function recordAuthor(dir: string, runId: string, iteration = "1") {
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

function bindingPayload(
	dir: string,
	runId: string,
): Record<string, unknown> | null {
	const slug = "governance";
	const path = join(
		dir,
		"docs",
		"development",
		"runs",
		slug,
		runId,
		"budget.jsonl",
	);
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	for (const line of text.split("\n").filter(Boolean)) {
		const parsed = JSON.parse(line) as { payload?: { kind?: string } };
		if (parsed.payload?.kind === "implementation-binding") {
			return parsed.payload as Record<string, unknown>;
		}
	}
	return null;
}

describe("implementation execution binding", () => {
	test(
		"auto-binds a separate execution run and keeps the copied ledger after source removal",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				await completeRun(dir, sourceId);
				const executionId = await startRun(dir, planPath);
				expect(executionId).not.toBe(sourceId);
				const unbound = await recordAuthor(dir, executionId);
				if (unbound.exitCode !== 0) {
					throw new Error(`${unbound.stdout}\n${unbound.stderr}`);
				}
				const binding = bindingPayload(dir, executionId);
				expect(binding).toMatchObject({
					kind: "implementation-binding",
					sourceRunId: sourceId,
					executionRunId: executionId,
					b0: 2,
					governingB: 2,
					mode: "advisory",
				});
				expect(binding?.approvedPlanBytes).toContain("## Delivery Budget");
				rmSync(
					join(dir, "docs", "development", "runs", "governance", sourceId),
					{ recursive: true, force: true },
				);
				const rebuilt = await cli(dir, ["records", "index"]);
				if (rebuilt.exitCode !== 0) {
					throw new Error(`${rebuilt.stdout}\n${rebuilt.stderr}`);
				}
				writeFileSync(planPath, planMarkdown(true));
				const retry = await recordAuthor(dir, executionId, "2");
				if (retry.exitCode !== 0) {
					throw new Error(`${retry.stdout}\n${retry.stderr}`);
				}
				expect(bindingPayload(dir, executionId)?.sourceRunId).toBe(sourceId);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"refuses an unbound budgeted execution and a changed plan",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const executionId = await startRun(dir, planPath);
				const missing = await recordAuthor(dir, executionId);
				expect(missing.exitCode).not.toBe(0);
				expect(`${missing.stdout}\n${missing.stderr}`).toContain(
					"IMPLEMENTATION_APPROVAL_REQUIRED",
				);
				await completeRun(dir, executionId);

				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				await completeRun(dir, sourceId);
				await reopenRun(dir, executionId);
				const bound = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					executionId,
					"--source-run",
					sourceId,
				]);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				expect(JSON.parse(bound.stdout).data).toMatchObject({
					created: true,
					sourceRunId: sourceId,
					executionRunId: executionId,
				});
				const repeat = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					executionId,
					"--source-run",
					sourceId,
				]);
				expect(repeat.exitCode).toBe(0);
				expect(JSON.parse(repeat.stdout).data.created).toBe(false);

				writeFileSync(
					planPath,
					planMarkdown().replace(
						"| W1 | Required behavior | 2 | 0 | - | - | Implements the requested behavior. |",
						"| W1 | Required behavior | 5 | 0 | - | - | Implements the requested behavior. |",
					),
				);
				const drifted = await recordAuthor(dir, executionId);
				expect(drifted.exitCode).not.toBe(0);
				expect(`${drifted.stdout}\n${drifted.stderr}`).toContain(
					"IMPLEMENTATION_PLAN_DRIFT",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"requires explicit selection when several approved sources exist",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const first = await startRun(dir, planPath);
				await approvePlan(dir, first);
				await completeRun(dir, first);
				const second = await startRun(dir, planPath);
				await approvePlan(dir, second);
				await completeRun(dir, second);
				const executionId = await startRun(dir, planPath);
				const admission = await recordAuthor(dir, executionId);
				expect(admission.exitCode).not.toBe(0);
				const text = `${admission.stdout}\n${admission.stderr}`;
				expect(text).toContain("IMPLEMENTATION_APPROVAL_REQUIRED");
				expect(text).toContain(first);
				expect(text).toContain(second);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"keeps the status update inside the finalized plan commit and drifts later notes",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				const reviewed = planMarkdown().replace(
					"# Governance plan\n",
					"# Governance plan\n\n**Status:** Reviewed\n",
				);
				writeFileSync(planPath, reviewed);
				git(dir, "add", planPath);
				git(dir, "commit", "-m", "mark reviewed");
				const finalized = git(dir, "rev-parse", "HEAD");
				await completeRun(dir, sourceId);
				const executionId = await startRun(dir, planPath);
				const bound = await recordAuthor(dir, executionId);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				const binding = bindingPayload(dir, executionId);
				expect(binding?.approvedPlanCommit).toBe(finalized);
				expect(binding?.approvedPlanBytes).toContain("**Status:** Reviewed");

				writeFileSync(
					planPath,
					`${reviewed}\nPhase 0 verification note belongs in the run record.\n`,
				);
				const noted = await recordAuthor(dir, executionId, "2");
				expect(noted.exitCode).not.toBe(0);
				expect(`${noted.stdout}\n${noted.stderr}`).toContain(
					"IMPLEMENTATION_PLAN_DRIFT",
				);

				git(dir, "add", planPath);
				git(dir, "commit", "-m", "phase 0 note");
				const later = git(dir, "rev-parse", "HEAD");
				expect(later).not.toBe(finalized);
				writeFileSync(planPath, reviewed.replace("- [ ]", "- [x]"));
				const restored = await recordAuthor(dir, executionId, "3");
				if (restored.exitCode !== 0) {
					throw new Error(`${restored.stdout}\n${restored.stderr}`);
				}
				expect(bindingPayload(dir, executionId)?.approvedPlanCommit).toBe(
					finalized,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"binds a worktree-mapped plan from canonical identity and worktree bytes",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await startRun(dir, planPath);
				await approvePlan(dir, sourceId);
				const reviewed = planMarkdown().replace(
					"# Governance plan\n",
					"# Governance plan\n\n**Status:** Reviewed\n",
				);
				writeFileSync(planPath, reviewed);
				git(dir, "add", planPath);
				git(dir, "commit", "-m", "mark reviewed");
				await completeRun(dir, sourceId);
				const created = await cli(dir, ["worktree", "create", "-p", planPath]);
				if (created.exitCode !== 0) {
					throw new Error(`${created.stdout}\n${created.stderr}`);
				}
				const worktree = JSON.parse(created.stdout).data
					.worktree_path as string;
				const worktreePlan = join(
					worktree,
					"docs",
					"development",
					"plans",
					"governance.md",
				);
				expect(readFileSync(worktreePlan, "utf8")).toContain(
					"**Status:** Reviewed",
				);

				const executionId = await startRun(dir, planPath);
				const recorded = await recordAuthor(dir, executionId);
				if (recorded.exitCode !== 0) {
					throw new Error(`${recorded.stdout}\n${recorded.stderr}`);
				}
				const binding =
					bindingPayload(worktree, executionId) ??
					bindingPayload(dir, executionId);
				expect(binding?.approvedPlanBytes).toContain("**Status:** Reviewed");

				writeFileSync(
					planPath,
					reviewed.replace(
						"| W1 | Required behavior | 2 | 0 | - | - | Implements the requested behavior. |",
						"| W1 | Required behavior | 9 | 0 | - | - | Implements the requested behavior. |",
					),
				);
				const mainOnly = await recordAuthor(dir, executionId, "2");
				if (mainOnly.exitCode !== 0) {
					throw new Error(`${mainOnly.stdout}\n${mainOnly.stderr}`);
				}
				writeFileSync(planPath, reviewed);

				writeFileSync(worktreePlan, reviewed.replace("- [ ]", "- [x]"));
				const checked = await recordAuthor(dir, executionId, "3");
				if (checked.exitCode !== 0) {
					throw new Error(`${checked.stdout}\n${checked.stderr}`);
				}

				writeFileSync(
					worktreePlan,
					reviewed.replace(
						"| W1 | Required behavior | 2 | 0 | - | - | Implements the requested behavior. |",
						"| W1 | Required behavior | 8 | 0 | - | - | Implements the requested behavior. |",
					),
				);
				const drifted = await recordAuthor(dir, executionId, "4");
				expect(drifted.exitCode).not.toBe(0);
				expect(`${drifted.stdout}\n${drifted.stderr}`).toContain(
					"IMPLEMENTATION_PLAN_DRIFT",
				);
				writeFileSync(worktreePlan, reviewed);
				writeFileSync(
					join(dir, "5x.toml"),
					'[reviewBudget]\nmode = "advisory"\n\n[author]\nprovider = "not-a-real-provider"\n',
				);
				git(dir, "add", "5x.toml");
				git(dir, "commit", "-m", "test provider");
				await completeRun(dir, executionId);

				const renderRun = await startRun(dir, planPath);
				const rendered = await cli(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					renderRun,
					"--var",
					`plan_path=${worktreePlan}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=bind",
				]);
				if (rendered.exitCode !== 0) {
					throw new Error(`${rendered.stdout}\n${rendered.stderr}`);
				}
				expect(JSON.parse(rendered.stdout).data.template).toBe(
					"author-next-phase",
				);
				expect(
					(
						bindingPayload(worktree, renderRun) ??
						bindingPayload(dir, renderRun)
					)?.sourceRunId,
				).toBe(sourceId);
				await completeRun(dir, renderRun);

				const invokeRun = await startRun(dir, planPath);
				const invoked = await cli(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					invokeRun,
					"--var",
					`plan_path=${worktreePlan}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=bind",
				]);
				expect(invoked.exitCode).not.toBe(0);
				expect(`${invoked.stdout}\n${invoked.stderr}`).toContain(
					"PROVIDER_NOT_FOUND",
				);
				expect(
					(
						bindingPayload(worktree, invokeRun) ??
						bindingPayload(dir, invokeRun)
					)?.sourceRunId,
				).toBe(sourceId);
				await completeRun(dir, invokeRun);

				const explicitRun = await startRun(dir, planPath);
				const bound = await cli(dir, [
					"review",
					"implementation",
					"bind",
					"--run",
					explicitRun,
					"--source-run",
					sourceId,
				]);
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				expect(JSON.parse(bound.stdout).data).toMatchObject({
					created: true,
					sourceRunId: sourceId,
					executionRunId: explicitRun,
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60000 },
	);

	test(
		"render and invoke gate implementation author templates before delegation",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const executionId = await startRun(dir, planPath);
				const rendered = await cli(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					executionId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
				]);
				expect(rendered.exitCode).not.toBe(0);
				expect(`${rendered.stdout}\n${rendered.stderr}`).toContain(
					"IMPLEMENTATION_APPROVAL_REQUIRED",
				);
				const continued = await cli(dir, [
					"template",
					"render",
					"author-next-phase-continued",
					"--run",
					executionId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
				]);
				expect(`${continued.stdout}\n${continued.stderr}`).toContain(
					"IMPLEMENTATION_APPROVAL_REQUIRED",
				);
				const implReview = await cli(dir, [
					"template",
					"render",
					"author-process-impl-review",
					"--run",
					executionId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"review_path=/tmp/review.md",
				]);
				expect(`${implReview.stdout}\n${implReview.stderr}`).toContain(
					"IMPLEMENTATION_APPROVAL_REQUIRED",
				);
				const planAuthor = await cli(dir, [
					"template",
					"render",
					"author-generate-plan",
					"--run",
					executionId,
					"--var",
					"prd_path=/tmp/prd.md",
					"--var",
					`plan_path=${planPath}`,
				]);
				expect(`${planAuthor.stdout}\n${planAuthor.stderr}`).not.toContain(
					"IMPLEMENTATION_APPROVAL_REQUIRED",
				);
				expect(bindingPayload(dir, executionId)).toBeNull();

				const invoked = await cli(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--run",
					executionId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=gate",
				]);
				expect(invoked.exitCode).not.toBe(0);
				expect(`${invoked.stdout}\n${invoked.stderr}`).toContain(
					"IMPLEMENTATION_APPROVAL_REQUIRED",
				);
				expect(`${invoked.stdout}\n${invoked.stderr}`).not.toContain(
					"PROVIDER_NOT_FOUND",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);
});
