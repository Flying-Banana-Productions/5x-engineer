/**
 * Template command handler — business logic for `5x template` subcommands.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Subcommands:
 * - render: Render a prompt template with variable substitution
 * - list: List all available prompt templates
 * - describe: Show detailed metadata for a specific template
 */

import { dirname, join, resolve } from "node:path";
import { loadConfig, resolveLayeredConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { outputError, outputSuccess } from "../output.js";
import { validateRunId } from "../run-id.js";
import {
	getTemplateSource,
	listTemplates,
	loadTemplate,
	setTemplateOverrideDir,
} from "../templates/loader.js";
import { DB_FILENAME, resolveControlPlaneRoot } from "./control-plane.js";
import { resolveRunExecutionContext } from "./run-context.js";
import { validateSessionContinuity } from "./session-check.js";
import { parseVars, resolveAndRenderTemplate } from "./template-vars.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateRenderParams {
	template: string;
	run?: string;
	vars?: string | string[];
	session?: string;
	newSession?: boolean;
	workdir?: string;
}

export interface TemplateRenderOutput {
	template: string;
	selected_template: string;
	step_name: string | null;
	prompt: string;
	declared_variables: string[];
	// Resolved template variables (including auto-generated ones like review_path)
	variables: Record<string, string>;
	// Warnings from template resolution (e.g. review_path mismatch)
	warnings?: string[];
	// Run-aware fields — only present when --run is provided
	run_id?: string;
	plan_path?: string;
	worktree_root?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function templateRender(
	params: TemplateRenderParams,
): Promise<void> {
	// -----------------------------------------------------------------------
	// Resolve run context (optional — only when --run is provided)
	// -----------------------------------------------------------------------
	let resolvedPlanPath: string | null = null;
	let resolvedWorktreeRoot: string | null = null;
	let projectRoot: string;
	let stateDir: string;
	let runDb: ReturnType<typeof getDb> | undefined;

	if (params.run) {
		validateRunId(params.run);

		const controlPlane = resolveControlPlaneRoot(params.workdir);

		if (controlPlane.mode === "none") {
			outputError(
				"NO_CONTROL_PLANE",
				`No 5x control-plane DB found. Initialize with "5x init" first.`,
			);
		}

		projectRoot = controlPlane.controlPlaneRoot;
		stateDir = controlPlane.stateDir;

		const dbRelPath = join(stateDir, DB_FILENAME);
		const db = getDb(projectRoot, dbRelPath);
		runDb = db;
		try {
			runMigrations(db);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Database upgrade required. Run "5x upgrade" to fix.\n\nDetails: ${msg}`,
			);
		}

		const ctxResult = resolveRunExecutionContext(db, params.run, {
			controlPlaneRoot: projectRoot,
			explicitWorkdir: params.workdir ? resolve(params.workdir) : undefined,
		});

		if (!ctxResult.ok) {
			outputError(ctxResult.error.code, ctxResult.error.message, {
				detail: ctxResult.error.detail,
			});
		}

		const ctx = ctxResult.context;
		resolvedPlanPath = ctx.effectivePlanPath;
		resolvedWorktreeRoot = ctx.mappedWorktreePath;
	} else {
		// No --run: resolve project root for config/template loading only
		const controlPlane = resolveControlPlaneRoot(params.workdir);
		if (controlPlane.mode === "none") {
			outputError(
				"NO_CONTROL_PLANE",
				`No 5x control-plane DB found. Initialize with "5x init" first.`,
			);
		}
		projectRoot = controlPlane.controlPlaneRoot;
		stateDir = controlPlane.stateDir;
	}

	// -----------------------------------------------------------------------
	// Load config
	// -----------------------------------------------------------------------
	const configContextDir = resolvedPlanPath
		? dirname(resolvedPlanPath)
		: undefined;

	let config: Awaited<ReturnType<typeof loadConfig>>["config"];
	if (configContextDir) {
		const result = await resolveLayeredConfig(projectRoot, configContextDir);
		config = result.config;
	} else {
		const result = await loadConfig(
			projectRoot,
			undefined,
			undefined,
			projectRoot,
		);
		config = result.config;
	}

	// -----------------------------------------------------------------------
	// Set up template override directory
	// -----------------------------------------------------------------------
	const templateDir = join(projectRoot, stateDir, "templates", "prompts");
	setTemplateOverrideDir(templateDir);

	// -----------------------------------------------------------------------
	// Parse vars (needed for session validation + rendering)
	// -----------------------------------------------------------------------
	const explicitVars = await parseVars(params.vars);

	// -----------------------------------------------------------------------
	// Session continuity validation (before template rendering)
	// -----------------------------------------------------------------------
	validateSessionContinuity({
		templateName: params.template,
		session: params.session,
		newSession: params.newSession,
		runId: params.run,
		db: runDb,
		config,
		explicitVars,
	});

	// -----------------------------------------------------------------------
	// Resolve and render template (shared helper)
	// -----------------------------------------------------------------------
	// When --new-session is set, pass session: undefined to ensure full
	// template is selected (not the -continued variant)
	const effectiveSession = params.newSession ? undefined : params.session;
	const resolved = resolveAndRenderTemplate({
		templateName: params.template,
		session: effectiveSession,
		newSession: params.newSession,
		explicitVars,
		resolvedPlanPath,
		config,
		projectRoot,
		// Pass run context for review_path auto-generation
		runId: params.run,
		phase: explicitVars.phase_number,
		// Re-root review_path into the worktree when a worktree is mapped
		worktreeRoot: resolvedWorktreeRoot ?? undefined,
	});
	let prompt = resolved.prompt;

	// -----------------------------------------------------------------------
	// Post-render: append ## Context block when --run resolves a worktree
	// -----------------------------------------------------------------------
	if (resolvedWorktreeRoot) {
		prompt += `\n\n## Context\n\n- Effective working directory: ${resolvedWorktreeRoot}\n`;
	}

	// -----------------------------------------------------------------------
	// Surface warnings (stderr for human visibility)
	// -----------------------------------------------------------------------
	if (resolved.warnings.length > 0) {
		for (const warning of resolved.warnings) {
			console.error(`Warning: ${warning}`);
		}
	}

	// -----------------------------------------------------------------------
	// Build output envelope
	// -----------------------------------------------------------------------
	const output: TemplateRenderOutput = {
		template: resolved.originalTemplateName,
		selected_template: resolved.selectedTemplateName,
		step_name: resolved.stepName,
		prompt,
		declared_variables: resolved.metadata.variables,
		variables: resolved.variables,
		// Warnings from template resolution
		...(resolved.warnings.length > 0 ? { warnings: resolved.warnings } : {}),
		// Run-aware fields
		...(params.run ? { run_id: params.run } : {}),
		...(resolvedPlanPath && params.run ? { plan_path: resolvedPlanPath } : {}),
		...(resolvedWorktreeRoot && params.run
			? { worktree_root: resolvedWorktreeRoot }
			: {}),
	};

	outputSuccess(output);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

interface TemplateListItem {
	name: string;
	description: string | null;
	source: "bundled" | "override";
}

interface TemplateListOutput {
	templates: TemplateListItem[];
}

function formatTemplateListText(data: TemplateListOutput): void {
	if (data.templates.length === 0) {
		console.log("No templates found.");
		return;
	}

	const hasOverrides = data.templates.some((t) => t.source === "override");

	// Calculate column widths
	const nameWidth = Math.max(...data.templates.map((t) => t.name.length));

	for (const t of data.templates) {
		const name = t.name.padEnd(nameWidth);
		const desc = t.description ?? "";
		const source = hasOverrides ? `  [${t.source}]` : "";
		console.log(`  ${name}  ${desc}${source}`);
	}
}

export function templateList(): void {
	const templates = listTemplates();
	const items: TemplateListItem[] = templates.map((t) => ({
		name: t.name,
		description: t.description,
		source: getTemplateSource(t.name),
	}));

	// Sort alphabetically by name
	items.sort((a, b) => a.name.localeCompare(b.name));

	outputSuccess({ templates: items }, formatTemplateListText);
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

interface TemplateDescribeOutput {
	name: string;
	description: string | null;
	version: number;
	step_name: string | null;
	variables: string[];
	variable_defaults: Record<string, string>;
	source: "bundled" | "override";
}

function formatTemplateDescribeText(data: TemplateDescribeOutput): void {
	console.log(`  Name:        ${data.name}`);
	if (data.description) {
		console.log(`  Description: ${data.description}`);
	}
	console.log(`  Version:     ${data.version}`);
	if (data.step_name) {
		console.log(`  Step name:   ${data.step_name}`);
	}
	console.log(`  Source:      ${data.source}`);
	console.log(
		`  Variables:   ${data.variables.length > 0 ? data.variables.join(", ") : "(none)"}`,
	);
	const defaults = Object.entries(data.variable_defaults);
	if (defaults.length > 0) {
		const formatted = defaults
			.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
			.join(", ");
		console.log(`  Defaults:    ${formatted}`);
	}
}

export function templateDescribe(name: string): void {
	let metadata: ReturnType<typeof loadTemplate>["metadata"];
	try {
		({ metadata } = loadTemplate(name));
	} catch {
		outputError(
			"TEMPLATE_NOT_FOUND",
			`Template "${name}" not found. Run "5x template list" to see available templates.`,
		);
	}

	const output: TemplateDescribeOutput = {
		name: metadata.name,
		description: metadata.description,
		version: metadata.version,
		step_name: metadata.stepName,
		variables: metadata.variables,
		variable_defaults: metadata.variableDefaults,
		source: getTemplateSource(metadata.name),
	};

	outputSuccess(output, formatTemplateDescribeText);
}
