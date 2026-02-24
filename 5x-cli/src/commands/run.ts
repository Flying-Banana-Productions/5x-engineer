import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { defineCommand } from "citty";
import {
	createAndVerifyAdapter,
	registerAdapterShutdown,
} from "../agents/factory.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import {
	getActiveRun,
	getApprovedPhaseNumbers,
	getPlan,
	upsertPlan,
} from "../db/operations.js";
import { runMigrations } from "../db/schema.js";
import { createDebugTraceLogger } from "../debug/trace.js";
import { resumeGate as headlessResumeGate } from "../gates/human.js";
import {
	branchNameFromPlan,
	checkGitSafety,
	createWorktree,
	runWorktreeSetupCommand,
} from "../git.js";
import { acquireLock, registerLockCleanup, releaseLock } from "../lock.js";
import { runPhaseExecutionLoop } from "../orchestrator/phase-execution-loop.js";
import { resolveReviewPath } from "../orchestrator/plan-review-loop.js";
import { parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";
import { createTuiController } from "../tui/controller.js";
import { shouldEnableTui } from "../tui/detect.js";
import {
	createTuiEscalationGate,
	createTuiPhaseGate,
	createTuiResumeGate,
} from "../tui/gates.js";
import {
	createPermissionHandler,
	NON_INTERACTIVE_NO_FLAG_ERROR,
	type PermissionPolicy,
} from "../tui/permissions.js";

export default defineCommand({
	meta: {
		name: "run",
		description:
			"Execute implementation phases with automated author-review loops",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan markdown file",
			required: true,
		},
		phase: {
			type: "string",
			description: "Start from a specific phase number (e.g., 3, 1.1)",
		},
		auto: {
			type: "boolean",
			description:
				"Skip inter-phase human gates; still escalate on human_required",
			default: false,
		},
		"allow-dirty": {
			type: "boolean",
			description: "Allow running with a dirty working tree",
			default: false,
		},
		"skip-quality": {
			type: "boolean",
			description: "Skip quality gate checks",
			default: false,
		},
		worktree: {
			type: "boolean",
			description: "Create an isolated git worktree for execution",
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
		"debug-trace": {
			type: "boolean",
			description:
				"Write detailed lifecycle trace logs to .5x/debug for hang diagnosis",
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

		// Derive project root
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);
		const traceLogger = createDebugTraceLogger({
			enabled: Boolean(args["debug-trace"] || process.env.FIVEX_DEBUG_TRACE),
			projectRoot,
			command: "run",
		});
		const trace = traceLogger.trace;
		if (traceLogger.enabled && traceLogger.filePath) {
			console.log(`  Debug trace: ${traceLogger.filePath}`);
		}
		trace("run.command.start", {
			planPath: canonical,
			auto: args.auto,
			phase: args.phase,
			worktree: args.worktree,
			noTui: args["no-tui"],
			attachTui: args["attach-tui"],
		});

		// Initialize DB
		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		const approvedPhases = new Set(getApprovedPhaseNumbers(db, canonical));
		const incompletePhases = plan.phases.filter(
			(p) => !approvedPhases.has(p.number),
		);
		if (incompletePhases.length === 0) {
			console.log();
			console.log("  All phases are review-approved. Nothing to run.");
			console.log();
			process.exit(0);
		}

		// --- Resolve workdir ---
		let workdir = projectRoot;
		let createdWorktree = false;

		// Check DB for existing worktree association
		const planRecord = getPlan(db, canonical);
		if (planRecord?.worktree_path) {
			if (existsSync(planRecord.worktree_path)) {
				workdir = planRecord.worktree_path;
				console.log(`  Using worktree: ${workdir}`);
			}
		}

		// Create worktree if requested and not already set
		if (args.worktree && workdir === projectRoot) {
			const branch = branchNameFromPlan(planPath);
			const wtPath = resolve(
				projectRoot,
				".5x",
				"worktrees",
				branch.replace(/\//g, "-"),
			);

			try {
				const info = await createWorktree(projectRoot, branch, wtPath);
				workdir = info.path;
				createdWorktree = true;
				upsertPlan(db, {
					planPath: canonical,
					worktreePath: info.path,
					branch: info.branch,
				});
				console.log(
					`  Created worktree: ${info.path} (branch: ${info.branch})`,
				);
			} catch (err) {
				console.error(
					`Error: Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
		}

		if (createdWorktree && config.worktree.postCreate) {
			console.log(`  Running worktree setup: ${config.worktree.postCreate}`);
			trace("run.worktree.post_create.start", {
				workdir,
				command: config.worktree.postCreate,
			});
			try {
				await runWorktreeSetupCommand(workdir, config.worktree.postCreate);
				trace("run.worktree.post_create.done", { workdir });
				console.log("  Worktree setup complete.");
			} catch (err) {
				trace("run.worktree.post_create.error", {
					workdir,
					error: err instanceof Error ? err.message : String(err),
				});
				console.error(
					`Error: Worktree setup failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
		}

		// --- Git safety check ---
		if (!args["allow-dirty"]) {
			try {
				const safety = await checkGitSafety(workdir);
				if (!safety.safe) {
					console.error(
						"Error: Working tree has uncommitted changes. " +
							"Commit or stash them, or pass --allow-dirty to proceed.",
					);
					if (safety.untrackedFiles.length > 0) {
						console.error(
							`  Untracked files: ${safety.untrackedFiles.slice(0, 5).join(", ")}${safety.untrackedFiles.length > 5 ? ` (+${safety.untrackedFiles.length - 5} more)` : ""}`,
						);
					}
					process.exit(1);
				}
			} catch {
				// git not available or not a repo — skip check
			}
		}

		// --- Acquire plan lock ---
		const lockResult = acquireLock(projectRoot, canonical);
		if (!lockResult.acquired) {
			if (lockResult.existingLock) {
				console.error(
					`Error: Plan is locked by PID ${lockResult.existingLock.pid} (started ${lockResult.existingLock.startedAt}). ` +
						"Another 5x process is running on this plan.",
				);
			} else {
				console.error("Error: Could not acquire plan lock.");
			}
			process.exit(1);
		}

		if (lockResult.stale) {
			console.log("  Note: Stale lock detected and acquired.");
		}

		// Register lock cleanup
		registerLockCleanup(projectRoot, canonical);

		// --- Resolve review path ---
		const reviewsDir = resolve(projectRoot, config.paths.reviews);
		let reviewPath = resolveReviewPath(db, canonical, reviewsDir);

		// --- Remap paths for worktree isolation ---
		// When workdir is a worktree, plan/review paths must resolve inside
		// the worktree so agents read/write artifacts there, not in the
		// primary checkout. DB lookups continue using the canonical
		// (primary checkout) path.
		let effectivePlanPath = canonical;
		if (workdir !== projectRoot) {
			const planRel = relative(projectRoot, canonical);
			if (planRel.startsWith("..")) {
				console.error(
					"Error: Plan file is outside the project root — cannot remap for worktree.",
				);
				process.exit(1);
			}
			effectivePlanPath = resolve(workdir, planRel);

			const reviewRel = relative(projectRoot, reviewPath);
			if (!reviewRel.startsWith("..")) {
				reviewPath = resolve(workdir, reviewRel);
			} else {
				console.error(
					"Warning: Review path is outside the project root and cannot be " +
						"remapped into the worktree. Agents will read/write reviews in the " +
						"primary checkout, breaking worktree isolation.",
				);
				console.error(`  Review path: ${reviewPath}`);
				console.error(
					"  Fix: set paths.reviews to a path within the project root.",
				);
			}
		}

		// --- Display header ---
		console.log();
		console.log(`  Plan: ${plan.title}`);
		console.log(
			`  Phases: ${incompletePhases.length} remaining of ${plan.phases.length} total`,
		);
		console.log(`  Review base: ${reviewPath}`);
		console.log("  Review files: per-phase (-phase-N-review.md)");
		if (args.phase) {
			console.log(`  Starting from phase: ${args.phase}`);
		}
		console.log();

		// --- Run the loop ---
		// Resolve effective quiet mode: explicit flag > TTY detection
		const effectiveQuiet =
			args.quiet !== undefined ? args.quiet : !process.stdout.isTTY;

		// --- Fail-closed check for non-interactive mode ---
		const isNonInteractive = !process.stdin.isTTY;
		if (isNonInteractive && !args.auto && !args.ci) {
			console.error(NON_INTERACTIVE_NO_FLAG_ERROR);
			releaseLock(projectRoot, canonical);
			process.exitCode = 1;
			return;
		}

		// --- TUI mode detection ---
		const isTuiRequested = shouldEnableTui(args);
		trace("run.tui.detected", {
			isTuiRequested,
			stdinTTY: Boolean(process.stdin.isTTY),
			stdoutTTY: Boolean(process.stdout.isTTY),
		});

		// If an interrupted run exists and TUI was requested, ask the resume
		// question before spawning TUI so the prompt is always visible.
		let pendingResumeDecision: "resume" | "start-fresh" | "abort" | undefined;
		if (isTuiRequested && !args.auto) {
			const activeRun = getActiveRun(db, canonical);
			if (activeRun && activeRun.command === "run") {
				trace("run.resume.pre_tui.prompt", {
					runId: activeRun.id,
					phase: activeRun.current_phase,
					state: activeRun.current_state,
				});
				pendingResumeDecision = await headlessResumeGate(
					activeRun.id,
					activeRun.current_phase ?? "0",
					activeRun.current_state ?? "EXECUTE",
				);

				if (pendingResumeDecision === "abort") {
					trace("run.resume.pre_tui.abort", { runId: activeRun.id });
					console.log();
					console.log("  Run: ABORTED");
					console.log("  Phases completed: 0/0");
					console.log(`  Run ID: ${activeRun.id.slice(0, 8)}`);
					console.log();
					releaseLock(projectRoot, canonical);
					process.exitCode = 1;
					return;
				}
				trace("run.resume.pre_tui.decision", {
					runId: activeRun.id,
					decision: pendingResumeDecision,
				});
			}
		}

		// --- Initialize adapter ---
		let adapter: Awaited<ReturnType<typeof createAndVerifyAdapter>>;
		try {
			trace("run.adapter.create.start");
			adapter = await createAndVerifyAdapter(config.author);
			trace("run.adapter.create.ok", { serverUrl: adapter.serverUrl });
		} catch (err) {
			trace("run.adapter.create.error", {
				error: err instanceof Error ? err.message : String(err),
			});
			const message = err instanceof Error ? err.message : String(err);
			console.error(`\n  Error: Failed to initialize agent adapter.`);
			if (message) console.error(`  Cause: ${message}`);
			releaseLock(projectRoot, canonical);
			process.exitCode = 1;
			return;
		}

		// --- Register adapter shutdown with TUI mode support ---
		const cancelController = new AbortController();
		// --- Spawn TUI ---
		const tui = createTuiController({
			serverUrl: adapter.serverUrl,
			workdir,
			client: (adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			enabled: isTuiRequested,
			autoAttach: Boolean(args["attach-tui"]),
			trace,
		});
		const effectiveTuiMode = tui.attached;
		const tuiOwnsTerminal = () => tui.attached && tui.active;
		trace("run.tui.controller.ready", {
			active: tui.active,
			attached: tui.attached,
			effectiveTuiMode,
		});

		registerAdapterShutdown(adapter, {
			tuiMode: effectiveTuiMode,
			cancelController,
		});
		trace("run.adapter.shutdown_registered", { tuiMode: effectiveTuiMode });

		// --- Resolve permission policy ---
		const permissionPolicy: PermissionPolicy =
			args.auto || args.ci
				? { mode: "auto-approve-all" }
				: effectiveTuiMode
					? { mode: "tui-native" }
					: { mode: "workdir-scoped", workdir };

		// --- Start permission handler ---
		let permissionHandler = createPermissionHandler(
			(adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			permissionPolicy,
			trace,
		);
		permissionHandler.start();
		trace("run.permission.handler_started", { mode: permissionPolicy.mode });

		// Handle TUI early exit — continue headless.
		// Only registered when TUI was actually spawned; no-op controller never fires.
		if (isTuiRequested) {
			tui.onExit((info) => {
				trace("run.tui.exit", info);
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
						{ mode: "workdir-scoped", workdir },
						trace,
					);
					permissionHandler.start();
					trace("run.permission.handler_switched", { mode: "workdir-scoped" });
				}
			});
		}

		// Phase 5: Create TUI-native gates when in TUI mode (non-auto)
		// These replace the readline-based gates from gates/human.ts
		const tuiPhaseGate =
			isTuiRequested && !args.auto
				? createTuiPhaseGate(
						(adapter as import("../agents/opencode.js").OpenCodeAdapter)
							._clientForTui,
						tui,
						{ signal: cancelController.signal, directory: workdir },
					)
				: undefined;
		const tuiEscalationGate =
			isTuiRequested && !args.auto
				? createTuiEscalationGate(
						(adapter as import("../agents/opencode.js").OpenCodeAdapter)
							._clientForTui,
						tui,
						{ signal: cancelController.signal, directory: workdir },
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
					? createTuiResumeGate(
							(adapter as import("../agents/opencode.js").OpenCodeAdapter)
								._clientForTui,
							tui,
							{ signal: cancelController.signal, directory: workdir },
						)
					: undefined;

		try {
			trace("run.loop.start", {
				effectivePlanPath,
				reviewPath,
				workdir,
			});
			const result = await runPhaseExecutionLoop(
				effectivePlanPath,
				reviewPath,
				db,
				adapter,
				config,
				{
					auto: args.auto,
					allowDirty: args["allow-dirty"],
					skipQuality: args["skip-quality"],
					startPhase: args.phase,
					workdir,
					projectRoot,
					// Function form: re-evaluated at each adapter call so TUI exit
					// mid-run is reflected in subsequent invocations (P1.4).
					quiet: () => effectiveQuiet || tuiOwnsTerminal(),
					// Stable DB identity anchored to the primary checkout path.
					// effectivePlanPath may be remapped to a worktree; canonical
					// stays consistent so resume/history lookups always match.
					canonicalPlanPath: canonical,
					showReasoning: args["show-reasoning"],
					signal: cancelController.signal,
					// Phase 4: Pass TUI controller for session switching and toasts
					tui,
					// Phase 5: Pass TUI-native gates for non-auto mode
					phaseGate: tuiPhaseGate,
					escalationGate: tuiEscalationGate,
					resumeGate: tuiResumeGate,
					trace,
				},
			);
			trace("run.loop.done", {
				runId: result.runId,
				complete: result.complete,
				aborted: result.aborted,
				paused: result.paused,
				phasesCompleted: result.phasesCompleted,
				totalPhases: result.totalPhases,
			});

			// --- Display final result ---
			// Guard on !tui.active: TUI may still own the terminal here (it is
			// killed in the finally block below). Writing to stdout/stderr while
			// the TUI is active corrupts the display (P0.6 output ownership rule).
			if (!tuiOwnsTerminal()) {
				console.log();
				if (result.complete) {
					console.log("  Run: COMPLETE");
				} else if (result.paused) {
					console.log("  Run: PAUSED");
				} else if (result.aborted) {
					console.log("  Run: ABORTED");
				} else {
					console.log("  Run: INCOMPLETE");
				}
				console.log(
					`  Phases completed: ${result.phasesCompleted}/${result.totalPhases}`,
				);
				console.log(`  Run ID: ${result.runId.slice(0, 8)}`);
				if (result.escalations.length > 0) {
					console.log(`  Escalations: ${result.escalations.length}`);
				}
				console.log();
			}

			if (!result.complete && !result.paused) {
				process.exitCode = process.exitCode ?? 1;
			} else if (result.paused) {
				process.exitCode = 0;
			}
		} finally {
			trace("run.cleanup.start");
			permissionHandler.stop();
			await adapter.close();
			tui.kill();
			trace("run.cleanup.done");
			releaseLock(projectRoot, canonical);
			trace("run.command.end", { exitCode: process.exitCode ?? 0 });
		}
	},
});
