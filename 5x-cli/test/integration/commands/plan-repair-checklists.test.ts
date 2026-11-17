import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	cpSync,
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
import { commitAll } from "../../helpers/git-fixture.js";
import { createScaffoldedProjectSeed } from "../../helpers/scaffold-fixture.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const REASON = "Operator authorized checklist-format repair and continuation";

let scaffoldSeed: string;
beforeAll(async () => {
	scaffoldSeed = await createScaffoldedProjectSeed();
}, 15000);
afterAll(() => {
	if (scaffoldSeed) rmSync(scaffoldSeed, { recursive: true, force: true });
});

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

type Envelope = {
	ok: boolean;
	data?: Record<string, unknown>;
	error?: { code: string; message: string; detail?: Record<string, unknown> };
};

function envelope(result: { stdout: string; stderr: string }): Envelope {
	const line =
		result.stdout
			.split("\n")
			.filter((entry) => entry.startsWith("{"))
			.at(-1) ?? "";
	try {
		return JSON.parse(line) as Envelope;
	} catch {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
}

function ok(result: { stdout: string; stderr: string; exitCode: number }) {
	if (result.exitCode !== 0) {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
	return envelope(result);
}

/** Approved shape from the incident: gate lists, no task markers. */
function malformedPlan(): string {
	return `# Booking preview

**Status:** Draft

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Booking preview | 2 | 0 | - | - | Implements the preview. |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Preview model

**Completion gate:** Preview data is typed.

- Add the preview type
  - include the member tier
- Map API fields

## Phase 2: Modal

**Completion gate:** The modal renders.

- Render the modal
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

function runDir(dir: string, runId: string): string {
	return join(dir, "docs", "development", "runs", "preview", runId);
}

function lines(dir: string, runId: string, stream: "budget" | "steps") {
	const path = join(runDir(dir, runId), `${stream}.jsonl`);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(
			(line) =>
				(JSON.parse(line) as { payload?: Record<string, unknown> }).payload ??
				{},
		);
}

function ofKind(dir: string, runId: string, kind: string) {
	return lines(dir, runId, "budget").filter((payload) => payload.kind === kind);
}

function stepNames(dir: string, runId: string): string[] {
	return lines(dir, runId, "steps").map((payload) => String(payload.step_name));
}

async function initRepo(): Promise<{ dir: string; planPath: string }> {
	const dir = mkdtempSync(join(tmpdir(), "5x-repair-checklists-"));
	cpSync(scaffoldSeed, dir, { recursive: true });
	writeFileSync(join(dir, "5x.toml"), '[reviewBudget]\nmode = "advisory"\n');
	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "preview.md");
	writeFileSync(planPath, malformedPlan());
	await commitAll(dir, "fixture");
	return { dir, planPath };
}

async function startRun(dir: string, planPath: string): Promise<string> {
	const init = ok(await cli(dir, ["run", "init", "--plan", planPath]));
	return String(init.data?.run_id);
}

/**
 * A legacy approval of the incident shape. Current CLIs refuse to record a
 * verdict on a non-executable plan, so the verdict is recorded against an
 * executable working copy while the committed plan, which the completed
 * run seals as its approval anchor, keeps the malformed bytes. This is the
 * historical state the run-form repair recovers.
 */
async function approveAndComplete(
	dir: string,
	runId: string,
): Promise<Envelope> {
	const planPath = join(dir, "docs", "development", "plans", "preview.md");
	const committed = readFileSync(planPath, "utf8");
	const phases = committed.indexOf("## Phase 1");
	writeFileSync(
		planPath,
		committed.slice(0, phases) +
			committed.slice(phases).replace(/^- (?!\[)/gm, "- [ ] "),
	);
	try {
		ok(
			await cli(
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
			),
		);
	} finally {
		writeFileSync(planPath, committed);
	}
	return ok(
		await cli(dir, [
			"run",
			"complete",
			"--run",
			runId,
			"--status",
			"completed",
		]),
	);
}

function author(
	dir: string,
	runId: string,
	iteration: string,
	options: { validateChecklist?: boolean } = {},
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
			"1",
			"--iteration",
			iteration,
			...(options.validateChecklist ? [] : ["--no-phase-checklist-validate"]),
		],
		{ result: "complete", commit: git(dir, "rev-parse", "HEAD") },
	);
}

describe("5x plan repair-checklists", () => {
	test.serial(
		"repairs an unapproved draft in place without a governance record",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const preview = ok(
					await cli(dir, [
						"plan",
						"repair-checklists",
						"--plan",
						planPath,
						"--dry-run",
					]),
				);
				expect(preview.data?.wrote).toBe(false);
				expect(preview.data?.recorded).toBe(false);
				expect(readFileSync(planPath, "utf8")).toBe(malformedPlan());
				const applied = ok(
					await cli(dir, [
						"plan",
						"repair-checklists",
						"--plan",
						planPath,
						"--apply",
						"--intent",
						String(preview.data?.intentDigest),
					]),
				);
				expect(applied.data?.wrote).toBe(true);
				const repaired = readFileSync(planPath, "utf8");
				expect(repaired).toContain(
					"- [ ] Add the preview type\n  - include the member tier",
				);
				expect(repaired).toContain("- [ ] Render the modal");
				const phases = ok(await cli(dir, ["plan", "phases", planPath]));
				expect(
					(
						(phases.data?.phases ?? []) as Array<{ checklist_total: number }>
					).map((phase) => phase.checklist_total),
				).toEqual([2, 1]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test.serial(
		"repairs a completed source before binding; the binding keeps its approval",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const approvalCommit = git(dir, "rev-parse", "HEAD");
				const sourceId = await startRun(dir, planPath);
				await approveAndComplete(dir, sourceId);

				// The file form defers to the approval instead of bypassing it.
				const governed = await cli(dir, [
					"plan",
					"repair-checklists",
					"--plan",
					planPath,
					"--dry-run",
				]);
				expect(governed.exitCode).not.toBe(0);
				const refusal = envelope(governed);
				expect(refusal.error?.code).toBe("PLAN_CHECKLIST_REPAIR_REQUIRES_RUN");
				expect(refusal.error?.message).toContain(`--run ${sourceId} --dry-run`);

				const applied = ok(
					await cli(dir, [
						"plan",
						"repair-checklists",
						"--run",
						sourceId,
						"--apply",
						"--reason",
						REASON,
					]),
				);
				expect(applied.data?.subject).toBe("source");
				expect(applied.data?.created).toBe(true);
				const receipts = ofKind(dir, sourceId, "plan-checklist-repair");
				expect(receipts).toHaveLength(1);
				expect(receipts[0]?.bindingId).toBeNull();
				expect(receipts[0]?.reason).toBe(REASON);
				expect(git(dir, "status", "--porcelain")).toBe("");

				const executionId = await startRun(dir, planPath);
				const bound = await author(dir, executionId, "1");
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				const binding = ofKind(dir, executionId, "implementation-binding")[0];
				expect(binding?.sourceRunId).toBe(sourceId);
				expect(binding?.approvedPlanCommit).toBe(approvalCommit);
				const carried = ofKind(dir, executionId, "plan-checklist-repair");
				expect(carried).toHaveLength(1);
				expect(carried[0]?.bindingId).toBe(binding?.id);
				expect(carried[0]?.carriedFrom).toEqual({
					runId: sourceId,
					repairId: receipts[0]?.id,
				});

				// A later source repair cannot silently change the binding.
				const later = await cli(dir, [
					"plan",
					"repair-checklists",
					"--run",
					sourceId,
					"--dry-run",
				]);
				expect(envelope(later).error?.code).toBe("PLAN_CHECKLIST_REPAIR_BOUND");
				expect(
					stepNames(dir, sourceId).filter((name) =>
						name.startsWith("reviewer:"),
					),
				).toEqual(["reviewer:plan"]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 60000 },
	);

	test.serial(
		"repairs an active drift-blocked execution on the same run after one instruction",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await startRun(dir, planPath);
				await approveAndComplete(dir, sourceId);
				const executionId = await startRun(dir, planPath);
				const bound = await author(dir, executionId, "1");
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}

				// A zero-item phase cannot be checked off; the failure names the repair.
				const empty = await author(dir, executionId, "2", {
					validateChecklist: true,
				});
				expect(empty.exitCode).not.toBe(0);
				expect(empty.stdout + empty.stderr).toContain(
					`5x plan repair-checklists --run ${executionId} --dry-run`,
				);

				// The operator's manual fix introduced a checked box: drift.
				writeFileSync(
					planPath,
					malformedPlan()
						.replace("- Add the preview type", "- [x] Add the preview type")
						.replace("- Map API fields", "- [ ] Map API fields"),
				);
				const drifted = await author(dir, executionId, "2");
				expect(drifted.exitCode).not.toBe(0);
				expect(drifted.stderr).toContain("[IMPLEMENTATION_PLAN_DRIFT]");
				expect(drifted.stderr).toContain(
					`5x plan repair-checklists --run ${executionId} --dry-run`,
				);

				const preview = ok(
					await cli(dir, [
						"plan",
						"repair-checklists",
						"--run",
						executionId,
						"--dry-run",
					]),
				);
				expect(preview.data?.recorded).toBe(false);
				expect(
					(
						(preview.data?.resetChecked ?? []) as Array<{ repaired: string }>
					).map((entry) => entry.repaired),
				).toEqual(["- [ ] Add the preview type"]);
				expect(
					((preview.data?.edits ?? []) as Array<{ after: string }>).map(
						(edit) => edit.after,
					),
				).toEqual([
					"- [ ] Add the preview type",
					"- [ ] Map API fields",
					"- [ ] Render the modal",
				]);
				expect(ofKind(dir, executionId, "plan-checklist-repair")).toHaveLength(
					0,
				);
				const stepsBefore = stepNames(dir, executionId);

				const applied = ok(
					await cli(dir, [
						"plan",
						"repair-checklists",
						"--run",
						executionId,
						"--apply",
						"--intent",
						String(preview.data?.intentDigest),
						"--reason",
						REASON,
					]),
				);
				expect(applied.data?.created).toBe(true);
				expect(applied.data?.completionAuthorized).toBe(false);
				expect(git(dir, "status", "--porcelain")).toBe("");
				const head = git(dir, "rev-parse", "HEAD");
				const stepsAfter = stepNames(dir, executionId);
				expect(stepsAfter).toEqual([...stepsBefore, "checklist-repair"]);
				expect(stepsAfter.some((name) => name.startsWith("reviewer:"))).toBe(
					false,
				);

				// Identical retry returns the stored receipt.
				const retry = ok(
					await cli(dir, [
						"plan",
						"repair-checklists",
						"--run",
						executionId,
						"--apply",
						"--reason",
						REASON,
					]),
				);
				expect(retry.data?.created).toBe(false);
				expect(ofKind(dir, executionId, "plan-checklist-repair")).toHaveLength(
					1,
				);
				expect(git(dir, "rev-parse", "HEAD")).toBe(head);

				// The author checks the new boxes and completes the phase on the same run.
				writeFileSync(
					planPath,
					readFileSync(planPath, "utf8")
						.replace("- [ ] Add the preview type", "- [x] Add the preview type")
						.replace("- [ ] Map API fields", "- [x] Map API fields"),
				);
				git(dir, "add", "--", planPath);
				git(dir, "commit", "-m", "check phase 1");
				const completed = await author(dir, executionId, "2", {
					validateChecklist: true,
				});
				if (completed.exitCode !== 0) {
					throw new Error(`${completed.stdout}\n${completed.stderr}`);
				}
				const binding = ofKind(dir, executionId, "implementation-binding");
				expect(binding).toHaveLength(1);

				// The derived index rebuilds over the new record kind.
				ok(await cli(dir, ["records", "index"]));
				const state = ok(
					await cli(dir, ["run", "state", "--run", executionId]),
				);
				expect(state.ok).toBe(true);
				const again = await author(dir, executionId, "3");
				if (again.exitCode !== 0) {
					throw new Error(`${again.stdout}\n${again.stderr}`);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 90000 },
	);

	test.serial(
		"approved author delegation names the run repair; repair and resume on the same run",
		async () => {
			const { dir, planPath } = await initRepo();
			try {
				const sourceId = await startRun(dir, planPath);
				const completed = await approveAndComplete(dir, sourceId);
				// Finalization reports the defect without blocking completion.
				expect(completed.data?.plan_executability).toMatchObject({
					executable: false,
					next: [`5x plan repair-checklists --run ${sourceId} --dry-run`],
				});

				const executionId = await startRun(dir, planPath);
				const bound = await author(dir, executionId, "1");
				if (bound.exitCode !== 0) {
					throw new Error(`${bound.stdout}\n${bound.stderr}`);
				}
				const render = () =>
					cli(dir, [
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
						"user_notes=continue",
					]);
				const blocked = await render();
				expect(blocked.exitCode).not.toBe(0);
				const refusal = envelope(blocked);
				expect(refusal.error?.code).toBe("PLAN_CHECKLIST_REPAIR_REQUIRED");
				expect(refusal.error?.detail?.next).toEqual([
					`5x plan repair-checklists --run ${executionId} --dry-run`,
				]);
				expect(refusal.error?.detail?.runPreserved).toBe(true);
				const stepsBefore = stepNames(dir, executionId);

				// `plan phases` stays usable and points at the same run.
				const phases = ok(await cli(dir, ["plan", "phases", planPath]));
				expect(
					((phases.data?.phases ?? []) as Array<{ executable: boolean }>).map(
						(phase) => phase.executable,
					),
				).toEqual([false, false]);
				expect(
					((phases.data?.executability ?? { next: [] }) as { next: string[] })
						.next,
				).toEqual([`5x plan repair-checklists --run ${executionId} --dry-run`]);

				const preview = ok(
					await cli(dir, [
						"plan",
						"repair-checklists",
						"--run",
						executionId,
						"--dry-run",
					]),
				);
				ok(
					await cli(dir, [
						"plan",
						"repair-checklists",
						"--run",
						executionId,
						"--apply",
						"--intent",
						String(preview.data?.intentDigest),
						"--reason",
						REASON,
					]),
				);
				const resumed = await render();
				if (resumed.exitCode !== 0) {
					throw new Error(`${resumed.stdout}\n${resumed.stderr}`);
				}
				expect(envelope(resumed).ok).toBe(true);
				const stepsAfter = stepNames(dir, executionId);
				expect(stepsAfter.slice(0, stepsBefore.length)).toEqual(stepsBefore);
				expect(stepsAfter.some((name) => name.startsWith("reviewer:"))).toBe(
					false,
				);
				const state = ok(
					await cli(dir, ["run", "state", "--run", executionId]),
				);
				expect(JSON.stringify(state.data)).toContain('"active"');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 90000 },
	);
});
