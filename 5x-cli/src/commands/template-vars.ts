/**
 * Shared template variable resolution helpers.
 *
 * Extracted from invoke.handler.ts (Phase 1, 014-harness-native-subagent)
 * so that both `5x invoke` and `5x template render` share one implementation.
 *
 * Framework-independent: no CLI framework imports.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { FiveXConfig } from "../config.js";
import { outputError } from "../output.js";
import { loadTemplate, renderTemplate } from "../templates/loader.js";

// ---------------------------------------------------------------------------
// Stdin var detection
// ---------------------------------------------------------------------------

/**
 * Check whether any --var flags use `@-` (stdin) syntax.
 * Must be called BEFORE parseVars() or readUpstreamEnvelope() to determine
 * whether stdin is reserved for a template variable.
 */
export function hasStdinVarFlag(vars: string | string[] | undefined): boolean {
	if (!vars) return false;
	const items = Array.isArray(vars) ? vars : [vars];
	return items.some((v) => {
		const eqIdx = v.indexOf("=");
		return eqIdx > 0 && v.slice(eqIdx + 1) === "@-";
	});
}

// ---------------------------------------------------------------------------
// File reference detection
// ---------------------------------------------------------------------------

/**
 * Check whether a --var value is a file reference (@./path or @/abs/path).
 * Returns true only when the value starts with `@` followed by `.` or `/`,
 * which unambiguously indicates a file path. Literal `@`-prefixed values
 * like `@username` return false and are passed through unchanged.
 */
function isFileReference(value: string): boolean {
	if (value.length < 2 || value[0] !== "@") return false;
	const ch = value[1];
	return ch === "." || ch === "/";
}

// ---------------------------------------------------------------------------
// --var parsing
// ---------------------------------------------------------------------------

/**
 * Parse --var key=value flags into a record.
 * Accepts a single string or array of strings.
 *
 * Supports:
 *   --var key=value       (literal value)
 *   --var key=@-          (read value from stdin)
 *   --var key=@./path.txt (read value from relative file)
 *   --var key=@/abs/path  (read value from absolute file)
 *
 * File-read is only triggered when the value after `@` starts with `.` or `/`
 * (i.e., looks like a file path). Literal values like `--var key=@username`
 * are passed through unchanged, preserving backward compatibility.
 *
 * At most one `@-` var is allowed per invocation.
 */
export async function parseVars(
	vars: string | string[] | undefined,
): Promise<Record<string, string>> {
	if (!vars) return {};
	const items = Array.isArray(vars) ? vars : [vars];
	if (items.length === 0) return {};
	const result: Record<string, string> = {};

	// Enforce at most one @- (stdin) var
	let stdinVarCount = 0;
	for (const v of items) {
		const eqIdx = v.indexOf("=");
		if (eqIdx > 0 && v.slice(eqIdx + 1) === "@-") {
			stdinVarCount++;
		}
	}
	if (stdinVarCount > 1) {
		outputError("INVALID_ARGS", "Only one --var can read from stdin (@-)");
	}

	for (const v of items) {
		const eqIdx = v.indexOf("=");
		if (eqIdx <= 0) {
			outputError(
				"INVALID_ARGS",
				`--var must be in "key=value" format, got: "${v}"`,
			);
		}
		const key = v.slice(0, eqIdx);
		let value = v.slice(eqIdx + 1);

		if (value === "@-") {
			// Read from stdin
			value = await new Response(Bun.stdin.stream()).text();
		} else if (isFileReference(value)) {
			// Read from file — strip the @ prefix.
			// Only triggered for path-like values (@./relative or @/absolute),
			// NOT for literal @-prefixed values like @username.
			const rawPath = value.slice(1);
			const filePath = resolve(rawPath);
			try {
				value = readFileSync(filePath, "utf-8");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				outputError(
					"INVALID_ARGS",
					`Failed to read file for --var ${key}=@${rawPath}: ${msg}`,
				);
			}
		}

		result[key] = value;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Internal variable resolution
// ---------------------------------------------------------------------------

/**
 * Determine if a template is a plan-review template vs implementation-review.
 * Plan-review templates include: reviewer-plan, reviewer-plan-continued, author-process-plan-review
 */
export function isPlanReviewTemplate(templateName: string): boolean {
	// Check for the base name before -continued suffix
	const baseName = templateName.replace(/-continued$/, "");
	return (
		baseName === "reviewer-plan" || baseName === "author-process-plan-review"
	);
}

/**
 * Check whether an explicit `review_path` resolves outside the configured
 * review directory. Returns a warning string if mismatched, null otherwise.
 *
 * For plan-review templates, checks against `planReviews` (falling back to
 * `reviews`). For implementation-review templates, checks against
 * `runReviews` (falling back to `reviews`).
 */
export function checkReviewPathMismatch(
	explicitReviewPath: string,
	templateName: string,
	config: Pick<FiveXConfig, "paths">,
	projectRoot: string,
): string | null {
	const isPlanReview = isPlanReviewTemplate(templateName);
	const configuredDir = isPlanReview
		? (config.paths.planReviews ?? config.paths.reviews)
		: (config.paths.runReviews ?? config.paths.reviews);

	// Resolve both paths to absolute for comparison
	const resolvedExplicitDir = dirname(resolve(projectRoot, explicitReviewPath));
	const resolvedConfiguredDir = resolve(projectRoot, configuredDir);

	if (resolvedExplicitDir !== resolvedConfiguredDir) {
		return `review_path "${explicitReviewPath}" resolves outside configured review directory "${configuredDir}". Omit --var review_path to use the auto-generated path.`;
	}

	return null;
}

/**
 * Generate a stable review path based on template type and context.
 *
 * Plan reviews: <planReviews>/<full-plan-basename>-review.md
 * Implementation reviews: <runReviews>/<run-id>-phase-<phase>-review.md
 * Fallback (no phase): <runReviews>/<run-id>-review.md
 *
 * Paths are repo-relative by default, absolute only when configured directory is absolute.
 */
function generateReviewPath(
	declaredVars: string[],
	explicitVars: Record<string, string>,
	config: Pick<FiveXConfig, "paths">,
	projectRoot: string,
	templateName: string,
	runId?: string,
	phase?: string,
	planPath?: string | null,
): string | null {
	// Only generate if review_path is declared but not explicitly provided
	if (!declaredVars.includes("review_path")) return null;
	if (explicitVars.review_path !== undefined) return null;

	// Determine which directory to use
	const isPlanReview = isPlanReviewTemplate(templateName);
	const reviewDir = isPlanReview
		? (config.paths.planReviews ?? config.paths.reviews)
		: (config.paths.runReviews ?? config.paths.reviews);

	// Generate filename based on context
	let filename: string;
	if (isPlanReview && planPath) {
		// Use plan path relative to project root for stable repo-relative identity
		const relativePlanPath = relative(projectRoot, planPath);
		// Normalize separators and remove .md extension
		const planBasename = relativePlanPath
			.replace(/[/\\]/g, "-")
			.replace(/\.md$/, "");
		filename = `${planBasename}-review.md`;
	} else if (runId && phase) {
		// Implementation review with phase context
		filename = `${runId}-phase-${phase}-review.md`;
	} else if (runId) {
		// Fallback: one document per run
		filename = `${runId}-review.md`;
	} else {
		// Cannot generate without run_id for implementation reviews
		// or plan_path for plan reviews
		return null;
	}

	// Resolve path: if reviewDir is absolute, use it directly; otherwise make repo-relative
	if (reviewDir.startsWith("/")) {
		return `${reviewDir}/${filename}`;
	}
	return `${reviewDir}/${filename}`;
}

/**
 * Resolve internal template-path variables owned by the CLI.
 * Explicit --var values override these defaults.
 */
export function resolveInternalTemplateVariables(
	declaredVars: string[],
	explicitVars: Record<string, string>,
	config: Pick<FiveXConfig, "paths">,
	projectRoot: string,
	templateName?: string,
	runId?: string,
	phase?: string,
	planPath?: string | null,
	worktreeRoot?: string,
): Record<string, string> {
	const internalVars: Record<string, string> = {};

	// paths.* values are always absolute after config loading — no resolve() needed.
	if (declaredVars.includes("plan_template_path")) {
		internalVars.plan_template_path = config.paths.templates.plan;
	}

	if (declaredVars.includes("review_template_path")) {
		internalVars.review_template_path = config.paths.templates.review;
	}

	// Auto-generate review_path if declared but not explicitly provided
	// For plan reviews, use explicitVars.plan_path as fallback if resolvedPlanPath is null
	const effectivePlanPath = planPath ?? explicitVars.plan_path ?? null;
	const generatedReviewPath = generateReviewPath(
		declaredVars,
		explicitVars,
		config,
		projectRoot,
		templateName ?? "",
		runId,
		phase,
		effectivePlanPath,
	);
	if (generatedReviewPath) {
		// Re-root review_path to the worktree when a worktree is mapped,
		// following the same pattern used for plan_path via effectivePlanPath.
		if (worktreeRoot) {
			const absReviewPath = resolve(projectRoot, generatedReviewPath);
			const relReviewPath = relative(projectRoot, absReviewPath);
			internalVars.review_path = join(worktreeRoot, relReviewPath);
		} else {
			internalVars.review_path = generatedReviewPath;
		}
	}

	return {
		...internalVars,
		...explicitVars,
	};
}

// ---------------------------------------------------------------------------
// Shared template resolution + rendering
// ---------------------------------------------------------------------------

export interface ResolveAndRenderOptions {
	templateName: string;
	session?: string;
	newSession?: boolean;
	explicitVars: Record<string, string>;
	resolvedPlanPath: string | null;
	config: Pick<FiveXConfig, "paths">;
	projectRoot: string;
	// Run context for review_path auto-generation
	runId?: string;
	phase?: string;
	/** Worktree root path — when set, auto-generated review_path is re-rooted into the worktree. */
	worktreeRoot?: string;
}

export interface ResolvedTemplate {
	originalTemplateName: string;
	selectedTemplateName: string;
	metadata: ReturnType<typeof loadTemplate>["metadata"];
	prompt: string;
	stepName: string | null;
	variables: Record<string, string>;
	warnings: string[];
}

/**
 * Shared continued-template selection, loading, variable resolution, and
 * rendering. Used by both `5x template render` and `5x invoke` to avoid
 * reimplementing the same logic in two places.
 */
export function resolveAndRenderTemplate(
	opts: ResolveAndRenderOptions,
): ResolvedTemplate {
	const {
		templateName: requestedName,
		session,
		config,
		projectRoot,
		runId,
		phase,
		resolvedPlanPath,
	} = opts;

	// Continued-template selection: when a session is active and a "-continued"
	// variant exists, use it (saves tokens since context is already loaded).
	// --new-session always means full template — skip continued-template probe.
	let templateName = requestedName;
	if (session && !opts.newSession) {
		const continuedName = `${templateName}-continued`;
		try {
			loadTemplate(continuedName);
			templateName = continuedName;
		} catch {
			// No continued variant — use the full template
		}
	}

	// Load template metadata
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

	// Inject resolved plan path as default for plan_path variable
	const vars = { ...opts.explicitVars };
	if (
		resolvedPlanPath &&
		!vars.plan_path &&
		templateMetadata.variables.includes("plan_path")
	) {
		vars.plan_path = resolvedPlanPath;
	}

	// Inject run context for review_path auto-generation
	// phase_number from explicit vars takes precedence for phase context
	const phaseNumber = vars.phase_number ?? phase;

	const variables = resolveInternalTemplateVariables(
		templateMetadata.variables,
		vars,
		config,
		projectRoot,
		templateName,
		runId,
		phaseNumber,
		resolvedPlanPath,
		opts.worktreeRoot,
	);

	const rendered = renderTemplate(templateName, variables);

	// Check for review_path mismatch warning
	const warnings: string[] = [];
	if (opts.explicitVars.review_path !== undefined) {
		const warning = checkReviewPathMismatch(
			opts.explicitVars.review_path,
			templateName,
			config,
			projectRoot,
		);
		if (warning) {
			warnings.push(warning);
		}
	}

	return {
		originalTemplateName: requestedName,
		selectedTemplateName: templateName,
		metadata: templateMetadata,
		prompt: rendered.prompt,
		stepName: rendered.stepName,
		variables,
		warnings,
	};
}
