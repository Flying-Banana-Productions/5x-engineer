import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import {
	createAndVerifyAdapter,
	registerAdapterShutdown,
} from "../agents/factory.js";
import type { AgentAdapter } from "../agents/types.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import {
	appendRunEvent,
	createRun,
	updateRunStatus,
	upsertAgentResult,
	upsertPlan,
} from "../db/operations.js";
import { runMigrations } from "../db/schema.js";
import { parsePlan } from "../parsers/plan.js";
import { resolveProjectRoot } from "../project-root.js";
import { renderTemplate, setTemplateOverrideDir } from "../templates/loader.js";
import { createTuiController } from "../tui/controller.js";
import { resolveTuiListen } from "../tui/detect.js";
import {
	createPermissionHandler,
	NON_INTERACTIVE_NO_FLAG_ERROR,
	type PermissionPolicy,
} from "../tui/permissions.js";

/**
 * Compute the next available sequence number from existing plan files.
 * Looks at filenames matching `NNN-impl-*.md` in the plans directory.
 */
export function nextSequenceNumber(plansDir: string): string {
	if (!existsSync(plansDir)) return "001";

	const files = readdirSync(plansDir).filter((f) =>
		/^\d{3}-impl-.*\.md$/.test(f),
	);
	if (files.length === 0) return "001";

	const maxSeq = files.reduce((max, f) => {
		const num = Number.parseInt(f.slice(0, 3), 10);
		return Number.isNaN(num) ? max : Math.max(max, num);
	}, 0);

	return String(maxSeq + 1).padStart(3, "0");
}

/**
 * Extract a URL-safe slug from a PRD title or filename.
 * Strips extension, lowercases, replaces non-alphanumeric with hyphens,
 * collapses consecutive hyphens, and trims leading/trailing hyphens.
 */
export function slugFromPath(prdPath: string): string {
	let name = basename(prdPath, ".md");
	// Strip leading sequence number (e.g., "370-" from "370-court-time-allocation-reporting")
	name = name.replace(/^\d+-/, "");
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Compute a deterministic target plan path. If the computed path already exists,
 * auto-increment the sequence number until a free path is found.
 */
export function computePlanPath(plansDir: string, prdPath: string): string {
	const slug = slugFromPath(prdPath) || "plan";
	const seqNum = Number.parseInt(nextSequenceNumber(plansDir), 10);

	for (let i = 0; i < 100; i++) {
		const seqStr = String(seqNum + i).padStart(3, "0");
		const filename = `${seqStr}-impl-${slug}.md`;
		const fullPath = join(plansDir, filename);
		if (!existsSync(fullPath)) return fullPath;
	}

	// Fallback — should never happen in practice
	const ts = Date.now();
	return join(plansDir, `${ts}-impl-${slug}.md`);
}

/** Generate a simple unique ID (UUID v4). */
function generateId(): string {
	return crypto.randomUUID();
}

export default defineCommand({
	meta: {
		name: "plan",
		description: "Generate an implementation plan from a PRD/TDD document",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to PRD/TDD document",
			required: true,
		},
		out: {
			type: "string",
			description: "Override output path for the plan",
		},
		"allow-dirty": {
			type: "boolean",
			description: "Allow running with a dirty working tree",
			default: false,
		},
		quiet: {
			type: "boolean",
			description:
				"Suppress formatted agent output (default: auto, quiet when stdout is not a TTY). Log files are always written.",
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
	},
	async run({ args }) {
		const prdPath = resolve(args.path);

		if (!existsSync(prdPath)) {
			console.error(`Error: PRD file not found: ${prdPath}`);
			process.exit(1);
		}

		// Derive project root consistently (config file > git root > cwd)
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		// Git safety check
		if (!args["allow-dirty"]) {
			try {
				const result = Bun.spawnSync(["git", "status", "--porcelain"], {
					cwd: projectRoot,
					stdout: "pipe",
					stderr: "pipe",
				});
				const output = result.stdout.toString().trim();
				if (output.length > 0) {
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

		// Compute target plan path
		const plansDir = resolve(projectRoot, config.paths.plans);
		const planPath = args.out
			? resolve(args.out)
			: computePlanPath(plansDir, prdPath);

		// Ensure plans directory exists
		const planDir = dirname(planPath);
		if (!existsSync(planDir)) {
			mkdirSync(planDir, { recursive: true });
		}

		// Resolve plan template path
		const planTemplatePath = resolve(projectRoot, config.paths.templates.plan);
		if (!existsSync(planTemplatePath)) {
			console.error(
				`Error: Plan template not found at ${planTemplatePath}. ` +
					`Configure paths.templates.plan in 5x.config.js.`,
			);
			process.exit(1);
		}

		// Initialize DB
		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		// Enable user-customized prompt templates (if present on disk)
		setTemplateOverrideDir(resolve(projectRoot, ".5x", "templates", "prompts"));

		// Create run record
		const runId = generateId();
		createRun(db, {
			id: runId,
			planPath,
			command: "plan",
		});
		appendRunEvent(db, {
			runId,
			eventType: "plan_generate_start",
			data: { prdPath, planPath },
		});

		// --- Fail-closed check for non-interactive mode (before adapter creation) ---
		const isNonInteractive = !process.stdin.isTTY;
		if (isNonInteractive && !args.ci) {
			console.error(NON_INTERACTIVE_NO_FLAG_ERROR);
			process.exitCode = 1;
			return;
		}

		// Initialize author adapter
		let adapter: AgentAdapter;
		try {
			adapter = await createAndVerifyAdapter(config.author);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			appendRunEvent(db, {
				runId,
				eventType: "error",
				data: {
					error:
						err instanceof Error ? err.message : "Unknown adapter init error",
				},
			});
			updateRunStatus(db, runId, "failed");
			console.error(`\n  Error: Failed to initialize agent adapter.`);
			if (message) console.error(`  Cause: ${message}`);
			process.exitCode = 1;
			return;
		}

		// --- TUI mode detection ---
		const tuiMode = resolveTuiListen(args);
		const isTuiRequested = tuiMode.enabled;

		// --- Register adapter shutdown with TUI mode support ---
		const cancelController = new AbortController();
		// --- Spawn TUI ---
		const tui = createTuiController({
			serverUrl: adapter.serverUrl,
			workdir: projectRoot,
			client: (adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			enabled: isTuiRequested,
		});

		registerAdapterShutdown(adapter, {
			tuiMode: false,
			cancelController,
		});

		// --- Resolve permission policy ---
		// Note: plan command doesn't have --auto, only --ci
		const permissionPolicy: PermissionPolicy = args.ci
			? { mode: "auto-approve-all" }
			: { mode: "workdir-scoped", workdir: projectRoot };

		// --- Start permission handler ---
		const permissionHandler = createPermissionHandler(
			(adapter as import("../agents/opencode.js").OpenCodeAdapter)
				._clientForTui,
			permissionPolicy,
		);
		permissionHandler.start();

		try {
			// Render prompt
			const template = renderTemplate("author-generate-plan", {
				prd_path: prdPath,
				plan_path: planPath,
				plan_template_path: planTemplatePath,
			});

			console.log();
			console.log("  Generating implementation plan from PRD...");
			console.log(`  Target: ${planPath}`);
			const modelName = config.author.model ?? "default";
			process.stdout.write(`  Author (${modelName}) `);

			// Resolve effective quiet mode: explicit flag > TTY detection
			const effectiveQuiet =
				args.quiet !== undefined ? args.quiet : !process.stdout.isTTY;

			// Compute log path
			const logDir = join(projectRoot, ".5x", "logs", runId);
			const agentResultId = generateId();
			const logPath = join(logDir, `agent-${agentResultId}.ndjson`);

			// Invoke agent with structured output.
			const result = await adapter.invokeForStatus({
				prompt: template.prompt,
				model: config.author.model,
				workdir: projectRoot,
				logPath,
				quiet: () => effectiveQuiet,
				showReasoning: args["show-reasoning"],
				signal: cancelController.signal,
				sessionTitle: "Plan generation",
				onSessionCreated: isTuiRequested
					? (sessionId) => tui.selectSession(sessionId, projectRoot)
					: undefined,
			});

			const durationStr =
				result.duration < 60_000
					? `${Math.round(result.duration / 1000)}s`
					: `${Math.round(result.duration / 60_000)}m ${Math.round((result.duration % 60_000) / 1000)}s`;
			console.log(`done (${durationStr})`);

			// Store agent result
			upsertAgentResult(db, {
				id: agentResultId,
				run_id: runId,
				phase: "-1",
				iteration: 0,
				role: "author",
				template: template.name,
				result_type: "status",
				result_json: JSON.stringify(result.status),
				duration_ms: result.duration,
				log_path: logPath,
				session_id: result.sessionId,
				model: config.author.model ?? null,
				tokens_in: result.tokensIn ?? null,
				tokens_out: result.tokensOut ?? null,
				cost_usd: result.costUsd ?? null,
			});

			const status = result.status;

			// Handle author signals
			if (status.result === "needs_human") {
				appendRunEvent(db, {
					runId,
					eventType: "escalation",
					data: {
						reason: status.reason ?? "Author needs human input",
					},
				});
				updateRunStatus(db, runId, "active", "NEEDS_HUMAN");
				console.log();
				console.log(
					`  Author needs human input: ${status.reason ?? "no reason given"}`,
				);
				console.log();
				process.exitCode = 1;
				return;
			}

			if (status.result === "failed") {
				appendRunEvent(db, {
					runId,
					eventType: "error",
					data: { reason: status.reason },
				});
				updateRunStatus(db, runId, "failed");
				console.error(
					`\n  Error: Author reported failure: ${status.reason ?? "no reason given"}`,
				);
				process.exitCode = 1;
				return;
			}

			// Verify file was created
			if (!existsSync(planPath)) {
				appendRunEvent(db, {
					runId,
					eventType: "error",
					data: { reason: "Plan file not found after author completion" },
				});
				updateRunStatus(db, runId, "failed");
				console.error(
					`\n  Error: Plan file not found at ${planPath} after author reported completion.`,
				);
				process.exitCode = 1;
				return;
			}

			// Record plan in DB
			upsertPlan(db, { planPath });
			appendRunEvent(db, {
				runId,
				eventType: "plan_generate_complete",
				data: { planPath, summary: status.notes },
			});
			updateRunStatus(db, runId, "completed");

			let phaseCount = 0;
			try {
				const planContent = readFileSync(planPath, "utf-8");
				const parsed = parsePlan(planContent);
				phaseCount = parsed.phases.length;
			} catch {
				// Non-critical — just for display
			}

			console.log();
			console.log(`  Created: ${planPath}`);
			if (phaseCount > 0) {
				console.log(`  Phases: ${phaseCount}`);
			}
			if (status.notes) {
				console.log(`  Summary: ${status.notes}`);
			}
			console.log();
			console.log(`  Next: 5x plan-review ${planPath}`);
			console.log();
		} catch (err) {
			// Handle adapter invocation errors (timeout, network, etc.)
			const message = err instanceof Error ? err.message : String(err);
			appendRunEvent(db, {
				runId,
				eventType: "error",
				data: { error: message },
			});
			updateRunStatus(db, runId, "failed");
			console.error(`\n  Error: Agent invocation failed.`);
			if (message) console.error(`  Cause: ${message}`);
			process.exitCode = 1;
		} finally {
			permissionHandler.stop();
			await adapter.close();
			tui.kill();
		}
	},
});
