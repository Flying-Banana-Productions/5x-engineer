/**
 * v1 Run lifecycle commands — commander adapter.
 *
 * Subcommands: init, state, record, complete, reopen, list, watch
 *
 * Business logic lives in run-v1.handler.ts.
 */

import { type Command, Option } from "@commander-js/extra-typings";
import { floatArg, intArg } from "../utils/parse-args.js";
import {
	runV1Complete,
	runV1Init,
	runV1List,
	runV1Record,
	runV1Reopen,
	runV1State,
	runV1Watch,
} from "./run-v1.handler.js";

export function registerRun(parent: Command) {
	const run = parent
		.command("run")
		.summary("Run lifecycle management")
		.description("Run lifecycle management");

	// ── init ──────────────────────────────────────────────────────────
	run
		.command("init")
		.summary("Initialize or resume a run for a plan")
		.description("Initialize or resume a run for a plan")
		.requiredOption(
			"-p, --plan <path>",
			"Path to implementation plan output (may not exist yet; must be under paths.plans)",
		)
		.option("--allow-dirty", "Allow dirty worktree")
		.option(
			"-w, --worktree [path]",
			"Ensure a plan worktree exists; optionally specify a path",
		)
		.option("--worktree-path <path>", "Explicit worktree path (deprecated)")
		.action(async (opts) => {
			// Map the consolidated --worktree [path] + deprecated --worktree-path
			let worktree = false;
			let worktreePath: string | undefined;

			if (opts.worktreePath) {
				// Deprecated --worktree-path used
				process.stderr.write(
					"Warning: --worktree-path is deprecated, use --worktree <path> instead\n",
				);
				worktree = true;
				worktreePath = opts.worktreePath;
			}

			if (opts.worktree !== undefined) {
				worktree = true;
				if (typeof opts.worktree === "string") {
					worktreePath = opts.worktree;
				}
			}

			await runV1Init({
				plan: opts.plan,
				allowDirty: opts.allowDirty,
				worktree,
				worktreePath,
			});
		});

	// Hide --worktree-path from help output
	const initCmd = run.commands.find((c) => c.name() === "init");
	if (initCmd) {
		const wtpOpt = initCmd.options.find((o) => o.long === "--worktree-path");
		if (wtpOpt) wtpOpt.hideHelp();
	}

	// ── state ─────────────────────────────────────────────────────────
	run
		.command("state")
		.summary("Get run state including steps and summary")
		.description("Get run state including steps and summary")
		.option("-r, --run <id>", "Run ID")
		.option("-p, --plan <path>", "Plan path (alternative to --run)")
		.option(
			"-t, --tail <n>",
			"Return only the last N steps",
			intArg("--tail", { positive: true }),
		)
		.option(
			"--since-step <n>",
			"Return only steps after this step ID",
			intArg("--since-step"),
		)
		.action(async (opts) => {
			await runV1State({
				run: opts.run,
				plan: opts.plan,
				tail: opts.tail,
				sinceStep: opts.sinceStep,
			});
		});

	// ── record ────────────────────────────────────────────────────────
	run
		.command("record")
		.summary("Record a step in a run")
		.description("Record a step in a run")
		.argument("[step-name]", "Step name (e.g. author:impl:status)")
		.option("-r, --run <id>", "Run ID")
		.option(
			"--result <value>",
			'Result JSON (raw string, "-" for stdin, "@path" for file)',
		)
		.option("-p, --phase <name>", "Phase identifier")
		.option(
			"--iteration <n>",
			"Iteration number",
			intArg("--iteration", { positive: true }),
		)
		.option("--session-id <id>", "Agent session ID")
		.option("--model <name>", "Model used")
		.option("--tokens-in <n>", "Input tokens", intArg("--tokens-in"))
		.option("--tokens-out <n>", "Output tokens", intArg("--tokens-out"))
		.option(
			"--cost-usd <n>",
			"Cost in USD",
			floatArg("--cost-usd", { nonNegative: true }),
		)
		.option(
			"--duration-ms <n>",
			"Duration in milliseconds",
			intArg("--duration-ms"),
		)
		.option("--log-path <path>", "Path to NDJSON log file")
		.action(async (stepName, opts) => {
			await runV1Record({
				stepName,
				run: opts.run,
				result: opts.result,
				phase: opts.phase,
				iteration: opts.iteration,
				sessionId: opts.sessionId,
				model: opts.model,
				tokensIn: opts.tokensIn,
				tokensOut: opts.tokensOut,
				costUsd: opts.costUsd,
				durationMs: opts.durationMs,
				logPath: opts.logPath,
			});
		});

	// ── complete ──────────────────────────────────────────────────────
	run
		.command("complete")
		.summary("Complete or abort a run")
		.description("Complete or abort a run")
		.requiredOption("-r, --run <id>", "Run ID")
		.addOption(
			new Option(
				"-s, --status <status>",
				"Terminal status (completed or aborted)",
			)
				.choices(["completed", "aborted"] as const)
				.default("completed"),
		)
		.option("--reason <text>", "Reason for completion/abort")
		.action(async (opts) => {
			await runV1Complete({
				run: opts.run,
				status: opts.status as "completed" | "aborted" | undefined,
				reason: opts.reason,
			});
		});

	// ── reopen ────────────────────────────────────────────────────────
	run
		.command("reopen")
		.summary("Reopen a completed or aborted run")
		.description("Reopen a completed or aborted run")
		.requiredOption("-r, --run <id>", "Run ID")
		.action(async (opts) => {
			await runV1Reopen({
				run: opts.run,
			});
		});

	// ── list ──────────────────────────────────────────────────────────
	run
		.command("list")
		.summary("List runs with optional filters")
		.description("List runs with optional filters")
		.option("-p, --plan <path>", "Filter by plan path")
		.addOption(
			new Option(
				"-s, --status <status>",
				"Filter by status (active, completed, aborted)",
			).choices(["active", "completed", "aborted"] as const),
		)
		.option(
			"-n, --limit <n>",
			"Maximum number of results",
			intArg("--limit", { positive: true }),
		)
		.action(async (opts) => {
			await runV1List({
				plan: opts.plan,
				status: opts.status,
				limit: opts.limit,
			});
		});

	// ── watch ─────────────────────────────────────────────────────────
	run
		.command("watch")
		.summary("Watch agent logs for a run in real-time")
		.description("Watch agent logs for a run in real-time")
		.requiredOption("-r, --run <id>", "Run ID")
		.option(
			"--human-readable",
			"Render human-readable output instead of raw NDJSON",
		)
		.option(
			"--show-reasoning",
			"Show agent reasoning (human-readable mode only)",
		)
		.option(
			"--tail-only",
			"Start at current EOF instead of replaying existing logs",
		)
		.option("--workdir <path>", "Project root override")
		.option(
			"--poll-interval <ms>",
			"Poll interval in ms (for testing)",
			(val: string) => Number.parseInt(val, 10),
		)
		.action(async (opts) => {
			await runV1Watch({
				run: opts.run,
				humanReadable: opts.humanReadable,
				showReasoning: opts.showReasoning,
				noReplay: opts.tailOnly,
				workdir: opts.workdir,
				pollInterval: opts.pollInterval,
			});
		});
}
