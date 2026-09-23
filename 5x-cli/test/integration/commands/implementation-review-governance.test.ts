import { describe, expect, test } from "bun:test";
import {
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
	if (runInit.exitCode !== 0) throw new Error(runInit.stderr);
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
});
