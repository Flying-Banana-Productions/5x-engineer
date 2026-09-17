/**
 * Export historical SQLite `runs` / `steps` (and answered prompts) into
 * git-native run records. Original origin and summary attribution stay
 * unknown; the exporter is a separate `materializer`.
 *
 * `--target auto` does not fetch. Remote-tracking refs are used as-is.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FiveXConfig } from "../config.js";
import {
	createWorkingTreeRecordStore,
	type PromptRecord,
	type PromptStore,
	RECORD_LINE_SCHEMA_VERSION,
	type RecordLine,
	type RecordOrigin,
	type RecordPerformer,
	type RecordStore,
	RUN_RECORD_FORMAT_VERSION,
	type RunRecordSummary,
	redactStepPayload,
	type StepRecordPayload,
	stepIdempotencyKey,
} from "../control-plane/index.js";
import {
	decodeJsonlFile,
	parseRunJson,
	STREAM_FILES,
} from "../control-plane/record-layout.js";
import { createSqlitePromptStore } from "../control-plane/sqlite-store.js";
import { getPlan } from "../db/operations.js";
import {
	getRunV1,
	getSteps,
	listRuns,
	type RunRowV1,
	type StepRow,
} from "../db/operations-v1.js";
import {
	addWorktreeForBranch,
	branchExists,
	commitFiles,
	computeDiffSummary,
	computePatchId,
	getCurrentBranch,
	gitShowFile,
	hasUncommittedChanges,
	listFiveXRefs,
	listRemotes,
	listWorktrees,
	removeWorktree,
	revParseCommit,
} from "../git.js";
import { planSlugFromPath, realpathExisting } from "../paths.js";
import { version } from "../version.js";
import { resolveRecordsRoot } from "./paths.js";

const EXPORTER_PERFORMER: RecordPerformer = {
	kind: "system",
	role: "exporter",
};

export class RecordsBackfillError extends Error {
	readonly code: string;
	readonly detail: unknown;
	constructor(code: string, message: string, detail?: unknown) {
		super(message);
		this.name = "RecordsBackfillError";
		this.code = code;
		this.detail = detail;
	}
}

export interface BackfillParams {
	planSlug?: string;
	target: "auto" | string;
	dryRun: boolean;
	startDir?: string;
}

export interface BackfillLineResult {
	key: string;
	created: boolean;
}

export interface BackfillMapping {
	run_id: string;
	plan_path: string;
	target_branch: string;
	worktree: string | null;
	files: string[];
	disagreements: Array<{ key: string; reason: string }>;
	lines: BackfillLineResult[];
}

export interface BackfillCommit {
	branch: string;
	message: string;
	created: boolean;
}

export interface BackfillResult {
	dry_run: boolean;
	mappings: BackfillMapping[];
	commits: BackfillCommit[];
	exported_by: RecordOrigin;
}

export interface BackfillRecordsOpts {
	db: Database;
	config: FiveXConfig;
	workdir: string;
	planSlug?: string;
	target: "auto" | string;
	dryRun: boolean;
	originFor: (performer: RecordPerformer) => RecordOrigin;
	promptStore?: PromptStore;
}

interface ResolvedTarget {
	branch: string;
	/** Existing checkout to write into; null means a temp worktree (or dry-run unknown). */
	worktree: string | null;
	needsTempWorktree: boolean;
	/** Remote-tracking ref to create the local branch from, when it does not exist locally. */
	startPoint?: string;
	fallback: boolean;
}

interface PreparedRun {
	run: RunRowV1;
	slug: string;
	summary: RunRecordSummary;
	stepOps: Array<{
		key: string;
		payload: StepRecordPayload;
		createdAt: string;
		human: boolean;
	}>;
	decisionOps: Array<{
		key: string;
		payload: unknown;
		createdAt: string;
	}>;
	files: string[];
	target: ResolvedTarget;
}

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

function posixJoin(...parts: string[]): string {
	return parts
		.map((p) => toPosix(p).replace(/^\/+|\/+$/g, ""))
		.filter(Boolean)
		.join("/");
}

function payloadsEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function asRunStatus(status: string): RunRecordSummary["status"] {
	if (status === "completed" || status === "aborted" || status === "active") {
		return status;
	}
	return "active";
}

function parseConfigJson(raw: string | null): unknown {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

function parseResultJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return raw;
	}
}

function isTerminalStatus(status: string): boolean {
	return status === "completed" || status === "aborted";
}

async function shaReachable(workdir: string, sha: string): Promise<boolean> {
	const resolved = await revParseCommit(workdir, sha);
	return resolved !== null;
}

async function checkoutOnBranch(
	checkout: string,
	branch: string,
): Promise<boolean> {
	try {
		const current = await getCurrentBranch(checkout);
		return current === branch;
	} catch {
		return false;
	}
}

/**
 * Map an explicit `--target` to a local branch plus optional start point.
 * Remote-tracking refs (for example `origin/foo`, or a unique remote
 * counterpart of `foo`) create or check out the local name from that ref —
 * never from HEAD.
 */
async function resolveExplicitTarget(
	workdir: string,
	requested: string,
): Promise<{ branch: string; startPoint?: string }> {
	if (await branchExists(requested, workdir)) {
		return { branch: requested };
	}

	const asRemoteTracking = await revParseCommit(
		workdir,
		`refs/remotes/${requested}`,
	);
	if (asRemoteTracking) {
		const remotes = await listRemotes(workdir);
		const remote = remotes
			.filter((r) => requested === r || requested.startsWith(`${r}/`))
			.sort((a, b) => b.length - a.length)[0];
		const localBranch =
			remote && requested.startsWith(`${remote}/`)
				? requested.slice(remote.length + 1)
				: requested;
		if (!localBranch) {
			return { branch: requested, startPoint: requested };
		}
		if (await branchExists(localBranch, workdir)) {
			return { branch: localBranch };
		}
		return { branch: localBranch, startPoint: requested };
	}

	const remotes = await listRemotes(workdir);
	const matches: string[] = [];
	for (const remote of remotes) {
		const ref = `${remote}/${requested}`;
		if (await revParseCommit(workdir, `refs/remotes/${ref}`)) {
			matches.push(ref);
		}
	}
	if (matches.length === 1 && matches[0]) {
		return { branch: requested, startPoint: matches[0] };
	}

	const parsed = await revParseCommit(workdir, requested);
	if (parsed !== null) {
		return { branch: requested, startPoint: requested };
	}

	throw new RecordsBackfillError(
		"BACKFILL_TARGET_NOT_FOUND",
		`Target branch "${requested}" does not exist locally or as a remote-tracking ref. Fetch first; backfill does not fetch.`,
		{ branch: requested },
	);
}

async function resolveTarget(opts: {
	workdir: string;
	slug: string;
	target: "auto" | string;
	mappedWorktreePath: string | null;
}): Promise<ResolvedTarget> {
	const current = await getCurrentBranch(opts.workdir);

	const useMappedIfOnBranch = async (
		branch: string,
	): Promise<string | null> => {
		if (
			opts.mappedWorktreePath &&
			existsSync(opts.mappedWorktreePath) &&
			(await checkoutOnBranch(opts.mappedWorktreePath, branch))
		) {
			return opts.mappedWorktreePath;
		}
		if (current === branch) return opts.workdir;
		const trees = await listWorktrees(opts.workdir);
		for (const tree of trees) {
			if (tree.branch !== branch) continue;
			try {
				if (
					realpathExisting(tree.path) === realpathExisting(opts.workdir) ||
					(opts.mappedWorktreePath &&
						realpathExisting(tree.path) ===
							realpathExisting(opts.mappedWorktreePath))
				) {
					return tree.path;
				}
			} catch {
				/* ignore */
			}
			if (
				existsSync(tree.path) &&
				(await checkoutOnBranch(tree.path, branch))
			) {
				return tree.path;
			}
		}
		return null;
	};

	if (opts.target !== "auto") {
		const resolved = await resolveExplicitTarget(opts.workdir, opts.target);
		const existing = await useMappedIfOnBranch(resolved.branch);
		return {
			branch: resolved.branch,
			worktree: existing,
			needsTempWorktree: existing === null,
			startPoint: resolved.startPoint,
			fallback: false,
		};
	}

	const fiveX = await listFiveXRefs(opts.workdir);
	const localName = `5x/${opts.slug}`;
	const local = fiveX.local.includes(localName);
	const remote = fiveX.remote.find(
		(r) => r.ref.endsWith(`/${localName}`) || r.ref === localName,
	);
	if (local || remote) {
		const existing = await useMappedIfOnBranch(localName);
		return {
			branch: localName,
			worktree: existing,
			needsTempWorktree: existing === null,
			startPoint: local ? undefined : remote?.ref,
			fallback: false,
		};
	}

	return {
		branch: current,
		worktree: opts.workdir,
		needsTempWorktree: false,
		fallback: true,
	};
}

function recordFiles(
	recordsRelPath: string,
	slug: string,
	runId: string,
	includeSteps: boolean,
	includeDecisions: boolean,
): string[] {
	const dir = posixJoin(recordsRelPath, slug, runId);
	const files = [posixJoin(dir, "run.json")];
	if (includeSteps) files.push(posixJoin(dir, STREAM_FILES.steps));
	if (includeDecisions) files.push(posixJoin(dir, STREAM_FILES.decisions));
	return files;
}

function buildSummary(
	run: RunRowV1,
	steps: StepRow[],
	materializer: RecordOrigin,
): RunRecordSummary {
	const status = asRunStatus(run.status);
	const terminal = isTerminalStatus(status);
	let finalHead: string | null = null;
	for (const step of steps) {
		if (step.head_commit) finalHead = step.head_commit;
	}
	const summary: RunRecordSummary = {
		id: run.id,
		plan_path: run.plan_path,
		config_json: parseConfigJson(run.config_json),
		created_at: run.created_at,
		sealed_at: terminal ? run.updated_at : null,
		status,
		final_head_commit: terminal ? finalHead : null,
		cli_version: version,
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: null,
		materializer,
	};
	if (terminal) {
		summary.sealer = null;
	} else {
		summary.backfilled = true;
	}
	return summary;
}

async function buildStepOps(
	workdir: string,
	runId: string,
	steps: StepRow[],
	redact: string[],
): Promise<PreparedRun["stepOps"]> {
	const ops: PreparedRun["stepOps"] = [];
	let previousHead: string | null = null;
	for (const step of steps) {
		let patchId: string | null = null;
		let diffSummary: StepRecordPayload["diff_summary"] = null;
		const head = step.head_commit;
		if (
			previousHead &&
			head &&
			(await shaReachable(workdir, previousHead)) &&
			(await shaReachable(workdir, head))
		) {
			try {
				patchId = await computePatchId(workdir, previousHead, head);
			} catch {
				patchId = null;
			}
			try {
				diffSummary = await computeDiffSummary(workdir, previousHead, head);
			} catch {
				diffSummary = null;
			}
		}
		const payload = redactStepPayload(
			{
				step_name: step.step_name,
				phase: step.phase,
				iteration: step.iteration,
				result_json: parseResultJson(step.result_json),
				head_commit: head,
				patch_id: patchId,
				diff_summary: diffSummary,
				duration_ms: step.duration_ms,
				tokens_in: step.tokens_in,
				tokens_out: step.tokens_out,
				cost_usd: step.cost_usd,
				model: step.model,
			},
			redact,
		);
		ops.push({
			key: stepIdempotencyKey({
				runId,
				stepName: step.step_name,
				phase: step.phase,
				iteration: step.iteration,
			}),
			payload,
			createdAt: step.created_at,
			human: step.step_name.startsWith("human:"),
		});
		if (head) previousHead = head;
	}
	return ops;
}

function promptDecisionPayload(prompt: PromptRecord): unknown {
	return {
		kind: "answered-prompt",
		prompt_id: prompt.id,
		kind_prompt: prompt.kind,
		message: prompt.message,
		answer: prompt.answer,
		answered_by: prompt.answeredBy,
	};
}

function humanDecisionPayload(step: PreparedRun["stepOps"][number]): unknown {
	return {
		kind: "human-step",
		step_name: step.payload.step_name,
		phase: step.payload.phase,
		iteration: step.payload.iteration,
		result_json: step.payload.result_json,
	};
}

interface ExistingSnapshot {
	summary: RunRecordSummary | null;
	lines: Map<string, RecordLine>;
}

function snapshotFromStore(
	store: RecordStore,
	runId: string,
): ExistingSnapshot {
	const summary = store.getRun(runId);
	if (!summary) return { summary: null, lines: new Map() };
	const lines = new Map<string, RecordLine>();
	for (const stream of ["steps", "decisions"] as const) {
		for (const line of store.listLines(runId, stream)) {
			lines.set(line.idempotencyKey, line);
		}
	}
	return { summary, lines };
}

async function snapshotFromGit(
	workdir: string,
	branch: string,
	recordsRelPath: string,
	slug: string,
	runId: string,
): Promise<ExistingSnapshot> {
	const dir = posixJoin(recordsRelPath, slug, runId);
	const runText = await gitShowFile(
		workdir,
		branch,
		posixJoin(dir, "run.json"),
	);
	let summary: RunRecordSummary | null = null;
	if (runText) {
		try {
			summary = parseRunJson(runText);
		} catch {
			summary = null;
		}
	}
	const lines = new Map<string, RecordLine>();
	for (const stream of ["steps", "decisions"] as const) {
		const text = await gitShowFile(
			workdir,
			branch,
			posixJoin(dir, STREAM_FILES[stream]),
		);
		if (!text) continue;
		try {
			for (const line of decodeJsonlFile(text, runId)) {
				if (!lines.has(line.idempotencyKey)) {
					lines.set(line.idempotencyKey, line);
				}
			}
		} catch {
			/* ignore corrupt */
		}
	}
	return { summary, lines };
}

function isRecordedSummary(summary: RunRecordSummary): boolean {
	return summary.backfilled !== true && summary.creator !== null;
}

function summariesEquivalent(
	existing: RunRecordSummary,
	next: RunRecordSummary,
): boolean {
	return (
		existing.id === next.id &&
		existing.plan_path === next.plan_path &&
		existing.status === next.status &&
		existing.sealed_at === next.sealed_at &&
		existing.final_head_commit === next.final_head_commit &&
		existing.creator === next.creator &&
		existing.sealer === next.sealer &&
		Boolean(existing.backfilled) === Boolean(next.backfilled) &&
		payloadsEqual(existing.config_json, next.config_json)
	);
}

function classifyLine(
	existing: RecordLine | undefined,
	payload: unknown,
): { created: boolean; disagreement?: { key: string; reason: string } } {
	if (!existing) return { created: true };
	if (existing.provenance === "recorded") {
		return {
			created: false,
			disagreement: {
				key: existing.idempotencyKey,
				reason: "recorded-vs-backfill",
			},
		};
	}
	if (!payloadsEqual(existing.payload, payload)) {
		return {
			created: false,
			disagreement: {
				key: existing.idempotencyKey,
				reason: "payload-mismatch",
			},
		};
	}
	return { created: false };
}

function classifySummary(
	existing: RunRecordSummary | null,
	next: RunRecordSummary,
): { write: boolean; disagreement?: { key: string; reason: string } } {
	if (!existing) return { write: true };
	if (isRecordedSummary(existing)) {
		return {
			write: false,
			disagreement: { key: "run.json", reason: "recorded-vs-backfill" },
		};
	}
	if (summariesEquivalent(existing, next)) {
		return { write: false };
	}
	return {
		write: false,
		disagreement: { key: "run.json", reason: "summary-mismatch" },
	};
}

function backfillEnvelope(materializer: RecordOrigin): {
	schemaVersion: number;
	provenance: "backfilled";
	origin: null;
	materializer: RecordOrigin;
} {
	return {
		schemaVersion: RECORD_LINE_SCHEMA_VERSION,
		provenance: "backfilled",
		origin: null,
		materializer,
	};
}

function commitMessageFor(runIds: string[], fallback: boolean): string {
	if (fallback) return "5x: backfill records";
	return `5x: backfill records for ${[...runIds].sort().join(", ")}`;
}

async function ensureTargetWorktree(
	workdir: string,
	target: ResolvedTarget,
	temps: string[],
): Promise<string> {
	if (target.worktree) return target.worktree;
	const path = mkdtempSync(join(tmpdir(), "5x-backfill-wt-"));
	temps.push(path);
	await addWorktreeForBranch(workdir, path, target.branch, target.startPoint);
	return path;
}

async function existingSnapshot(opts: {
	workdir: string;
	writeRoot: string | null;
	branch: string;
	recordsRelPath: string;
	slug: string;
	runId: string;
	config: FiveXConfig;
	controlPlaneRoot: string;
}): Promise<ExistingSnapshot> {
	if (opts.writeRoot && existsSync(opts.writeRoot)) {
		const resolved = resolveRecordsRoot({
			recordsConfigAbs: opts.config.paths.records,
			controlPlaneRoot: opts.controlPlaneRoot,
			effectiveWorkdir: opts.writeRoot,
		});
		if (existsSync(resolved.recordsAbsPath)) {
			const store = createWorkingTreeRecordStore({
				recordsRoot: resolved.recordsAbsPath,
			});
			return snapshotFromStore(store, opts.runId);
		}
	}
	return snapshotFromGit(
		opts.workdir,
		opts.branch,
		opts.recordsRelPath,
		opts.slug,
		opts.runId,
	);
}

function applyPrepared(
	store: RecordStore,
	prepared: PreparedRun,
	existing: ExistingSnapshot,
	materializer: RecordOrigin,
): {
	disagreements: BackfillMapping["disagreements"];
	lines: BackfillLineResult[];
} {
	const envelope = backfillEnvelope(materializer);
	const disagreements: BackfillMapping["disagreements"] = [];
	const lines: BackfillLineResult[] = [];

	const summaryClass = classifySummary(existing.summary, prepared.summary);
	if (summaryClass.disagreement) disagreements.push(summaryClass.disagreement);
	if (summaryClass.write) {
		store.putRun(prepared.summary);
	}
	lines.push({ key: "run.json", created: summaryClass.write });

	const appendOps = [];
	for (const step of prepared.stepOps) {
		const cls = classifyLine(existing.lines.get(step.key), step.payload);
		if (cls.disagreement) disagreements.push(cls.disagreement);
		lines.push({ key: step.key, created: cls.created });
		if (cls.created) {
			appendOps.push({
				runId: prepared.run.id,
				stream: "steps" as const,
				idempotencyKey: step.key,
				payload: step.payload,
				createdAt: step.createdAt,
				...envelope,
			});
		}
		if (step.human) {
			const dKey = `decision:human:${step.key}`;
			const dPayload = humanDecisionPayload(step);
			const dCls = classifyLine(existing.lines.get(dKey), dPayload);
			if (dCls.disagreement) disagreements.push(dCls.disagreement);
			lines.push({ key: dKey, created: dCls.created });
			if (dCls.created) {
				appendOps.push({
					runId: prepared.run.id,
					stream: "decisions" as const,
					idempotencyKey: dKey,
					payload: dPayload,
					createdAt: step.createdAt,
					...envelope,
				});
			}
		}
	}
	for (const dec of prepared.decisionOps) {
		const cls = classifyLine(existing.lines.get(dec.key), dec.payload);
		if (cls.disagreement) disagreements.push(cls.disagreement);
		lines.push({ key: dec.key, created: cls.created });
		if (cls.created) {
			appendOps.push({
				runId: prepared.run.id,
				stream: "decisions" as const,
				idempotencyKey: dec.key,
				payload: dec.payload,
				createdAt: dec.createdAt,
				...envelope,
			});
		}
	}
	if (appendOps.length > 0) {
		if (store.getRun(prepared.run.id) === null) {
			if (summaryClass.disagreement?.reason !== "recorded-vs-backfill") {
				store.putRun(prepared.summary);
				store.atomicAppend(appendOps);
			}
		} else {
			store.atomicAppend(appendOps);
		}
	}
	return { disagreements, lines };
}

function classifyDryRun(
	prepared: PreparedRun,
	existing: ExistingSnapshot,
): {
	disagreements: BackfillMapping["disagreements"];
	lines: BackfillLineResult[];
} {
	const disagreements: BackfillMapping["disagreements"] = [];
	const lines: BackfillLineResult[] = [];
	const summaryClass = classifySummary(existing.summary, prepared.summary);
	if (summaryClass.disagreement) disagreements.push(summaryClass.disagreement);
	lines.push({ key: "run.json", created: summaryClass.write });
	for (const step of prepared.stepOps) {
		const cls = classifyLine(existing.lines.get(step.key), step.payload);
		if (cls.disagreement) disagreements.push(cls.disagreement);
		lines.push({ key: step.key, created: cls.created });
		if (step.human) {
			const dKey = `decision:human:${step.key}`;
			const dCls = classifyLine(
				existing.lines.get(dKey),
				humanDecisionPayload(step),
			);
			if (dCls.disagreement) disagreements.push(dCls.disagreement);
			lines.push({ key: dKey, created: dCls.created });
		}
	}
	for (const dec of prepared.decisionOps) {
		const cls = classifyLine(existing.lines.get(dec.key), dec.payload);
		if (cls.disagreement) disagreements.push(cls.disagreement);
		lines.push({ key: dec.key, created: cls.created });
	}
	return { disagreements, lines };
}

export async function backfillRecords(
	opts: BackfillRecordsOpts,
): Promise<BackfillResult> {
	const { db, config, workdir, planSlug, target, dryRun, originFor } = opts;
	const materializer = originFor(EXPORTER_PERFORMER);
	const promptStore = opts.promptStore ?? createSqlitePromptStore(db);
	const recordsRelPath = resolveRecordsRoot({
		recordsConfigAbs: config.paths.records,
		controlPlaneRoot: workdir,
		effectiveWorkdir: workdir,
	}).recordsRelPath;

	const listed = listRuns(db, { limit: 0 });
	const filtered = listed.filter((row) => {
		if (!planSlug) return true;
		return planSlugFromPath(row.plan_path) === planSlug;
	});
	filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const prepared: PreparedRun[] = [];
	for (const row of filtered) {
		const run = getRunV1(db, row.id);
		if (!run) continue;
		const slug = planSlugFromPath(run.plan_path);
		const mapped = getPlan(db, run.plan_path);
		const targetInfo = await resolveTarget({
			workdir,
			slug,
			target,
			mappedWorktreePath: mapped?.worktree_path ?? null,
		});
		const steps = getSteps(db, run.id);
		const stepOps = await buildStepOps(
			workdir,
			run.id,
			steps,
			config.records.redact,
		);
		const answered = promptStore.listAnsweredPrompts?.(run.id) ?? [];
		const decisionOps = answered.map((prompt) => ({
			key: `decision:prompt:${prompt.id}`,
			payload: promptDecisionPayload(prompt),
			createdAt: prompt.answeredAt ?? prompt.createdAt,
		}));
		const files = recordFiles(
			recordsRelPath,
			slug,
			run.id,
			stepOps.length > 0,
			decisionOps.length > 0 || stepOps.some((s) => s.human),
		);
		prepared.push({
			run,
			slug,
			summary: buildSummary(run, steps, materializer),
			stepOps,
			decisionOps,
			files,
			target: targetInfo,
		});
	}

	const mappings: BackfillMapping[] = [];
	const commits: BackfillCommit[] = [];

	if (dryRun) {
		for (const item of prepared) {
			const existing = await existingSnapshot({
				workdir,
				writeRoot: item.target.worktree,
				branch: item.target.branch,
				recordsRelPath,
				slug: item.slug,
				runId: item.run.id,
				config,
				controlPlaneRoot: workdir,
			});
			const classified = classifyDryRun(item, existing);
			mappings.push({
				run_id: item.run.id,
				plan_path: item.run.plan_path,
				target_branch: item.target.branch,
				worktree: item.target.needsTempWorktree ? null : item.target.worktree,
				files: item.files,
				disagreements: classified.disagreements,
				lines: classified.lines,
			});
		}
		return { dry_run: true, mappings, commits, exported_by: materializer };
	}

	const groups = new Map<
		string,
		{ items: PreparedRun[]; target: ResolvedTarget }
	>();
	for (const item of prepared) {
		const group = groups.get(item.target.branch);
		if (group) group.items.push(item);
		else groups.set(item.target.branch, { items: [item], target: item.target });
	}

	const temps: string[] = [];
	try {
		for (const [branch, group] of groups) {
			const writeRoot = await ensureTargetWorktree(
				workdir,
				group.target,
				temps,
			);
			const resolved = resolveRecordsRoot({
				recordsConfigAbs: config.paths.records,
				controlPlaneRoot: workdir,
				effectiveWorkdir: writeRoot,
			});
			const store = createWorkingTreeRecordStore({
				recordsRoot: resolved.recordsAbsPath,
			});
			const filesToCommit = new Set<string>();
			for (const item of group.items) {
				const existing = snapshotFromStore(store, item.run.id);
				if (!existing.summary && existing.lines.size === 0) {
					const fromGit = await snapshotFromGit(
						workdir,
						branch,
						recordsRelPath,
						item.slug,
						item.run.id,
					);
					existing.summary = fromGit.summary;
					for (const [k, v] of fromGit.lines) existing.lines.set(k, v);
				}
				const applied = applyPrepared(store, item, existing, materializer);
				mappings.push({
					run_id: item.run.id,
					plan_path: item.run.plan_path,
					target_branch: branch,
					worktree: writeRoot,
					files: item.files,
					disagreements: applied.disagreements,
					lines: applied.lines,
				});
				if (applied.lines.some((l) => l.created)) {
					for (const f of item.files) filesToCommit.add(f);
				}
			}
			const message = commitMessageFor(
				group.items.map((i) => i.run.id),
				group.target.fallback,
			);
			const existingFiles = [...filesToCommit].filter((rel) =>
				existsSync(join(writeRoot, ...rel.split("/"))),
			);
			const dirty = await hasUncommittedChanges(writeRoot);
			let created = false;
			if (dirty && existingFiles.length > 0) {
				await commitFiles(writeRoot, existingFiles, message);
				created = true;
			}
			commits.push({
				branch,
				message,
				created,
			});
		}
	} finally {
		for (const path of temps) {
			try {
				await removeWorktree(workdir, path, true);
			} catch {
				/* best-effort */
			}
		}
	}

	mappings.sort((a, b) =>
		a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0,
	);
	return { dry_run: false, mappings, commits, exported_by: materializer };
}
