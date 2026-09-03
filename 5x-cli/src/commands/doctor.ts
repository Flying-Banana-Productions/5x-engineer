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
				"runs, database health, and git-native run records). Warning findings do not fail\n" +
				"the command; any fail finding exits nonzero. Use --fix to apply deterministic\n" +
				"non-destructive repairs (stale/corrupt locks, dead worktree mappings, lossless\n" +
				"harness sync, records index rebuild).",
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
