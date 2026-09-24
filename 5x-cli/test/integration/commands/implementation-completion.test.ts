import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

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

async function initRepo(mode: "enforced" | "off" | "advisory") {
	const dir = mkdtempSync(join(tmpdir(), "5x-impl-complete-"));
	git(dir, "init");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "user.name", "Test");
	const initialized = await cli(dir, ["init"]);
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
	writeFileSync(join(dir, "5x.toml"), `[reviewBudget]\nmode = "${mode}"\n`);
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
});
