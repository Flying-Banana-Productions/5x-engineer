import {
	listBaseSkillNames,
	renderAllSkillTemplates,
} from "../../../skills/loader.js";
import type { SkillMetadata } from "../../installer.js";

function adaptCursorTerminology(content: string): string {
	let adapted = content;

	adapted = adapted
		.replaceAll(
			"These skills assume an opencode environment with the 5x harness installed.",
			"These skills assume your project has the 5x harness installed.",
		)
		.replaceAll("## Task Reuse", "## Session Reuse")
		.replace(/task reuse/gi, "session reuse")
		.replace(/Task\s+tool/g, "Cursor subagent invocation")
		.replaceAll("subagent_type", "subagent")
		.replaceAll("$REVIEWER_TASK_ID", "$REVIEWER_AGENT_SESSION_ID")
		.replaceAll("REVIEWER_TASK_ID", "REVIEWER_AGENT_SESSION_ID")
		.replaceAll("task_id=", "agent_session_id=")
		.replace(/task_id/g, "agent session ID");

	return adapted;
}

export function listSkillNames(): string[] {
	return listBaseSkillNames();
}

export function listSkills(): SkillMetadata[] {
	return renderAllSkillTemplates({ native: true }).map((skill) => ({
		...skill,
		content: adaptCursorTerminology(skill.content),
	}));
}
