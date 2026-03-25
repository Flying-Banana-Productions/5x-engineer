/**
 * OpenCode harness skill loader.
 *
 * OpenCode skills are rendered from shared base templates using native
 * delegation mode (`{ native: true }`).
 */

import {
	listBaseSkillNames,
	renderAllSkillTemplates,
	renderSkillByName,
} from "../../../skills/loader.js";
import type { SkillMetadata } from "../../installer.js";

export {
	parseSkillFrontmatter,
	type SkillFrontmatter,
} from "../../../skills/frontmatter.js";

/**
 * Get the raw content of a bundled skill.
 * Returns the full rendered SKILL.md content including YAML frontmatter.
 */
export function getDefaultSkillRaw(name: string): string {
	try {
		return renderSkillByName(name, { native: true }).content;
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
 */
export function listSkills(): SkillMetadata[] {
	return renderAllSkillTemplates({ native: true });
}
