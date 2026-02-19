import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { createAndVerifyAdapter } from "../agents/factory.js";
import type { AgentAdapter, LegacyAgentAdapter } from "../agents/types.js";
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
import { parseStatusBlock } from "../parsers/signals.js";
import { resolveProjectRoot } from "../project-root.js";
import { renderTemplate } from "../templates/loader.js";

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

		// Initialize author adapter
		let adapter: AgentAdapter;
		try {
			adapter = await createAndVerifyAdapter(config.author);
		} catch (err) {
			appendRunEvent(db, {
				runId,
				eventType: "error",
				data: {
					error:
						err instanceof Error ? err.message : "Unknown adapter init error",
				},
			});
			updateRunStatus(db, runId, "failed");
			console.error(
				"\n  Error: Agent adapter not yet available. " +
					"This is expected while 5x is being refactored.",
			);
			process.exitCode = 1;
			return;
		}

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

		// Invoke agent
		const startTime = Date.now();
		const result = await (adapter as unknown as LegacyAgentAdapter).invoke({
			prompt: template.prompt,
			model: config.author.model,
			workdir: projectRoot,
		});
		const duration = Date.now() - startTime;
		const durationStr =
			duration < 60_000
				? `${Math.round(duration / 1000)}s`
				: `${Math.round(duration / 60_000)}m ${Math.round((duration % 60_000) / 1000)}s`;
		console.log(`done (${durationStr})`);

		// Parse 5x:status from output
		const status = parseStatusBlock(result.output);

		// Store agent result
		const agentResultId = generateId();
		upsertAgentResult(db, {
			id: agentResultId,
			run_id: runId,
			role: "author",
			template_name: template.name,
			phase: "-1",
			iteration: 0,
			exit_code: result.exitCode,
			duration_ms: result.duration,
			tokens_in: result.tokens?.input ?? null,
			tokens_out: result.tokens?.output ?? null,
			cost_usd: result.cost ?? null,
			signal_type: status ? "status" : null,
			signal_data: status ? JSON.stringify(status) : null,
		});

		// Handle non-zero exit code
		if (result.exitCode !== 0) {
			appendRunEvent(db, {
				runId,
				eventType: "error",
				data: { exitCode: result.exitCode, error: result.error },
			});
			updateRunStatus(db, runId, "failed");
			console.error(
				`\n  Error: Author agent exited with code ${result.exitCode}`,
			);
			if (result.error) console.error(`  ${result.error}`);
			process.exit(1);
		}

		// Handle missing status block
		if (!status) {
			appendRunEvent(db, {
				runId,
				eventType: "escalation",
				data: { reason: "Missing 5x:status block in author output" },
			});
			updateRunStatus(db, runId, "failed", "ESCALATE");
			console.error(
				"\n  Error: Author did not produce a 5x:status block. Manual review required.",
			);
			console.error(
				"  Check if the plan file was created at the expected path.",
			);
			process.exit(1);
		}

		// Handle author signals
		if (status.result === "needs_human") {
			appendRunEvent(db, {
				runId,
				eventType: "escalation",
				data: {
					reason: status.reason ?? "Author needs human input",
					blockedOn: status.blockedOn,
				},
			});
			updateRunStatus(db, runId, "active", "NEEDS_HUMAN");
			console.log();
			console.log(
				`  Author needs human input: ${status.reason ?? "no reason given"}`,
			);
			if (status.blockedOn) {
				console.log(`  Blocked on: ${status.blockedOn}`);
			}
			console.log();
			process.exit(1);
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
			process.exit(1);
		}

		// Verify planPath matches
		if (status.planPath && status.planPath !== planPath) {
			console.warn(
				`  Warning: status.planPath "${status.planPath}" differs from expected "${planPath}"`,
			);
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
			process.exit(1);
		}

		// Record plan in DB
		upsertPlan(db, { planPath });
		appendRunEvent(db, {
			runId,
			eventType: "plan_generate_complete",
			data: { planPath, summary: status.summary },
		});
		updateRunStatus(db, runId, "completed");

		// Display result
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
		if (status.summary) {
			console.log(`  Summary: ${status.summary}`);
		}
		console.log();
		console.log(`  Next: 5x plan-review ${planPath}`);
		console.log();
	},
});
