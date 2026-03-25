import {
	listBaseSkillNames,
	renderAllSkillTemplates,
} from "../../../skills/loader.js";
import type { SkillMetadata } from "../../installer.js";

export function listSkillNames(): string[] {
	return listBaseSkillNames();
}

export function listSkills(): SkillMetadata[] {
	return renderAllSkillTemplates({ native: true });
}
