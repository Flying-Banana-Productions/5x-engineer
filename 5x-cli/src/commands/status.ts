import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../config.js";
import { openDbReadOnly } from "../db/connection.js";
import type { RunRow } from "../db/operations.js";
import { getActiveRun, getLatestRun, getRunEvents } from "../db/operations.js";
import { type Phase, parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath } from "../paths.js";

function progressBar(percentage: number, width: number = 12): string {
	const filled = Math.round((percentage / 100) * width);
	const empty = width - filled;
	return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function phasePercentage(phase: Phase): number {
	if (phase.isComplete) return 100;
	if (phase.items.length === 0) return 0;
	const checked = phase.items.filter((i) => i.checked).length;
	return Math.round((checked / phase.items.length) * 100);
}

function formatStatus(phases: Phase[]): string {
	const completedCount = phases.filter((p) => p.isComplete).length;
	const total = phases.length;

	if (total === 0) return "No phases found";
	if (completedCount === total) return "All phases complete";

	const firstIncomplete = phases.find((p) => !p.isComplete);
	if (completedCount === 0) {
		return `Phase ${firstIncomplete?.number ?? "1"} ready`;
	}

	// Use actual phase numbers from the completed phases (handles dotted numbers like 1.1)
	const completedPhases = phases.filter((p) => p.isComplete);
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

function findGitRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	const root = resolve("/");
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir || dir === root) break;
		dir = parent;
	}
	return null;
}

function tryLoadRunState(opts: {
	planPathProvided: string;
	planPathCanonical: string;
	projectRoot: string;
	dbPath: string;
}): {
	active: RunRow | null;
	latest: RunRow | null;
	lastEventType: string | null;
} | null {
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
			const events = getRunEvents(db, active.id);
			if (events.length > 0) {
				lastEventType = events[events.length - 1]?.event_type ?? null;
			}
		}

		return { active, latest, lastEventType };
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

		const versionStr = plan.version ? ` (v${plan.version})` : "";
		const statusLine = formatStatus(plan.phases);
		const completedCount = plan.phases.filter((p) => p.isComplete).length;

		console.log();
		console.log(`  ${plan.title}${versionStr}`);
		console.log(`  Status: ${statusLine}`);
		console.log();

		for (const phase of plan.phases) {
			const pct = phasePercentage(phase);
			const bar = progressBar(pct);
			const pctStr = `${pct}%`.padStart(4);
			const label = `Phase ${phase.number}: ${phase.title}`;
			console.log(`  ${label.padEnd(45)} ${bar} ${pctStr}`);
		}

		console.log();
		console.log(
			`  Overall: ${plan.completionPercentage}% (${completedCount}/${plan.phases.length} phases complete)`,
		);

		// Show DB run state if available
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
		const runState = tryLoadRunState({
			planPathProvided,
			planPathCanonical,
			projectRoot,
			dbPath,
		});
		if (runState?.active) {
			const r = runState.active;
			console.log();
			console.log(
				`  Active run: ${r.id.slice(0, 8)} (${r.command}, phase ${r.current_phase ?? "?"}, state: ${r.current_state ?? "?"})`,
			);
			console.log(
				`  Started: ${formatDuration(r.started_at)}${runState.lastEventType ? ` | Last event: ${runState.lastEventType}` : ""}`,
			);
		} else if (runState?.latest && runState.latest.status !== "active") {
			const r = runState.latest;
			console.log();
			console.log(
				`  Last run: ${r.id.slice(0, 8)} (${r.command}, ${r.status})`,
			);
		}

		console.log();
	},
});
