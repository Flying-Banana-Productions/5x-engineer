import codeAuthorRaw from "./5x-code-author.md" with { type: "text" };
import planAuthorRaw from "./5x-plan-author.md" with { type: "text" };
import reviewerRaw from "./5x-reviewer.md" with { type: "text" };

export interface AgentTemplateMetadata {
	name: string;
	role: "author" | "reviewer";
	rawContent: string;
}

export interface AgentRenderConfig {
	authorModel?: string;
	reviewerModel?: string;
}

export interface RenderedAgentTemplate {
	name: string;
	content: string;
}

const AGENT_TEMPLATES: AgentTemplateMetadata[] = [
	{
		name: "5x-reviewer",
		role: "reviewer",
		rawContent: reviewerRaw,
	},
	{
		name: "5x-plan-author",
		role: "author",
		rawContent: planAuthorRaw,
	},
	{
		name: "5x-code-author",
		role: "author",
		rawContent: codeAuthorRaw,
	},
];

function yamlQuote(value: string): string {
	return (
		'"' +
		value
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"')
			.replace(/\n/g, "\\n")
			.replace(/\r/g, "\\r") +
		'"'
	);
}

function injectModel(raw: string, model: string | undefined): string {
	if (!model) return raw;
	return raw.replace(/^(---\r?\n)/, `$1model: ${yamlQuote(model)}\n`);
}

export function listAgentTemplates(): AgentTemplateMetadata[] {
	return [...AGENT_TEMPLATES];
}

export function renderAgentTemplates(
	config: AgentRenderConfig,
): RenderedAgentTemplate[] {
	return AGENT_TEMPLATES.map((tmpl) => {
		const model =
			tmpl.role === "author"
				? config.authorModel?.trim() || undefined
				: config.reviewerModel?.trim() || undefined;
		return {
			name: tmpl.name,
			content: injectModel(tmpl.rawContent, model),
		};
	});
}
