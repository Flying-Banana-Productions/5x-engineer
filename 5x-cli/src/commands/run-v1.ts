/**
 * v1 Run lifecycle commands — citty adapter.
 *
 * Subcommands: init, state, record, complete, reopen, list
 *
 * Business logic lives in run-v1.handler.ts.
 */

import { defineCommand } from "citty";
import { parseFloatArg, parseIntArg } from "../utils/parse-args.js";
import {
	runV1Complete,
	runV1Init,
	runV1List,
	runV1Record,
	runV1Reopen,
	runV1State,
	runV1Watch,
} from "./run-v1.handler.js";

const initCmd = defineCommand({
	meta: {
		name: "init",
		description: "Initialize or resume a run for a plan",
	},
	args: {
		plan: {
			type: "string",
			description: "Path to implementation plan",
			required: true,
		},
		"allow-dirty": {
			type: "boolean",
			description: "Allow dirty worktree",
			default: false,
		},
		worktree: {
			type: "boolean",
			description:
				"Ensure a plan worktree exists (use --worktree-path for explicit path)",
			default: false,
		},
		"worktree-path": {
			type: "string",
			description:
				"Explicit worktree path to attach (or use --worktree <path> shorthand)",
		},
	},
	run: ({ args }) =>
		runV1Init({
			plan: args.plan as string,
			allowDirty: args["allow-dirty"] as boolean,
			worktree: args.worktree as boolean,
			worktreePath: args["worktree-path"] as string | undefined,
		}),
});

const stateCmd = defineCommand({
	meta: {
		name: "state",
		description: "Get run state including steps and summary",
	},
	args: {
		run: {
			type: "string",
			description: "Run ID",
		},
		plan: {
			type: "string",
			description: "Plan path (alternative to --run)",
		},
		tail: {
			type: "string",
			description: "Return only the last N steps",
		},
		"since-step": {
			type: "string",
			description: "Return only steps after this step ID",
		},
	},
	run: ({ args }) =>
		runV1State({
			run: args.run as string | undefined,
			plan: args.plan as string | undefined,
			tail: args.tail
				? parseIntArg(args.tail as string, "--tail", { positive: true })
				: undefined,
			sinceStep: args["since-step"]
				? parseIntArg(args["since-step"] as string, "--since-step")
				: undefined,
		}),
});

const recordCmd = defineCommand({
	meta: {
		name: "record",
		description: "Record a step in a run",
	},
	args: {
		stepName: {
			type: "positional",
			description: "Step name (e.g. author:impl:status)",
			required: false,
		},
		run: {
			type: "string",
			description: "Run ID",
			required: false,
		},
		result: {
			type: "string",
			description: 'Result JSON (raw string, "-" for stdin, "@path" for file)',
			required: false,
		},
		phase: { type: "string", description: "Phase identifier" },
		iteration: { type: "string", description: "Iteration number" },
		"session-id": { type: "string", description: "Agent session ID" },
		model: { type: "string", description: "Model used" },
		"tokens-in": { type: "string", description: "Input tokens" },
		"tokens-out": { type: "string", description: "Output tokens" },
		"cost-usd": { type: "string", description: "Cost in USD" },
		"duration-ms": { type: "string", description: "Duration in milliseconds" },
		"log-path": { type: "string", description: "Path to NDJSON log file" },
	},
	run: ({ args }) =>
		runV1Record({
			stepName: args.stepName as string | undefined,
			run: args.run as string | undefined,
			result: args.result as string | undefined,
			phase: args.phase as string | undefined,
			iteration: args.iteration
				? parseIntArg(args.iteration as string, "--iteration", {
						positive: true,
					})
				: undefined,
			sessionId: args["session-id"] as string | undefined,
			model: args.model as string | undefined,
			tokensIn: args["tokens-in"]
				? parseIntArg(args["tokens-in"] as string, "--tokens-in")
				: undefined,
			tokensOut: args["tokens-out"]
				? parseIntArg(args["tokens-out"] as string, "--tokens-out")
				: undefined,
			costUsd: args["cost-usd"]
				? parseFloatArg(args["cost-usd"] as string, "--cost-usd", {
						nonNegative: true,
					})
				: undefined,
			durationMs: args["duration-ms"]
				? parseIntArg(args["duration-ms"] as string, "--duration-ms")
				: undefined,
			logPath: args["log-path"] as string | undefined,
		}),
});

const completeCmd = defineCommand({
	meta: {
		name: "complete",
		description: "Complete or abort a run",
	},
	args: {
		run: {
			type: "string",
			description: "Run ID",
			required: true,
		},
		status: {
			type: "string",
			description: "Terminal status (completed or aborted)",
			default: "completed",
		},
		reason: {
			type: "string",
			description: "Reason for completion/abort",
		},
	},
	run: ({ args }) =>
		runV1Complete({
			run: args.run as string,
			status: args.status as "completed" | "aborted" | undefined,
			reason: args.reason as string | undefined,
		}),
});

const reopenCmd = defineCommand({
	meta: {
		name: "reopen",
		description: "Reopen a completed or aborted run",
	},
	args: {
		run: {
			type: "string",
			description: "Run ID",
			required: true,
		},
	},
	run: ({ args }) =>
		runV1Reopen({
			run: args.run as string,
		}),
});

const listCmd = defineCommand({
	meta: {
		name: "list",
		description: "List runs with optional filters",
	},
	args: {
		plan: {
			type: "string",
			description: "Filter by plan path",
		},
		status: {
			type: "string",
			description: "Filter by status (active, completed, aborted)",
		},
		limit: {
			type: "string",
			description: "Maximum number of results",
		},
	},
	run: ({ args }) =>
		runV1List({
			plan: args.plan as string | undefined,
			status: args.status as string | undefined,
			limit: args.limit
				? parseIntArg(args.limit as string, "--limit", { positive: true })
				: undefined,
		}),
});

const watchCmd = defineCommand({
	meta: {
		name: "watch",
		description: "Watch agent logs for a run in real-time",
	},
	args: {
		run: {
			type: "string" as const,
			description: "Run ID",
			required: true as const,
		},
		"human-readable": {
			type: "boolean" as const,
			description: "Render human-readable output instead of raw NDJSON",
			default: false,
		},
		"show-reasoning": {
			type: "boolean" as const,
			description: "Show agent reasoning (human-readable mode only)",
			default: false,
		},
		"tail-only": {
			type: "boolean" as const,
			description: "Start at current EOF instead of replaying existing logs",
			default: false,
		},
		workdir: {
			type: "string" as const,
			description: "Project root override",
		},
	},
	run: ({ args }) =>
		runV1Watch({
			run: args.run as string,
			humanReadable: args["human-readable"] as boolean,
			showReasoning: args["show-reasoning"] as boolean,
			noReplay: args["tail-only"] as boolean,
			workdir: args.workdir as string | undefined,
		}),
});

export default defineCommand({
	meta: {
		name: "run",
		description: "Run lifecycle management",
	},
	subCommands: {
		init: () => Promise.resolve(initCmd),
		state: () => Promise.resolve(stateCmd),
		record: () => Promise.resolve(recordCmd),
		complete: () => Promise.resolve(completeCmd),
		reopen: () => Promise.resolve(reopenCmd),
		list: () => Promise.resolve(listCmd),
		watch: () => Promise.resolve(watchCmd),
	},
});
