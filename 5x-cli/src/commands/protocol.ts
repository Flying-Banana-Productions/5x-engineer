/**
 * Protocol commands — commander adapter.
 *
 * 3-level nesting:
 *   protocol → validate → author/reviewer
 *   protocol → emit    → author/reviewer
 *
 * Business logic lives in protocol.handler.ts and protocol-emit.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { intArg } from "../utils/parse-args.js";
import { protocolValidate } from "./protocol.handler.js";
import {
	protocolEmitAuthor,
	protocolEmitReviewer,
} from "./protocol-emit.handler.js";

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function registerProtocol(parent: Command) {
	const protocol = parent
		.command("protocol")
		.summary("Structured protocol validation and recording")
		.description(
			"Validate JSON output from author and reviewer agents against the 5x protocol\n" +
				"schemas. Optionally record validated results as run steps.",
		);

	const validate = protocol
		.command("validate")
		.summary("Validate structured JSON against protocol schemas")
		.description(
			"Parse and validate JSON from a file or stdin against the author or reviewer\n" +
				"protocol schema. Returns the validated and normalized result.",
		);

	validate
		.command("author")
		.summary("Validate an AuthorStatus structured result")
		.description(
			"Validate a JSON object against the AuthorStatus protocol schema. By default,\n" +
				'requires a commit hash for "complete" results; use --no-require-commit to\n' +
				"relax this constraint.",
		)
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
			intArg("--iteration"),
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
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x protocol validate author -i /tmp/author-result.json\n" +
				"  $ cat result.json | 5x protocol validate author\n" +
				"  $ 5x protocol validate author -i result.json --record -r abc123 --phase phase-1\n" +
				"  $ 5x protocol validate author -i result.json --no-require-commit",
		)
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
		.description(
			"Validate a JSON object against the ReviewerVerdict protocol schema.",
		)
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
			intArg("--iteration"),
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x protocol validate reviewer -i /tmp/verdict.json\n" +
				"  $ cat verdict.json | 5x protocol validate reviewer --record -r abc123",
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

	// -----------------------------------------------------------------------
	// protocol emit — produce canonical structured output for agents
	// -----------------------------------------------------------------------

	const emit = protocol
		.command("emit")
		.summary("Produce canonical structured JSON for protocol output")
		.description(
			"Agents call this to produce schema-conforming structured output.\n" +
				"Success writes raw canonical JSON to stdout (no envelope).\n" +
				"Errors use the standard { ok: false, error } envelope with non-zero exit.",
		);

	emit
		.command("reviewer")
		.summary("Emit a ReviewerVerdict structured result")
		.description(
			"Produce a canonical ReviewerVerdict JSON object from flags.\n" +
				"Use --ready or --no-ready to set the readiness assessment.\n" +
				"Use --item to add review items (repeatable). Items imply corrections.\n" +
				"If no flags are provided and stdin is piped, reads JSON from stdin\n" +
				"and normalizes it to canonical form.",
		)
		.option("--ready", "Plan/code is ready (possibly with corrections)")
		.option("--no-ready", "Plan/code is not ready")
		.option(
			"--item <json>",
			"Review item as JSON (repeatable)",
			collect,
			[] as string[],
		)
		.option("--summary <text>", "1-3 sentence assessment")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x protocol emit reviewer --ready\n" +
				'  $ 5x protocol emit reviewer --no-ready --item \'{"title":"Fix X","action":"auto_fix","reason":"..."}\'\n' +
				'  $ echo \'{"verdict":"rejected","issues":[...]}\' | 5x protocol emit reviewer',
		)
		.action(async (opts) => {
			await protocolEmitReviewer({
				ready: opts.ready,
				item: opts.item,
				summary: opts.summary,
			});
		});

	emit
		.command("author")
		.summary("Emit an AuthorStatus structured result")
		.description(
			"Produce a canonical AuthorStatus JSON object from flags.\n" +
				"Exactly one of --complete, --needs-human, or --failed is required.\n" +
				"If no flags are provided and stdin is piped, reads JSON from stdin\n" +
				"and normalizes it to canonical form.",
		)
		.option("--complete", "Work finished successfully")
		.option("--needs-human", "Human intervention needed")
		.option("--failed", "Unable to complete the work")
		.option("--commit <hash>", "Git commit hash (required with --complete)")
		.option(
			"--reason <text>",
			"Explanation (required with --needs-human or --failed)",
		)
		.option("--notes <text>", "Optional additional context")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x protocol emit author --complete --commit abc123\n" +
				'  $ 5x protocol emit author --needs-human --reason "Need design decision"\n' +
				'  $ echo \'{"status":"done","commit":"abc123"}\' | 5x protocol emit author',
		)
		.action(async (opts) => {
			await protocolEmitAuthor({
				complete: opts.complete,
				needsHuman: opts.needsHuman,
				failed: opts.failed,
				commit: opts.commit,
				reason: opts.reason,
				notes: opts.notes,
			});
		});
}
