/**
 * OpenCode agent template loader and renderer.
 *
 * Loads bundled OpenCode agent markdown templates and renders them with
 * optional model frontmatter derived from the current 5x config.
 *
 * Phase 2 (014-harness-native-subagent-orchestration):
 * Templates are bundled as static strings and rendered at install time.
 * Model fields are included only when the corresponding 5x config role
 * model is set; otherwise they are omitted so OpenCode inherits the
 * primary agent's model.
 *
 * Tool naming verified against OpenCode documentation (March 2026):
 * Tool names in the `tools` frontmatter block use OpenCode's built-in
 * tool identifiers: write, edit, bash, read, grep, glob, list, webfetch.
 * These are NOT the same as Claude Code tool names (Read, Write, Bash, etc.)
 * or legacy names (read_file, write_file, run_terminal_cmd).
 *
 * cwd frontmatter: OpenCode does NOT support a `cwd` frontmatter field.
 * The effective working directory is communicated via the post-render
 * ## Context block appended by `5x template render --run`. No `cwd`
 * field is included in agent templates.
 */

import codeAuthorRaw from "./5x-code-author.md" with { type: "text" };
import orchestratorRaw from "./5x-orchestrator.md" with { type: "text" };
import planAuthorRaw from "./5x-plan-author.md" with { type: "text" };
import reviewerRaw from "./5x-reviewer.md" with { type: "text" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata for a bundled OpenCode agent template. */
export interface AgentTemplateMetadata {
	/** Agent filename (without .md extension) — also the agent name. */
	name: string;
	/** OpenCode agent mode: primary or subagent. */
	mode: "primary" | "subagent";
	/** Role this agent maps to for model config: author, reviewer, or none. */
	role: "author" | "reviewer" | null;
	/** Raw template content (frontmatter + body). */
	rawContent: string;
}

/** Config for rendering an agent template with model injection. */
export interface AgentRenderConfig {
	/** Model string for author agents (from config.author.model). */
	authorModel?: string;
	/** Model string for reviewer agent (from config.reviewer.model). */
	reviewerModel?: string;
}

/** Result of rendering an agent template. */
export interface RenderedAgentTemplate {
	/** Agent filename (without .md extension). */
	name: string;
	/** Rendered markdown content ready to write to disk. */
	content: string;
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

const AGENT_TEMPLATES: AgentTemplateMetadata[] = [
	{
		name: "5x-reviewer",
		mode: "subagent",
		role: "reviewer",
		rawContent: reviewerRaw,
	},
	{
		name: "5x-plan-author",
		mode: "subagent",
		role: "author",
		rawContent: planAuthorRaw,
	},
	{
		name: "5x-code-author",
		mode: "subagent",
		role: "author",
		rawContent: codeAuthorRaw,
	},
	{
		name: "5x-orchestrator",
		mode: "primary",
		role: null,
		rawContent: orchestratorRaw,
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inject a `model:` line into an agent template's YAML frontmatter when
 * a model is provided. The injection happens immediately after the opening
 * `---` delimiter, before the existing frontmatter fields.
 *
 * If no model is provided, the template is returned unchanged (OpenCode
 * will inherit the primary agent's model for subagents).
 */
function injectModel(raw: string, model: string | undefined): string {
	if (!model) return raw;

	// Match the opening --- delimiter and inject model immediately after
	return raw.replace(/^(---\r?\n)/, `$1model: ${model}\n`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all bundled OpenCode agent templates.
 */
export function listAgentTemplates(): AgentTemplateMetadata[] {
	return [...AGENT_TEMPLATES];
}

/**
 * Render all bundled agent templates with model config applied.
 *
 * Model fields are injected into frontmatter only when the corresponding
 * role model is configured in 5x. When a model is omitted, OpenCode
 * inherits the primary agent's model at runtime.
 *
 * The orchestrator never gets a model field (it inherits whatever the
 * user selects in the harness UI before prompting).
 */
export function renderAgentTemplates(
	config: AgentRenderConfig,
): RenderedAgentTemplate[] {
	return AGENT_TEMPLATES.map((tmpl) => {
		let model: string | undefined;

		if (tmpl.role === "author") {
			model = config.authorModel?.trim() || undefined;
		} else if (tmpl.role === "reviewer") {
			model = config.reviewerModel?.trim() || undefined;
		}
		// orchestrator (role: null) always omits model

		const content = injectModel(tmpl.rawContent, model);
		return { name: tmpl.name, content };
	});
}

/**
 * Get a single agent template by name, rendered with model config.
 * Returns undefined if the template name is not found.
 */
export function renderAgentTemplate(
	name: string,
	config: AgentRenderConfig,
): RenderedAgentTemplate | undefined {
	const tmpl = AGENT_TEMPLATES.find((t) => t.name === name);
	if (!tmpl) return undefined;

	let model: string | undefined;
	if (tmpl.role === "author") {
		model = config.authorModel?.trim() || undefined;
	} else if (tmpl.role === "reviewer") {
		model = config.reviewerModel?.trim() || undefined;
	}

	const content = injectModel(tmpl.rawContent, model);
	return { name: tmpl.name, content };
}
