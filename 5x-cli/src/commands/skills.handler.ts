/**
 * Skills command handler — business logic for installing agent skills.
 *
 * Framework-independent: no CLI framework imports.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { removeDirIfEmpty } from "../harnesses/installer.js";
import { outputError, outputSuccess } from "../output.js";
import { resolveProjectRoot } from "../project-root.js";
import { listSkillNames, listSkills } from "../skills/loader.js";

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface SkillsInstallParams {
	scope: "user" | "project";
	force?: boolean;
	/** Override the default ".agents" install root directory name. */
	installRoot?: string;
	/** Working directory override for project scope — defaults to resolve("."). */
	startDir?: string;
	/** Home directory override for user scope — defaults to homedir(). */
	homeDir?: string;
}

export interface SkillsUninstallParams {
	scope: "all" | "user" | "project";
	installRoot?: string;
	/** Working directory override for project scope — defaults to resolve("."). */
	startDir?: string;
	/** Home directory override for user scope — defaults to homedir(). */
	homeDir?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillsUninstallScopeResult {
	removed: string[];
	notFound: string[];
}

interface SkillsUninstallOutput {
	scope: "all" | "user" | "project";
	installRoot: string;
	scopes: Partial<Record<"user" | "project", SkillsUninstallScopeResult>>;
}

// ---------------------------------------------------------------------------
// Install handler
// ---------------------------------------------------------------------------

/**
 * Install bundled skills to the appropriate scope directory following
 * the agentskills.io convention: `<root>/<installRoot>/skills/<name>/SKILL.md`.
 */
export async function skillsInstall(
	params: SkillsInstallParams,
): Promise<void> {
	const {
		scope,
		force = false,
		installRoot = ".agents",
		startDir,
		homeDir,
	} = params;

	if (scope !== "user" && scope !== "project") {
		outputError(
			"INVALID_SCOPE",
			`Invalid scope "${scope}". Must be "user" or "project".`,
		);
	}

	const baseDir =
		scope === "user" ? (homeDir ?? homedir()) : resolveProjectRoot(startDir);
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

	outputSuccess({
		scope,
		installRoot,
		path: skillsDir,
		created,
		overwritten,
		skipped,
	});
}

// ---------------------------------------------------------------------------
// Uninstall handler
// ---------------------------------------------------------------------------

/**
 * Uninstall bundled skills from the specified scope(s).
 *
 * Removes only known 5x-managed skill files (SKILL.md for each bundled skill),
 * cleaning up empty directories afterward.
 */
export async function skillsUninstall(
	params: SkillsUninstallParams,
): Promise<SkillsUninstallOutput> {
	const { scope, installRoot = ".agents", startDir, homeDir } = params;

	// Validate scope
	if (scope !== "all" && scope !== "user" && scope !== "project") {
		outputError(
			"INVALID_SCOPE",
			`Invalid scope "${scope}". Must be "all", "user", or "project".`,
		);
	}

	// Determine scopes to process
	const scopesToProcess: Array<"user" | "project"> =
		scope === "all" ? ["user", "project"] : [scope];

	const skillNames = listSkillNames();
	const scopes: Partial<
		Record<"user" | "project", SkillsUninstallScopeResult>
	> = {};

	// Process each scope
	for (const scopeName of scopesToProcess) {
		const baseDir =
			scopeName === "user"
				? (homeDir ?? homedir())
				: resolveProjectRoot(startDir);
		const skillsDir = join(baseDir, installRoot, "skills");

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
		// Also clean up the parent install root directory if empty (e.g., .agents/)
		const installRootDir = join(baseDir, installRoot);
		removeDirIfEmpty(installRootDir);

		scopes[scopeName] = { removed, notFound };
	}

	const output: SkillsUninstallOutput = {
		scope,
		installRoot,
		scopes,
	};

	outputSuccess(output);
	return output;
}
