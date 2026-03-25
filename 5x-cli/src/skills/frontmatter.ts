import { parse as parseYaml } from "yaml";

/** Parsed YAML frontmatter from a SKILL.md file. */
export interface SkillFrontmatter {
	name: string;
	description: string;
	metadata?: Record<string, string>;
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
