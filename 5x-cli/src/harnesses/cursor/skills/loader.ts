import {
	resolveSkillTokens,
	type SkillTokenMap,
} from "../../../skills/harness-tokens.js";
import {
	listBaseSkillNames,
	renderAllSkillTemplates,
} from "../../../skills/loader.js";
import {
	createRenderContext,
	type SkillRenderContext,
} from "../../../skills/renderer.js";
import type { SkillMetadata } from "../../installer.js";

const CURSOR_SKILL_TOKENS: SkillTokenMap = {
	NATIVE_CONTINUE_PARAM: "resume",
};

/**
 * Adapt terminology from OpenCode-specific to Cursor-specific.
 * This applies only to native-rendered blocks (Task tool references).
 * Invoke-rendered blocks already use `5x invoke` which is correct for both.
 */
function adaptCursorTerminology(content: string): string {
	let adapted = resolveSkillTokens(content, CURSOR_SKILL_TOKENS);

	adapted = adapted
		.replaceAll(
			"These skills assume an opencode environment with the 5x harness installed.",
			"These skills assume your project has the 5x harness installed.",
		)
		.replaceAll("## Task Reuse", "## Session Reuse")
		.replace(/task reuse/gi, "session reuse")
		.replace(/Task\s+tool/g, "Cursor subagent invocation")
		.replaceAll("subagent_type", "subagent");

	return adapted;
}

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
		content: adaptCursorTerminology(skill.content),
	}));
}
