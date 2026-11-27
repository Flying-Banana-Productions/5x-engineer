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

/**
 * OpenCode 2.x runs every `subagent` call in the background: the tool result
 * is a launch acknowledgment carrying the child `sessionID`, and the parent
 * receives a completion report when the child goes idle. Native launch sites
 * therefore separate the acknowledgment (LAUNCH) from the completed result.
 */
const OPENCODE_AWAIT_RESULT = [
	"",
	"CHILD_SESSION_ID=<sessionID from LAUNCH>",
	"# The subagent runs in the background. LAUNCH is only an acknowledgment:",
	"# never validate it. Wait for the completion report from $CHILD_SESSION_ID",
	"# and ignore reports from other child sessions.",
	"RESULT=<final JSON object from $CHILD_SESSION_ID's completion report>",
].join("\n");

const OPENCODE_SKILL_TOKENS: SkillTokenMap = {
	NATIVE_CONTINUE_PARAM: "sessionID",
	NATIVE_DELEGATE_TOOL: "`subagent` tool",
	NATIVE_AGENT_PARAM: "agent",
	NATIVE_LAUNCH_VAR: "LAUNCH",
	NATIVE_AWAIT_RESULT: OPENCODE_AWAIT_RESULT,
	NATIVE_CHILD_ID_SOURCE: "$CHILD_SESSION_ID",
	NATIVE_CHILD_ID_NOUN: "child session id",
	NATIVE_CHILD_ID_FROM:
		"`$CHILD_SESSION_ID` (the child `sessionID` saved from the launch acknowledgment), not the completion",
	NATIVE_AWAIT_NOTE:
		" The `subagent` tool runs the child in the background and returns only a\n" +
		"launch acknowledgment with the child `sessionID`. Wait for that child's\n" +
		"completion report, then validate and record only the final JSON object from\n" +
		"it. Never validate the acknowledgment, never record a report from another\n" +
		"child session against the current step, and delegate one step at a time.",
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
