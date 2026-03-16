/**
 * v1 Agent invocation commands — commander adapter.
 *
 * Subcommands: author, reviewer
 *
 * Business logic lives in invoke.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { collect, intArg, timeoutArg } from "../utils/parse-args.js";
import { invokeAgent } from "./invoke.handler.js";

/**
 * Register shared options on an invoke subcommand.
 * Returns the same command for chaining.
 */
function addInvokeOptions<C extends Command>(cmd: C) {
	return cmd
		.argument("<template>", "Template name (e.g. author-next-phase)")
		.option(
			"-r, --run <id>",
			"Run ID (provide via flag or pipe from upstream command)",
		)
		.option(
			"--var <key=value>",
			"Template variable (key=value, repeatable)",
			collect,
			[] as string[],
		)
		.option("-m, --model <name>", "Model override")
		.option(
			"-w, --workdir <path>",
			"Working directory for agent tool execution",
		)
		.option("--session <id>", "Resume an existing session by ID")
		.option(
			"-t, --timeout <seconds>",
			"Per-run timeout in seconds",
			timeoutArg(),
		)
		.option("-q, --quiet", "Suppress console output (stderr)")
		.option(
			"--show-reasoning",
			"Show agent reasoning/thinking in console output",
		)
		.option("--stderr", "Stream output to stderr even when not a TTY")
		.option(
			"--author-provider <name>",
			"Override author provider (e.g. codex, @acme/provider-foo)",
		)
		.option("--reviewer-provider <name>", "Override reviewer provider")
		.option(
			"--opencode-url <url>",
			"Override OpenCode server URL (external mode)",
		)
		.option(
			"--record",
			"Auto-record the result as a run step (uses template's step_name)",
		)
		.option(
			"--record-step <name>",
			"Override step name for recording (default: from template frontmatter)",
		)
		.option("--phase <name>", "Phase identifier (used with --record)")
		.option(
			"--iteration <n>",
			"Iteration number (used with --record)",
			intArg("--iteration"),
		);
}

/**
 * Build an option-grouped help text block for invoke subcommands.
 */
function invokeHelpSuffix(examples: string): string {
	return (
		"\nOption Groups:\n" +
		"  Template:   <template>, --var, --session\n" +
		"  Execution:  -r/--run, -m/--model, -t/--timeout, -w/--workdir,\n" +
		"              --author-provider, --reviewer-provider, --opencode-url\n" +
		"  Output:     -q/--quiet, --show-reasoning, --stderr\n" +
		"  Recording:  --record, --record-step, --phase, --iteration\n" +
		`\nExamples:\n${examples}`
	);
}

export function registerInvoke(parent: Command) {
	const invoke = parent
		.command("invoke")
		.summary("Invoke an AI agent with a prompt template")
		.description(
			"Launch an author or reviewer agent with a prompt template. Templates are\n" +
				"rendered with variable substitution, then sent to the configured AI provider.\n" +
				"Supports session resumption, model override, timeout, and automatic run step\n" +
				"recording.",
		);

	addInvokeOptions(
		invoke
			.command("author")
			.summary("Invoke an author agent with a template")
			.description(
				"Launch an author agent using the specified prompt template. The author agent\n" +
					"generates code, documentation, or other artifacts. Use --var to inject\n" +
					"template variables, --model to override the provider, and --record to\n" +
					"automatically save the result as a run step.",
			),
	)
		.addHelpText(
			"after",
			invokeHelpSuffix(
				"  $ 5x invoke author author-next-phase -r abc123\n" +
					'  $ 5x invoke author author-fix-quality -r abc123 --var user_notes="fix lint"\n' +
					"  $ 5x invoke author author-next-phase -r abc123 -m claude-opus -t 300\n" +
					"  $ 5x invoke author author-next-phase -r abc123 --record --phase phase-1",
			),
		)
		.action(async (template, opts) => {
			await invokeAgent("author", {
				template,
				run: opts.run,
				vars: opts.var,
				model: opts.model,
				workdir: opts.workdir,
				session: opts.session,
				timeoutSeconds: opts.timeout,
				quiet: opts.quiet,
				showReasoning: opts.showReasoning,
				stderr: opts.stderr,
				authorProvider: opts.authorProvider,
				reviewerProvider: opts.reviewerProvider,
				opencodeUrl: opts.opencodeUrl,
				record: opts.record,
				recordStep: opts.recordStep,
				phase: opts.phase,
				iteration: opts.iteration,
			});
		});

	addInvokeOptions(
		invoke
			.command("reviewer")
			.summary("Invoke a reviewer agent with a template")
			.description(
				"Launch a reviewer agent using the specified prompt template. The reviewer\n" +
					"agent evaluates code or plan quality and produces a structured verdict.",
			),
	)
		.addHelpText(
			"after",
			invokeHelpSuffix(
				"  $ 5x invoke reviewer reviewer-plan -r abc123\n" +
					"  $ 5x invoke reviewer reviewer-impl -r abc123 --phase phase-1 --record\n" +
					"  $ 5x invoke reviewer reviewer-impl -r abc123 -q              # quiet mode",
			),
		)
		.action(async (template, opts) => {
			await invokeAgent("reviewer", {
				template,
				run: opts.run,
				vars: opts.var,
				model: opts.model,
				workdir: opts.workdir,
				session: opts.session,
				timeoutSeconds: opts.timeout,
				quiet: opts.quiet,
				showReasoning: opts.showReasoning,
				stderr: opts.stderr,
				authorProvider: opts.authorProvider,
				reviewerProvider: opts.reviewerProvider,
				opencodeUrl: opts.opencodeUrl,
				record: opts.record,
				recordStep: opts.recordStep,
				phase: opts.phase,
				iteration: opts.iteration,
			});
		});
}
