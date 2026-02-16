import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePlan, type Phase } from "../parsers/plan.js";

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

  const completedRange =
    completedCount === 1 ? "Phase 1" : `Phases 1\u2013${completedCount}`;
  return `${completedRange} complete; Phase ${firstIncomplete?.number ?? completedCount + 1} ready`;
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
    console.log();
  },
});
