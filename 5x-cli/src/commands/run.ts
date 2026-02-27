import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineCommand } from "citty";
import {
	createAndVerifyAdapter,
	registerAdapterShutdown,
} from "../agents/factory.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import {
	getApprovedPhaseNumbers,
	getPlan,
	upsertPlan,
} from "../db/operations.js";
import { runMigrations } from "../db/schema.js";
import { createDebugTraceLogger } from "../debug/trace.js";
import { overlayEnvFromDirectory } from "../env.js";
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
import { findGitRoot, resolveProjectRoot } from "../project-root.js";
import { setTemplateOverrideDir } from "../templates/loader.js";
import { createTuiController } from "../tui/controller.js";
import { resolveTuiListen } from "../tui/detect.js";
import {
	createPermissionHandler,
	NON_INTERACTIVE_NO_FLAG_ERROR,
	type PermissionPolicy,
} from "../tui/permissions.js";

export interface WorktreeTemplateSyncResult {
	copied: string[];
	skipped: string[];
	missingSource: string[];
	unmappableAbsolute: string[];
}

export interface WorktreeReviewPathResult {
	reviewPath: string;
	warning?: string;
}

function isPathInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Compute the subfolder offset between the git root and the project root.
 * In a monorepo where `5x.config` lives in a subfolder, `git worktree add`
 * checks out the entire repo so paths inside the worktree must include
 * this offset. Returns "" when they're the same directory.
 */
export function worktreeSubfolderOffset(projectRoot: string): string {
	const gitRoot = findGitRoot(projectRoot);
	if (!gitRoot) return "";
	return relative(gitRoot, projectRoot);
}

/**
 * Given a raw worktree root path and a subfolder offset, return the
 * effective working directory inside the worktree that corresponds
 * to the project root.
 */
export function resolveWorktreeWorkdir(
	worktreePath: string,
	offset: string,
): string {
	return offset ? resolve(worktreePath, offset) : worktreePath;
}

export function remapReviewPathForWorktree(opts: {
	projectRoot: string;
	workdir: string;
	reviewPath: string;
}): WorktreeReviewPathResult {
	if (opts.workdir === opts.projectRoot) {
		return { reviewPath: opts.reviewPath };
	}

	if (isPathInside(opts.workdir, opts.reviewPath)) {
		return { reviewPath: opts.reviewPath };
	}

	const reviewRel = relative(opts.projectRoot, opts.reviewPath);
	const reviewUnderProjectRoot =
		reviewRel !== "" && !reviewRel.startsWith("..") && !isAbsolute(reviewRel);
	if (reviewUnderProjectRoot) {
		return {
			reviewPath: resolve(opts.workdir, reviewRel),
		};
	}

	return {
		reviewPath: opts.reviewPath,
		warning:
			"Review path is outside the project root and worktree; cannot remap for worktree isolation.",
	};
}

export function syncWorktreeTemplates(opts: {
	projectRoot: string;
	workdir: string;
	templatePaths: string[];
}): WorktreeTemplateSyncResult {
	const copied: string[] = [];
	const skipped: string[] = [];
	const missingSource: string[] = [];
	const unmappableAbsolute: string[] = [];

	for (const configuredPath of opts.templatePaths) {
		const sourcePath = isAbsolute(configuredPath)
			? configuredPath
			: resolve(opts.projectRoot, configuredPath);

		let targetPath: string;
		if (isAbsolute(configuredPath)) {
			if (!isPathInside(opts.projectRoot, configuredPath)) {
				unmappableAbsolute.push(configuredPath);
				continue;
			}
			const rel = relative(opts.projectRoot, configuredPath);
			targetPath = resolve(opts.workdir, rel);
		} else {
			targetPath = resolve(opts.workdir, configuredPath);
		}

		if (!existsSync(sourcePath)) {
			missingSource.push(sourcePath);
			continue;
		}

		if (existsSync(targetPath)) {
			skipped.push(targetPath);
			continue;
		}

		mkdirSync(dirname(targetPath), { recursive: true });
		copyFileSync(sourcePath, targetPath);
		copied.push(targetPath);
	}

	return { copied, skipped, missingSource, unmappableAbsolute };
}

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
		const planPath = resolve(args.path);
		const canonical = canonicalizePlanPath(planPath);

		// Validate plan file
		if (!existsSync(canonical)) {
			console.error(`Error: Plan file not found: ${planPath}`);
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
			tuiListen: args["tui-listen"],
		});

		// Initialize DB
		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		// --- Resolve workdir ---
		let workdir = projectRoot;
		let createdWorktree = false;

		// In a monorepo, projectRoot (where 5x.config lives) may be a
		// subfolder of the git root.  `git worktree add` checks out the
		// entire repo, so paths inside the worktree must include this offset.
		const wtOffset = worktreeSubfolderOffset(projectRoot);

		// Check DB for existing worktree association
		const planRecord = getPlan(db, canonical);
		if (planRecord?.worktree_path) {
			if (existsSync(planRecord.worktree_path)) {
				workdir = resolveWorktreeWorkdir(planRecord.worktree_path, wtOffset);
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
				workdir = resolveWorktreeWorkdir(info.path, wtOffset);
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

		if (workdir !== projectRoot) {
			const templateSync = syncWorktreeTemplates({
				projectRoot,
				workdir,
				templatePaths: [
					config.paths.templates.plan,
					config.paths.templates.review,
				],
			});

			for (const path of templateSync.copied) {
				console.log(
					`  Copied template into worktree: ${relative(workdir, path)}`,
				);
			}
			for (const sourcePath of templateSync.missingSource) {
				console.log(
					`  Warning: Template source not found for worktree sync: ${sourcePath}`,
				);
			}
			for (const configuredPath of templateSync.unmappableAbsolute) {
				console.log(
					"  Warning: Absolute template path is outside project root and " +
						`cannot be mirrored into worktree: ${configuredPath}`,
				);
			}

			trace("run.worktree.template_sync", {
				workdir,
				copied: templateSync.copied,
				skipped: templateSync.skipped,
				missingSource: templateSync.missingSource,
				unmappableAbsolute: templateSync.unmappableAbsolute,
			});
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

		// Enable user-customized prompt templates (if present on disk)
		setTemplateOverrideDir(resolve(projectRoot, ".5x", "templates", "prompts"));

		// --- Resolve review path ---
		// Implementation reviews use a dedicated directory (or fall back to reviews)
		const reviewsDir = resolve(
			projectRoot,
			config.paths.runReviews ?? config.paths.reviews,
		);
		const additionalReviewDirs: string[] = [];
		if (workdir !== projectRoot) {
			const reviewsRel = relative(projectRoot, reviewsDir);
			if (
				reviewsRel !== "" &&
				!reviewsRel.startsWith("..") &&
				!isAbsolute(reviewsRel)
			) {
				additionalReviewDirs.push(resolve(workdir, reviewsRel));
			}
		}
		let reviewPath = resolveReviewPath(db, canonical, reviewsDir, {
			command: "run",
			additionalReviewDirs,
		});

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

			const remappedReview = remapReviewPathForWorktree({
				projectRoot,
				workdir,
				reviewPath,
			});
			reviewPath = remappedReview.reviewPath;
			if (remappedReview.warning) {
				console.error(
					"Warning: Review path is outside the project root and cannot be " +
						"remapped into the worktree. Agents will read/write reviews in the " +
						"primary checkout, breaking worktree isolation.",
				);
				console.error(`  Review path: ${reviewPath}`);
				console.error(
					"  Fix: set paths.runReviews (or paths.reviews) to a path within the project root.",
				);
			}
		}

		if (!existsSync(effectivePlanPath)) {
			console.error(`Error: Plan file not found: ${effectivePlanPath}`);
			releaseLock(projectRoot, canonical);
			process.exitCode = 1;
			return;
		}

		let planContent: string;
		try {
			planContent = readFileSync(effectivePlanPath, "utf-8");
		} catch {
			console.error(`Error: Could not read plan file: ${effectivePlanPath}`);
			releaseLock(projectRoot, canonical);
			process.exitCode = 1;
			return;
		}

		const plan = parsePlan(planContent);
		if (plan.phases.length === 0) {
			console.error(
				"Error: No phases found in plan file. Is this a valid implementation plan?",
			);
			releaseLock(projectRoot, canonical);
			process.exitCode = 1;
			return;
		}

		const approvedPhases = new Set(getApprovedPhaseNumbers(db, canonical));
		const incompletePhases = plan.phases.filter(
			(phase) => !approvedPhases.has(phase.number),
		);
		if (incompletePhases.length === 0) {
			console.log();
			console.log("  All phases are review-approved. Nothing to run.");
			console.log();
			releaseLock(projectRoot, canonical);
			process.exitCode = 0;
			return;
		}

		// --- Display header ---
		console.log();
		console.log(`  Plan: ${plan.title}`);
		console.log(
			`  Phases: ${incompletePhases.length} remaining of ${plan.phases.length} total`,
		);
		console.log(`  Review base: ${reviewPath}`);
		console.log("  Review files: per-phase (<plan>-phase-N-review.md)");
		if (args.phase) {
			console.log(`  Starting from phase: ${args.phase}`);
		}
		console.log();

		// Bun loads .env before command execution (from initial cwd). In worktree
		// runs we must overlay env from the resolved workdir so subprocesses and
		// tool execution use the worktree-specific values.
		const workdirEnv = overlayEnvFromDirectory(workdir, process.env);
		if (workdirEnv.keyCount > 0) {
			trace("run.env.overlay", {
				workdir,
				loadedFiles: workdirEnv.loadedFiles,
				keyCount: workdirEnv.keyCount,
			});
		}

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
		const tuiMode = resolveTuiListen(args);
		const isTuiRequested = tuiMode.enabled;
		trace("run.tui.detected", {
			reason: tuiMode.reason,
			isTuiRequested,
			stdinTTY: Boolean(process.stdin.isTTY),
			stdoutTTY: Boolean(process.stdout.isTTY),
		});

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
			trace,
		});
		trace("run.tui.controller.ready", {
			active: tui.active,
			attached: false,
			effectiveTuiMode: false,
		});

		registerAdapterShutdown(adapter, {
			tuiMode: false,
			cancelController,
		});
		trace("run.adapter.shutdown_registered", { tuiMode: false });

		// --- Resolve permission policy ---
		const permissionPolicy: PermissionPolicy =
			args.auto || args.ci
				? { mode: "auto-approve-all" }
				: { mode: "workdir-scoped", workdir };

		// --- Start permission handler ---
		const permissionHandler = createPermissionHandler(
			(adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			permissionPolicy,
			trace,
		);
		permissionHandler.start();
		trace("run.permission.handler_started", { mode: permissionPolicy.mode });

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
					quiet: () => effectiveQuiet,
					// Stable DB identity anchored to the primary checkout path.
					// effectivePlanPath may be remapped to a worktree; canonical
					// stays consistent so resume/history lookups always match.
					canonicalPlanPath: canonical,
					showReasoning: args["show-reasoning"],
					signal: cancelController.signal,
					// TUI listen mode is observability-only; gates remain CLI-driven.
					tui,
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
