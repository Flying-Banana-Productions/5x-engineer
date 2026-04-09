/**
 * Harness asset installer helpers.
 *
 * Provides reusable install logic for writing both skills and agents to
 * harness-specific directories with created/overwritten/skipped reporting
 * matching the existing `skills install` command style.
 *
 * Phase 2 (014-harness-native-subagent-orchestration):
 * Installer is harness-agnostic — callers provide resolved paths from
 * the harness location registry. The `skills install` command is kept
 * backward-compatible; this module adds a parallel path for harnesses
 * that require agent files in addition to skills.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata for a bundled skill. */
export interface SkillMetadata {
	/** Skill name (matches the subdirectory name). */
	name: string;
	/** Short description of what the skill does and when to use it. */
	description: string;
	/** Full raw SKILL.md content (frontmatter + body). */
	content: string;
}

/** A file to install: a relative filename and its text content. */
export interface InstallableFile {
	/** Filename (e.g. "SKILL.md" or "5x-reviewer.md"). */
	filename: string;
	/** Text content to write. */
	content: string;
}

/** Result of installing a single asset. */
export type InstallResult = "created" | "overwritten" | "skipped";

/** Summary of an asset install operation. */
export interface InstallSummary {
	created: string[];
	overwritten: string[];
	skipped: string[];
	/** Files removed during install (e.g., stale assets from mode transitions). */
	removed?: string[];
}

/** Summary of an asset uninstall operation. */
export interface UninstallSummary {
	removed: string[];
	notFound: string[];
}

// ---------------------------------------------------------------------------
// Core installer
// ---------------------------------------------------------------------------

/**
 * Install a list of files into a target directory.
 *
 * Each file is written to `<targetDir>/<file.filename>`.
 * With `force = false`, existing files are skipped only if content matches.
 * With `force = true`, existing files are always overwritten.
 *
 * The target directory is created if it does not exist.
 *
 * @returns Summary of created, overwritten, and skipped file names.
 */
export function installFiles(
	targetDir: string,
	files: InstallableFile[],
	force: boolean,
): InstallSummary {
	mkdirSync(targetDir, { recursive: true });

	const created: string[] = [];
	const overwritten: string[] = [];
	const skipped: string[] = [];

	for (const file of files) {
		const filePath = join(targetDir, file.filename);
		const exists = existsSync(filePath);

		if (exists && !force) {
			// Compare content - skip only if identical
			const existingContent = readFileSync(filePath, "utf-8");
			if (existingContent === file.content) {
				skipped.push(file.filename);
				continue;
			}
			// Content differs - overwrite (config change scenario)
		}

		writeFileSync(filePath, file.content, "utf-8");

		if (exists) {
			overwritten.push(file.filename);
		} else {
			created.push(file.filename);
		}
	}

	return { created, overwritten, skipped };
}

/**
 * Install a set of skill files following the agentskills.io convention:
 * `<skillsDir>/<skillName>/SKILL.md`.
 *
 * Each skill is installed in its own subdirectory named after the skill.
 *
 * @returns Summary of created, overwritten, and skipped paths
 *   (format: "<skillName>/SKILL.md").
 */
export function installSkillFiles(
	skillsDir: string,
	skills: Array<{ name: string; content: string }>,
	force: boolean,
): InstallSummary {
	mkdirSync(skillsDir, { recursive: true });

	const created: string[] = [];
	const overwritten: string[] = [];
	const skipped: string[] = [];

	for (const skill of skills) {
		const skillDir = join(skillsDir, skill.name);
		const filePath = join(skillDir, "SKILL.md");
		const exists = existsSync(filePath);

		if (exists && !force) {
			// Compare content - skip only if identical
			const existingContent = readFileSync(filePath, "utf-8");
			if (existingContent === skill.content) {
				skipped.push(`${skill.name}/SKILL.md`);
				continue;
			}
			// Content differs - overwrite (config change scenario)
		}

		mkdirSync(skillDir, { recursive: true });
		writeFileSync(filePath, skill.content, "utf-8");

		if (exists) {
			overwritten.push(`${skill.name}/SKILL.md`);
		} else {
			created.push(`${skill.name}/SKILL.md`);
		}
	}

	return { created, overwritten, skipped };
}

/**
 * Install a set of agent files directly into an agents directory:
 * `<agentsDir>/<agentName>.md`.
 *
 * @returns Summary of created, overwritten, and skipped file names.
 */
export function installAgentFiles(
	agentsDir: string,
	agents: Array<{ name: string; content: string }>,
	force: boolean,
): InstallSummary {
	return installFiles(
		agentsDir,
		agents.map((a) => ({ filename: `${a.name}.md`, content: a.content })),
		force,
	);
}

/**
 * Install a set of rule files directly into a rules directory:
 * `<rulesDir>/<ruleName>.mdc`.
 *
 * @returns Summary of created, overwritten, and skipped file names.
 */
export function installRuleFiles(
	rulesDir: string,
	rules: Array<{ name: string; content: string }>,
	force: boolean,
): InstallSummary {
	return installFiles(
		rulesDir,
		rules.map((r) => ({ filename: `${r.name}.mdc`, content: r.content })),
		force,
	);
}

// ---------------------------------------------------------------------------
// Uninstall helpers
// ---------------------------------------------------------------------------

/**
 * Remove a directory if it exists and is empty.
 *
 * No-op if the directory does not exist or contains entries.
 * Uses try/catch on `rmdirSync` to handle the TOCTOU race where
 * the directory becomes non-empty between check and remove.
 */
export function removeDirIfEmpty(dir: string): void {
	if (!existsSync(dir)) return;

	try {
		const entries = readdirSync(dir);
		if (entries.length > 0) return;
		rmdirSync(dir);
	} catch {
		// Directory may have been removed or become non-empty — ignore.
	}
}

/**
 * Uninstall a set of skill files following the agentskills.io convention:
 * `<skillsDir>/<skillName>/SKILL.md`.
 *
 * For each name: removes the SKILL.md file if it exists, then removes
 * the skill subdirectory if empty. After all skills, removes the
 * skillsDir itself if empty.
 *
 * @returns Summary with entries formatted as `<name>/SKILL.md`.
 */
export function uninstallSkillFiles(
	skillsDir: string,
	skillNames: string[],
): UninstallSummary {
	const removed: string[] = [];
	const notFound: string[] = [];

	for (const name of skillNames) {
		const skillDir = join(skillsDir, name);
		const filePath = join(skillDir, "SKILL.md");

		if (existsSync(filePath)) {
			rmSync(filePath);
			removed.push(`${name}/SKILL.md`);
		} else {
			notFound.push(`${name}/SKILL.md`);
		}

		removeDirIfEmpty(skillDir);
	}

	removeDirIfEmpty(skillsDir);

	return { removed, notFound };
}

/**
 * Uninstall a set of agent files from an agents directory:
 * `<agentsDir>/<agentName>.md`.
 *
 * For each name: removes the .md file if it exists. After all agents,
 * removes the agentsDir itself if empty.
 *
 * @returns Summary with entries formatted as `<name>.md`.
 */
export function uninstallAgentFiles(
	agentsDir: string,
	agentNames: string[],
): UninstallSummary {
	const removed: string[] = [];
	const notFound: string[] = [];

	for (const name of agentNames) {
		const filePath = join(agentsDir, `${name}.md`);

		if (existsSync(filePath)) {
			rmSync(filePath);
			removed.push(`${name}.md`);
		} else {
			notFound.push(`${name}.md`);
		}
	}

	removeDirIfEmpty(agentsDir);

	return { removed, notFound };
}

/**
 * Remove stale agent files that exist on disk but are not in the
 * list of agents to keep. Used during mixed-mode delegation transitions
 * to clean up agent files for roles that switched to invoke mode.
 *
 * Only deletes 5x-managed agent files (those in the managedAgentNames list),
 * preserving user-authored or third-party agent profiles in shared directories.
 *
 * @param agentsDir - The agents directory path
 * @param keepAgentNames - Array of agent names that should be kept (without .md extension)
 * @param managedAgentNames - Array of 5x-managed agent names that are safe to delete (from bundled inventory)
 * @returns Array of removed file names (e.g., "5x-plan-author.md")
 */
export function removeStaleAgentFiles(
	agentsDir: string,
	keepAgentNames: string[],
	managedAgentNames: string[],
): string[] {
	if (!existsSync(agentsDir)) {
		return [];
	}

	const keepSet = new Set(keepAgentNames);
	const managedSet = new Set(managedAgentNames);
	const removed: string[] = [];

	const entries = readdirSync(agentsDir);
	for (const entry of entries) {
		// Only process .md files
		if (!entry.endsWith(".md")) continue;

		const agentName = entry.slice(0, -3); // Remove .md extension

		// Only delete if:
		// 1. The file is a 5x-managed agent (in managedSet)
		// 2. The agent is NOT in the keep-set (stale)
		if (managedSet.has(agentName) && !keepSet.has(agentName)) {
			const filePath = join(agentsDir, entry);
			rmSync(filePath);
			removed.push(entry);
		}
	}

	removeDirIfEmpty(agentsDir);

	return removed;
}

/**
 * Uninstall a set of rule files from a rules directory:
 * `<rulesDir>/<ruleName>.mdc`.
 *
 * For each name: removes the .mdc file if it exists. After all rules,
 * removes the rulesDir itself if empty.
 *
 * @returns Summary with entries formatted as `<name>.mdc`.
 */
export function uninstallRuleFiles(
	rulesDir: string,
	ruleNames: string[],
): UninstallSummary {
	const removed: string[] = [];
	const notFound: string[] = [];

	for (const name of ruleNames) {
		const filePath = join(rulesDir, `${name}.mdc`);

		if (existsSync(filePath)) {
			rmSync(filePath);
			removed.push(`${name}.mdc`);
		} else {
			notFound.push(`${name}.mdc`);
		}
	}

	removeDirIfEmpty(rulesDir);

	return { removed, notFound };
}
