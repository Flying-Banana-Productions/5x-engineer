/**
 * Rebuild the SQLite `runs` / `steps` index from git-native run records.
 *
 * Origin / provenance / creator / sealer stay on the record; they are never
 * copied into SQLite. Newer local-only SQLite steps are kept, never deleted.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { FiveXConfig } from "../config.js";
import {
	decodeJsonlFile,
	parseRunJson,
} from "../control-plane/record-layout.js";
import type { RecordStore } from "../control-plane/record-store.js";
import type {
	RecordLine,
	RunRecordSummary,
	StepRecordPayload,
} from "../control-plane/record-types.js";
import { stepIdempotencyKey } from "../control-plane/record-types.js";
import type { PlanRow } from "../db/operations.js";
import {
	completeRun,
	createRunV1,
	getRunV1,
	getSteps,
	recordStep,
	type StepRow,
} from "../db/operations-v1.js";
import { parseRunTimestamp } from "../db/timestamps.js";
import { gitLsTreePaths, gitShowFile } from "../git.js";
import { isPathUnder, planSlugFromPath, relativePathUnder } from "../paths.js";
import { resolveRecordsRoot } from "./paths.js";
import {
	type ProgressSession,
	prepareProgressSession,
	type ResolvedPlanProgress,
	resolvePlanProgress,
} from "./resolve.js";

export interface IndexRebuildResult {
	runs_upserted: number;
	steps_upserted: number;
	steps_skipped_newer_local: number;
	plans: string[];
}

export interface RecordIndexRun {
	summary: RunRecordSummary;
	steps: RecordLine[];
	planSlug: string;
	planPath: string;
	commit: string | null;
}

export interface RecordIndexSnapshot {
	plans: string[];
	runs: RecordIndexRun[];
}

export interface IndexRebuildGit {
	gitShowFile: typeof gitShowFile;
	gitLsTreePaths: typeof gitLsTreePaths;
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

function planListSkipSubtrees(
	plansDir: string,
	paths: FiveXConfig["paths"],
): string[] {
	const roots: string[] = [];
	const plansAbs = resolve(plansDir);
	for (const p of [
		paths.reviews,
		paths.planReviews,
		paths.runReviews,
		paths.records,
	]) {
		if (!p) continue;
		const abs = resolve(p);
		if (abs === plansAbs || isPathUnder(abs, plansAbs)) roots.push(abs);
	}
	return roots;
}

function collectMarkdownFiles(dir: string, skipSubtrees: string[]): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	let entries: Array<{
		name: string;
		isDirectory(): boolean;
		isFile(): boolean;
	}>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		const full = resolve(join(dir, ent.name));
		if (ent.isDirectory()) {
			const skip = skipSubtrees.some((root) => isPathUnder(full, root));
			if (skip) continue;
			out.push(...collectMarkdownFiles(full, skipSubtrees));
		} else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
			out.push(full);
		}
	}
	return out;
}

function slugMatchesFilter(planPath: string, want: string): boolean {
	const slug = planSlugFromPath(planPath);
	const wantSlug = planSlugFromPath(want);
	if (slug === want || slug === wantSlug) return true;
	const posix = toPosix(planPath);
	const base = posix.slice(posix.lastIndexOf("/") + 1);
	return base === want || posix === toPosix(want);
}

function stringifyResultJson(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value ?? null);
}

function stringifyConfigJson(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function parseStepPayload(payload: unknown): StepRecordPayload | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const p = payload as Partial<StepRecordPayload>;
	if (typeof p.step_name !== "string" || typeof p.iteration !== "number") {
		return null;
	}
	return p as StepRecordPayload;
}

function findSqliteStep(
	db: Database,
	runId: string,
	stepName: string,
	phase: string | null,
	iteration: number,
): StepRow | null {
	return db
		.query(
			`SELECT * FROM steps
			 WHERE run_id = ?1 AND step_name = ?2 AND phase IS ?3 AND iteration = ?4`,
		)
		.get(runId, stepName, phase, iteration) as StepRow | null;
}

function upsertRunFromSummary(
	db: Database,
	summary: RunRecordSummary,
): boolean {
	const existing = getRunV1(db, summary.id);
	const terminal =
		summary.status === "completed" || summary.status === "aborted"
			? summary.status
			: null;
	if (!existing) {
		createRunV1(db, {
			id: summary.id,
			planPath: summary.plan_path,
			configJson: stringifyConfigJson(summary.config_json),
		});
		if (terminal) completeRun(db, summary.id, terminal);
		return true;
	}
	if (terminal && existing.status !== terminal) {
		completeRun(db, summary.id, terminal);
		return true;
	}
	return false;
}

function insertStepFromLine(db: Database, line: RecordLine): boolean {
	const payload = parseStepPayload(line.payload);
	if (!payload) return false;
	const phase = payload.phase ?? null;
	const existing = findSqliteStep(
		db,
		line.runId,
		payload.step_name,
		phase,
		payload.iteration,
	);
	if (existing) return false;
	recordStep(db, {
		run_id: line.runId,
		step_name: payload.step_name,
		phase: phase ?? undefined,
		iteration: payload.iteration,
		result_json: stringifyResultJson(payload.result_json),
		model: payload.model ?? undefined,
		tokens_in: payload.tokens_in ?? undefined,
		tokens_out: payload.tokens_out ?? undefined,
		cost_usd: payload.cost_usd ?? undefined,
		duration_ms: payload.duration_ms ?? undefined,
		head_commit: payload.head_commit ?? undefined,
	});
	return true;
}

function newestRecordCreatedMs(steps: RecordLine[]): number {
	let max = Number.NEGATIVE_INFINITY;
	for (const line of steps) {
		const ms = parseRunTimestamp(line.createdAt);
		if (Number.isFinite(ms) && ms > max) max = ms;
	}
	return max;
}

function stepKeyFromPayload(runId: string, payload: StepRecordPayload): string {
	return stepIdempotencyKey({
		runId,
		stepName: payload.step_name,
		phase: payload.phase ?? null,
		iteration: payload.iteration,
	});
}

function sqliteStepKey(row: StepRow): string {
	return stepIdempotencyKey({
		runId: row.run_id,
		stepName: row.step_name,
		phase: row.phase,
		iteration: row.iteration,
	});
}

async function loadRunsAtCommit(opts: {
	workdir: string;
	commit: string;
	recordsRelPath: string;
	planSlug: string;
	planPath: string;
	git: IndexRebuildGit;
}): Promise<RecordIndexRun[]> {
	const prefix = posixJoin(opts.recordsRelPath, opts.planSlug);
	const paths = await opts.git.gitLsTreePaths(
		opts.workdir,
		opts.commit,
		prefix,
	);
	const runJsonPaths = paths.filter((p) => toPosix(p).endsWith("/run.json"));
	const runs: RecordIndexRun[] = [];
	for (const runJsonRel of runJsonPaths) {
		const posix = toPosix(runJsonRel);
		const parts = posix.split("/");
		const runId = parts.length >= 2 ? parts[parts.length - 2] : "";
		if (!runId) continue;
		const runText = await opts.git.gitShowFile(
			opts.workdir,
			opts.commit,
			posix,
		);
		if (runText == null) continue;
		let summary: RunRecordSummary;
		try {
			summary = parseRunJson(runText);
		} catch {
			continue;
		}
		const stepsRel = posixJoin(
			opts.recordsRelPath,
			opts.planSlug,
			runId,
			"steps.jsonl",
		);
		const stepsText = await opts.git.gitShowFile(
			opts.workdir,
			opts.commit,
			stepsRel,
		);
		let steps: RecordLine[] = [];
		if (stepsText != null && stepsText.length > 0) {
			try {
				steps = decodeJsonlFile(stepsText, summary.id).filter(
					(line) => line.stream === "steps",
				);
			} catch {
				steps = [];
			}
		}
		runs.push({
			summary,
			steps,
			planSlug: opts.planSlug,
			planPath: opts.planPath,
			commit: opts.commit,
		});
	}
	return runs;
}

export async function collectRecordIndexSnapshot(opts: {
	db: Database;
	workdir: string;
	config: FiveXConfig;
	planSlug?: string;
	resolve?: typeof resolvePlanProgress;
	git?: IndexRebuildGit;
	session?: ProgressSession;
}): Promise<RecordIndexSnapshot> {
	const resolveProgress = opts.resolve ?? resolvePlanProgress;
	const git: IndexRebuildGit = opts.git ?? { gitShowFile, gitLsTreePaths };
	const records = resolveRecordsRoot({
		recordsConfigAbs: opts.config.paths.records,
		controlPlaneRoot: opts.workdir,
		effectiveWorkdir: opts.workdir,
	});
	const plansDir = opts.config.paths.plans;
	const skipSubtrees = planListSkipSubtrees(plansDir, opts.config.paths);
	const mdAbsPaths = collectMarkdownFiles(plansDir, skipSubtrees);
	const plansRel =
		relativePathUnder(plansDir, opts.workdir)?.replace(/\\/g, "/") ?? "";
	const skipRelPrefixes = skipSubtrees
		.map((abs) => relativePathUnder(abs, opts.workdir)?.replace(/\\/g, "/"))
		.filter((p): p is string => Boolean(p));

	const diskRels: string[] = [];
	const absByRel = new Map<string, string>();
	for (const absPath of mdAbsPaths) {
		const rel = relativePathUnder(absPath, opts.workdir)?.replace(/\\/g, "/");
		if (!rel) continue;
		diskRels.push(rel);
		absByRel.set(rel, absPath);
	}

	const planRows = opts.db.query("SELECT * FROM plans").all() as PlanRow[];
	const worktreeByPlanPath = new Map<string, string | null>();
	for (const row of planRows) {
		worktreeByPlanPath.set(row.plan_path, row.worktree_path);
	}
	const worktreePaths = [
		...new Set(
			[...worktreeByPlanPath.values()].filter(
				(p): p is string => typeof p === "string" && p.length > 0,
			),
		),
	];

	const session =
		opts.session ??
		(await prepareProgressSession({
			workdir: opts.workdir,
			recordsRelPath: records.recordsRelPath,
			plansRelPath: plansRel || undefined,
			skipRelPrefixes,
			planRepoRels: diskRels,
			planSlug: opts.planSlug,
			plansBranch: opts.config.plans.branch ?? null,
			worktreePaths,
		}));

	const allRels = new Set<string>([...diskRels, ...session.discoveredPlanRels]);
	const entries: Array<{
		slug: string;
		planPath: string;
		rel: string;
		worktreePath: string | null;
	}> = [];
	for (const rel of allRels) {
		const abs = absByRel.get(rel) ?? join(opts.workdir, ...rel.split("/"));
		if (opts.planSlug && !slugMatchesFilter(rel, opts.planSlug)) continue;
		const slug = planSlugFromPath(rel);
		entries.push({
			slug,
			planPath: abs,
			rel,
			worktreePath: worktreeByPlanPath.get(abs) ?? null,
		});
	}

	if (opts.planSlug && entries.length === 0) {
		const slug = planSlugFromPath(opts.planSlug);
		entries.push({
			slug,
			planPath: join(plansDir, `${slug}.md`),
			rel: toPosix(relative(opts.workdir, join(plansDir, `${slug}.md`))),
			worktreePath: null,
		});
	}

	const runs: RecordIndexRun[] = [];
	const plans: string[] = [];
	const seenSlug = new Set<string>();

	for (const entry of entries) {
		if (!seenSlug.has(entry.slug)) {
			seenSlug.add(entry.slug);
			plans.push(entry.slug);
		}
		const resolved: ResolvedPlanProgress = await resolveProgress({
			workdir: opts.workdir,
			planPath: entry.planPath,
			planSlug: entry.slug,
			recordsRelPath: records.recordsRelPath,
			worktreePath: entry.worktreePath,
			plansBranch: opts.config.plans.branch ?? null,
			session,
		});
		const commit = resolved.commit;
		if (!commit) continue;
		const loaded = await loadRunsAtCommit({
			workdir: opts.workdir,
			commit,
			recordsRelPath: records.recordsRelPath,
			planSlug: entry.slug,
			planPath: entry.rel,
			git,
		});
		runs.push(...loaded);
	}

	plans.sort();
	return { plans, runs };
}

export async function rebuildRecordsIndex(opts: {
	db: Database;
	recordStore?: RecordStore;
	workdir: string;
	config: FiveXConfig;
	planSlug?: string;
	resolve: typeof resolvePlanProgress;
	git?: IndexRebuildGit;
	session?: ProgressSession;
}): Promise<IndexRebuildResult> {
	void opts.recordStore;
	const snapshot = await collectRecordIndexSnapshot({
		db: opts.db,
		workdir: opts.workdir,
		config: opts.config,
		planSlug: opts.planSlug,
		resolve: opts.resolve,
		git: opts.git,
		session: opts.session,
	});

	let runs_upserted = 0;
	let steps_upserted = 0;
	let steps_skipped_newer_local = 0;

	for (const run of snapshot.runs) {
		if (upsertRunFromSummary(opts.db, run.summary)) runs_upserted += 1;
		const recordKeys = new Set<string>();
		for (const line of run.steps) {
			const payload = parseStepPayload(line.payload);
			if (payload) recordKeys.add(stepKeyFromPayload(line.runId, payload));
			if (insertStepFromLine(opts.db, line)) steps_upserted += 1;
		}
		const newest = newestRecordCreatedMs(run.steps);
		for (const row of getSteps(opts.db, run.summary.id)) {
			if (recordKeys.has(sqliteStepKey(row))) continue;
			const createdMs = parseRunTimestamp(row.created_at);
			if (Number.isFinite(createdMs) && createdMs > newest) {
				steps_skipped_newer_local += 1;
			}
		}
	}

	return {
		runs_upserted,
		steps_upserted,
		steps_skipped_newer_local,
		plans: snapshot.plans,
	};
}

export { sqliteStepKey };

export function listMappedWorktreePaths(db: Database): string[] {
	const rows = db
		.query(
			"SELECT worktree_path FROM plans WHERE worktree_path IS NOT NULL AND worktree_path != ''",
		)
		.all() as Array<{ worktree_path: string }>;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (seen.has(row.worktree_path)) continue;
		seen.add(row.worktree_path);
		out.push(row.worktree_path);
	}
	return out;
}

export function walkRecordRunDirs(recordsAbsPath: string): Array<{
	runId: string;
	runDir: string;
	planSlug: string;
}> {
	const found: Array<{ runId: string; runDir: string; planSlug: string }> = [];
	if (!existsSync(recordsAbsPath)) return found;
	let slugs: string[];
	try {
		slugs = readdirSync(recordsAbsPath);
	} catch {
		return found;
	}
	for (const slug of slugs) {
		const slugDir = join(recordsAbsPath, slug);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(slugDir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		let runIds: string[];
		try {
			runIds = readdirSync(slugDir);
		} catch {
			continue;
		}
		for (const runId of runIds) {
			const runDir = join(slugDir, runId);
			try {
				if (!statSync(runDir).isDirectory()) continue;
			} catch {
				continue;
			}
			found.push({ runId, runDir, planSlug: slug });
		}
	}
	return found;
}
