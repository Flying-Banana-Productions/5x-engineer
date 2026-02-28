import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../config.js";
import { openDbReadOnly } from "../db/connection.js";
import type { PhaseProgressRow, RunRow } from "../db/operations.js";
import {
	getActiveRun,
	getApprovedPhaseNumbers,
	getLastRunEvent,
	getLatestRun,
	listPhaseProgress,
} from "../db/operations.js";
import { type Phase, parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath } from "../paths.js";
import { findGitRoot } from "../project-root.js";

function progressBar(percentage: number, width: number = 12): string {
	const filled = Math.round((percentage / 100) * width);
	const empty = width - filled;
	return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function phasePercentage(phase: Phase, approved: boolean): number {
	if (approved || phase.isComplete) return 100;
	if (phase.items.length === 0) return 0;
	const checked = phase.items.filter((i) => i.checked).length;
	return Math.round((checked / phase.items.length) * 100);
}

function formatStatus(phases: Phase[], approvedSet: Set<string>): string {
	const completedCount = phases.filter(
		(p) => approvedSet.has(p.number) || p.isComplete,
	).length;
	const total = phases.length;

	if (total === 0) return "No phases found";
	if (completedCount === total) return "All phases complete";

	const firstIncomplete = phases.find(
		(p) => !approvedSet.has(p.number) && !p.isComplete,
	);
	if (completedCount === 0) {
		return `Phase ${firstIncomplete?.number ?? "1"} ready`;
	}

	const completedPhases = phases.filter(
		(p) => approvedSet.has(p.number) || p.isComplete,
	);
	const firstNum = completedPhases[0]?.number ?? "?";
	const lastNum =
		completedPhases[completedPhases.length - 1]?.number ?? firstNum;
	const completedRange =
		completedCount === 1
			? `Phase ${firstNum}`
			: `Phases ${firstNum}\u2013${lastNum}`;
	return `${completedRange} complete; Phase ${firstIncomplete?.number ?? "?"} ready`;
}

function formatDuration(startedAt: string): string {
	const start = new Date(`${startedAt}Z`).getTime();
	const now = Date.now();
	const diffMs = now - start;
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ${mins % 60}m ago`;
}

interface DbState {
	active: RunRow | null;
	latest: RunRow | null;
	lastEventType: string | null;
	approvedPhases: Set<string>;
	phaseProgress: PhaseProgressRow[];
}

function tryLoadDbState(opts: {
	planPathProvided: string;
	planPathCanonical: string;
	projectRoot: string;
	dbPath: string;
}): DbState | null {
	const resolvedDbPath = resolve(opts.projectRoot, opts.dbPath);
	if (!existsSync(resolvedDbPath)) return null;

	let db: ReturnType<typeof openDbReadOnly> | null = null;
	try {
		db = openDbReadOnly(opts.projectRoot, opts.dbPath);

		const activeCanonical = getActiveRun(db, opts.planPathCanonical);
		const active =
			activeCanonical ??
			(opts.planPathProvided !== opts.planPathCanonical
				? getActiveRun(db, opts.planPathProvided)
				: null);

		const latestCanonical = active ?? getLatestRun(db, opts.planPathCanonical);
		const latest =
			latestCanonical ??
			(opts.planPathProvided !== opts.planPathCanonical
				? getLatestRun(db, opts.planPathProvided)
				: null);

		let lastEventType: string | null = null;
		if (active) {
			const lastEvent = getLastRunEvent(db, active.id);
			lastEventType = lastEvent?.event_type ?? null;
		}

		const approvedPhases = new Set(
			getApprovedPhaseNumbers(db, opts.planPathCanonical),
		);
		const phaseProgress = listPhaseProgress(db, opts.planPathCanonical);

		return { active, latest, lastEventType, approvedPhases, phaseProgress };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			`Note: failed to read run state from DB at ${resolvedDbPath}: ${message}. ` +
				"Status will omit DB info.",
		);
		return null;
	} finally {
		try {
			db?.close();
		} catch {}
	}
}

export default defineCommand({
	meta: {
		name: "status",
		description: "Display implementation plan progress",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan markdown file",
			required: true,
		},
	},
	async run({ args }) {
		const planPathProvided = resolve(args.path);
		const planPathCanonical = canonicalizePlanPath(planPathProvided);

		let markdown: string;
		try {
			markdown = readFileSync(planPathCanonical, "utf-8");
		} catch {
			console.error(`Error: Plan file not found: ${planPathProvided}`);
			process.exit(1);
		}

		const plan = parsePlan(markdown);

		if (plan.phases.length === 0) {
			console.error("Error: No phases found in plan file");
			process.exit(1);
		}

		// Load DB state (phase approvals are the source of truth)
		const planDir = dirname(planPathCanonical);
		let dbPath = ".5x/5x.db";
		let projectRoot = findGitRoot(planDir) ?? planDir;
		try {
			const { config, configPath } = await loadConfig(planDir);
			dbPath = config.db.path;
			projectRoot = configPath ? dirname(configPath) : projectRoot;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`Note: failed to load 5x config: ${message}. Using default DB path for status.`,
			);
		}

		const dbState = tryLoadDbState({
			planPathProvided,
			planPathCanonical,
			projectRoot,
			dbPath,
		});

		// DB-backed approvals are authoritative; fall back to parser for cold start
		const approvedSet = dbState?.approvedPhases ?? new Set<string>();

		const versionStr = plan.version ? ` (v${plan.version})` : "";
		const statusLine = formatStatus(plan.phases, approvedSet);
		const completedCount = plan.phases.filter(
			(p) => approvedSet.has(p.number) || p.isComplete,
		).length;

		console.log();
		console.log(`  ${plan.title}${versionStr}`);
		console.log(`  Status: ${statusLine}`);
		console.log();

		for (const phase of plan.phases) {
			const approved = approvedSet.has(phase.number);
			const pct = phasePercentage(phase, approved);
			const bar = progressBar(pct);
			const pctStr = `${pct}%`.padStart(4);
			const label = `Phase ${phase.number}: ${phase.title}`;
			console.log(`  ${label.padEnd(45)} ${bar} ${pctStr}`);
		}

		const overallPct =
			plan.phases.length > 0
				? Math.round((completedCount / plan.phases.length) * 100)
				: 0;
		console.log();
		console.log(
			`  Overall: ${overallPct}% (${completedCount}/${plan.phases.length} phases complete)`,
		);

		// Show run info
		if (dbState?.active) {
			const r = dbState.active;
			console.log();
			console.log(
				`  Active run: ${r.id.slice(0, 8)} (${r.command}, phase ${r.current_phase ?? "?"}, state: ${r.current_state ?? "?"})`,
			);
			console.log(
				`  Started: ${formatDuration(r.started_at)}${dbState.lastEventType ? ` | Last event: ${dbState.lastEventType}` : ""}`,
			);
		} else if (dbState?.latest && dbState.latest.status !== "active") {
			const r = dbState.latest;
			console.log();
			console.log(
				`  Last run: ${r.id.slice(0, 8)} (${r.command}, ${r.status})`,
			);
		}

		console.log();
	},
});
