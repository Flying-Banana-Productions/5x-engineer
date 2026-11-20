/**
 * Guide commands — commander adapter.
 *
 * Subcommands: plan
 *
 * Business logic lives in guide.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { guidePlan } from "./guide.handler.js";

export function registerGuide(parent: Command) {
	const guide = parent
		.command("guide")
		.summary("Task instructions for an agent working outside a 5x run")
		.description(
			"Print instructions for doing a single 5x task directly, without installing a\n" +
				"harness or taking on an orchestrator, author, or reviewer role. A guide is\n" +
				"read-only: it starts no run and writes nothing. Output is markdown; pass\n" +
				"--json for an envelope.",
		);

	guide
		.command("plan")
		.summary("How to write an implementation plan for this project")
		.description(
			"Print this project's plan-authoring rules for an agent to follow: the\n" +
				"configured plan template, the plan contract, how to check the result, and how\n" +
				"to hand it off for plan review. Run it, then follow its output.\n\n" +
				"Honors a project override of the author-generate-plan prompt.",
		)
		.argument(
			"[source]",
			"Requirements document (TDD, PRD, saved issue body). Omit when the requirements are in the conversation.",
		)
		.option(
			"-o, --out <path>",
			"Plan file to write; must be inside paths.plans. Omit to let the agent choose a name there.",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x guide plan docs/tdd/rate-limiter.md --out docs/development/031-rate-limiter.plan.md\n" +
				"  $ 5x guide plan docs/tdd/rate-limiter.md      # agent picks the plan file name\n" +
				"  $ 5x guide plan                               # requirements come from the conversation\n" +
				"  $ 5x guide plan spec.md --json                # envelope with prompt and resolved paths",
		)
		.action(async (source, opts) => {
			await guidePlan({ source, out: opts.out });
		});
}
