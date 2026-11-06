/**
 * `5x plan repair-checklists`: operator-authorized mechanical checklist repair.
 *
 * File form repairs an unapproved draft in place and records nothing. Run
 * form proves the repair against the run's effective authorized anchor,
 * commits only the plan file, and pairs one `plan-checklist-repair` budget
 * line with its step. No reviewer invocation, gate, or new run is involved,
 * and no phase is marked complete.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { createReviewBudgetId } from "../control-plane/ids.js";
import { createWorkingTreeRecordStore } from "../control-plane/record-fs.js";
import type { RecordStore } from "../control-plane/record-store.js";
import {
	type RecordOrigin,
	RecordStoreError,
	recordedEnvelope,
	type StepRecordPayload,
} from "../control-plane/record-types.js";
import {
	createReviewBudgetStore,
	type ReviewBudgetStore,
} from "../control-plane/review-budget-store.js";
import { CliError } from "../output.js";
import {
	canonicalizePlanPath,
	planSlugFromPath,
	relativePathUnder,
} from "../paths.js";
import {
	type ChecklistRepairPlanResult,
	type ChecklistRepairSelection,
	checklistRepairDigest,
	planChecklistRepair,
	proveChecklistRepair,
} from "../plan-schema/checklist-repair.js";
import { resolveRecordsRoot } from "../records/paths.js";
import {
	decodePlanChecklistRepairPayload,
	encodePlanChecklistRepairPayload,
	type PlanChecklistRepairPayload,
	planChecklistRepairKey,
	planChecklistRepairStepKey,
} from "../review-budget/record-lines.js";
import {
	type ChecklistRepairSubject,
	hashPlanBytes,
	planDriftRecoveryHelp,
	planFileGoverningRun,
	readChecklistRepairSubject,
	showPlanAtCommit,
} from "../review-governance/implementation-state.js";
import {
	capturePlanSchemaMigrationExpectedKeys,
	commitOnly,
} from "../review-governance/schema-migration.js";
import { subprocess } from "../utils/subprocess.js";
import { resolveDbContext } from "./context.js";
import type { ReviewBudgetCommandContext } from "./review-budget-context.js";

export interface RepairChecklistsInput {
	planPath?: string;
	runId?: string;
	dryRun?: boolean;
	apply?: boolean;
	reason?: string;
	phases?: string[];
	lines?: string[];
	/** Intent digest from a preview. A different candidate is re-previewed. */
	intent?: string;
	checkpoint?: boolean;
	startDir?: string;
}

export function validateRepairChecklistsInput(
	input: RepairChecklistsInput,
): void {
	if ((input.planPath === undefined) === (input.runId === undefined)) {
		throw new CliError(
			"INVALID_ARGS",
			"Pass exactly one of --plan <path> (unapproved draft) or --run <id> (approved source or bound execution).",
		);
	}
	if (Boolean(input.dryRun) === Boolean(input.apply)) {
		throw new CliError(
			"INVALID_ARGS",
			"Pass exactly one of --dry-run or --apply.",
		);
	}
	if (input.runId !== undefined && input.apply) {
		if (!input.reason || input.reason.trim().length === 0) {
			throw new CliError(
				"INVALID_ARGS",
				'--apply on a run records the operator instruction: pass --reason "<the instruction you were given>".',
			);
		}
	}
}

export function parseRepairSelection(input: {
	phases?: string[];
	lines?: string[];
}): ChecklistRepairSelection | undefined {
	const phases = (input.phases ?? []).flatMap((value) =>
		value
			.split(",")
			.map((entry) => entry.trim().replace(/^phase[\s-]*/i, ""))
			.filter(Boolean),
	);
	const lines = (input.lines ?? []).flatMap((value) =>
		value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => {
				const match = entry.match(/^(\d+)(?:-(\d+))?$/);
				if (!match) {
					throw new CliError(
						"INVALID_ARGS",
						`--lines takes <start>-<end> line ranges; got ${entry}.`,
					);
				}
				const start = Number(match[1]);
				const end = Number(match[2] ?? match[1]);
				return { start, end };
			}),
	);
	if (phases.length === 0 && lines.length === 0) return undefined;
	return {
		...(phases.length > 0 ? { phases } : {}),
		...(lines.length > 0 ? { lines } : {}),
	};
}

function selectionFlags(selection: ChecklistRepairSelection | undefined) {
	const flags: string[] = [];
	for (const phase of selection?.phases ?? []) flags.push(`--phase ${phase}`);
	if (selection?.lines && selection.lines.length > 0) {
		flags.push(
			`--lines ${selection.lines.map((r) => `${r.start}-${r.end}`).join(",")}`,
		);
	}
	return flags;
}

function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function failPlan(
	result: Extract<ChecklistRepairPlanResult, { ok: false }>,
	help: { schema: 0 | 1 | null; runId?: string },
): never {
	if (result.code === "CHECKLIST_REPAIR_DISALLOWED") {
		throw new CliError(
			"PLAN_CHECKLIST_REPAIR_DISALLOWED",
			`${result.message} Nothing was written or recorded. Restore the listed lines, or route the real requirement change through the scoped amendment process.`,
			{
				disallowed: result.disallowed ?? [],
				...(help.runId
					? {
							amendmentHelp: planDriftRecoveryHelp(help.schema === 1 ? 1 : 0),
						}
					: {}),
			},
		);
	}
	throw new CliError(
		result.code === "CHECKLIST_REPAIR_SELECTION_INVALID"
			? "INVALID_ARGS"
			: result.code,
		result.message,
		result.unresolved ? { unresolved: result.unresolved } : undefined,
	);
}

function remainingWork(plan: Extract<ChecklistRepairPlanResult, { ok: true }>) {
	return {
		openItemsByPhase: plan.phases
			.filter((phase) => phase.itemsAfter > phase.checkedAfter)
			.map((phase) => ({
				phase: phase.id,
				open: phase.itemsAfter - phase.checkedAfter,
				total: phase.itemsAfter,
			})),
		unresolvedPhases: plan.unresolved,
		note: "Check a newly introduced box only after matching it to evidence already recorded for that unchanged obligation. This repair does not complete a phase or resolve a finding.",
	};
}

function previewOf(plan: Extract<ChecklistRepairPlanResult, { ok: true }>) {
	return {
		schema: plan.schema,
		repairAvailable: plan.edits.length > 0,
		edits: plan.edits,
		resetChecked: plan.resetChecked,
		preservedCheckboxToggles: plan.toggles,
		nestedPreserved: plan.nestedPreserved,
		phases: plan.phases,
		remainingWork: remainingWork(plan),
	};
}

// ---------------------------------------------------------------------------
// File form
// ---------------------------------------------------------------------------

async function repairPlanFile(input: RepairChecklistsInput) {
	const startDir = resolve(input.startDir ?? ".");
	const raw = input.planPath ?? "";
	const given = isAbsolute(raw) ? raw : resolve(startDir, raw);
	if (!existsSync(given)) {
		throw new CliError("PLAN_NOT_FOUND", `Plan file not found: ${given}`);
	}
	const dbContext = await resolveDbContext({ startDir });
	const controlPlaneRoot =
		dbContext.controlPlane?.controlPlaneRoot ??
		dbContext.projectRoot ??
		startDir;
	const canonical = canonicalizePlanPath(given);
	const records = resolveRecordsRoot({
		recordsConfigAbs: dbContext.config.paths.records,
		controlPlaneRoot,
		effectiveWorkdir: controlPlaneRoot,
	});
	const recordStore = createWorkingTreeRecordStore({
		recordsRoot: records.recordsAbsPath,
		controlPlaneRoot,
	});
	const store = createReviewBudgetStore(recordStore);
	const governing = planFileGoverningRun({
		recordStore,
		store,
		planPath: canonical,
	});
	if (governing) {
		const next = `5x plan repair-checklists --run ${governing.runId} --dry-run`;
		throw new CliError(
			"PLAN_CHECKLIST_REPAIR_REQUIRES_RUN",
			`This plan is governed by ${governing.kind === "execution" ? "the bound execution run" : "the completed plan-review approval on run"} ${governing.runId}. The file form would bypass that authority. Preview the run-aware repair instead: ${next}`,
			{ runId: governing.runId, subject: governing.kind, next: [next] },
		);
	}
	const target = editablePlanPath({ dbContext, given, canonical });
	const current = readFileSync(target, "utf8");
	const selection = parseRepairSelection(input);
	const plan = planChecklistRepair({
		anchorBytes: current,
		currentBytes: current,
		schema: "file",
		...(selection ? { selection } : {}),
	});
	if (!plan.ok) failPlan(plan, { schema: null });
	const intentDigest = checklistRepairDigest({
		scope: `file:${canonical}`,
		beforeBlobHash: hashPlanBytes(current),
		afterBlobHash: hashPlanBytes(plan.targetBytes),
		parentLineageId: null,
		edits: plan.edits,
	});
	const base = {
		form: "file" as const,
		path: target,
		intentDigest,
		recorded: false,
		completionAuthorized: false as const,
		...previewOf(plan),
	};
	if (input.intent !== undefined && input.intent !== intentDigest) {
		throw new CliError(
			"PLAN_CHECKLIST_REPAIR_STALE",
			"The plan changed since that preview. Review the refreshed candidate below; nothing was written.",
			base,
		);
	}
	const applyCommand = [
		"5x plan repair-checklists",
		`--plan ${quote(target)}`,
		...selectionFlags(selection),
		"--apply",
		`--intent ${intentDigest}`,
	].join(" ");
	if (input.dryRun || plan.edits.length === 0) {
		return {
			...base,
			wrote: false,
			next: plan.edits.length > 0 ? [applyCommand] : [],
			message:
				plan.edits.length > 0
					? "Preview only. Apply writes the plan file; then continue the ordinary review."
					: "No deterministic checklist repair is available. Unresolved phases need a selection or author work.",
		};
	}
	writeFileSync(target, plan.targetBytes);
	return {
		...base,
		wrote: true,
		next: [],
		message:
			"Wrote the repaired draft. No governance record was written; continue the ordinary plan review.",
	};
}

function editablePlanPath(input: {
	dbContext: Awaited<ReturnType<typeof resolveDbContext>>;
	given: string;
	canonical: string;
}): string {
	if (input.given !== input.canonical) return input.given;
	try {
		const row = input.dbContext.db
			.query("SELECT worktree_path FROM plans WHERE plan_path = ?1")
			.get(input.canonical) as { worktree_path: string | null } | null;
		const root = input.dbContext.controlPlane?.controlPlaneRoot;
		if (!row?.worktree_path || !root) return input.given;
		const rel = relativePathUnder(input.canonical, root);
		if (rel === null) return input.given;
		const mapped = join(row.worktree_path, rel);
		return existsSync(mapped) ? mapped : input.given;
	} catch {
		return input.given;
	}
}

// ---------------------------------------------------------------------------
// Run form
// ---------------------------------------------------------------------------

export interface RunRepairDeps {
	recordStore: RecordStore;
	store: ReviewBudgetStore;
	origin: RecordOrigin;
	planPath: string;
	readPlanAtCommit: (commit: string) => Promise<string | null>;
	readPlanFile: () => string | null;
	writePlanFile: (bytes: string) => void;
	/** Commit only the plan file; return the commit whose blob holds it. */
	commitPlanFile: (message: string) => Promise<{
		commit: string;
		committed: boolean;
	}>;
	checkpoint?: () => Promise<{
		committed: boolean;
		commit: string | null;
		path: string;
	}>;
}

function tipRepair(
	subject: ChecklistRepairSubject,
): PlanChecklistRepairPayload | undefined {
	const tip = subject.repairs.at(-1);
	return tip && tip.id === subject.parentLineageId ? tip : undefined;
}

function receiptOf(repair: PlanChecklistRepairPayload) {
	const { authorizedPlanBytes: _bytes, ...rest } = repair;
	return rest;
}

export async function repairChecklistsForRun(
	input: RepairChecklistsInput & { runId: string },
	deps: RunRepairDeps,
) {
	const expectedKeys = capturePlanSchemaMigrationExpectedKeys(
		deps.recordStore,
		input.runId,
	);
	const subjectResult = await readChecklistRepairSubject({
		store: deps.store,
		recordStore: deps.recordStore,
		runId: input.runId,
		readPlanAtCommit: deps.readPlanAtCommit,
	});
	if (!subjectResult.ok) {
		throw new CliError(
			subjectResult.code,
			subjectResult.message,
			subjectResult.detail,
		);
	}
	const subject = subjectResult.subject;
	const current = deps.readPlanFile();
	if (current === null) {
		throw new CliError(
			"PLAN_NOT_FOUND",
			`Plan file not found: ${deps.planPath}. A missing file is not an empty plan.`,
		);
	}
	const identity = {
		form: "run" as const,
		runId: input.runId,
		subject: subject.kind,
		bindingId: subject.bindingId,
		path: deps.planPath,
		completionAuthorized: false as const,
		preservedEvidence: {
			approval: "unchanged" as const,
			...(subject.evidence ?? {}),
			note: "A mechanical repair moves only the authorized plan anchor. Existing review, quality and debt evidence, completed phases and open findings are unchanged.",
		},
	};
	const selection = parseRepairSelection(input);
	const plan = planChecklistRepair({
		anchorBytes: subject.anchorBytes,
		currentBytes: current,
		schema: subject.schema,
		...(selection ? { selection } : {}),
	});
	if (!plan.ok) failPlan(plan, { schema: subject.schema, runId: input.runId });
	// Identical retry: the tip receipt already authorizes these exact bytes.
	const tip = tipRepair(subject);
	if (
		tip &&
		plan.edits.length === 0 &&
		tip.afterBlobHash === hashPlanBytes(current) &&
		(input.intent === undefined || input.intent === tip.intentDigest)
	) {
		const checkpoint =
			input.apply && input.checkpoint !== false && deps.checkpoint
				? await deps.checkpoint()
				: undefined;
		return {
			...identity,
			created: false,
			recorded: true,
			repairAvailable: false,
			intentDigest: tip.intentDigest,
			repair: receiptOf(tip),
			...(checkpoint ? { checkpoint } : {}),
			next: [],
			message:
				"This repair is already recorded for the current plan bytes. Resume the interrupted step.",
		};
	}
	const scope = `${subject.kind}:${input.runId}:${subject.bindingId ?? "-"}`;
	const digestFor = (
		bytes: string,
		edits: Extract<ChecklistRepairPlanResult, { ok: true }>["edits"],
	) =>
		checklistRepairDigest({
			scope,
			beforeBlobHash: subject.anchorHash,
			afterBlobHash: hashPlanBytes(bytes),
			parentLineageId: subject.parentLineageId,
			edits,
		});
	const intentDigest = digestFor(plan.targetBytes, plan.edits);
	const preview = {
		...identity,
		intentDigest,
		anchor: {
			commit: subject.anchorCommit,
			blobHash: subject.anchorHash,
			parentLineageId: subject.parentLineageId,
		},
		...previewOf(plan),
	};
	if (input.intent !== undefined && input.intent !== intentDigest) {
		throw new CliError(
			"PLAN_CHECKLIST_REPAIR_STALE",
			"The plan or run changed since that preview. The refreshed candidate is below; nothing was written or recorded. If its edits match what the operator already authorized, apply it with the new --intent.",
			preview,
		);
	}
	const applyCommand = [
		"5x plan repair-checklists",
		`--run ${input.runId}`,
		...selectionFlags(selection),
		"--apply",
		`--intent ${intentDigest}`,
		'--reason "<operator repair instruction>"',
	].join(" ");
	if (plan.edits.length === 0) {
		if (input.apply && plan.unresolved.length > 0) {
			throw new CliError(
				"PLAN_CHECKLIST_REPAIR_UNAVAILABLE",
				"No deterministic checklist repair is available. Select the list for each unresolved phase, or route missing requirements to the author.",
				preview,
			);
		}
		return {
			...preview,
			created: false,
			recorded: false,
			next: [],
			message:
				plan.unresolved.length > 0
					? "No deterministic repair. Select each ambiguous list with --phase/--lines; missing requirements need author work."
					: "Nothing to repair: the plan matches its authorized anchor apart from checkbox state.",
		};
	}
	if (input.dryRun) {
		return {
			...preview,
			created: false,
			recorded: false,
			next: [applyCommand],
			message:
				"Preview only. With the operator's instruction, apply records it and resumes the same run; no reviewer, gate, or new run is needed.",
		};
	}

	// Apply: write, commit the plan only, re-prove the committed blob, record.
	if (plan.targetBytes !== current) deps.writePlanFile(plan.targetBytes);
	const committed = await deps.commitPlanFile(
		`5x: mechanical checklist repair for ${input.runId}`,
	);
	const committedBytes = await deps.readPlanAtCommit(committed.commit);
	if (committedBytes === null) {
		throw new CliError(
			"PLAN_CHECKLIST_REPAIR_COMMIT_FAILED",
			`Plan bytes at ${committed.commit} are unavailable after the repair commit. Nothing was recorded; repeat the same command.`,
		);
	}
	let recordedBytes = plan.targetBytes;
	let edits = plan.edits;
	if (committedBytes !== plan.targetBytes) {
		// A commit hook may rewrite the file. Prove the bytes git holds.
		const proof = proveChecklistRepair({
			beforeBytes: subject.anchorBytes,
			afterBytes: committedBytes,
			schema: subject.schema,
		});
		if (
			!proof.ok ||
			proof.edits.length === 0 ||
			proof.checkedIntroductions.length > 0
		) {
			throw new CliError(
				"PLAN_CHECKLIST_REPAIR_HOOK_CHANGED",
				`The committed plan at ${committed.commit} is not a mechanical checklist repair of the authorized anchor (a hook or concurrent edit changed it). Nothing was recorded.`,
				proof.ok ? undefined : { disallowed: proof.disallowed },
			);
		}
		recordedBytes = committedBytes;
		edits = proof.edits;
	}
	const recordedDigest = digestFor(recordedBytes, edits);
	const payload: PlanChecklistRepairPayload = {
		kind: "plan-checklist-repair",
		version: 1,
		id: `checklist-repair:${createReviewBudgetId()}`,
		runId: input.runId,
		subject: subject.kind,
		bindingId: subject.bindingId,
		parentLineageId: subject.parentLineageId,
		beforeCommit: subject.anchorCommit,
		afterCommit: committed.commit,
		beforeBlobHash: subject.anchorHash,
		afterBlobHash: hashPlanBytes(recordedBytes),
		authorizedPlanBytes: recordedBytes,
		planSchema: subject.schema,
		edits,
		resetCheckedLines: plan.resetChecked.map((reset) => reset.line),
		reason: (input.reason ?? "").trim(),
		intentDigest: recordedDigest,
		createdAt: new Date().toISOString(),
	};
	const step: StepRecordPayload = {
		step_name: "checklist-repair",
		phase: null,
		iteration: 0,
		result_json: {
			repairId: payload.id,
			intentDigest: payload.intentDigest,
			afterCommit: payload.afterCommit,
			subject: payload.subject,
			reason: payload.reason,
		},
		head_commit: payload.afterCommit,
		patch_id: null,
		diff_summary: null,
		duration_ms: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		model: null,
	};
	let appended: ReturnType<RecordStore["atomicAppendIfAllNew"]>;
	try {
		appended = deps.recordStore.atomicAppendIfAllNew(
			[
				{
					runId: input.runId,
					stream: "budget",
					idempotencyKey: planChecklistRepairKey(input.runId, recordedDigest),
					payload: encodePlanChecklistRepairPayload(payload),
					createdAt: payload.createdAt,
					...recordedEnvelope(deps.origin),
				},
				{
					runId: input.runId,
					stream: "steps",
					idempotencyKey: planChecklistRepairStepKey(
						input.runId,
						recordedDigest,
					),
					payload: step,
					createdAt: payload.createdAt,
					...recordedEnvelope(deps.origin),
				},
			],
			expectedKeys,
		);
	} catch (error) {
		if (
			error instanceof RecordStoreError &&
			error.code === "RECORD_PRECONDITION_FAILED"
		) {
			throw new CliError(
				"RECORD_PRECONDITION_FAILED",
				`Run history changed during the repair. The plan commit ${committed.commit} is kept; repeat the same command to record it (the identical retry resumes against that commit).`,
			);
		}
		throw error;
	}
	let stored = payload;
	let created = appended.created;
	if (!appended.created) {
		const winner = appended.duplicates
			.map((entry) => entry.line.payload)
			.find(
				(candidate) =>
					(candidate as { kind?: unknown } | null)?.kind ===
					"plan-checklist-repair",
			);
		const decoded = winner
			? decodePlanChecklistRepairPayload(winner)
			: undefined;
		if (!decoded || decoded.afterBlobHash !== payload.afterBlobHash) {
			throw new CliError(
				"PLAN_CHECKLIST_REPAIR_CONFLICT",
				"A concurrent checklist repair won this attempt. Inspect the stored record and re-preview.",
			);
		}
		stored = decoded;
		created = false;
	}
	const checkpoint =
		input.checkpoint !== false && deps.checkpoint
			? await deps.checkpoint()
			: undefined;
	return {
		...identity,
		created,
		recorded: true,
		intentDigest: stored.intentDigest,
		anchor: {
			commit: stored.afterCommit,
			blobHash: stored.afterBlobHash,
			parentLineageId: stored.id,
		},
		...previewOf(plan),
		commit: committed.commit,
		committed: committed.committed,
		repair: receiptOf(stored),
		...(checkpoint ? { checkpoint } : {}),
		next: [],
		message:
			"Repair recorded on the same run. Resume the interrupted step; check new boxes only against matching recorded evidence.",
	};
}

/** CLI wiring: context, worktree plan path and plan-only commits. */
export async function repairChecklists(
	input: RepairChecklistsInput,
	runContext?: (runId: string) => Promise<ReviewBudgetCommandContext>,
) {
	validateRepairChecklistsInput(input);
	if (input.planPath !== undefined) return repairPlanFile(input);
	const runId = input.runId as string;
	if (!runContext) {
		throw new CliError("INVALID_ARGS", "--run requires a run context.");
	}
	const ctx = await runContext(runId);
	const execution = ctx.executionContext;
	const workdir = execution.effectiveWorkingDirectory;
	const planPath = execution.effectivePlanPath;
	const readPlanAtCommit = (commit: string) =>
		showPlanAtCommit(workdir, commit, execution.run.plan_path, {
			repoRoot: execution.controlPlaneRoot,
		});
	return repairChecklistsForRun(
		{ ...input, runId },
		{
			recordStore: ctx.recordStore,
			store: ctx.store,
			origin: ctx.originFor({ kind: "human", role: "operator" }),
			planPath,
			readPlanAtCommit,
			readPlanFile: () =>
				existsSync(planPath) ? readFileSync(planPath, "utf8") : null,
			writePlanFile: (bytes) => writeFileSync(planPath, bytes),
			commitPlanFile: async (message) => {
				const result = await commitOnly(workdir, planPath, message, {
					code: "PLAN_CHECKLIST_REPAIR_COMMIT_FAILED",
					failure:
						"The repaired plan is written but not committed; nothing was recorded. Fix the failure, then repeat the same command.",
				});
				if (result.committed && result.commit) {
					return { commit: result.commit, committed: true };
				}
				return {
					commit: await lastPlanCommit(workdir, planPath),
					committed: false,
				};
			},
			checkpoint: async () => {
				const slug = planSlugFromPath(execution.run.plan_path);
				const path = posix.join(ctx.recordsRelPath, slug, runId);
				if (!existsSync(join(ctx.recordsAbsPath, slug, runId))) {
					return { committed: false, commit: null, path };
				}
				const result = await commitOnly(
					workdir,
					path,
					`5x: record checklist repair for ${runId}`,
					{
						code: "PLAN_CHECKLIST_REPAIR_CHECKPOINT_FAILED",
						failure: `The repair is recorded but ${path} is not committed. Repeat the same command: the identical retry returns the stored record and retries the checkpoint. Pass --no-checkpoint to commit the records yourself.`,
					},
				);
				return { ...result, path };
			},
		},
	);
}

/** The commit that last wrote the plan file: the resumable repair commit. */
async function lastPlanCommit(
	workdir: string,
	planPath: string,
): Promise<string> {
	const log = await subprocess.execGit(
		["log", "-1", "--format=%H", "--", planPath],
		workdir,
	);
	const commit = log.stdout.trim();
	if (log.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
		throw new CliError(
			"PLAN_CHECKLIST_REPAIR_COMMIT_FAILED",
			`Could not find the commit holding the plan file. ${(log.stderr || log.stdout).trim()}`,
		);
	}
	return commit;
}
