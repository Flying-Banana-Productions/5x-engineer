/**
 * Protocol commands — commander adapter.
 *
 * 3-level nesting: protocol → validate → author/reviewer
 *
 * Business logic lives in protocol.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { intArg } from "../utils/parse-args.js";
import { protocolValidate } from "./protocol.handler.js";

export function registerProtocol(parent: Command) {
	const protocol = parent
		.command("protocol")
		.summary("Structured protocol validation and recording")
		.description("Structured protocol validation and recording");

	const validate = protocol
		.command("validate")
		.summary(
			"Validate structured JSON against author/reviewer protocol schemas",
		)
		.description(
			"Validate structured JSON against author/reviewer protocol schemas",
		);

	validate
		.command("author")
		.summary("Validate an AuthorStatus structured result")
		.description("Validate an AuthorStatus structured result")
		.option(
			"-i, --input <path>",
			"Path to input JSON file (default: read from stdin)",
		)
		.option("-r, --run <id>", "Run ID (used with --record)")
		.option("--record", "Record the validated result as a run step")
		.option("--step <name>", "Step name for recording (used with --record)")
		.option("--phase <name>", "Phase identifier (used with --record)")
		.option(
			"--iteration <n>",
			"Iteration number (used with --record)",
			intArg("--iteration", { positive: true }),
		)
		.option(
			"--require-commit",
			"Require commit hash for complete results (default: true)",
			true,
		)
		.option(
			"--no-require-commit",
			"Do not require commit hash for complete results",
		)
		.option("--plan <path>", "Path to plan file for checklist validation")
		.option(
			"--phase-checklist-validate",
			"Validate phase checklist completion (default: true)",
			true,
		)
		.option("--no-phase-checklist-validate", "Skip phase checklist validation")
		.action(async (opts) => {
			await protocolValidate({
				role: "author",
				input: opts.input,
				requireCommit: opts.requireCommit,
				run: opts.run,
				record: opts.record,
				step: opts.step,
				phase: opts.phase,
				iteration: opts.iteration,
				plan: opts.plan,
				phaseChecklistValidate: opts.phaseChecklistValidate,
			});
		});

	validate
		.command("reviewer")
		.summary("Validate a ReviewerVerdict structured result")
		.description("Validate a ReviewerVerdict structured result")
		.option(
			"-i, --input <path>",
			"Path to input JSON file (default: read from stdin)",
		)
		.option("-r, --run <id>", "Run ID (used with --record)")
		.option("--record", "Record the validated result as a run step")
		.option("--step <name>", "Step name for recording (used with --record)")
		.option("--phase <name>", "Phase identifier (used with --record)")
		.option(
			"--iteration <n>",
			"Iteration number (used with --record)",
			intArg("--iteration", { positive: true }),
		)
		.action(async (opts) => {
			await protocolValidate({
				role: "reviewer",
				input: opts.input,
				run: opts.run,
				record: opts.record,
				step: opts.step,
				phase: opts.phase,
				iteration: opts.iteration,
			});
		});
}
