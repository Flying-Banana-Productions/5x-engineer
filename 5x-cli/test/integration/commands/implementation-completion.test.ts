import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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

async function initRepo(
	mode: "enforced" | "off" | "advisory",
	options?: { plan?: string; qualityGate?: string },
) {
	const dir = mkdtempSync(join(tmpdir(), "5x-impl-complete-"));
	git(dir, "init");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	const initialized = await cli(dir, ["init"]);
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
	const gates = options?.qualityGate
		? `qualityGates = ["${options.qualityGate}"]\n`
		: "";
	writeFileSync(
		join(dir, "5x.toml"),
		`${gates}[reviewBudget]\nmode = "${mode}"\n`,
	);
	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "governance.md");
	writeFileSync(planPath, options?.plan ?? planMarkdown());
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

function debtPlan(input: {
	effort: number;
	architecture: number;
	targetPhase: string;
	secondPhase: boolean;
}): string {
	const phase2 = input.secondPhase
		? `
## Phase 2: Follow

**Completion gate:** The last phase accounts for the approved claim.

- [ ] Account for the claim
`
		: "";
	return `# Governance plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Required behavior | ${input.effort} | ${input.architecture} | DC0 (\`intrinsic\`) | - | Removes a duplicate writer. |

### Debt Claims

#### DC0

- Target phase: ${input.targetPhase}
- Minimal-compliant effort delta: 0
- Minimal-compliant architecture delta: 0
- Before: two separate writers updated the same counter
- After: one writer owns the counter

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Bind

**Completion gate:** The execution run is bound to the approved plan.

- [ ] Bind execution to the approved plan
${phase2}`;
}

function twoPhasePlan(): string {
	return `${planMarkdown()}\n## Phase 2: Follow\n\n**Completion gate:** Later.\n\n- [ ] Follow\n`;
}

async function approveSource(
	dir: string,
	planPath: string,
	effort: number,
	claimId?: string,
): Promise<string> {
	const sourceId = await startRun(dir, planPath);
	const verdict: Record<string, unknown> = {
		readiness: "ready",
		items: [],
		baselineAssessment: {
			independentEffortEstimate: effort,
			confidence: "high",
			reason: "The independent estimate matches the approved effort.",
		},
	};
	if (claimId) {
		verdict.creditAssessments = [
			{
				creditClaimId: claimId,
				eligibility: "eligible",
				coupling: "intrinsic",
				reason: "The simpler post-state is intrinsic to the claimed phase.",
			},
		];
	}
	const review = await cli(
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
			"0",
		],
		verdict,
	);
	if (review.exitCode !== 0) {
		throw new Error(`${review.stdout}\n${review.stderr}`);
	}
	const done = await cli(dir, [
		"run",
		"complete",
		"--run",
		sourceId,
		"--status",
		"completed",
	]);
	if (done.exitCode !== 0) {
		throw new Error(`${done.stdout}\n${done.stderr}`);
	}
	return sourceId;
}

async function commitFile(
	dir: string,
	runId: string,
	phase: string,
	relativePath: string,
	body: string,
	message: string,
): Promise<string> {
	const file = join(dir, relativePath);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, body);
	const committed = await cli(dir, [
		"commit",
		"--run",
		runId,
		"--phase",
		phase,
		"--message",
		message,
		"--all-files",
	]);
	if (committed.exitCode !== 0) {
		throw new Error(`${committed.stdout}\n${committed.stderr}`);
	}
	return git(dir, "rev-parse", "HEAD");
}

async function recordAuthor(
	dir: string,
	runId: string,
	phase: string,
	commit: string,
	iteration: string,
) {
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
			phase,
			"--iteration",
			iteration,
			"--no-phase-checklist-validate",
		],
		{ result: "complete", commit },
	);
}

async function renderReview(
	dir: string,
	runId: string,
	planPath: string,
	phase: string,
	commit: string,
) {
	return cli(dir, [
		"template",
		"render",
		"reviewer-commit",
		"--run",
		runId,
		"--var",
		`phase_number=${phase}`,
		"--var",
		`commit_hash=${commit}`,
		"--var",
		`plan_path=${planPath}`,
	]);
}

function reviewContextId(stdout: string): string {
	return JSON.parse(stdout).data.review_context_id as string;
}

function governanceOf(stdout: string): {
	route?: string;
	completionAuthorized?: boolean;
	observationId?: string;
} {
	const result = JSON.parse(stdout).data?.result as
		| { governance?: Record<string, unknown> }
		| undefined;
	const governance = result?.governance;
	return {
		route: typeof governance?.route === "string" ? governance.route : undefined,
		completionAuthorized:
			typeof governance?.completionAuthorized === "boolean"
				? governance.completionAuthorized
				: undefined,
		observationId:
			typeof governance?.observationId === "string"
				? governance.observationId
				: undefined,
	};
}

function preAuthorSteps(dir: string, runId: string): unknown[] {
	const path = join(
		dir,
		"docs",
		"development",
		"runs",
		"governance",
		runId,
		"steps.jsonl",
	);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { payload?: { step_name?: string } })
		.filter((line) => line.payload?.step_name === "implementation:pre-author");
}

describe("implementation completion boundaries", () => {
	test(
		"raw phase completion and sealing cannot skip binding or review",
		async () => {
			const { dir, planPath } = await initRepo("enforced");
			let executionId = await startRun(dir, planPath);
			const premature = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(premature.exitCode).not.toBe(0);
			expect(premature.stderr + premature.stdout).toContain(
				"IMPLEMENTATION_APPROVAL_REQUIRED",
			);
			const stop = await cli(dir, [
				"run",
				"complete",
				"--run",
				executionId,
				"--status",
				"aborted",
				"--reason",
				"no approved source",
			]);
			expect(stop.exitCode, `${stop.stdout}\n${stop.stderr}`).toBe(0);

			const sourceId = await startRun(dir, planPath);
			const review = await cli(
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
					"0",
				],
				{
					readiness: "ready",
					items: [],
					baselineAssessment: {
						independentEffortEstimate: 2,
						confidence: "high",
						reason: "The original scope is two points.",
					},
				},
			);
			expect(review.exitCode).toBe(0);
			const sourceDone = await cli(dir, [
				"run",
				"complete",
				"--run",
				sourceId,
				"--status",
				"completed",
			]);
			expect(
				sourceDone.exitCode,
				`${sourceDone.stdout}\n${sourceDone.stderr}`,
			).toBe(0);
			executionId = await startRun(dir, planPath);
			expect(executionId).not.toBe(sourceId);
			writeFileSync(planPath, planMarkdown(true));

			const checked = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1", checklist: "done" }),
			]);
			expect(checked.exitCode).not.toBe(0);
			expect(checked.stderr + checked.stdout).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);

			const skipped = await cli(
				dir,
				[
					"protocol",
					"validate",
					"author",
					"--run",
					executionId,
					"--record",
					"--step",
					"phase:complete",
					"--phase",
					"1",
					"--no-phase-checklist-validate",
				],
				{ result: "complete", commit: "a".repeat(40), phase: "1" },
			);
			expect(skipped.exitCode).not.toBe(0);
			expect(skipped.stderr + skipped.stdout).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);

			const seal = await cli(dir, [
				"run",
				"complete",
				"--run",
				executionId,
				"--status",
				"completed",
			]);
			expect(seal.stderr + seal.stdout).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);

			const aborted = await cli(dir, [
				"run",
				"complete",
				"--run",
				executionId,
				"--status",
				"aborted",
				"--reason",
				"unfinished review",
			]);
			expect(aborted.exitCode, `${aborted.stdout}\n${aborted.stderr}`).toBe(0);
			const reopened = await cli(dir, ["run", "reopen", "--run", executionId]);
			expect(reopened.exitCode).toBe(0);
			const reseal = await cli(dir, [
				"run",
				"complete",
				"--run",
				executionId,
				"--status",
				"completed",
			]);
			expect(reseal.exitCode).not.toBe(0);
		},
		{ timeout: 30000 },
	);

	test(
		"a mode-off plan seals without an implementation binding",
		async () => {
			const { dir, planPath } = await initRepo("off");
			const runId = await startRun(dir, planPath);
			const done = await cli(dir, [
				"run",
				"complete",
				"--run",
				runId,
				"--status",
				"completed",
			]);
			expect(done.exitCode).toBe(0);
		},
		{ timeout: 30000 },
	);

	test(
		"a review commit after the reviewed code still allows phase completion",
		async () => {
			const { dir, planPath } = await initRepo("enforced");
			const sourceId = await startRun(dir, planPath);
			const review = await cli(
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
					"0",
				],
				{
					readiness: "ready",
					items: [],
					baselineAssessment: {
						independentEffortEstimate: 2,
						confidence: "high",
						reason: "The original scope is two points.",
					},
				},
			);
			expect(review.exitCode, review.stderr).toBe(0);
			expect(
				(
					await cli(dir, [
						"run",
						"complete",
						"--run",
						sourceId,
						"--status",
						"completed",
					])
				).exitCode,
			).toBe(0);
			const executionId = await startRun(dir, planPath);
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
			const committed = await cli(dir, [
				"commit",
				"--run",
				executionId,
				"--phase",
				"1",
				"--message",
				"implement",
				"--all-files",
			]);
			expect(committed.exitCode, committed.stderr).toBe(0);
			const end = git(dir, "rev-parse", "HEAD");
			const author = await cli(
				dir,
				[
					"protocol",
					"validate",
					"author",
					"--run",
					executionId,
					"--record",
					"--step",
					"author:implement",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--no-phase-checklist-validate",
				],
				{ result: "complete", commit: end },
			);
			expect(author.exitCode, `${author.stdout}\n${author.stderr}`).toBe(0);
			const rendered = await cli(dir, [
				"template",
				"render",
				"reviewer-commit",
				"--run",
				executionId,
				"--var",
				"phase_number=1",
				"--var",
				`commit_hash=${end}`,
				"--var",
				`plan_path=${planPath}`,
			]);
			expect(rendered.exitCode, `${rendered.stdout}\n${rendered.stderr}`).toBe(
				0,
			);
			const contextId = JSON.parse(rendered.stdout).data
				.review_context_id as string;
			const verdict = await cli(
				dir,
				[
					"protocol",
					"validate",
					"reviewer",
					"--run",
					executionId,
					"--record",
					"--step",
					"reviewer:review",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--review-context",
					contextId,
				],
				{
					readiness: "ready",
					items: [],
					nonblocking: [
						{
							id: "n1",
							title: "Note",
							reason: "No code change is required.",
							scopeClass: "pre_existing",
						},
					],
				},
			);
			expect(verdict.exitCode, `${verdict.stdout}\n${verdict.stderr}`).toBe(0);
			mkdirSync(join(dir, "docs", "development", "reviews"), {
				recursive: true,
			});
			writeFileSync(
				join(dir, "docs", "development", "reviews", "phase-1.md"),
				"approved\n",
			);
			const reviewCommit = await cli(dir, [
				"commit",
				"--run",
				executionId,
				"--phase",
				"1",
				"--message",
				"record review",
				"--all-files",
			]);
			expect(reviewCommit.exitCode, reviewCommit.stderr).toBe(0);
			expect(git(dir, "rev-parse", "HEAD")).not.toBe(end);
			const completed = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(
				completed.exitCode,
				`${completed.stdout}\n${completed.stderr}`,
			).toBe(0);
			writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
			const later = await cli(dir, [
				"commit",
				"--run",
				executionId,
				"--phase",
				"1",
				"--message",
				"after review",
				"--all-files",
			]);
			expect(later.exitCode, later.stderr).toBe(0);
			const seal = await cli(dir, [
				"run",
				"complete",
				"--run",
				executionId,
				"--status",
				"completed",
			]);
			expect(seal.exitCode).not.toBe(0);
			expect(seal.stderr + seal.stdout).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);
		},
		{ timeout: 30000 },
	);

	test(
		"next-phase author rendering is blocked while an earlier phase is open",
		async () => {
			const { dir, planPath } = await initRepo("enforced");
			writeFileSync(
				planPath,
				`${planMarkdown()}\n## Phase 2: Follow\n\n**Completion gate:** Later.\n\n- [ ] Follow\n`,
			);
			git(dir, "add", "-A");
			git(dir, "commit", "-m", "add phase 2");
			const sourceId = await startRun(dir, planPath);
			const review = await cli(
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
					"0",
				],
				{
					readiness: "ready",
					items: [],
					baselineAssessment: {
						independentEffortEstimate: 2,
						confidence: "high",
						reason: "The original scope is two points.",
					},
				},
			);
			expect(review.exitCode, review.stderr).toBe(0);
			expect(
				(
					await cli(dir, [
						"run",
						"complete",
						"--run",
						sourceId,
						"--status",
						"completed",
					])
				).exitCode,
			).toBe(0);
			const executionId = await startRun(dir, planPath);
			const first = await cli(dir, [
				"template",
				"render",
				"author-next-phase",
				"--run",
				executionId,
				"--var",
				`plan_path=${planPath}`,
				"--var",
				"phase_number=1",
				"--var",
				"user_notes=bind",
			]);
			expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
			const next = await cli(dir, [
				"template",
				"render",
				"author-next-phase",
				"--run",
				executionId,
				"--var",
				`plan_path=${planPath}`,
				"--var",
				"phase_number=2",
				"--var",
				"user_notes=blocked",
			]);
			expect(next.exitCode).not.toBe(0);
			expect(next.stderr + next.stdout).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);
		},
		{ timeout: 30000 },
	);

	test(
		"multiple approved sources block completion until one source is selected",
		async () => {
			const { dir, planPath } = await initRepo("enforced");
			const first = await approveSource(dir, planPath, 2);
			const second = await approveSource(dir, planPath, 2);
			const executionId = await startRun(dir, planPath);
			const premature = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			const prematureText = `${premature.stdout}\n${premature.stderr}`;
			expect(premature.exitCode).not.toBe(0);
			expect(prematureText).toContain("IMPLEMENTATION_APPROVAL_REQUIRED");
			expect(prematureText).toContain(first);
			expect(prematureText).toContain(second);
			const author = await recordAuthor(
				dir,
				executionId,
				"1",
				git(dir, "rev-parse", "HEAD"),
				"1",
			);
			const authorText = `${author.stdout}\n${author.stderr}`;
			expect(author.exitCode).not.toBe(0);
			expect(authorText).toContain("IMPLEMENTATION_APPROVAL_REQUIRED");
			expect(authorText).toContain(first);
			expect(authorText).toContain(second);
			const bound = await cli(dir, [
				"review",
				"implementation",
				"bind",
				"--run",
				executionId,
				"--source-run",
				first,
			]);
			expect(bound.exitCode, `${bound.stdout}\n${bound.stderr}`).toBe(0);
			const stillOpen = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(stillOpen.exitCode).not.toBe(0);
			expect(`${stillOpen.stdout}\n${stillOpen.stderr}`).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);
		},
		{ timeout: 60000 },
	);

	test(
		"a direct author record keeps the legacy commit parent and still blocks the next phase",
		async () => {
			const { dir, planPath } = await initRepo("enforced", {
				plan: twoPhasePlan(),
			});
			await approveSource(dir, planPath, 2);
			const executionId = await startRun(dir, planPath);
			const end = await commitFile(
				dir,
				executionId,
				"1",
				"src/a.ts",
				"export const a = 1;\n",
				"implement",
			);
			const parent = git(dir, "rev-parse", `${end}^`);
			const author = await recordAuthor(dir, executionId, "1", end, "1");
			expect(author.exitCode, `${author.stdout}\n${author.stderr}`).toBe(0);
			expect(preAuthorSteps(dir, executionId)).toEqual([]);
			const rendered = await renderReview(dir, executionId, planPath, "1", end);
			expect(rendered.exitCode, `${rendered.stdout}\n${rendered.stderr}`).toBe(
				0,
			);
			const prompt = JSON.parse(rendered.stdout).data.prompt as string;
			expect(prompt).toContain(`${parent}..${end}`);
			expect(prompt).toContain("src/a.ts");
			const unfinished = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(`${unfinished.stdout}\n${unfinished.stderr}`).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);
			const next = await recordAuthor(
				dir,
				executionId,
				"2",
				git(dir, "rev-parse", "HEAD"),
				"1",
			);
			expect(next.exitCode).not.toBe(0);
			expect(`${next.stdout}\n${next.stderr}`).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);
			expect(preAuthorSteps(dir, executionId)).toEqual([]);
		},
		{ timeout: 60000 },
	);

	test(
		"a zero-claim review seals, and a realized claim seals only after the realization",
		async () => {
			const zero = await initRepo("enforced");
			await approveSource(zero.dir, zero.planPath, 2);
			const zeroRun = await startRun(zero.dir, zero.planPath);
			const zeroCommit = await commitFile(
				zero.dir,
				zeroRun,
				"1",
				"src/a.ts",
				"export const a = 1;\n",
				"implement",
			);
			expect(
				(await recordAuthor(zero.dir, zeroRun, "1", zeroCommit, "1")).exitCode,
			).toBe(0);
			const zeroReview = await renderReview(
				zero.dir,
				zeroRun,
				zero.planPath,
				"1",
				zeroCommit,
			);
			expect(zeroReview.exitCode, zeroReview.stderr).toBe(0);
			const zeroVerdict = await cli(
				zero.dir,
				[
					"protocol",
					"validate",
					"reviewer",
					"--run",
					zeroRun,
					"--record",
					"--step",
					"reviewer:review",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--review-context",
					reviewContextId(zeroReview.stdout),
				],
				{
					readiness: "ready",
					items: [],
					creditRealizations: [],
				},
			);
			expect(
				zeroVerdict.exitCode,
				`${zeroVerdict.stdout}\n${zeroVerdict.stderr}`,
			).toBe(0);
			expect(governanceOf(zeroVerdict.stdout).completionAuthorized).toBe(true);
			const zeroPhase = await cli(zero.dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				zeroRun,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(
				zeroPhase.exitCode,
				`${zeroPhase.stdout}\n${zeroPhase.stderr}`,
			).toBe(0);
			const zeroState = await cli(zero.dir, ["run", "state", "--run", zeroRun]);
			expect(zeroState.exitCode, zeroState.stderr).toBe(0);
			const zeroGovernance = JSON.parse(zeroState.stdout).data
				.implementation_governance;
			expect(zeroGovernance.domain).toBe("implementation");
			expect(zeroGovernance.binding.sourceRunId).toEqual(expect.any(String));
			expect(zeroGovernance.reviewedRange.baseCommit).toEqual(
				expect.any(String),
			);
			expect(zeroGovernance.reviewedRange.reviewedCommit).toBe(zeroCommit);
			expect(zeroGovernance.credit.realizedCredit).toBe(0);
			expect(zeroGovernance.credit.grossEffort).toBeGreaterThan(0);
			expect(zeroGovernance.credit.positiveBurden).toBeGreaterThanOrEqual(0);
			expect(zeroState.stdout).not.toContain("not_physically_realized");
			expect(zeroGovernance.phases).toContainEqual(
				expect.objectContaining({
					phase: "1",
					reviewed: true,
					claimsReconciled: true,
					ready: true,
				}),
			);
			const zeroSeal = await cli(zero.dir, [
				"run",
				"complete",
				"--run",
				zeroRun,
				"--status",
				"completed",
			]);
			expect(zeroSeal.exitCode, `${zeroSeal.stdout}\n${zeroSeal.stderr}`).toBe(
				0,
			);

			const claimed = await initRepo("enforced", {
				plan: debtPlan({
					effort: 2,
					architecture: -1,
					targetPhase: "phase-1",
					secondPhase: false,
				}),
			});
			await approveSource(claimed.dir, claimed.planPath, 2, "DC0");
			const claimedRun = await startRun(claimed.dir, claimed.planPath);
			const claimedCommit = await commitFile(
				claimed.dir,
				claimedRun,
				"1",
				"src/a.ts",
				"export const a = 1;\n",
				"implement",
			);
			expect(
				(await recordAuthor(claimed.dir, claimedRun, "1", claimedCommit, "1"))
					.exitCode,
			).toBe(0);
			const claimedReview = await renderReview(
				claimed.dir,
				claimedRun,
				claimed.planPath,
				"1",
				claimedCommit,
			);
			expect(claimedReview.exitCode, claimedReview.stderr).toBe(0);
			const contextId = reviewContextId(claimedReview.stdout);
			const omitted = await cli(
				claimed.dir,
				[
					"protocol",
					"validate",
					"reviewer",
					"--run",
					claimedRun,
					"--record",
					"--step",
					"reviewer:review",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--review-context",
					contextId,
				],
				{ readiness: "ready", items: [], creditRealizations: [] },
			);
			expect(omitted.exitCode, `${omitted.stdout}\n${omitted.stderr}`).toBe(0);
			expect(governanceOf(omitted.stdout).completionAuthorized).toBe(false);
			const blocked = await cli(claimed.dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				claimedRun,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(`${blocked.stdout}\n${blocked.stderr}`).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);
			const realized = await cli(
				claimed.dir,
				[
					"protocol",
					"validate",
					"reviewer",
					"--run",
					claimedRun,
					"--record",
					"--step",
					"reviewer:review",
					"--phase",
					"1",
					"--iteration",
					"2",
					"--review-context",
					contextId,
				],
				{
					readiness: "ready",
					items: [],
					creditRealizations: [
						{
							creditClaimId: "DC0",
							realization: "realized",
							realizedArchitectureDelta: -1,
							evidence: `Post-state at ${claimedCommit} has one writer.`,
						},
					],
				},
			);
			expect(realized.exitCode, `${realized.stdout}\n${realized.stderr}`).toBe(
				0,
			);
			expect(governanceOf(realized.stdout)).toMatchObject({
				route: "complete",
				completionAuthorized: true,
			});
			const completed = await cli(claimed.dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				claimedRun,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(
				completed.exitCode,
				`${completed.stdout}\n${completed.stderr}`,
			).toBe(0);
			const seal = await cli(claimed.dir, [
				"run",
				"complete",
				"--run",
				claimedRun,
				"--status",
				"completed",
			]);
			expect(seal.exitCode, `${seal.stdout}\n${seal.stderr}`).toBe(0);
		},
		{ timeout: 60000 },
	);

	test(
		"a material shortfall in the last phase blocks phase and run completion",
		async () => {
			const { dir, planPath } = await initRepo("enforced", {
				plan: debtPlan({
					effort: 8,
					architecture: -5,
					targetPhase: "phase-2",
					secondPhase: true,
				}),
			});
			await approveSource(dir, planPath, 8, "DC0");
			const executionId = await startRun(dir, planPath);
			const firstCommit = await commitFile(
				dir,
				executionId,
				"1",
				"src/a.ts",
				"export const a = 1;\n",
				"phase 1",
			);
			expect(
				(await recordAuthor(dir, executionId, "1", firstCommit, "1")).exitCode,
			).toBe(0);
			const firstReview = await renderReview(
				dir,
				executionId,
				planPath,
				"1",
				firstCommit,
			);
			expect(firstReview.exitCode, firstReview.stderr).toBe(0);
			const firstVerdict = await cli(
				dir,
				[
					"protocol",
					"validate",
					"reviewer",
					"--run",
					executionId,
					"--record",
					"--step",
					"reviewer:review",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--review-context",
					reviewContextId(firstReview.stdout),
				],
				{ readiness: "ready", items: [], creditRealizations: [] },
			);
			expect(
				firstVerdict.exitCode,
				`${firstVerdict.stdout}\n${firstVerdict.stderr}`,
			).toBe(0);
			const phaseOne = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(phaseOne.exitCode, `${phaseOne.stdout}\n${phaseOne.stderr}`).toBe(
				0,
			);
			const secondCommit = await commitFile(
				dir,
				executionId,
				"2",
				"src/b.ts",
				"export const b = 1;\n",
				"phase 2",
			);
			expect(
				(await recordAuthor(dir, executionId, "2", secondCommit, "1")).exitCode,
			).toBe(0);
			const secondReview = await renderReview(
				dir,
				executionId,
				planPath,
				"2",
				secondCommit,
			);
			expect(
				secondReview.exitCode,
				`${secondReview.stdout}\n${secondReview.stderr}`,
			).toBe(0);
			const shortfall = await cli(
				dir,
				[
					"protocol",
					"validate",
					"reviewer",
					"--run",
					executionId,
					"--record",
					"--step",
					"reviewer:review",
					"--phase",
					"2",
					"--iteration",
					"1",
					"--review-context",
					reviewContextId(secondReview.stdout),
				],
				{
					readiness: "ready",
					items: [],
					creditRealizations: [
						{
							creditClaimId: "DC0",
							realization: "not_realized",
							realizedArchitectureDelta: 0,
							evidence: `Post-state at ${secondCommit} still has both writers.`,
						},
					],
				},
			);
			expect(
				shortfall.exitCode,
				`${shortfall.stdout}\n${shortfall.stderr}`,
			).toBe(0);
			expect(governanceOf(shortfall.stdout).completionAuthorized).toBe(false);
			const phaseTwo = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"2",
				"--result",
				JSON.stringify({ phase: "2" }),
			]);
			const phaseTwoText = `${phaseTwo.stdout}\n${phaseTwo.stderr}`;
			expect(phaseTwo.exitCode).not.toBe(0);
			expect(phaseTwoText).toContain("IMPLEMENTATION_BOUNDARY_BLOCKED");
			expect(phaseTwoText).toContain("Phase 2");
			const state = await cli(dir, ["run", "state", "--run", executionId]);
			const phases = JSON.parse(state.stdout).data.implementation_governance
				.phases as Array<{ phase: string; ready: boolean }>;
			expect(phases.find((phase) => phase.phase === "2")?.ready).toBe(false);
			const seal = await cli(dir, [
				"run",
				"complete",
				"--run",
				executionId,
				"--status",
				"completed",
			]);
			expect(seal.exitCode).not.toBe(0);
			expect(`${seal.stdout}\n${seal.stderr}`).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);
		},
		{ timeout: 60000 },
	);

	test(
		"an eligible correction proof carries the realized claim through phase completion",
		async () => {
			const { dir, planPath } = await initRepo("enforced", {
				plan: debtPlan({
					effort: 2,
					architecture: -1,
					targetPhase: "phase-1",
					secondPhase: false,
				}),
				qualityGate: "echo ok",
			});
			await approveSource(dir, planPath, 2, "DC0");
			const executionId = await startRun(dir, planPath);
			const reviewed = await commitFile(
				dir,
				executionId,
				"1",
				"src/a.ts",
				"export const a = 1;\n",
				"implement",
			);
			expect(
				(await recordAuthor(dir, executionId, "1", reviewed, "1")).exitCode,
			).toBe(0);
			const rendered = await renderReview(
				dir,
				executionId,
				planPath,
				"1",
				reviewed,
			);
			expect(rendered.exitCode, rendered.stderr).toBe(0);
			const verdict = await cli(
				dir,
				[
					"protocol",
					"validate",
					"reviewer",
					"--run",
					executionId,
					"--record",
					"--step",
					"reviewer:review",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--review-context",
					reviewContextId(rendered.stdout),
				],
				{
					readiness: "ready_with_corrections",
					items: [
						{
							id: "P2.1",
							title: "Rename the local counter",
							action: "auto_fix",
							reason: "The name does not match the surrounding file.",
							priority: "P2",
							scopeClass: "implementation_defect",
							effortDelta: 0,
							architectureDelta: 0,
							planWorkItemIds: ["W1"],
							boundaryChanges: [],
							mechanicalExplanation:
								"Rename the exported binding in src/a.ts only.",
						},
					],
					creditRealizations: [
						{
							creditClaimId: "DC0",
							realization: "realized",
							realizedArchitectureDelta: -1,
							evidence: `Post-state at ${reviewed} has one writer.`,
						},
					],
				},
			);
			expect(verdict.exitCode, `${verdict.stdout}\n${verdict.stderr}`).toBe(0);
			const governance = governanceOf(verdict.stdout);
			expect(governance).toMatchObject({
				route: "author_revision",
				completionAuthorized: false,
			});
			const observationId = governance.observationId;
			expect(observationId).toBeTruthy();
			const corrected = await commitFile(
				dir,
				executionId,
				"1",
				"src/a.ts",
				"export const counter = 1;\n",
				"rename counter",
			);
			expect(corrected).not.toBe(reviewed);
			const repair = await recordAuthor(dir, executionId, "1", corrected, "2");
			expect(repair.exitCode, `${repair.stdout}\n${repair.stderr}`).toBe(0);
			const finished = await cli(dir, [
				"review",
				"corrections",
				"finish",
				"--run",
				executionId,
				"--phase",
				"1",
				"--review",
				observationId as string,
				"--commit",
				corrected,
			]);
			expect(finished.exitCode, `${finished.stdout}\n${finished.stderr}`).toBe(
				0,
			);
			expect(JSON.parse(finished.stdout).data.status).toBe("complete");
			expect(git(dir, "rev-parse", "HEAD")).not.toBe(reviewed);
			const completed = await cli(dir, [
				"run",
				"record",
				"phase:complete",
				"--run",
				executionId,
				"--phase",
				"1",
				"--result",
				JSON.stringify({ phase: "1" }),
			]);
			expect(
				completed.exitCode,
				`${completed.stdout}\n${completed.stderr}`,
			).toBe(0);
			await commitFile(
				dir,
				executionId,
				"1",
				"src/c.ts",
				"export const extra = 1;\n",
				"after proof",
			);
			const seal = await cli(dir, [
				"run",
				"complete",
				"--run",
				executionId,
				"--status",
				"completed",
			]);
			expect(seal.exitCode).not.toBe(0);
			expect(`${seal.stdout}\n${seal.stderr}`).toContain(
				"IMPLEMENTATION_BOUNDARY_BLOCKED",
			);
		},
		{ timeout: 60000 },
	);
});
