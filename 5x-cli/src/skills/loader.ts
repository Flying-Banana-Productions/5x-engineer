import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import skillPhaseExecutionRaw from "./5x-phase-execution.md" with {
	type: "text",
};
// Skill files are co-located and imported as strings via Bun's text loader
import skillPlanRaw from "./5x-plan.md" with { type: "text" };
import skillPlanReviewRaw from "./5x-plan-review.md" with { type: "text" };

/** Metadata for a bundled skill. */
export interface SkillMetadata {
	name: string;
	filename: string;
	content: string;
}

// Registry of all bundled skills
const SKILLS: Record<string, string> = {
	"5x-plan": skillPlanRaw,
	"5x-plan-review": skillPlanReviewRaw,
	"5x-phase-execution": skillPhaseExecutionRaw,
};

/**
 * Get the raw content of a bundled skill.
 * Used by `5x init` to scaffold editable copies to disk.
 */
export function getDefaultSkillRaw(name: string): string {
	const raw = SKILLS[name];
	if (raw === undefined) {
		const available = Object.keys(SKILLS).join(", ");
		throw new Error(`Unknown skill "${name}". Available skills: ${available}`);
	}
	return raw;
}

/**
 * List all bundled skill names.
 */
export function listSkillNames(): string[] {
	return Object.keys(SKILLS);
}

/**
 * Get metadata for all bundled skills.
 */
export function listSkills(): SkillMetadata[] {
	return Object.entries(SKILLS).map(([name, content]) => ({
		name,
		filename: `${name}.md`,
		content,
	}));
}

/**
 * Scaffold bundled skills into the project's `.5x/skills/` directory.
 * Skips files that already exist (don't overwrite user customizations).
 *
 * @param projectRoot - Absolute path to the project root
 * @param force - Whether to overwrite existing skill files
 * @returns Object tracking created, overwritten, and skipped skills
 */
export function ensureSkills(
	projectRoot: string,
	force: boolean,
): {
	created: string[];
	overwritten: string[];
	skipped: string[];
} {
	const skillsDir = join(projectRoot, ".5x", "skills");
	mkdirSync(skillsDir, { recursive: true });

	const skills = listSkills();
	const created: string[] = [];
	const overwritten: string[] = [];
	const skipped: string[] = [];

	for (const skill of skills) {
		const filePath = join(skillsDir, skill.filename);
		const exists = existsSync(filePath);

		if (exists && !force) {
			skipped.push(skill.filename);
			continue;
		}

		writeFileSync(filePath, skill.content, "utf-8");
		if (exists) {
			overwritten.push(skill.filename);
		} else {
			created.push(skill.filename);
		}
	}

	return { created, overwritten, skipped };
}
