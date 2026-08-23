/**
 * Doctor command — commander adapter.
 *
 * Registers `5x doctor [--fix]`. Business logic lives in doctor.handler.ts.
 */

import { homedir } from "node:os";
import type { Command } from "@commander-js/extra-typings";
import { doctorRun } from "./doctor.handler.js";

export function registerDoctor(parent: Command) {
	parent
		.command("doctor")
		.summary("Diagnose project health")
		.description(
			"Run built-in recovery checks (harness freshness, locks, worktrees, lingering\n" +
				"runs, and database health). Warning findings do not fail the command; any\n" +
				"fail finding exits nonzero. Use --fix to apply deterministic non-destructive\n" +
				"repairs (stale/corrupt locks, dead worktree mappings, lossless harness sync).",
		)
		.option("--fix", "Apply safe repairs for fixable findings")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x doctor\n" +
				"  $ 5x doctor --fix\n" +
				"  $ 5x doctor --text",
		)
		.action(async (opts) => {
			await doctorRun({
				fix: opts.fix,
				homeDir: homedir(),
			});
		});
}
