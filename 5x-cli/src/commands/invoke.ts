/**
 * v1 Agent invocation commands — citty adapter.
 *
 * Subcommands: author, reviewer
 *
 * Business logic lives in invoke.handler.ts.
 */

import { defineCommand } from "citty";
import { parseTimeout } from "../utils/parse-args.js";
import { invokeAgent } from "./invoke.handler.js";

const sharedArgs = {
	template: {
		type: "positional" as const,
		description: "Template name (e.g. author-next-phase)",
		required: true as const,
	},
	run: {
		type: "string" as const,
		description: "Run ID (provide via flag or pipe from upstream command)",
		required: false as const,
	},
	var: {
		type: "string" as const,
		description: "Template variable (key=value, repeatable)",
	},
	model: {
		type: "string" as const,
		description: "Model override",
	},
	workdir: {
		type: "string" as const,
		description: "Working directory for agent tool execution",
	},
	session: {
		type: "string" as const,
		description: "Resume an existing session by ID",
	},
	timeout: {
		type: "string" as const,
		description: "Per-run timeout in seconds",
	},
	quiet: {
		type: "boolean" as const,
		description: "Suppress console output (stderr)",
		default: false,
	},
	"show-reasoning": {
		type: "boolean" as const,
		description: "Show agent reasoning/thinking in console output",
		default: false,
	},
	stderr: {
		type: "boolean" as const,
		description: "Stream output to stderr even when not a TTY",
		default: false,
	},
	"author-provider": {
		type: "string" as const,
		description: "Override author provider (e.g. codex, @acme/provider-foo)",
	},
	"reviewer-provider": {
		type: "string" as const,
		description: "Override reviewer provider",
	},
	"opencode-url": {
		type: "string" as const,
		description: "Override OpenCode server URL (external mode)",
	},
	record: {
		type: "boolean" as const,
		description:
			"Auto-record the result as a run step (uses template's step_name)",
	},
	"record-step": {
		type: "string" as const,
		description:
			"Override step name for recording (default: from template frontmatter)",
	},
	phase: {
		type: "string" as const,
		description: "Phase identifier (used with --record)",
	},
	iteration: {
		type: "string" as const,
		description: "Iteration number (used with --record)",
	},
};

const authorCmd = defineCommand({
	meta: {
		name: "author",
		description: "Invoke an author agent with a template",
	},
	args: sharedArgs,
	run: ({ args }) =>
		invokeAgent("author", {
			template: args.template as string,
			run: args.run as string | undefined,
			vars: args.var as string | string[] | undefined,
			model: args.model as string | undefined,
			workdir: args.workdir as string | undefined,
			session: args.session as string | undefined,
			timeoutSeconds: parseTimeout(args.timeout as string | undefined),
			quiet: args.quiet as boolean | undefined,
			showReasoning: args["show-reasoning"] as boolean | undefined,
			stderr: args.stderr as boolean | undefined,
			authorProvider: args["author-provider"] as string | undefined,
			reviewerProvider: args["reviewer-provider"] as string | undefined,
			opencodeUrl: args["opencode-url"] as string | undefined,
			record: args.record as boolean | undefined,
			recordStep: args["record-step"] as string | undefined,
			phase: args.phase as string | undefined,
			iteration: args.iteration
				? Number.parseInt(args.iteration as string, 10)
				: undefined,
		}),
});

const reviewerCmd = defineCommand({
	meta: {
		name: "reviewer",
		description: "Invoke a reviewer agent with a template",
	},
	args: sharedArgs,
	run: ({ args }) =>
		invokeAgent("reviewer", {
			template: args.template as string,
			run: args.run as string | undefined,
			vars: args.var as string | string[] | undefined,
			model: args.model as string | undefined,
			workdir: args.workdir as string | undefined,
			session: args.session as string | undefined,
			timeoutSeconds: parseTimeout(args.timeout as string | undefined),
			quiet: args.quiet as boolean | undefined,
			showReasoning: args["show-reasoning"] as boolean | undefined,
			stderr: args.stderr as boolean | undefined,
			authorProvider: args["author-provider"] as string | undefined,
			reviewerProvider: args["reviewer-provider"] as string | undefined,
			opencodeUrl: args["opencode-url"] as string | undefined,
			record: args.record as boolean | undefined,
			recordStep: args["record-step"] as string | undefined,
			phase: args.phase as string | undefined,
			iteration: args.iteration
				? Number.parseInt(args.iteration as string, 10)
				: undefined,
		}),
});

export default defineCommand({
	meta: {
		name: "invoke",
		description: "Invoke an agent with a prompt template",
	},
	subCommands: {
		author: () => Promise.resolve(authorCmd),
		reviewer: () => Promise.resolve(reviewerCmd),
	},
});
