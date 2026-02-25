import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import {
	createAndVerifyAdapter,
	registerAdapterShutdown,
} from "../agents/factory.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { overlayEnvFromDirectory } from "../env.js";
import { checkGitSafety } from "../git.js";
import {
	resolveReviewPath,
	runPlanReviewLoop,
} from "../orchestrator/plan-review-loop.js";
import { parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";
import { createTuiController } from "../tui/controller.js";
import { shouldEnableTui } from "../tui/detect.js";
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
		"no-tui": {
			type: "boolean",
			description:
				"Disable TUI mode — use headless output even in an interactive terminal",
			default: false,
		},
		"attach-tui": {
			type: "boolean",
			description:
				"Auto-launch TUI in this terminal (default is external attach mode)",
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
	},
	async run({ args }) {
		const planPath = resolve(args.path);
		const canonical = canonicalizePlanPath(planPath);

		// Validate plan file
		if (!existsSync(canonical)) {
			console.error(`Error: Plan file not found: ${planPath}`);
			process.exit(1);
		}

		let planContent: string;
		try {
			planContent = readFileSync(canonical, "utf-8");
		} catch {
			console.error(`Error: Could not read plan file: ${canonical}`);
			process.exit(1);
		}

		// Verify it's parseable as a plan
		const plan = parsePlan(planContent);
		if (plan.phases.length === 0) {
			console.error(
				"Error: No phases found in plan file. Is this a valid implementation plan?",
			);
			process.exit(1);
		}

		// Derive project root consistently (config file > git root > cwd)
		const projectRoot = resolveProjectRoot();
		overlayEnvFromDirectory(projectRoot, process.env);
		const { config } = await loadConfig(projectRoot);

		// Git safety check
		if (!args["allow-dirty"]) {
			try {
				const safety = await checkGitSafety(projectRoot);
				if (!safety.safe) {
					console.error(
						"Error: Working tree has uncommitted changes. " +
							"Commit or stash them, or pass --allow-dirty to proceed.",
					);
					process.exit(1);
				}
			} catch {
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
			adapter = await createAndVerifyAdapter(config.author);
		} catch (err) {
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
		const isTuiRequested = shouldEnableTui(args);

		// --- Register adapter shutdown with TUI mode support ---
		const cancelController = new AbortController();
		// --- Spawn TUI ---
		const tui = createTuiController({
			serverUrl: adapter.serverUrl,
			workdir: projectRoot,
			client: (adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			enabled: isTuiRequested,
			autoAttach: Boolean(args["attach-tui"]),
		});
		const effectiveTuiMode = tui.attached;
		const tuiOwnsTerminal = () => tui.attached && tui.active;

		registerAdapterShutdown(adapter, {
			tuiMode: effectiveTuiMode,
			cancelController,
		});

		// --- Resolve permission policy ---
		const permissionPolicy: PermissionPolicy =
			args.auto || args.ci
				? { mode: "auto-approve-all" }
				: effectiveTuiMode
					? { mode: "tui-native" }
					: { mode: "workdir-scoped", workdir: projectRoot };

		// --- Start permission handler ---
		let permissionHandler = createPermissionHandler(
			(adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			permissionPolicy,
		);
		permissionHandler.start();

		// Handle TUI early exit — continue headless.
		// Only registered when TUI was actually spawned; no-op controller never fires.
		if (isTuiRequested) {
			tui.onExit((info) => {
				if (info.isUserCancellation) {
					process.stderr.write("TUI interrupted — cancelling run\n");
					cancelController.abort();
					process.exitCode = info.code ?? 130;
					return;
				}

				process.stderr.write("TUI exited — continuing headless\n");

				if (permissionPolicy.mode === "tui-native") {
					permissionHandler.stop();
					permissionHandler = createPermissionHandler(
						(adapter as import("../agents/opencode.js").OpenCodeAdapter)
							._clientForTui,
						{ mode: "workdir-scoped", workdir: projectRoot },
					);
					permissionHandler.start();
				}
			});
		}

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
			isTuiRequested && !args.auto
				? createTuiPlanReviewResumeGate(
						(adapter as import("../agents/opencode.js").OpenCodeAdapter)
							._clientForTui,
						tui,
						{ signal: cancelController.signal, directory: projectRoot },
					)
				: undefined;

		try {
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
				},
			);

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
			permissionHandler.stop();
			await adapter.close();
			tui.kill();
		}
	},
});
