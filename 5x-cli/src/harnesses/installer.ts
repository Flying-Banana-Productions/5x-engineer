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

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Core installer
// ---------------------------------------------------------------------------

/**
 * Install a list of files into a target directory.
 *
 * Each file is written to `<targetDir>/<file.filename>`.
 * With `force = false`, existing files are skipped.
 * With `force = true`, existing files are overwritten.
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
			skipped.push(file.filename);
			continue;
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
			skipped.push(`${skill.name}/SKILL.md`);
			continue;
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
