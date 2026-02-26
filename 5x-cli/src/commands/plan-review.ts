import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
	createAndVerifyAdapter,
	registerAdapterShutdown,
} from "../agents/factory.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { getActiveRun, getAgentResults } from "../db/operations.js";
import { runMigrations } from "../db/schema.js";
import { createDebugTraceLogger } from "../debug/trace.js";
import { overlayEnvFromDirectory } from "../env.js";
import { resumeGate as headlessResumeGate } from "../gates/human.js";
import { checkGitSafety } from "../git.js";
import {
	resolveReviewPath,
	runPlanReviewLoop,
} from "../orchestrator/plan-review-loop.js";
import { parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";
import { createTuiController } from "../tui/controller.js";
import { resolveTuiListen } from "../tui/detect.js";
import {
	createTuiHumanGate,
	createTuiPlanReviewResumeGate,
} from "../tui/gates.js";
import {
	createPermissionHandler,
	NON_INTERACTIVE_NO_FLAG_ERROR,
	type PermissionPolicy,
} from "../tui/permissions.js";

export default defineCommand({
	meta: {
		name: "plan-review",
		description: "Run automated review loop on an implementation plan",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan markdown file",
			required: true,
		},
		auto: {
			type: "boolean",
			description:
				"Auto-resolve mechanical fixes; still escalate human_required items",
			default: false,
		},
		"allow-dirty": {
			type: "boolean",
			description: "Allow running with a dirty working tree",
			default: false,
		},
		quiet: {
			type: "boolean",
			description:
				"Suppress formatted agent output (default: auto, quiet when stdout is not a TTY). Log files are always written. Logs may contain sensitive data.",
		},
		"tui-listen": {
			type: "boolean",
			description:
				"Enable external TUI attach listening (default: off; attach manually in another terminal)",
			default: false,
		},
		ci: {
			type: "boolean",
			description: "CI/unattended mode: auto-approve all tool permissions",
			default: false,
		},
		"show-reasoning": {
			type: "boolean",
			description:
				"Show agent reasoning/thinking tokens inline (dim styling). Default: suppressed.",
			default: false,
		},
		"debug-trace": {
			type: "boolean",
			description:
				"Write detailed lifecycle trace logs to .5x/debug for hang diagnosis",
			default: false,
		},
	},
	async run({ args }) {
		const projectRoot = resolveProjectRoot();
		const traceLogger = createDebugTraceLogger({
			enabled: Boolean(args["debug-trace"] || process.env.FIVEX_DEBUG_TRACE),
			projectRoot,
			command: "plan-review",
		});
		const trace = traceLogger.trace;
		if (traceLogger.enabled && traceLogger.filePath) {
			console.log(`  Debug trace: ${traceLogger.filePath}`);
		}

		const planPath = resolve(args.path);
		const canonical = canonicalizePlanPath(planPath);
		trace("plan_review.command.start", {
			planPath: canonical,
			auto: args.auto,
			tuiListen: args["tui-listen"],
			ci: args.ci,
		});

		// Validate plan file
		if (!existsSync(canonical)) {
			trace("plan_review.plan.not_found", { planPath: canonical });
			console.error(`Error: Plan file not found: ${planPath}`);
			process.exit(1);
		}

		let planContent: string;
		try {
			planContent = readFileSync(canonical, "utf-8");
		} catch {
			trace("plan_review.plan.read_error", { planPath: canonical });
			console.error(`Error: Could not read plan file: ${canonical}`);
			process.exit(1);
		}

		// Verify it's parseable as a plan
		const plan = parsePlan(planContent);
		if (plan.phases.length === 0) {
			trace("plan_review.plan.no_phases", { planPath: canonical });
			console.error(
				"Error: No phases found in plan file. Is this a valid implementation plan?",
			);
			process.exit(1);
		}

		// Derive project root consistently (config file > git root > cwd)
		overlayEnvFromDirectory(projectRoot, process.env);
		const { config } = await loadConfig(projectRoot);
		trace("plan_review.config.loaded", {
			projectRoot,
			reviewsPath: config.paths.reviews,
		});

		// Git safety check
		if (!args["allow-dirty"]) {
			try {
				const safety = await checkGitSafety(projectRoot);
				if (!safety.safe) {
					trace("plan_review.git.unsafe");
					console.error(
						"Error: Working tree has uncommitted changes. " +
							"Commit or stash them, or pass --allow-dirty to proceed.",
					);
					process.exit(1);
				}
			} catch {
				trace("plan_review.git.check_skipped");
				// git not available or not a repo — skip check
			}
		}

		// Initialize DB
		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		// Resolve review path
		const reviewsDir = resolve(projectRoot, config.paths.reviews);
		const reviewPath = resolveReviewPath(db, canonical, reviewsDir);

		// --- Fail-closed check for non-interactive mode (before adapter creation) ---
		const isNonInteractive = !process.stdin.isTTY;
		if (isNonInteractive && !args.auto && !args.ci) {
			trace("plan_review.non_interactive.no_policy");
			console.error(NON_INTERACTIVE_NO_FLAG_ERROR);
			process.exitCode = 1;
			return;
		}

		// Initialize adapters
		console.log();
		console.log(`  Plan: ${plan.title}`);
		console.log(`  Review path: ${reviewPath}`);
		console.log();

		let adapter: Awaited<ReturnType<typeof createAndVerifyAdapter>>;
		try {
			trace("plan_review.adapter.create.start");
			adapter = await createAndVerifyAdapter(config.author);
			trace("plan_review.adapter.create.ok", { serverUrl: adapter.serverUrl });
		} catch (err) {
			trace("plan_review.adapter.create.error", {
				error: err instanceof Error ? err.message : String(err),
			});
			const message = err instanceof Error ? err.message : String(err);
			console.error(`\n  Error: Failed to initialize agent adapter.`);
			if (message) console.error(`  Cause: ${message}`);
			process.exitCode = 1;
			return;
		}

		// Resolve effective quiet mode: explicit flag > TTY detection
		const effectiveQuiet =
			args.quiet !== undefined ? args.quiet : !process.stdout.isTTY;

		// --- TUI mode detection ---
		const tuiMode = resolveTuiListen(args);
		const isTuiRequested = tuiMode.enabled;
		trace("plan_review.tui.mode", {
			reason: tuiMode.reason,
			enabled: isTuiRequested,
		});

		// If an interrupted plan-review run exists and TUI is requested, ask the
		// resume question before spawning TUI so the prompt is always visible.
		let pendingResumeDecision: "resume" | "start-fresh" | "abort" | undefined;
		if (isTuiRequested && !args.auto) {
			const activeRun = getActiveRun(db, canonical);
			if (activeRun && activeRun.command === "plan-review") {
				const iteration = getAgentResults(db, activeRun.id, "-1").length;
				trace("plan_review.resume.pre_tui.prompt", {
					runId: activeRun.id,
					iteration,
				});
				pendingResumeDecision = await headlessResumeGate(
					activeRun.id,
					`iteration-${iteration}`,
					"REVIEW",
				);

				if (pendingResumeDecision === "abort") {
					trace("plan_review.resume.pre_tui.abort", { runId: activeRun.id });
					console.log();
					console.log("  Plan review: ABORTED");
					console.log(`  Run ID: ${activeRun.id.slice(0, 8)}`);
					console.log();
					process.exitCode = 1;
					return;
				}

				trace("plan_review.resume.pre_tui.decision", {
					runId: activeRun.id,
					decision: pendingResumeDecision,
				});
			}
		}

		// --- Register adapter shutdown with TUI mode support ---
		const cancelController = new AbortController();
		// --- Spawn TUI ---
		const tui = createTuiController({
			serverUrl: adapter.serverUrl,
			workdir: projectRoot,
			client: (adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			enabled: isTuiRequested,
			trace,
		});
		const tuiOwnsTerminal = () => false;
		trace("plan_review.tui.controller.ready", {
			active: tui.active,
			attached: false,
			effectiveTuiMode: false,
		});

		registerAdapterShutdown(adapter, {
			tuiMode: false,
			cancelController,
		});

		// --- Resolve permission policy ---
		const permissionPolicy: PermissionPolicy =
			args.auto || args.ci
				? { mode: "auto-approve-all" }
				: { mode: "workdir-scoped", workdir: projectRoot };

		// --- Start permission handler ---
		const permissionHandler = createPermissionHandler(
			(adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			permissionPolicy,
			trace,
		);
		permissionHandler.start();

		// Phase 5: Create TUI-native gates when in TUI mode (non-auto)
		// These replace the readline-based gates from gates/human.ts
		const tuiHumanGate =
			isTuiRequested && !args.auto
				? createTuiHumanGate(
						(adapter as import("../agents/opencode.js").OpenCodeAdapter)
							._clientForTui,
						tui,
						{ signal: cancelController.signal, directory: projectRoot },
					)
				: undefined;
		const tuiResumeGate =
			pendingResumeDecision !== undefined
				? async () => {
						const decision = pendingResumeDecision ?? "abort";
						pendingResumeDecision = undefined;
						return decision;
					}
				: isTuiRequested && !args.auto
					? createTuiPlanReviewResumeGate(
							(adapter as import("../agents/opencode.js").OpenCodeAdapter)
								._clientForTui,
							tui,
							{ signal: cancelController.signal, directory: projectRoot },
						)
					: undefined;

		try {
			trace("plan_review.loop.start", {
				planPath: canonical,
				reviewPath,
			});
			// Run the loop
			const result = await runPlanReviewLoop(
				canonical,
				reviewPath,
				db,
				adapter,
				config,
				{
					auto: args.auto,
					allowDirty: args["allow-dirty"],
					projectRoot,
					// Function form: re-evaluated at each adapter call so TUI exit
					// mid-run is reflected in subsequent invocations (P1.4).
					quiet: () => effectiveQuiet || tuiOwnsTerminal(),
					canonicalPlanPath: canonical,
					showReasoning: args["show-reasoning"],
					signal: cancelController.signal,
					// Phase 4: Pass TUI controller for session switching and toasts
					tui,
					// Phase 5: Pass TUI-native gates for non-auto mode
					humanGate: tuiHumanGate,
					resumeGate: tuiResumeGate,
					trace,
				},
			);
			trace("plan_review.loop.done", {
				approved: result.approved,
				iterations: result.iterations,
				runId: result.runId,
			});

			// Display final result.
			// Guard on !tui.active: TUI may still own the terminal here (killed
			// in finally below). Writing to stdout while TUI is active corrupts
			// the display (P0.6 output ownership rule).
			if (!tuiOwnsTerminal()) {
				console.log();
				if (result.approved) {
					console.log("  Plan review: APPROVED");
				} else {
					console.log("  Plan review: NOT APPROVED");
				}
				console.log(`  Iterations: ${result.iterations}`);
				console.log(`  Review: ${result.reviewPath}`);
				console.log(`  Run ID: ${result.runId.slice(0, 8)}`);
				if (result.escalations.length > 0) {
					console.log(`  Escalations: ${result.escalations.length}`);
				}
				console.log();

				if (result.approved) {
					console.log(`  Next: 5x run ${planPath}`);
					console.log();
				}
			}

			if (!result.approved) {
				process.exitCode = 1;
			}
		} finally {
			trace("plan_review.cleanup.start");
			permissionHandler.stop();
			await adapter.close();
			tui.kill();
			trace("plan_review.cleanup.done", { exitCode: process.exitCode ?? 0 });
		}
	},
});
