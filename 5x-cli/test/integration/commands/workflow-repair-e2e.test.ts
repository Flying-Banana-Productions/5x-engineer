/**
 * Plan 217 phase 5: the motivating lifecycle (Player Desk plan 568) as a
 * bounded detour. An approved plan whose phases have plain gate bullets but no
 * task markers reaches a ready code review with passing quality; the phase
 * cannot be checked off. One operator instruction repairs the checklist on the
 * same run, the author checks the new boxes against the recorded evidence, the
 * phase completes, and the next phase is delegated, with no additional
 * reviewer or quality invocation. Every step runs the real CLI against an
 * isolated fixture repository.
 */

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
import { renderSkillByName } from "../../../src/skills/loader.js";
import { createRenderContext } from "../../../src/skills/renderer.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";
import { commitAll } from "../../helpers/git-fixture.js";
import { createScaffoldedProjectSeed } from "../../helpers/scaffold-fixture.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const INSTRUCTION =
	"Operator: this is a silly reason to block progress; fix the checklist and move on";

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

type CliResult = { stdout: string; stderr: string; exitCode: number };

async function cli(
	cwd: string,
	args: string[],
	stdin?: unknown,
): Promise<CliResult> {
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

function envelope(result: CliResult): Envelope {
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

function ok(result: CliResult): Envelope {
	if (result.exitCode !== 0) {
		throw new Error(`${result.stdout}\n${result.stderr}`);
	}
	return envelope(result);
}

/** Plan 568's approved shape: three phases, gate bullets, no task markers. */
function incidentPlan(): string {
	return `# Booking modal member preview

**Status:** Approved

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Preview model and modal | 3 | 0 | - | - | Implements the member preview. |

### Surface Snapshot

- Subsystems: 1
- Production files: 2
- Persistent/external boundaries: 0

## Phase 1: Preview model

**Completion gate:** Preview data is typed and mapped from the API.

- Add the preview type
  - include the member tier
- Map API fields

## Phase 2: Modal

**Completion gate:** The modal renders the preview.

- Render the modal
- Close on escape

## Phase 3: Polish

**Completion gate:** Copy is final.

- Final copy review
`;
}

const PLAN_READY = {
	readiness: "ready",
	items: [],
	baselineAssessment: {
		independentEffortEstimate: 3,
		confidence: "high",
		reason: "The original scope is three points.",
	},
};

interface Fixture {
	dir: string;
	planPath: string;
	counter: string;
}

async function initRepo(): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "5x-workflow-repair-e2e-"));
	cpSync(scaffoldSeed, dir, { recursive: true });
	const counter = join(mkdtempSync(join(tmpdir(), "5x-quality-count-")), "n");
	writeFileSync(
		join(dir, "5x.toml"),
		`qualityGates = ["sh -c 'echo run >> ${counter}'"]\n[reviewBudget]\nmode = "enforced"\n`,
	);
	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "preview.md");
	writeFileSync(planPath, incidentPlan());
	await commitAll(dir, "fixture");
	return { dir, planPath, counter };
}

function runDir(dir: string, runId: string): string {
	return join(dir, "docs", "development", "runs", "preview", runId);
}

function journal(dir: string, runId: string, stream: "budget" | "steps") {
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

function rawJournal(dir: string, runId: string, stream: "budget" | "steps") {
	const path = join(runDir(dir, runId), `${stream}.jsonl`);
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function ofKind(dir: string, runId: string, kind: string) {
	return journal(dir, runId, "budget").filter((entry) => entry.kind === kind);
}

function stepNames(dir: string, runId: string): string[] {
	return journal(dir, runId, "steps").map((entry) => String(entry.step_name));
}

function qualityRuns(counter: string): number {
	return existsSync(counter)
		? readFileSync(counter, "utf8").split("\n").filter(Boolean).length
		: 0;
}

/**
 * The legacy approval of the incident: the verdict was recorded while the
 * working copy was executable, but the committed plan sealed as the approval
 * anchor has no task markers. Current CLIs refuse a verdict on a
 * non-executable plan, which is why the fixture records it this way.
 */
async function legacyApproval(fx: Fixture): Promise<string> {
	const sourceId = String(
		ok(await cli(fx.dir, ["run", "init", "--plan", fx.planPath])).data?.run_id,
	);
	const committed = readFileSync(fx.planPath, "utf8");
	const phases = committed.indexOf("## Phase 1");
	writeFileSync(
		fx.planPath,
		committed.slice(0, phases) +
			committed.slice(phases).replace(/^(\s*)- (?!\[)/gm, "$1- [ ] "),
	);
	try {
		ok(
			await cli(
				fx.dir,
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
				PLAN_READY,
			),
		);
	} finally {
		writeFileSync(fx.planPath, committed);
	}
	const completed = ok(
		await cli(fx.dir, [
			"run",
			"complete",
			"--run",
			sourceId,
			"--status",
			"completed",
		]),
	);
	// Finalization reports the defect and the repair; it does not block.
	expect(completed.data?.plan_executability).toMatchObject({
		executable: false,
	});
	return sourceId;
}

async function phaseStatus(fx: Fixture, phase: string) {
	const phases = ok(await cli(fx.dir, ["plan", "phases", fx.planPath]));
	const list = (phases.data?.phases ?? []) as Array<{
		id: string;
		done: boolean;
		executable: boolean;
		checklist_total: number;
	}>;
	return {
		phase: list.find((entry) => entry.id === phase),
		executability: phases.data?.executability as
			| { executable: boolean; next?: string[] }
			| undefined,
	};
}

describe("operator-directed workflow repair, end to end (plan 568 lifecycle)", () => {
	test.serial(
		"one instruction repairs the checklist, preserves ready review and quality, completes the phase and continues",
		async () => {
			const fx = await initRepo();
			try {
				const sourceId = await legacyApproval(fx);
				const sourceSteps = rawJournal(fx.dir, sourceId, "steps");
				const sourceBudget = rawJournal(fx.dir, sourceId, "budget");

				// Execution: implement phase 1, pass quality, get a ready review.
				const runId = String(
					ok(await cli(fx.dir, ["run", "init", "--plan", fx.planPath])).data
						?.run_id,
				);
				mkdirSync(join(fx.dir, "src"), { recursive: true });
				writeFileSync(
					join(fx.dir, "src", "preview.ts"),
					"export type Preview = { tier: string };\n",
				);
				const code = String(
					ok(
						await cli(fx.dir, [
							"commit",
							"--run",
							runId,
							"--phase",
							"1",
							"-m",
							"feat: preview model",
							"--all-files",
						]),
					).data?.hash,
				);
				ok(
					await cli(
						fx.dir,
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
							"0",
							"--no-phase-checklist-validate",
						],
						{ result: "complete", commit: code },
					),
				);
				const binding = ofKind(fx.dir, runId, "implementation-binding");
				expect(binding).toHaveLength(1);
				expect(binding[0]?.sourceRunId).toBe(sourceId);
				ok(
					await cli(fx.dir, [
						"quality",
						"run",
						"--record",
						"--run",
						runId,
						"--phase",
						"1",
					]),
				);
				expect(qualityRuns(fx.counter)).toBe(1);
				const context = String(
					ok(
						await cli(fx.dir, [
							"template",
							"render",
							"reviewer-commit",
							"--run",
							runId,
							"--var",
							"phase_number=1",
							"--var",
							`commit_hash=${code}`,
							"--var",
							`plan_path=${fx.planPath}`,
						]),
					).data?.review_context_id,
				);
				const reviewed = ok(
					await cli(
						fx.dir,
						[
							"protocol",
							"validate",
							"reviewer",
							"--run",
							runId,
							"--record",
							"--step",
							"reviewer:commit",
							"--phase",
							"1",
							"--iteration",
							"0",
							"--review-context",
							context,
						],
						{ readiness: "ready", items: [] },
					),
				);
				const governance = (
					reviewed.data?.result as
						| { governance?: Record<string, unknown> }
						| undefined
				)?.governance;
				expect(governance?.route).toBe("complete");
				expect(governance?.completionAuthorized).toBe(true);

				// The phase gate (Step 6): the phase exists but has no items.
				const before = await phaseStatus(fx, "1");
				expect(before.phase).toMatchObject({
					done: false,
					executable: false,
					checklist_total: 0,
				});
				expect(before.executability?.next).toEqual([
					`5x plan repair-checklists --run ${runId} --dry-run`,
				]);
				// The old dead end now names the same-run repair.
				const blocked = await cli(
					fx.dir,
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
						"1",
					],
					{ result: "complete", commit: code },
				);
				expect(blocked.exitCode).not.toBe(0);
				expect(blocked.stdout + blocked.stderr).toContain(
					`5x plan repair-checklists --run ${runId} --dry-run`,
				);

				const stepsBeforeRepair = stepNames(fx.dir, runId);
				const reviewersBefore = stepsBeforeRepair.filter((name) =>
					name.startsWith("reviewer:"),
				);
				expect(reviewersBefore).toEqual(["reviewer:commit"]);

				// One operator instruction: preview, then apply with that reason.
				const preview = ok(
					await cli(fx.dir, [
						"plan",
						"repair-checklists",
						"--run",
						runId,
						"--dry-run",
					]),
				);
				expect(preview.data?.subject).toBe("execution");
				expect(
					((preview.data?.edits ?? []) as Array<{ after: string }>).map(
						(edit) => edit.after,
					),
				).toEqual([
					"- [ ] Add the preview type",
					"- [ ] Map API fields",
					"- [ ] Render the modal",
					"- [ ] Close on escape",
					"- [ ] Final copy review",
				]);
				const applied = ok(
					await cli(fx.dir, [
						"plan",
						"repair-checklists",
						"--run",
						runId,
						"--apply",
						"--intent",
						String(preview.data?.intentDigest),
						"--reason",
						INSTRUCTION,
					]),
				);
				expect(applied.data?.created).toBe(true);
				expect(applied.data?.completionAuthorized).toBe(false);
				const receipts = ofKind(fx.dir, runId, "plan-checklist-repair");
				expect(receipts).toHaveLength(1);
				expect(receipts[0]?.reason).toBe(INSTRUCTION);
				expect(receipts[0]?.bindingId).toBe(binding[0]?.id);
				expect(stepNames(fx.dir, runId)).toEqual([
					...stepsBeforeRepair,
					"checklist-repair",
				]);
				expect(readFileSync(fx.planPath, "utf8")).toContain(
					"- [ ] Add the preview type\n  - include the member tier",
				);

				// The author checks phase 1 boxes against the recorded evidence and
				// commits only the plan: a checkbox toggle, not new work.
				writeFileSync(
					fx.planPath,
					readFileSync(fx.planPath, "utf8")
						.replace("- [ ] Add the preview type", "- [x] Add the preview type")
						.replace("- [ ] Map API fields", "- [x] Map API fields"),
				);
				ok(
					await cli(fx.dir, [
						"commit",
						"--run",
						runId,
						"--phase",
						"1",
						"--files",
						fx.planPath,
						"-m",
						"plan: check phase 1 against recorded review and quality",
					]),
				);
				const checked = ok(
					await cli(
						fx.dir,
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
							"1",
						],
						{ result: "complete", commit: git(fx.dir, "rev-parse", "HEAD") },
					),
				);
				expect(checked.ok).toBe(true);

				// Checklist verification through the corrected envelope query.
				const after = await phaseStatus(fx, "1");
				expect(after.phase).toMatchObject({
					done: true,
					executable: true,
					checklist_total: 2,
				});
				expect(after.executability?.executable).toBe(true);
				const state = ok(await cli(fx.dir, ["run", "state", "--run", runId]));
				const impl = state.data?.implementation_governance as
					| Record<string, unknown>
					| undefined;
				expect(JSON.stringify(impl)).not.toContain("gatelessHumanGate");
				// The ready review still governs: same binding, same reviewed code
				// endpoint, no open gate, and one review cycle with no quality rerun.
				expect(impl?.activeGate ?? null).toBeNull();
				expect(
					(impl?.binding as { id?: string; sourceRunId?: string } | undefined)
						?.id,
				).toBe(String(binding[0]?.id));
				expect(
					(impl?.reviewedRange as { reviewedCommit?: string } | undefined)
						?.reviewedCommit,
				).toBe(code);
				const telemetry = impl?.telemetry as
					| { reviewCycles: number; qualityReruns: number }
					| null
					| undefined;
				if (telemetry) {
					expect(telemetry.reviewCycles).toBe(1);
					expect(telemetry.qualityReruns).toBe(0);
				}
				ok(
					await cli(fx.dir, [
						"run",
						"record",
						"phase:complete",
						"--run",
						runId,
						"--phase",
						"1",
						"--result",
						'{"phase":"1"}',
					]),
				);

				// Remaining-phase continuation on the same run and binding.
				const next = ok(
					await cli(fx.dir, [
						"template",
						"render",
						"author-next-phase",
						"--run",
						runId,
						"--var",
						`plan_path=${fx.planPath}`,
						"--var",
						"phase_number=2",
						"--var",
						"user_notes=continue",
					]),
				);
				expect(next.data?.binding_id).toBe(binding[0]?.id);
				expect(next.data?.source_run_id).toBe(sourceId);
				// The effective prompt lets new work be checked before its first
				// review; recorded results gate only historical check-off.
				const nextPrompt = String(next.data?.prompt);
				expect(nextPrompt).toContain(
					"implement, test, and check off newly performed work as usual, including repaired boxes in phases not yet implemented",
				);
				expect(nextPrompt).toContain(
					"check those boxes before returning `complete`, since their first review follows your result.",
				);
				expect(nextPrompt).toContain(
					"only to check a box solely from carried historical evidence",
				);

				// Restart: rebuild the derived index and re-read state.
				ok(await cli(fx.dir, ["records", "index"]));
				const restarted = ok(
					await cli(fx.dir, ["run", "state", "--run", runId]),
				);
				expect(JSON.stringify(restarted.data)).toContain('"active"');

				// Continuity and invocation counts: one run, one binding, one
				// source, an unchanged baseline, and no additional review or
				// quality invocation caused by the repair.
				expect(ofKind(fx.dir, runId, "implementation-binding")).toEqual(
					binding,
				);
				expect(rawJournal(fx.dir, sourceId, "steps")).toBe(sourceSteps);
				expect(rawJournal(fx.dir, sourceId, "budget")).toBe(sourceBudget);
				const finalSteps = stepNames(fx.dir, runId);
				expect(
					finalSteps.filter((name) => name.startsWith("reviewer:")),
				).toEqual(["reviewer:commit"]);
				expect(
					finalSteps.filter((name) => name.startsWith("quality:")),
				).toHaveLength(1);
				expect(qualityRuns(fx.counter)).toBe(1);
				expect(ofKind(fx.dir, runId, "plan-checklist-repair")).toHaveLength(1);

				// Phase 2 is ordinary new work under repaired boxes: the author
				// implements it and checks its boxes, and the complete result is
				// accepted before any review of phase 2 exists.
				writeFileSync(
					join(fx.dir, "src", "modal.ts"),
					"export const closeOn = 'Escape';\n",
				);
				writeFileSync(
					fx.planPath,
					readFileSync(fx.planPath, "utf8")
						.replace("- [ ] Render the modal", "- [x] Render the modal")
						.replace("- [ ] Close on escape", "- [x] Close on escape"),
				);
				const phase2Code = String(
					ok(
						await cli(fx.dir, [
							"commit",
							"--run",
							runId,
							"--phase",
							"2",
							"-m",
							"feat: preview modal",
							"--all-files",
						]),
					).data?.hash,
				);
				const implemented = ok(
					await cli(
						fx.dir,
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
							"2",
							"--iteration",
							"0",
						],
						{ result: "complete", commit: phase2Code },
					),
				);
				expect(implemented.ok).toBe(true);
				expect(
					stepNames(fx.dir, runId).filter((name) =>
						name.startsWith("reviewer:"),
					),
				).toEqual(["reviewer:commit"]);
				expect((await phaseStatus(fx, "2")).phase).toMatchObject({
					done: true,
					executable: true,
					checklist_total: 2,
				});
				// Its first review and quality run then follow normally.
				ok(
					await cli(fx.dir, [
						"quality",
						"run",
						"--record",
						"--run",
						runId,
						"--phase",
						"2",
					]),
				);
				const context2 = String(
					ok(
						await cli(fx.dir, [
							"template",
							"render",
							"reviewer-commit",
							"--run",
							runId,
							"--var",
							"phase_number=2",
							"--var",
							`commit_hash=${phase2Code}`,
							"--var",
							`plan_path=${fx.planPath}`,
						]),
					).data?.review_context_id,
				);
				const reviewed2 = ok(
					await cli(
						fx.dir,
						[
							"protocol",
							"validate",
							"reviewer",
							"--run",
							runId,
							"--record",
							"--step",
							"reviewer:commit",
							"--phase",
							"2",
							"--iteration",
							"0",
							"--review-context",
							context2,
						],
						{ readiness: "ready", items: [] },
					),
				);
				expect(
					(
						reviewed2.data?.result as
							| { governance?: { route?: string } }
							| undefined
					)?.governance?.route,
				).toBe("complete");
				ok(
					await cli(fx.dir, [
						"run",
						"record",
						"phase:complete",
						"--run",
						runId,
						"--phase",
						"2",
						"--result",
						'{"phase":"2"}',
					]),
				);
				expect(qualityRuns(fx.counter)).toBe(2);
				expect(ofKind(fx.dir, runId, "plan-checklist-repair")).toHaveLength(1);
				expect(ofKind(fx.dir, runId, "implementation-binding")).toEqual(
					binding,
				);
				const runs = ok(await cli(fx.dir, ["run", "list"]));
				expect(JSON.stringify(runs.data)).toContain(runId);
			} finally {
				rmSync(fx.dir, { recursive: true, force: true });
				rmSync(join(fx.counter, ".."), { recursive: true, force: true });
			}
		},
		{ timeout: 120000 },
	);

	test.serial(
		"a scoped repair applies through the preview's selector-preserving command and retries identically",
		async () => {
			// The effective execution recipe applies `.data.next[0]` and keeps
			// the selection on every apply, re-preview and retry.
			const recipe = renderSkillByName(
				"5x-phase-execution",
				createRenderContext(true),
			).content;
			expect(recipe).toContain(
				"Apply with the command the preview returned in `.data.next[0]`",
			);
			expect(recipe).toContain(
				"every apply, re-preview, and retry repeats the same\n   selectors",
			);
			const placeholder = '"<operator repair instruction>"';
			const applyArgs = (command: string): string[] => {
				const [head, tail] = command.split(placeholder);
				expect(tail).toBe("");
				const words = String(head).trim().split(/\s+/);
				expect(words[0]).toBe("5x");
				return [...words.slice(1), INSTRUCTION];
			};

			const fx = await initRepo();
			try {
				await legacyApproval(fx);
				const runId = String(
					ok(await cli(fx.dir, ["run", "init", "--plan", fx.planPath])).data
						?.run_id,
				);
				mkdirSync(join(fx.dir, "src"), { recursive: true });
				writeFileSync(
					join(fx.dir, "src", "preview.ts"),
					"export type Preview = { tier: string };\n",
				);
				const code = String(
					ok(
						await cli(fx.dir, [
							"commit",
							"--run",
							runId,
							"--phase",
							"1",
							"-m",
							"feat: preview model",
							"--all-files",
						]),
					).data?.hash,
				);
				ok(
					await cli(
						fx.dir,
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
							"0",
							"--no-phase-checklist-validate",
						],
						{ result: "complete", commit: code },
					),
				);

				// The operator authorizes phase 1 only.
				const preview = ok(
					await cli(fx.dir, [
						"plan",
						"repair-checklists",
						"--run",
						runId,
						"--phase",
						"1",
						"--dry-run",
					]),
				);
				expect(
					((preview.data?.edits ?? []) as Array<{ after: string }>).map(
						(edit) => edit.after,
					),
				).toEqual(["- [ ] Add the preview type", "- [ ] Map API fields"]);
				const command = String(
					(preview.data?.next as string[] | undefined)?.[0],
				);
				expect(command).toBe(
					`5x plan repair-checklists --run ${runId} --phase 1 --apply --intent ${String(preview.data?.intentDigest)} --reason ${placeholder}`,
				);

				// Dropping the selector recomputes the unscoped candidate: refused
				// as stale with nothing written or recorded.
				const planBefore = readFileSync(fx.planPath, "utf8");
				const head = git(fx.dir, "rev-parse", "HEAD");
				const dropped = await cli(fx.dir, [
					"plan",
					"repair-checklists",
					"--run",
					runId,
					"--apply",
					"--intent",
					String(preview.data?.intentDigest),
					"--reason",
					INSTRUCTION,
				]);
				expect(dropped.exitCode).not.toBe(0);
				expect(envelope(dropped).error?.code).toBe(
					"PLAN_CHECKLIST_REPAIR_STALE",
				);
				expect(readFileSync(fx.planPath, "utf8")).toBe(planBefore);
				expect(git(fx.dir, "rev-parse", "HEAD")).toBe(head);
				expect(ofKind(fx.dir, runId, "plan-checklist-repair")).toHaveLength(0);

				// The returned command applies the authorized scope unchanged.
				const applied = ok(await cli(fx.dir, applyArgs(command)));
				expect(applied.data?.created).toBe(true);
				const receipts = ofKind(fx.dir, runId, "plan-checklist-repair");
				expect(receipts).toHaveLength(1);
				expect(receipts[0]?.reason).toBe(INSTRUCTION);
				expect(receipts[0]?.intentDigest).toBe(preview.data?.intentDigest);
				const repaired = readFileSync(fx.planPath, "utf8");
				expect(repaired).toContain("- [ ] Add the preview type");
				expect(repaired).toContain("- [ ] Map API fields");
				expect(repaired).toContain("\n- Render the modal\n");
				expect(repaired).toContain("\n- Final copy review\n");
				expect((await phaseStatus(fx, "1")).phase).toMatchObject({
					executable: true,
					checklist_total: 2,
				});

				// An identical retry with the same selectors returns the stored
				// receipt; nothing new is written or recorded.
				const afterApply = git(fx.dir, "rev-parse", "HEAD");
				const retried = ok(await cli(fx.dir, applyArgs(command)));
				expect(retried.data?.created).toBe(false);
				expect(retried.data?.recorded).toBe(true);
				expect(git(fx.dir, "rev-parse", "HEAD")).toBe(afterApply);
				expect(ofKind(fx.dir, runId, "plan-checklist-repair")).toHaveLength(1);
			} finally {
				rmSync(fx.dir, { recursive: true, force: true });
				rmSync(join(fx.counter, ".."), { recursive: true, force: true });
			}
		},
		{ timeout: 120000 },
	);
});
