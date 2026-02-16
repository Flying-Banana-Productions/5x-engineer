import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parsePlan, type Phase } from "../parsers/plan.js";
import { getDb, closeDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { getActiveRun, getLatestRun, getRunEvents } from "../db/operations.js";
import type { RunRow } from "../db/operations.js";

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
    return `Phase ${firstIncomplete?.number ?? 1} ready`;
  }

  // Use actual phase numbers from the completed phases (handles dotted numbers like 1.1)
  const completedPhases = phases.filter((p) => p.isComplete);
  const firstNum = completedPhases[0]!.number;
  const lastNum = completedPhases[completedPhases.length - 1]!.number;
  const completedRange =
    completedCount === 1
      ? `Phase ${firstNum}`
      : `Phases ${firstNum}\u2013${lastNum}`;
  return `${completedRange} complete; Phase ${firstIncomplete?.number ?? "?"} ready`;
}

function formatDuration(startedAt: string): string {
  const start = new Date(startedAt + "Z").getTime();
  const now = Date.now();
  const diffMs = now - start;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

function tryLoadRunState(
  planPath: string
): { active: RunRow | null; latest: RunRow | null; lastEventType: string | null } | null {
  // Walk up from plan file to find project root (where .5x/ lives)
  let dir = dirname(planPath);
  const root = resolve("/");
  while (dir !== root) {
    const dbPath = resolve(dir, ".5x", "5x.db");
    if (existsSync(dbPath)) {
      try {
        const db = getDb(dir);
        runMigrations(db);
        const active = getActiveRun(db, planPath);
        const latest = active ?? getLatestRun(db, planPath);
        let lastEventType: string | null = null;
        if (active) {
          const events = getRunEvents(db, active.id);
          if (events.length > 0) {
            lastEventType = events[events.length - 1]!.event_type;
          }
        }
        return { active, latest, lastEventType };
      } catch {
        return null; // DB exists but failed to query — degrade gracefully
      } finally {
        closeDb();
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
  run({ args }) {
    const planPath = resolve(args.path);

    let markdown: string;
    try {
      markdown = readFileSync(planPath, "utf-8");
    } catch {
      console.error(`Error: Plan file not found: ${planPath}`);
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
      `  Overall: ${plan.completionPercentage}% (${completedCount}/${plan.phases.length} phases complete)`
    );

    // Show DB run state if available
    const runState = tryLoadRunState(planPath);
    if (runState?.active) {
      const r = runState.active;
      console.log();
      console.log(`  Active run: ${r.id.slice(0, 8)} (${r.command}, phase ${r.current_phase ?? "?"}, state: ${r.current_state ?? "?"})`);
      console.log(`  Started: ${formatDuration(r.started_at)}${runState.lastEventType ? ` | Last event: ${runState.lastEventType}` : ""}`);
    } else if (runState?.latest && runState.latest.status !== "active") {
      const r = runState.latest;
      console.log();
      console.log(`  Last run: ${r.id.slice(0, 8)} (${r.command}, ${r.status})`);
    }

    console.log();
  },
});
