/**
 * OpenCode harness skill loader.
 *
 * Loads the bundled 5x skill .md files co-located in this directory and
 * exposes them as `SkillMetadata[]` for the OpenCode plugin to install.
 *
 * `parseSkillFrontmatter()` is also exported for tests and any consumer
 * that needs to extract name/description from a SKILL.md file.
 */

import { parse as parseYaml } from "yaml";
import type { SkillMetadata } from "../../installer.js";

// Skill files imported as text via Bun's text loader
import skill5xRaw from "./5x/SKILL.md" with { type: "text" };
import skillPhaseExecutionRaw from "./5x-phase-execution/SKILL.md" with {
	type: "text",
};
import skillPlanRaw from "./5x-plan/SKILL.md" with { type: "text" };
import skillPlanReviewRaw from "./5x-plan-review/SKILL.md" with {
	type: "text",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed YAML frontmatter from a SKILL.md file. */
export interface SkillFrontmatter {
	name: string;
	description: string;
	metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Skill registry
// ---------------------------------------------------------------------------

/** Registry of all bundled skills (name -> raw SKILL.md content). */
const SKILLS: Record<string, string> = {
	"5x": skill5xRaw,
	"5x-plan": skillPlanRaw,
	"5x-plan-review": skillPlanReviewRaw,
	"5x-phase-execution": skillPhaseExecutionRaw,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
