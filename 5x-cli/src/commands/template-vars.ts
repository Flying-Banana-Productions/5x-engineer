/**
 * Shared template variable resolution helpers.
 *
 * Extracted from invoke.handler.ts (Phase 1, 014-harness-native-subagent)
 * so that both `5x invoke` and `5x template render` share one implementation.
 *
 * Framework-independent: no citty imports.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
 * Accepts a single string or array of strings (citty may collapse repeated flags).
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
 * Resolve internal template-path variables owned by the CLI.
 * Explicit --var values override these defaults.
 */
export function resolveInternalTemplateVariables(
	declaredVars: string[],
	explicitVars: Record<string, string>,
	config: Pick<FiveXConfig, "paths">,
	projectRoot: string,
): Record<string, string> {
	const internalVars: Record<string, string> = {};

	if (declaredVars.includes("plan_template_path")) {
		internalVars.plan_template_path = resolve(
			projectRoot,
			config.paths.templates.plan,
		);
	}

	if (declaredVars.includes("review_template_path")) {
		internalVars.review_template_path = resolve(
			projectRoot,
			config.paths.templates.review,
		);
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
	explicitVars: Record<string, string>;
	resolvedPlanPath: string | null;
	config: Pick<FiveXConfig, "paths">;
	projectRoot: string;
}

export interface ResolvedTemplate {
	originalTemplateName: string;
	selectedTemplateName: string;
	metadata: ReturnType<typeof loadTemplate>["metadata"];
	prompt: string;
	stepName: string | null;
	variables: Record<string, string>;
}

/**
 * Shared continued-template selection, loading, variable resolution, and
 * rendering. Used by both `5x template render` and `5x invoke` to avoid
 * reimplementing the same logic in two places.
 */
export function resolveAndRenderTemplate(
	opts: ResolveAndRenderOptions,
): ResolvedTemplate {
	const { templateName: requestedName, session, config, projectRoot } = opts;

	// Continued-template selection: when a session is active and a "-continued"
	// variant exists, use it (saves tokens since context is already loaded).
	let templateName = requestedName;
	if (session) {
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
		opts.resolvedPlanPath &&
		!vars.plan_path &&
		templateMetadata.variables.includes("plan_path")
	) {
		vars.plan_path = opts.resolvedPlanPath;
	}

	const variables = resolveInternalTemplateVariables(
		templateMetadata.variables,
		vars,
		config,
		projectRoot,
	);

	const rendered = renderTemplate(templateName, variables);

	return {
		originalTemplateName: requestedName,
		selectedTemplateName: templateName,
		metadata: templateMetadata,
		prompt: rendered.prompt,
		stepName: rendered.stepName,
		variables,
	};
}
