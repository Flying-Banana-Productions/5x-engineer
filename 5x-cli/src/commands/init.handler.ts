/**
 * Init command handler — business logic for project scaffolding.
 *
 * Framework-independent: no citty imports.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import defaultTomlConfig from "../templates/5x.default.toml" with {
	type: "text",
};
import {
	DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE,
	DEFAULT_REVIEW_TEMPLATE,
} from "../templates/default-artifacts.js";
import { getDefaultTemplateRaw, listTemplates } from "../templates/loader.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface InitParams {
	force?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the default 5x.toml config content.
 * Loaded from the bundled template file at src/templates/5x.default.toml.
 */
function generateTomlConfig(): string {
	return defaultTomlConfig;
}

function ensureTemplateFiles(
	projectRoot: string,
	force: boolean,
): {
	created: string[];
	overwritten: string[];
	skipped: string[];
} {
	const templatesDir = join(projectRoot, ".5x", "templates");
	mkdirSync(templatesDir, { recursive: true });

	const targets = [
		{
			name: "implementation-plan-template.md",
			path: join(templatesDir, "implementation-plan-template.md"),
			content: DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE,
		},
		{
			name: "review-template.md",
			path: join(templatesDir, "review-template.md"),
			content: DEFAULT_REVIEW_TEMPLATE,
		},
	] as const;

	const created: string[] = [];
	const overwritten: string[] = [];
	const skipped: string[] = [];

	for (const target of targets) {
		const exists = existsSync(target.path);
		if (exists && !force) {
			skipped.push(target.name);
			continue;
		}
		writeFileSync(target.path, target.content, "utf-8");
		if (exists) overwritten.push(target.name);
		else created.push(target.name);
	}

	return { created, overwritten, skipped };
}

/**
 * Scaffold editable copies of the agent prompt templates into
 * `.5x/templates/prompts/`. Users can customize these to alter agent behavior;
 * the loader falls back to bundled defaults for any missing files.
 */
function ensurePromptTemplates(
	projectRoot: string,
	force: boolean,
): {
	created: string[];
	overwritten: string[];
	skipped: string[];
} {
	const promptsDir = join(projectRoot, ".5x", "templates", "prompts");
	mkdirSync(promptsDir, { recursive: true });

	const templates = listTemplates();
	const created: string[] = [];
	const overwritten: string[] = [];
	const skipped: string[] = [];

	for (const tmpl of templates) {
		const filename = `${tmpl.name}.md`;
		const filePath = join(promptsDir, filename);
		const exists = existsSync(filePath);
		if (exists && !force) {
			skipped.push(filename);
			continue;
		}
		const content = getDefaultTemplateRaw(tmpl.name);
		writeFileSync(filePath, content, "utf-8");
		if (exists) overwritten.push(filename);
		else created.push(filename);
	}

	return { created, overwritten, skipped };
}

/**
 * Append `.5x/` to .gitignore if not already present.
 * Creates .gitignore if it doesn't exist.
 */
function ensureGitignore(projectRoot: string): {
	created: boolean;
	appended: boolean;
} {
	const gitignorePath = join(projectRoot, ".gitignore");
	const entry = ".5x/";

	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, `${entry}\n`, "utf-8");
		return { created: true, appended: false };
	}

	const content = readFileSync(gitignorePath, "utf-8");
	const lines = content.split("\n");

	// Check if .5x/ is already in .gitignore (exact line match, trimmed)
	const alreadyPresent = lines.some((line) => line.trim() === entry);
	if (alreadyPresent) {
		return { created: false, appended: false };
	}

	// Append with a newline before if file doesn't end with one
	const separator = content.endsWith("\n") ? "" : "\n";
	writeFileSync(gitignorePath, `${content}${separator}${entry}\n`, "utf-8");
	return { created: false, appended: true };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function initScaffold(params: InitParams): Promise<void> {
	const projectRoot = resolve(".");
	const force = Boolean(params.force);

	// 1. Generate config file (TOML format)
	const configPath = join(projectRoot, "5x.toml");
	const configExists = existsSync(configPath);
	// Also check for legacy JS config — skip if either exists (user can `5x upgrade` to convert)
	const legacyJsExists =
		existsSync(join(projectRoot, "5x.config.js")) ||
		existsSync(join(projectRoot, "5x.config.mjs"));
	if ((configExists || legacyJsExists) && !force) {
		const which = configExists ? "5x.toml" : "5x.config.js";
		console.log(
			`  Skipped config (${which} already exists, use --force to overwrite)`,
		);
	} else {
		const configContent = generateTomlConfig();
		writeFileSync(configPath, configContent, "utf-8");
		console.log(
			configExists && force ? "  Overwrote 5x.toml" : "  Created 5x.toml",
		);
	}

	// 2. Create .5x/ directory
	const dotFiveXDir = join(projectRoot, ".5x");
	if (!existsSync(dotFiveXDir)) {
		mkdirSync(dotFiveXDir, { recursive: true });
		console.log("  Created .5x/ directory");
	} else {
		console.log("  Skipped .5x/ directory (already exists)");
	}

	const templateResult = ensureTemplateFiles(projectRoot, force);
	for (const name of templateResult.created) {
		console.log(`  Created .5x/templates/${name}`);
	}
	for (const name of templateResult.overwritten) {
		console.log(`  Overwrote .5x/templates/${name}`);
	}
	for (const name of templateResult.skipped) {
		console.log(`  Skipped .5x/templates/${name} (already exists)`);
	}

	// 2b. Scaffold prompt templates (agent prompts, customizable)
	const promptResult = ensurePromptTemplates(projectRoot, force);
	for (const name of promptResult.created) {
		console.log(`  Created .5x/templates/prompts/${name}`);
	}
	for (const name of promptResult.overwritten) {
		console.log(`  Overwrote .5x/templates/prompts/${name}`);
	}
	for (const name of promptResult.skipped) {
		console.log(`  Skipped .5x/templates/prompts/${name} (already exists)`);
	}

	// 3. Update .gitignore
	const gitignoreResult = ensureGitignore(projectRoot);
	if (gitignoreResult.created) {
		console.log("  Created .gitignore with .5x/");
	} else if (gitignoreResult.appended) {
		console.log("  Added .5x/ to .gitignore");
	} else {
		console.log("  Skipped .gitignore (.5x/ already present)");
	}

	console.log("  External TUI is opt-in: use --tui-listen");
	console.log("  Interactive prompts always run in the CLI terminal");
	console.log(
		"  Run '5x skills install project' to install skills for agent clients",
	);
}

// Export helpers for testing and for the upgrade command
export {
	ensureGitignore,
	ensurePromptTemplates,
	ensureTemplateFiles,
	generateTomlConfig,
};
