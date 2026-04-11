/**
 * OpenCode harness skill loader.
 *
 * OpenCode skills are rendered from shared base templates using the
 * configured delegation mode (native or invoke per role).
 */

import {
	resolveSkillTokens,
	type SkillTokenMap,
} from "../../../skills/harness-tokens.js";
import {
	listBaseSkillNames,
	renderAllSkillTemplates,
	renderSkillByName,
} from "../../../skills/loader.js";
import {
	createRenderContext,
	type SkillRenderContext,
} from "../../../skills/renderer.js";
import type { SkillMetadata } from "../../installer.js";

export {
	parseSkillFrontmatter,
	type SkillFrontmatter,
} from "../../../skills/frontmatter.js";

const OPENCODE_SKILL_TOKENS: SkillTokenMap = {
	NATIVE_CONTINUE_PARAM: "task_id",
};

function adaptOpencodeSkill(content: string): string {
	return resolveSkillTokens(content, OPENCODE_SKILL_TOKENS);
}

/**
 * Get the raw content of a bundled skill.
 * Returns the full rendered SKILL.md content including YAML frontmatter.
 *
 * @param name - Skill name (e.g., "5x", "5x-plan")
 * @param ctx - Optional render context. Defaults to all-native for backward compatibility.
 */
export function getDefaultSkillRaw(
	name: string,
	ctx?: SkillRenderContext,
): string {
	const renderContext = ctx ?? createRenderContext(true);
	try {
		return adaptOpencodeSkill(renderSkillByName(name, renderContext).content);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith('Unknown base skill template "')
		) {
			const available = listBaseSkillNames().join(", ");
			throw new Error(
				`Unknown skill "${name}". Available skills: ${available}`,
			);
		}
		throw error;
	}
}

/**
 * List all bundled skill names.
 */
export function listSkillNames(): string[] {
	return listBaseSkillNames();
}

/**
 * Get metadata for all bundled skills.
 *
 * @param ctx - Optional render context. Defaults to all-native for backward compatibility.
 */
export function listSkills(ctx?: SkillRenderContext): SkillMetadata[] {
	const renderContext = ctx ?? createRenderContext(true);
	return renderAllSkillTemplates(renderContext).map((skill) => ({
		...skill,
		content: adaptOpencodeSkill(skill.content),
	}));
}
