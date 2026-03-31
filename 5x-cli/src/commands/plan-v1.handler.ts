/**
 * Plan inspection command handler — business logic for plan parsing.
 *
 * Framework-independent: no CLI framework imports.
 *
 * When a plan has a mapped worktree, `plan phases` reads the plan from
 * the worktree copy (where checklist items get checked by the author
 * agent). This ensures phase completion status is accurate when
 * orchestrating from the repo root.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FiveXConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import type { PlanRow } from "../db/operations.js";
import { listRuns } from "../db/operations-v1.js";
import { runMigrations } from "../db/schema.js";
import { outputError, outputSuccess } from "../output.js";
import { parsedPlanHasPhases, parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath, planSlugFromPath } from "../paths.js";
import { resolveDbContext } from "./context.js";
import { resolveControlPlaneRoot } from "./control-plane.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface PlanPhasesParams {
	path: string;
}

export interface PlanListParams {
	excludeFinished?: boolean;
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

/**
 * Human-readable text formatter for `plan phases` output.
 *
 * Renders a checklist with checkbox notation and progress counts.
 */
function formatPhasesText(data: Record<string, unknown>): void {
	const phases = data.phases as Array<{
		id: number;
		title: string;
		done: boolean;
		checklist_total: number;
		checklist_done: number;
	}>;

	if (!phases || phases.length === 0) {
		console.log("(no phases)");
		return;
	}

	console.log("Phases:");
	for (const phase of phases) {
		const check = phase.done ? "x" : " ";
		console.log(
			`  [${check}] Phase ${phase.id}: ${phase.title} (${phase.checklist_done}/${phase.checklist_total})`,
		);
	}
}

export interface PlanListEntry {
	plan_path: string;
	name: string;
	file: string;
	title: string;
	status: "complete" | "incomplete";
	completion_pct: number;
	phases_done: number;
	phases_total: number;
	active_run: string | null;
	runs_total: number;
}

/**
 * Human-readable text formatter for `plan list` output.
 *
 * Column-aligned table (ColDef / padEnd) matching `run list` text style.
 */
export function formatPlanListText(data: {
	plans_dir: string;
	plans: PlanListEntry[];
}): void {
	const { plans } = data;

	if (plans.length === 0) {
		console.log("(no plans)");
		return;
	}

	const rows = plans.map((p) => ({
		planPath: p.plan_path,
		status: p.status,
		progress: `${p.completion_pct}%`,
		phases: `${p.phases_done}/${p.phases_total}`,
		runs: String(p.runs_total),
		activeRun: p.active_run ?? "-",
	}));

	type ColDef = { header: string; key: keyof (typeof rows)[0]; width: number };
	const cols: ColDef[] = [
		{ header: "Plan Path", key: "planPath", width: 9 },
		{ header: "Status", key: "status", width: 6 },
		{ header: "Progress", key: "progress", width: 8 },
		{ header: "Phases", key: "phases", width: 6 },
		{ header: "Runs", key: "runs", width: 4 },
		{ header: "Active Run", key: "activeRun", width: 10 },
	];

	for (const col of cols) {
		for (const row of rows) {
			col.width = Math.max(col.width, row[col.key].length);
		}
	}

	const headerLine = cols.map((c) => c.header.padEnd(c.width)).join("  ");
	console.log(headerLine);
	for (const row of rows) {
		const line = cols.map((c) => row[c.key].padEnd(c.width)).join("  ");
		console.log(line);
	}
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function planPhases(params: PlanPhasesParams): Promise<void> {
	const planPath = resolve(params.path);

	// Try to resolve the plan through worktree mapping
	const worktreePlanPath = resolveWorktreePlanPath(planPath);
	const effectivePath = worktreePlanPath ?? planPath;
	if (!existsSync(effectivePath)) {
		outputError("PLAN_NOT_FOUND", `Plan file not found: ${planPath}`, {
			plan_path: planPath,
			...(worktreePlanPath ? { worktree_plan_path: worktreePlanPath } : {}),
		});
	}

	const markdown = readFileSync(effectivePath, "utf-8");
	const plan = parsePlan(markdown);

	const result: Record<string, unknown> = {
		phases: plan.phases.map((p) => ({
			id: p.number,
			title: p.title,
			done: p.isComplete,
			checklist_total: p.items.length,
			checklist_done: p.items.filter((i) => i.checked).length,
		})),
		filePaths: worktreePlanPath
			? { root: planPath, worktree: worktreePlanPath }
			: { root: planPath },
	};

	outputSuccess(result, formatPhasesText);
}

function posixRelativeDir(fromDir: string, toPath: string): string {
	return relative(fromDir, toPath).replace(/\\/g, "/");
}

/** True when `childPath` is `parentPath` or a path inside it (same semantics as run-v1). */
function isPathUnder(childPath: string, parentPath: string): boolean {
	const relPath = relative(parentPath, childPath);
	return !relPath.startsWith("..") && !isAbsolute(relPath);
}

/**
 * Subtrees under `paths.plans` that hold review / audit markdown, not implementation plans.
 * `plan list` recurses into other subdirectories but skips these roots entirely.
 */
function planListSkipSubtrees(
	plansDir: string,
	paths: FiveXConfig["paths"],
): string[] {
	const roots: string[] = [];
	const plansAbs = resolve(plansDir);
	for (const p of [paths.reviews, paths.planReviews, paths.runReviews]) {
		if (!p) continue;
		const abs = resolve(p);
		if (abs === plansAbs || isPathUnder(abs, plansAbs)) roots.push(abs);
	}
	return roots;
}

function collectMarkdownFiles(dir: string, skipSubtrees: string[]): string[] {
	if (!existsSync(dir)) return [];

	const out: string[] = [];
	const entries = readdirSync(dir, { withFileTypes: true });
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

/**
 * Prefer the worktree copy of a plan when mapped and the file exists there
 * (same re-root rule as `plan phases`).
 */
function effectivePlanReadPath(
	projectRoot: string,
	canonicalPlanPath: string,
	worktreePath: string | null | undefined,
): string {
	if (!worktreePath) return canonicalPlanPath;
	const relPlanPath = relative(projectRoot, canonicalPlanPath);
	if (relPlanPath.startsWith("..") || isAbsolute(relPlanPath)) {
		return canonicalPlanPath;
	}
	const candidate = join(worktreePath, relPlanPath);
	return existsSync(candidate) ? candidate : canonicalPlanPath;
}

export async function planList(params: PlanListParams): Promise<void> {
	const { projectRoot, config, db } = await resolveDbContext();
	const plansDir = config.paths.plans;
	const skipSubtrees = planListSkipSubtrees(plansDir, config.paths);

	const mdAbsPaths = collectMarkdownFiles(plansDir, skipSubtrees);

	const planRows = db.query("SELECT * FROM plans").all() as PlanRow[];
	const worktreeByPlanPath = new Map<string, string | null>();
	for (const row of planRows) {
		worktreeByPlanPath.set(row.plan_path, row.worktree_path);
	}

	const allRuns = listRuns(db, { limit: 10000 });
	const runsByPlanPath = new Map<string, typeof allRuns>();
	for (const run of allRuns) {
		const list = runsByPlanPath.get(run.plan_path) ?? [];
		list.push(run);
		runsByPlanPath.set(run.plan_path, list);
	}

	const entries: PlanListEntry[] = [];

	for (const absPath of mdAbsPaths) {
		const canonical = canonicalizePlanPath(absPath);
		const plan_path = posixRelativeDir(plansDir, canonical);
		const worktreePath = worktreeByPlanPath.get(canonical) ?? null;
		const readPath = effectivePlanReadPath(
			projectRoot,
			canonical,
			worktreePath,
		);

		let title = "";
		let phases_total = 0;
		let phases_done = 0;
		let completion_pct = 0;
		let status: "complete" | "incomplete" = "incomplete";

		try {
			const markdown = readFileSync(readPath, "utf-8");
			const parsed = parsePlan(markdown);
			title = parsed.title;
			phases_total = parsed.phases.length;
			phases_done = parsed.phases.filter((p) => p.isComplete).length;
			completion_pct =
				phases_total > 0 ? Math.round((phases_done / phases_total) * 100) : 0;
			status =
				phases_total > 0 && phases_done === phases_total
					? "complete"
					: "incomplete";
			if (!parsedPlanHasPhases(parsed)) {
				process.stderr.write(
					`Warning: ${plan_path} has no implementation-plan phases (expected "## Phase N:" headings). ` +
						`It is still listed; move or edit the file if it is not a plan.\n`,
				);
			}
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`Warning: could not read ${plan_path} for plan listing: ${detail}\n`,
			);
		}

		const runs = runsByPlanPath.get(canonical) ?? [];
		const runs_total = runs.length;
		const active = runs.find((r) => r.status === "active");
		const active_run = active?.id ?? null;

		const name = planSlugFromPath(plan_path);
		const slash = plan_path.lastIndexOf("/");
		const file = slash >= 0 ? plan_path.slice(slash + 1) : plan_path;

		entries.push({
			plan_path,
			name,
			file,
			title,
			status,
			completion_pct,
			phases_done,
			phases_total,
			active_run,
			runs_total,
		});
	}

	let plans = entries;
	if (params.excludeFinished) {
		plans = plans.filter((e) => e.status !== "complete");
	}

	plans.sort((a, b) => {
		const aDone = a.status === "complete";
		const bDone = b.status === "complete";
		if (aDone !== bDone) return aDone ? 1 : -1;
		return a.plan_path.localeCompare(b.plan_path);
	});

	outputSuccess({ plans_dir: plansDir, plans }, formatPlanListText);
}

// ---------------------------------------------------------------------------
// Worktree plan path resolution
// ---------------------------------------------------------------------------

const DB_FILENAME = "5x.db";

/**
 * If the plan has a mapped worktree, return the path to the plan file
 * in the worktree (if it exists there). Returns null if no mapping,
 * no DB, or the worktree copy doesn't exist.
 */
function resolveWorktreePlanPath(planPath: string): string | null {
	try {
		const cp = resolveControlPlaneRoot();
		if (cp.mode === "none") return null;

		const dbPath = join(cp.controlPlaneRoot, cp.stateDir, DB_FILENAME);
		if (!existsSync(dbPath)) return null;

		const db = getDb(cp.controlPlaneRoot, join(cp.stateDir, DB_FILENAME));
		runMigrations(db);

		const plan = db
			.query("SELECT worktree_path FROM plans WHERE plan_path = ?1")
			.get(planPath) as { worktree_path: string | null } | null;

		const worktreePath = plan?.worktree_path;
		if (!worktreePath) return null;

		// Re-root the plan path into the worktree
		const relPlanPath = relative(cp.controlPlaneRoot, planPath);
		const worktreePlanPath = join(worktreePath, relPlanPath);

		if (!existsSync(worktreePlanPath)) return null;

		return worktreePlanPath;
	} catch {
		// Any failure in DB/control-plane resolution is non-fatal —
		// fall back to reading the plan at the given path.
		return null;
	}
}
