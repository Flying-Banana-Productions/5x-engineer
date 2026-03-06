/**
 * Skills command handler — business logic for installing agent skills.
 *
 * Framework-independent: no citty imports.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { outputError, outputSuccess } from "../output.js";
import { resolveProjectRoot } from "../project-root.js";
import { listSkills } from "../skills/loader.js";

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface SkillsInstallParams {
	scope: "user" | "project";
	force?: boolean;
	/** Override the default ".agents" install root directory name. */
	installRoot?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Install bundled skills to the appropriate scope directory following
 * the agentskills.io convention: `<root>/<installRoot>/skills/<name>/SKILL.md`.
 */
export async function skillsInstall(
	params: SkillsInstallParams,
): Promise<void> {
	const { scope, force = false, installRoot = ".agents" } = params;

	if (scope !== "user" && scope !== "project") {
		outputError(
			"INVALID_SCOPE",
			`Invalid scope "${scope}". Must be "user" or "project".`,
		);
	}

	const baseDir = scope === "user" ? homedir() : resolveProjectRoot();
	const skillsDir = join(baseDir, installRoot, "skills");

	const skills = listSkills();
	const created: string[] = [];
	const overwritten: string[] = [];
	const skipped: string[] = [];

	for (const skill of skills) {
		const skillDir = join(skillsDir, skill.name);
		const filePath = join(skillDir, "SKILL.md");
		const exists = existsSync(filePath);

		if (exists && !force) {
			skipped.push(skill.name);
			continue;
		}

		mkdirSync(skillDir, { recursive: true });
		writeFileSync(filePath, skill.content, "utf-8");

		if (exists) {
			overwritten.push(skill.name);
		} else {
			created.push(skill.name);
		}
	}

	const targetDisplay =
		scope === "user" ? `~/${installRoot}/skills/` : `${installRoot}/skills/`;

	for (const name of created) {
		console.log(`  Created ${targetDisplay}${name}/SKILL.md`);
	}
	for (const name of overwritten) {
		console.log(`  Overwrote ${targetDisplay}${name}/SKILL.md`);
	}
	for (const name of skipped) {
		console.log(`  Skipped ${targetDisplay}${name}/SKILL.md (already exists)`);
	}

	outputSuccess({
		scope,
		installRoot,
		path: skillsDir,
		created,
		overwritten,
		skipped,
	});
}
