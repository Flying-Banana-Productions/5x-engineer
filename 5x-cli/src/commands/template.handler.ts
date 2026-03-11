/**
 * Template command handler — business logic for `5x template render`.
 *
 * Framework-independent: no citty imports.
 *
 * Phase 1 (014-harness-native-subagent-orchestration):
 * Standalone prompt rendering so native subagent orchestration can
 * obtain the exact rendered prompt without invoking a provider.
 */

import { dirname, join, resolve } from "node:path";
import { loadConfig, resolveLayeredConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { outputError, outputSuccess } from "../output.js";
import { validateRunId } from "../run-id.js";
import {
	loadTemplate,
	renderTemplate,
	setTemplateOverrideDir,
} from "../templates/loader.js";
import { DB_FILENAME, resolveControlPlaneRoot } from "./control-plane.js";
import { resolveRunExecutionContext } from "./run-context.js";
import {
	parseVars,
	resolveInternalTemplateVariables,
} from "./template-vars.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateRenderParams {
	template: string;
	run?: string;
	vars?: string | string[];
	session?: string;
	workdir?: string;
}

export interface TemplateRenderOutput {
	template: string;
	selected_template: string;
	step_name: string | null;
	prompt: string;
	declared_variables: string[];
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
		const result = await loadConfig(projectRoot);
		config = result.config;
	}

	// -----------------------------------------------------------------------
	// Set up template override directory
	// -----------------------------------------------------------------------
	const templateDir = join(projectRoot, stateDir, "templates", "prompts");
	setTemplateOverrideDir(templateDir);

	// -----------------------------------------------------------------------
	// Continued-template selection (mirrors invoke.handler.ts logic)
	// -----------------------------------------------------------------------
	let templateName = params.template;
	const originalTemplateName = templateName;
	if (params.session) {
		const continuedName = `${templateName}-continued`;
		try {
			loadTemplate(continuedName);
			templateName = continuedName;
		} catch {
			// No continued variant — use the full template
		}
	}

	// -----------------------------------------------------------------------
	// Load template metadata
	// -----------------------------------------------------------------------
	let templateMetadata: ReturnType<typeof loadTemplate>["metadata"];
	try {
		const loaded = loadTemplate(templateName);
		templateMetadata = loaded.metadata;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("Unknown template") || message.includes("not found")) {
			outputError("TEMPLATE_NOT_FOUND", message);
		}
		throw err;
	}

	// -----------------------------------------------------------------------
	// Parse and resolve variables
	// -----------------------------------------------------------------------
	const explicitVars = await parseVars(params.vars);

	// Inject resolved plan path as default for plan_path variable
	if (
		resolvedPlanPath &&
		!explicitVars.plan_path &&
		templateMetadata.variables.includes("plan_path")
	) {
		explicitVars.plan_path = resolvedPlanPath;
	}

	const variables = resolveInternalTemplateVariables(
		templateMetadata.variables,
		explicitVars,
		config,
		projectRoot,
	);

	// -----------------------------------------------------------------------
	// Render template
	// -----------------------------------------------------------------------
	const rendered = renderTemplate(templateName, variables);
	let prompt = rendered.prompt;

	// -----------------------------------------------------------------------
	// Post-render: append ## Context block when --run resolves a worktree
	// -----------------------------------------------------------------------
	if (resolvedWorktreeRoot) {
		prompt += `\n\n## Context\n\n- Effective working directory: ${resolvedWorktreeRoot}\n`;
	}

	// -----------------------------------------------------------------------
	// Build output envelope
	// -----------------------------------------------------------------------
	const output: TemplateRenderOutput = {
		template: originalTemplateName,
		selected_template: templateName,
		step_name: rendered.stepName,
		prompt,
		declared_variables: templateMetadata.variables,
		// Run-aware fields
		...(params.run ? { run_id: params.run } : {}),
		...(resolvedPlanPath && params.run ? { plan_path: resolvedPlanPath } : {}),
		...(resolvedWorktreeRoot && params.run
			? { worktree_root: resolvedWorktreeRoot }
			: {}),
	};

	outputSuccess(output);
}
