import { parse as parseYaml } from "yaml";

// Template files are co-located and imported as strings via Bun's text loader
// (configured in bunfig.toml or handled by bun build --compile).
// For runtime compatibility, we import them eagerly and index by name.
import authorGeneratePlanRaw from "./author-generate-plan.md" with {
	type: "text",
};
import authorNextPhaseRaw from "./author-next-phase.md" with { type: "text" };
import authorProcessReviewRaw from "./author-process-review.md" with {
	type: "text",
};
import reviewerCommitRaw from "./reviewer-commit.md" with { type: "text" };
import reviewerPlanRaw from "./reviewer-plan.md" with { type: "text" };

/**
 * Template metadata parsed from YAML frontmatter.
 */
export interface TemplateMetadata {
	name: string;
	version: number;
	variables: string[];
}

/**
 * A fully rendered template ready for adapter.invoke().
 */
export interface RenderedTemplate {
	name: string;
	prompt: string;
}

/**
 * Parsed template: metadata + body (before variable substitution).
 */
interface ParsedTemplate {
	metadata: TemplateMetadata;
	body: string;
}

// Registry of all bundled templates, keyed by name
const TEMPLATES: Record<string, string> = {
	"author-generate-plan": authorGeneratePlanRaw,
	"author-next-phase": authorNextPhaseRaw,
	"author-process-review": authorProcessReviewRaw,
	"reviewer-plan": reviewerPlanRaw,
	"reviewer-commit": reviewerCommitRaw,
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ESCAPED_BRACES_RE = /\\\{\{/g;
const VARIABLE_RE = /\{\{([a-z_]+)\}\}/g;
const ESCAPED_SENTINEL = "\x00LBRACE\x00";

/**
 * Parse YAML frontmatter from a raw template string.
 * Returns metadata and the body (everything after frontmatter).
 */
function parseTemplate(raw: string, templateName: string): ParsedTemplate {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) {
		throw new Error(
			`Template "${templateName}" is missing YAML frontmatter (--- delimiters).`,
		);
	}

	const yamlStr = match[1] ?? "";
	const body = raw.slice(match[0].length);

	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(yamlStr);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Template "${templateName}" has invalid YAML frontmatter: ${msg}`,
		);
	}

	if (
		!frontmatter ||
		typeof frontmatter !== "object" ||
		Array.isArray(frontmatter)
	) {
		throw new Error(
			`Template "${templateName}" frontmatter must be a YAML mapping.`,
		);
	}

	const fm = frontmatter as Record<string, unknown>;

	if (typeof fm.name !== "string" || !fm.name) {
		throw new Error(
			`Template "${templateName}" frontmatter is missing required "name" field.`,
		);
	}
	if (typeof fm.version !== "number" || !Number.isInteger(fm.version)) {
		throw new Error(
			`Template "${templateName}" frontmatter "version" must be an integer.`,
		);
	}
	if (!Array.isArray(fm.variables)) {
		throw new Error(
			`Template "${templateName}" frontmatter "variables" must be an array of strings.`,
		);
	}
	for (const v of fm.variables) {
		if (typeof v !== "string" || !/^[a-z_]+$/.test(v)) {
			throw new Error(
				`Template "${templateName}" frontmatter variable "${v}" must match [a-z_]+.`,
			);
		}
	}

	if (fm.name !== templateName) {
		throw new Error(
			`Template "${templateName}" frontmatter name "${fm.name}" does not match registry key.`,
		);
	}

	return {
		metadata: {
			name: fm.name,
			version: fm.version,
			variables: fm.variables as string[],
		},
		body,
	};
}

// Cache parsed templates to avoid repeated YAML parsing on each load/render/list call.
const parsedCache = new Map<string, ParsedTemplate>();

/**
 * Load a template by name. Returns parsed metadata and raw body.
 * Throws if the template does not exist or has invalid frontmatter.
 */
export function loadTemplate(name: string): {
	metadata: TemplateMetadata;
	body: string;
} {
	const cached = parsedCache.get(name);
	if (cached) return cached;

	const raw = TEMPLATES[name];
	if (raw === undefined) {
		const available = Object.keys(TEMPLATES).join(", ");
		throw new Error(
			`Unknown template "${name}". Available templates: ${available}`,
		);
	}
	const result = parseTemplate(raw, name);
	parsedCache.set(name, result);
	return result;
}

/**
 * Render a template body with variable substitution.
 *
 * Exported for direct testing of rendering mechanics (escape handling, etc.)
 * without requiring a registered template.
 *
 * Rules:
 * - `{{variable_name}}` is replaced with the provided value.
 * - `\{{` in the body is treated as a literal `{{` (escape sequence).
 * - Any unresolved `{{...}}` after substitution is a hard error.
 * - Variable values must be safe scalars (no newlines, no `-->`).
 */
export function renderBody(
	body: string,
	variables: Record<string, string>,
	declaredVars: string[],
	templateName: string,
): string {
	// Validate variable values are safe scalars (defense-in-depth for signal blocks)
	for (const [key, value] of Object.entries(variables)) {
		if (declaredVars.includes(key)) {
			if (value.includes("-->")) {
				throw new Error(
					`Template "${templateName}" variable "${key}" contains unsafe sequence "-->". ` +
						`Variable values must be safe scalars for signal block integrity.`,
				);
			}
			if (value.includes("\n")) {
				throw new Error(
					`Template "${templateName}" variable "${key}" contains a newline. ` +
						`Variable values must be safe scalars for signal block integrity.`,
				);
			}
		}
	}

	// 1. Replace escaped \{{ with sentinel (before substitution and unresolved check)
	let rendered = body.replace(ESCAPED_BRACES_RE, ESCAPED_SENTINEL);

	// 2. Substitute {{variable_name}} with values
	rendered = rendered.replace(VARIABLE_RE, (_match, varName: string) => {
		if (varName in variables) {
			return variables[varName] ?? "";
		}
		// Will be caught by unresolved check below
		return _match;
	});

	// 3. Check for any unresolved {{...}} (typo or extra variable in template)
	//    Sentinels are invisible here — only real unresolved variables are caught
	const unresolved = rendered.match(/\{\{[a-z_]+\}\}/g);
	if (unresolved) {
		const unique = [...new Set(unresolved)];
		throw new Error(
			`Template "${templateName}" has unresolved variables after substitution: ${unique.join(", ")}. ` +
				`Check for typos in the template or provide the missing variables.`,
		);
	}

	// 4. Restore sentinels to literal {{
	rendered = rendered.replaceAll(ESCAPED_SENTINEL, "{{");

	return rendered;
}

/**
 * Render a template with variable substitution.
 *
 * - All variables declared in frontmatter must be provided (unless suffixed
 *   with `_optional` in the variables list — not yet implemented; all are required).
 * - `{{variable_name}}` is replaced with the provided value.
 * - `\{{` in the template is treated as a literal `{{` (escape sequence).
 * - Any unresolved `{{...}}` after substitution is a hard error.
 */
export function renderTemplate(
	name: string,
	variables: Record<string, string>,
): RenderedTemplate {
	const { metadata, body } = loadTemplate(name);

	// Check all required variables are provided
	const missing = metadata.variables.filter((v) => !(v in variables));
	if (missing.length > 0) {
		throw new Error(
			`Template "${name}" is missing required variables: ${missing.join(", ")}`,
		);
	}

	const prompt = renderBody(body, variables, metadata.variables, name);

	return {
		name: metadata.name,
		prompt,
	};
}

/**
 * List all available template names and their metadata.
 */
export function listTemplates(): TemplateMetadata[] {
	return Object.keys(TEMPLATES).map((name) => {
		const { metadata } = loadTemplate(name);
		return metadata;
	});
}
