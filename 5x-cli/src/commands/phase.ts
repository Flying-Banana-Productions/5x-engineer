/**
 * Phase command — commander adapter.
 *
 * Registers `5x phase finish`. Business logic lives in phase.handler.ts.
 * Subcommand layout leaves room for a future `phase start`.
 */

import type { Command } from "@commander-js/extra-typings";
import { intArg } from "../utils/parse-args.js";
import { phaseFinish } from "./phase.handler.js";
import { AMBIENT_RUN_OPTION_HELP } from "./run-identity.js";

export function registerPhase(parent: Command) {
	const phase = parent
		.command("phase")
		.summary("Phase-level composite operations")
		.description(
			"Composite helpers that run the existing quality, protocol, and checklist\n" +
				"primitives as one step. Subcommands share a single stdout envelope.",
		);

	phase
		.command("finish")
		.summary(
			"Run quality, protocol validate, and checklist for a phase iteration",
		)
		.description(
			"Fail-forward composite: quality gates, then author protocol validate/record,\n" +
				'then (when the author result is "complete") the phase checklist. Successful\n' +
				"sub-steps are skipped on resume for the same (run, phase, iteration).",
		)
		.requiredOption(
			"--phase <name>",
			"Phase identifier (resume key; not inferred)",
		)
		.requiredOption(
			"--iteration <n>",
			"Iteration number (resume key; not inferred)",
			intArg("--iteration"),
		)
		.requiredOption(
			"--step <name>",
			"Author step name to record (typically from template render)",
		)
		.option("-r, --run <id>", AMBIENT_RUN_OPTION_HELP)
		.option(
			"-i, --input <path>",
			"Path to author JSON (default: read from stdin)",
		)
		.option(
			"--record-step <name>",
			'Quality step name to record (default: "quality:check")',
		)
		.option(
			"--phase-checklist-validate",
			"Validate phase checklist when author result is complete (default: true)",
			true,
		)
		.option("--no-phase-checklist-validate", "Skip phase checklist validation")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x phase finish --phase 1 --iteration 1 --step author:impl --input result.json\n" +
				'  $ echo "$RESULT" | 5x phase finish --phase 1 --iteration 1 --step author:impl\n' +
				"  $ 5x phase finish --phase 1 --iteration 1 --step author:impl --no-phase-checklist-validate",
		)
		.action(async (opts) => {
			await phaseFinish({
				phase: opts.phase,
				iteration: opts.iteration,
				step: opts.step,
				run: opts.run,
				input: opts.input,
				recordStep: opts.recordStep,
				phaseChecklistValidate: opts.phaseChecklistValidate,
			});
		});
}
