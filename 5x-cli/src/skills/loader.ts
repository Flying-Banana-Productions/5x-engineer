import type { SkillMetadata } from "../harnesses/installer.js";
import skill5xTemplate from "./base/5x/SKILL.tmpl.md" with { type: "text" };
import skill5xConfig from "./base/5x-config/SKILL.md" with { type: "text" };
import skillPhaseExecutionTemplate from "./base/5x-phase-execution/SKILL.tmpl.md" with {
	type: "text",
};
import skillPlanTemplate from "./base/5x-plan/SKILL.tmpl.md" with {
	type: "text",
};
import skillPlanReviewTemplate from "./base/5x-plan-review/SKILL.tmpl.md" with {
	type: "text",
};
import skill5xWindowsTemplate from "./base/5x-windows/SKILL.tmpl.md" with {
	type: "text",
};
import { parseSkillFrontmatter } from "./frontmatter.js";
import type { SkillRenderContext } from "./renderer.js";
import { renderSkillTemplate } from "./renderer.js";

const BASE_SKILL_TEMPLATES: Record<string, string> = {
	"5x": skill5xTemplate,
	"5x-windows": skill5xWindowsTemplate,
	"5x-plan": skillPlanTemplate,
	"5x-plan-review": skillPlanReviewTemplate,
	"5x-phase-execution": skillPhaseExecutionTemplate,
	"5x-config": skill5xConfig,
};

/** List base skill template names. */
export function listBaseSkillNames(): string[] {
	return Object.keys(BASE_SKILL_TEMPLATES);
}

/** Load and render a single base skill template by name. */
export function renderSkillByName(
	name: string,
	ctx: SkillRenderContext,
): SkillMetadata {
	const rawTemplate = BASE_SKILL_TEMPLATES[name];
	if (rawTemplate === undefined) {
		const available = listBaseSkillNames().join(", ");
		throw new Error(
			`Unknown base skill template "${name}". Available templates: ${available}`,
		);
	}

	const content = renderSkillTemplate(rawTemplate, ctx);
	const fm = parseSkillFrontmatter(content);
	return {
		name: fm.name,
		description: fm.description,
		content,
	};
}

/** Load all base skill templates, render with context, parse frontmatter. */
export function renderAllSkillTemplates(
	ctx: SkillRenderContext,
): SkillMetadata[] {
	return listBaseSkillNames().map((name) => renderSkillByName(name, ctx));
}
