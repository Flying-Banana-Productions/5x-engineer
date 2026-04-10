/**
 * Init command handler — business logic for project scaffolding.
 *
 * Framework-independent: no CLI framework imports.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import defaultTomlConfig from "../templates/5x.default.toml" with {
	type: "text",
};
import {
	DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE,
	DEFAULT_REVIEW_TEMPLATE,
} from "../templates/default-artifacts.js";
import { getDefaultTemplateRaw, listTemplates } from "../templates/loader.js";
import {
	DB_FILENAME,
	resolveCheckoutRoot,
	resolveControlPlaneRoot,
} from "./control-plane.js";

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface InitParams {
	force?: boolean;
	/** Scaffold editable prompt templates to .5x/templates/prompts/. */
	installTemplates?: boolean;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
	/**
	 * Relative path from cwd: scaffold only a paths-only `5x.toml` under the
	 * control-plane root. Mutually exclusive with root init (no `.5x/` / DB).
	 */
	subProjectPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the full commented TOML template used by `5x upgrade` (JS→TOML and
 * patch baseline). Not written by `5x init`.
 */
export function generateTomlConfig(): string {
	return defaultTomlConfig;
}

/** Minimal `[paths]`-only scaffold for `5x init --sub-project-path`. */
const SUB_PROJECT_PATHS_TOML = `[paths]
plans = "docs/development"
reviews = "docs/development/reviews"
archive = "docs/archive"
`;

function assertPathInsideControlRoot(
	controlPlaneRoot: string,
	targetPath: string,
): void {
	const root = resolve(controlPlaneRoot);
	const target = resolve(targetPath);
	const rel = relative(root, target);
	if (rel.startsWith("..") || rel === "..") {
		throw new Error(
			`Sub-project path must be inside the control-plane root (${root}).`,
		);
	}
}

/**
 * Create a paths-only `5x.toml` under `--sub-project-path` after verifying the
 * control plane (state dir + DB) exists.
 */
async function runSubProjectInit(params: InitParams): Promise<void> {
	const force = Boolean(params.force);
	const cwd = resolve(params.startDir ?? ".");
	const raw = params.subProjectPath?.trim();
	if (!raw) {
		throw new Error(
			"Sub-project path is required when using --sub-project-path.",
		);
	}

	const controlPlane = resolveControlPlaneRoot(cwd);
	const cpRoot = resolve(controlPlane.controlPlaneRoot);
	const stateRoot = isAbsolute(controlPlane.stateDir)
		? controlPlane.stateDir
		: join(cpRoot, controlPlane.stateDir);

	if (!existsSync(stateRoot) || !existsSync(join(stateRoot, DB_FILENAME))) {
		throw new Error(
			"Root project must be initialized first. Run `5x init` from the repository root.",
		);
	}

	const absTarget = resolve(cwd, raw);
	assertPathInsideControlRoot(cpRoot, absTarget);

	mkdirSync(absTarget, { recursive: true });

	const tomlPath = join(absTarget, "5x.toml");
	const ctxHint = relative(cwd, absTarget) || ".";

	if (existsSync(tomlPath) && !force) {
		console.log(
			`  Skipped ${tomlPath} (already exists, use --force to overwrite)`,
		);
		console.log(
			`  Run '5x config set <key> <value> --context ${ctxHint}' for further customization.`,
		);
		return;
	}

	writeFileSync(tomlPath, SUB_PROJECT_PATHS_TOML, "utf-8");
	console.log(`  Created ${tomlPath}`);
	console.log(
		`  Run '5x config set <key> <value> --context ${ctxHint}' for further customization.`,
	);
}

/**
 * Phase 3c invariant: template scaffolding uses `projectRoot` which equals
 * `controlPlaneRoot` when running from the main checkout. Init is blocked
 * from managed worktrees by the Phase 1a guard above, so template paths
 * always resolve under the correct control-plane root. No re-anchoring needed.
 */
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
 * Check installed prompt templates against bundled versions during `5x upgrade`.
 *
 * Unlike the old upgradePromptTemplates(), this function never writes files.
 * It only reports which on-disk templates differ from the current bundled
 * versions so the user can decide what to do.
 *
 * If the prompts directory doesn't exist, returns empty results — the user
 * is using bundled templates and there is nothing to check.
 */
function checkInstalledPromptTemplates(projectRoot: string): {
	current: string[];
	diverged: string[];
} {
	const promptsDir = join(projectRoot, ".5x", "templates", "prompts");
	if (!existsSync(promptsDir)) {
		return { current: [], diverged: [] };
	}

	const templates = listTemplates();
	const current: string[] = [];
	const diverged: string[] = [];

	for (const tmpl of templates) {
		const filename = `${tmpl.name}.md`;
		const filePath = join(promptsDir, filename);

		if (!existsSync(filePath)) {
			// User removed this template — loader falls back to bundled. Skip.
			continue;
		}

		const diskContent = readFileSync(filePath, "utf-8");
		const bundledContent = getDefaultTemplateRaw(tmpl.name);

		if (diskContent === bundledContent) {
			current.push(filename);
		} else {
			diverged.push(filename);
		}
	}

	return { current, diverged };
}

/** Lines appended idempotently by {@link ensureGitignore}. */
const GITIGNORE_ENTRIES = [".5x/", "5x.toml.local"] as const;

/**
 * Append `.5x/` and `5x.toml.local` to .gitignore if not already present.
 * Creates .gitignore if it doesn't exist.
 */
function ensureGitignore(projectRoot: string): {
	created: boolean;
	appended: boolean;
} {
	const gitignorePath = join(projectRoot, ".gitignore");

	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, `${GITIGNORE_ENTRIES.join("\n")}\n`, "utf-8");
		return { created: true, appended: false };
	}

	let content = readFileSync(gitignorePath, "utf-8");
	let appended = false;

	for (const entry of GITIGNORE_ENTRIES) {
		const lines = content.split("\n");
		const alreadyPresent = lines.some((line) => line.trim() === entry);
		if (alreadyPresent) continue;

		const separator = content.endsWith("\n") ? "" : "\n";
		content = `${content}${separator}${entry}\n`;
		appended = true;
	}

	if (appended) {
		writeFileSync(gitignorePath, content, "utf-8");
	}

	return { created: false, appended };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function initScaffold(params: InitParams): Promise<void> {
	const force = Boolean(params.force);
	const cwd = resolve(params.startDir ?? ".");

	// Managed-mode guard: block `5x init` from a linked worktree when the
	// main repo is already 5x-managed. No escape hatch — `--force` only
	// overwrites templates (or sub-project `5x.toml`), it does not bypass this guard.
	// Compare the git checkout root (not raw cwd) against controlPlaneRoot
	// so that running `5x init` from a subdirectory of the main checkout
	// is correctly recognized as "main checkout" and allowed.
	const controlPlane = resolveControlPlaneRoot(cwd);
	const checkoutRoot = resolveCheckoutRoot(cwd);
	if (controlPlane.mode === "managed") {
		const normalizedCheckout = checkoutRoot ? resolve(checkoutRoot) : null;
		const normalizedRoot = resolve(controlPlane.controlPlaneRoot);
		if (normalizedCheckout !== normalizedRoot) {
			throw new Error(
				`This worktree is managed by the control-plane at \`${controlPlane.controlPlaneRoot}\`. ` +
					"Run `5x init` from the main checkout if you need to re-initialize.",
			);
		}
	}

	const subPath = params.subProjectPath?.trim();
	if (subPath) {
		await runSubProjectInit({ ...params, subProjectPath: subPath });
		return;
	}

	// Scaffold at the checkout root (or cwd if outside git), not the raw cwd.
	// This ensures `5x init` from a subdirectory still creates `.5x/` at the
	// repository root (no root `5x.toml` — Zod defaults apply until overridden).
	const projectRoot = checkoutRoot ?? cwd;

	// 1. Create .5x/ directory
	const dotFiveXDir = join(projectRoot, ".5x");
	if (!existsSync(dotFiveXDir)) {
		mkdirSync(dotFiveXDir, { recursive: true });
		console.log("  Created .5x/ directory");
	} else {
		console.log("  Skipped .5x/ directory (already exists)");
	}

	// 2a. Create state DB with schema migrations
	const dbPath = join(".5x", DB_FILENAME);
	const dbFullPath = join(dotFiveXDir, DB_FILENAME);
	if (!existsSync(dbFullPath)) {
		const db = getDb(projectRoot, dbPath);
		runMigrations(db);
		closeDb();
		console.log(`  Created ${dbPath}`);
	} else {
		console.log(`  Skipped ${dbPath} (already exists)`);
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

	// 2b. Scaffold prompt templates (agent prompts, customizable) — opt-in only
	if (params.installTemplates) {
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
	}

	// 3. Update .gitignore
	const gitignoreResult = ensureGitignore(projectRoot);
	if (gitignoreResult.created) {
		console.log("  Created .gitignore with .5x/ and 5x.toml.local");
	} else if (gitignoreResult.appended) {
		console.log("  Updated .gitignore (added missing entries)");
	} else {
		console.log("  Skipped .gitignore (all entries already present)");
	}

	console.log("  External TUI is opt-in: use --tui-listen");
	console.log("  Interactive prompts always run in the CLI terminal");
	console.log(
		"  Run '5x harness install opencode --scope project' to install skills and subagent profiles",
	);
	console.log(
		"  Run '5x config show' to see all available configuration options.",
	);
	console.log("  Run '5x config set <key> <value>' to customize.");
}

// Export helpers for testing and for the upgrade command
export {
	checkInstalledPromptTemplates,
	ensureGitignore,
	ensurePromptTemplates,
	ensureTemplateFiles,
};
