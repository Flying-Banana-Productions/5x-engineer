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
		.description(
			"Manage implementation runs — the unit of work in the 5x workflow. A run tracks\n" +
				"an AI agent's progress through an implementation plan, recording each step\n" +
				"(author, reviewer, quality gate) with metadata. Runs are backed by a local\n" +
				"SQLite database in the project's .5x directory.",
		);

	// ── init ──────────────────────────────────────────────────────────
	run
		.command("init")
		.summary("Initialize or resume a run for a plan")
		.description(
			"Create a new run for an implementation plan, or resume an existing active run\n" +
				"for the same plan. Optionally creates or attaches a git worktree for isolated\n" +
				"development. If a run already exists for the plan and is still active, returns\n" +
				"the existing run ID.",
		)
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
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x run init -p docs/development/015-test-separation.md\n" +
				"  $ 5x run init -p plan.md -w                        # create worktree\n" +
				"  $ 5x run init -p plan.md -w /tmp/my-worktree       # use specific path\n" +
				"  $ 5x run init -p plan.md --allow-dirty              # skip clean-worktree check",
		)
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
		.description(
			"Retrieve the current state of a run: status, step history, and summary\n" +
				"metadata. Supports filtering to recent steps via --tail or --since-step for\n" +
				"efficient polling. Accepts either --run (by ID) or --plan (finds the active\n" +
				"run for that plan).",
		)
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
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x run state -r abc123\n" +
				"  $ 5x run state -p plan.md\n" +
				"  $ 5x run state -r abc123 -t 5                      # last 5 steps only\n" +
				"  $ 5x run state -r abc123 --since-step 42            # steps after #42",
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
		.description(
			"Append a step to a run's history. Steps capture what happened (author\n" +
				"implementation, reviewer verdict, quality check) with optional metadata:\n" +
				"session ID, model, token counts, cost, and duration. The result can be\n" +
				"provided as a JSON string, read from stdin (-), or read from a file (@path).",
		)
		.argument("[step-name]", "Step name (e.g. author:impl:status)")
		.option("-r, --run <id>", "Run ID")
		.option(
			"--result <value>",
			'Result JSON (raw string, "-" for stdin, "@path" for file)',
		)
		.option("-p, --phase <name>", "Phase identifier")
		.option("--iteration <n>", "Iteration number", intArg("--iteration"))
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
		.addHelpText(
			"after",
			"\nOption Groups:\n" +
				"  Required:  [step-name], -r/--run\n" +
				'  Result:    --result (raw string, "-" for stdin, "@path" for file)\n' +
				"  Metadata:  -p/--phase, --iteration, --session-id, --model\n" +
				"  Metrics:   --tokens-in, --tokens-out, --cost-usd, --duration-ms, --log-path\n" +
				"\nExamples:\n" +
				'  $ 5x run record author:impl:status -r abc123 --result \'{"status":"complete"}\'\n' +
				"  $ echo '{\"ok\":true}' | 5x run record quality:check -r abc123 --result=-\n" +
				"  $ 5x run record review:verdict -r abc123 --result=@/tmp/verdict.json\n" +
				"  $ 5x run record author:impl -r abc123 -p phase-1 --iteration 2 \\\n" +
				"      --model claude-sonnet --tokens-in 5000 --tokens-out 2000",
		)
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
		.description(
			'Set a run\'s terminal status to "completed" or "aborted". Once completed, no\n' +
				'further steps can be recorded. Use "run reopen" to reverse this.',
		)
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
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x run complete -r abc123\n" +
				'  $ 5x run complete -r abc123 -s aborted --reason "Plan superseded"',
		)
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
		.description(
			"Return a terminated run to active status, allowing additional steps to be\n" +
				"recorded. Useful when a run was completed prematurely.",
		)
		.requiredOption("-r, --run <id>", "Run ID")
		.addHelpText("after", "\nExamples:\n" + "  $ 5x run reopen -r abc123")
		.action(async (opts) => {
			await runV1Reopen({
				run: opts.run,
			});
		});

	// ── list ──────────────────────────────────────────────────────────
	run
		.command("list")
		.summary("List runs with optional filters")
		.description(
			"List runs in the project database. Filter by plan path, status, or limit the\n" +
				"number of results. Returns an array of run summaries.",
		)
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
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x run list\n" +
				"  $ 5x run list -p plan.md\n" +
				"  $ 5x run list -s active -n 10\n" +
				"  $ 5x run list --status completed",
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
		.description(
			"Tail the NDJSON log file for a run, streaming new entries as they are written.\n" +
				"In human-readable mode, formats log entries with timestamps and optional\n" +
				"reasoning display. Useful for monitoring a running agent session.",
		)
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
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x run watch -r abc123\n" +
				"  $ 5x run watch -r abc123 --human-readable --show-reasoning\n" +
				"  $ 5x run watch -r abc123 --tail-only                # skip replay, live only",
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
