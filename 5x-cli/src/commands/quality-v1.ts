/**
 * v1 Quality gate command — commander adapter.
 *
 * `5x quality run`
 *
 * Business logic lives in quality-v1.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { runQuality } from "./quality-v1.handler.js";

export function registerQuality(parent: Command) {
	const quality = parent
		.command("quality")
		.summary("Quality gate operations")
		.description("Quality gate operations");

	quality
		.command("run")
		.summary("Execute configured quality gates")
		.description("Execute configured quality gates")
		.option(
			"--record",
			'Auto-record the result as a run step (default step name: "quality:check")',
		)
		.option(
			"--record-step <name>",
			'Override step name for recording (default: "quality:check")',
		)
		.option("-r, --run <id>", "Run ID (required when using --record)")
		.option("-p, --phase <name>", "Phase identifier (used with --record)")
		.option(
			"-w, --workdir <path>",
			"Working directory override (aligns with invoke --workdir precedence model)",
		)
		.action(async (opts) => {
			await runQuality({
				record: opts.record,
				recordStep: opts.recordStep,
				run: opts.run,
				phase: opts.phase,
				workdir: opts.workdir,
			});
		});
}
