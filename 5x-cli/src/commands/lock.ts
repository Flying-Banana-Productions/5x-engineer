/**
 * Lock inspect / unlock commands — commander adapter.
 *
 * Registers `5x lock list` (nested) and top-level `5x unlock <plan>`.
 * Business logic lives in lock.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { lockList, unlockPlan } from "./lock.handler.js";

export function registerLock(parent: Command) {
	const lock = parent
		.command("lock")
		.summary("Inspect plan locks")
		.description(
			"List plan-level locks under the control-plane state directory.",
		);

	lock
		.command("list")
		.summary("List all plan locks")
		.description(
			"Show every .lock file with plan path, PID, started-at, and liveness (live / stale / corrupt).",
		)
		.addHelpText(
			"after",
			"\nExamples:\n  $ 5x lock list\n  $ 5x lock list --text",
		)
		.action(async () => {
			await lockList();
		});

	parent
		.command("unlock")
		.summary("Release a plan lock")
		.description(
			"Release a stale or corrupt lock for a plan. Live holders are refused unless --force is passed.",
		)
		.argument("<plan>", "Path to the plan whose lock to release")
		.option("-f, --force", "Release even when the holder PID appears live")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x unlock docs/development/foo.md\n" +
				"  $ 5x unlock docs/development/foo.md --force",
		)
		.action(async (plan, opts) => {
			await unlockPlan({ plan, force: opts.force });
		});
}
