import { parse as parseYaml } from "yaml";
// Skill files are co-located in subdirectories and imported as strings via Bun's text loader
import skill5xRaw from "./5x/SKILL.md" with { type: "text" };
import skillPhaseExecutionRaw from "./5x-phase-execution/SKILL.md" with {
	type: "text",
};
import skillPlanRaw from "./5x-plan/SKILL.md" with { type: "text" };
import skillPlanReviewRaw from "./5x-plan-review/SKILL.md" with {
	type: "text",
};

/** Parsed YAML frontmatter from a SKILL.md file. */
export interface SkillFrontmatter {
	name: string;
	description: string;
	metadata?: Record<string, string>;
}

/** Metadata for a bundled skill. */
export interface SkillMetadata {
	/** Skill name (matches the subdirectory name). */
	name: string;
	/** Short description of what the skill does and when to use it. */
	description: string;
	/** Full raw SKILL.md content (frontmatter + body). */
	content: string;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Expects content starting with `---`, YAML block, closing `---`, then body.
 *
 * @throws if frontmatter is missing, malformed, or lacks required fields.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match?.[1]) {
		throw new Error("SKILL.md is missing YAML frontmatter (--- delimiters)");
	}
	const parsed = parseYaml(match[1]) as Record<string, unknown>;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("SKILL.md frontmatter is not a valid YAML mapping");
	}
	const { name, description } = parsed;
	if (typeof name !== "string" || name.length === 0) {
		throw new Error(
			'SKILL.md frontmatter is missing required "name" field (non-empty string)',
		);
	}
	if (typeof description !== "string" || description.length === 0) {
		throw new Error(
			'SKILL.md frontmatter is missing required "description" field (non-empty string)',
		);
	}
	return {
		name,
		description,
		metadata:
			parsed.metadata &&
			typeof parsed.metadata === "object" &&
			!Array.isArray(parsed.metadata)
				? (parsed.metadata as Record<string, string>)
				: undefined,
	};
}

// Registry of all bundled skills (name → raw SKILL.md content)
const SKILLS: Record<string, string> = {
	"5x": skill5xRaw,
	"5x-plan": skillPlanRaw,
	"5x-plan-review": skillPlanReviewRaw,
	"5x-phase-execution": skillPhaseExecutionRaw,
};

/**
 * Get the raw content of a bundled skill.
 * Returns the full SKILL.md content including YAML frontmatter.
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
 * Parses YAML frontmatter from each SKILL.md to extract name and description.
 */
export function listSkills(): SkillMetadata[] {
	return Object.entries(SKILLS).map(([name, content]) => {
		const fm = parseSkillFrontmatter(content);
		return { name, description: fm.description, content };
	});
}
