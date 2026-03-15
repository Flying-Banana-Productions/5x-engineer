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
			intArg("--iteration", { positive: true }),
		);
}

export function registerInvoke(parent: Command) {
	const invoke = parent
		.command("invoke")
		.summary("Invoke an agent with a prompt template")
		.description("Invoke an agent with a prompt template");

	addInvokeOptions(
		invoke
			.command("author")
			.summary("Invoke an author agent with a template")
			.description("Invoke an author agent with a template"),
	).action(async (template, opts) => {
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
			.description("Invoke a reviewer agent with a template"),
	).action(async (template, opts) => {
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
