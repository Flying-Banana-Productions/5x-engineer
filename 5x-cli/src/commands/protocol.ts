/**
 * Protocol commands — citty adapter.
 *
 * Subcommands: validate
 *
 * Business logic lives in protocol.handler.ts.
 */

import { defineCommand } from "citty";
import { protocolValidate } from "./protocol.handler.js";

const sharedArgs = {
	input: {
		type: "string" as const,
		description: "Path to input JSON file (default: read from stdin)",
	},
	run: {
		type: "string" as const,
		description: "Run ID (used with --record)",
	},
	record: {
		type: "boolean" as const,
		description: "Record the validated result as a run step",
	},
	step: {
		type: "string" as const,
		description: "Step name for recording (used with --record)",
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
		description: "Validate an AuthorStatus structured result",
	},
	args: {
		...sharedArgs,
		"require-commit": {
			type: "boolean" as const,
			description:
				"Require commit hash for complete results (default: true). Use --no-require-commit to opt out.",
			default: true,
		},
		plan: {
			type: "string" as const,
			description: "Path to plan file for checklist validation",
		},
		"phase-checklist-validate": {
			type: "boolean" as const,
			default: true,
			description:
				"Validate phase checklist completion (use --no-phase-checklist-validate to skip)",
		},
	},
	run: ({ args }) =>
		protocolValidate({
			role: "author",
			input: args.input as string | undefined,
			requireCommit: args["require-commit"] as boolean | undefined,
			run: args.run as string | undefined,
			record: args.record as boolean | undefined,
			step: args.step as string | undefined,
			phase: args.phase as string | undefined,
			iteration: args.iteration
				? Number.parseInt(args.iteration as string, 10)
				: undefined,
			plan: args.plan as string | undefined,
			phaseChecklistValidate: args["phase-checklist-validate"] as
				| boolean
				| undefined,
		}),
});

const reviewerCmd = defineCommand({
	meta: {
		name: "reviewer",
		description: "Validate a ReviewerVerdict structured result",
	},
	args: sharedArgs,
	run: ({ args }) =>
		protocolValidate({
			role: "reviewer",
			input: args.input as string | undefined,
			run: args.run as string | undefined,
			record: args.record as boolean | undefined,
			step: args.step as string | undefined,
			phase: args.phase as string | undefined,
			iteration: args.iteration
				? Number.parseInt(args.iteration as string, 10)
				: undefined,
		}),
});

export default defineCommand({
	meta: {
		name: "protocol",
		description: "Structured protocol validation and recording",
	},
	subCommands: {
		validate: () =>
			Promise.resolve(
				defineCommand({
					meta: {
						name: "validate",
						description:
							"Validate structured JSON against author/reviewer protocol schemas",
					},
					subCommands: {
						author: () => Promise.resolve(authorCmd),
						reviewer: () => Promise.resolve(reviewerCmd),
					},
				}),
			),
	},
});
