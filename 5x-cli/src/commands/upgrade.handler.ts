/**
 * Upgrade command handler — business logic for migrating a project's config,
 * database, templates, and harness assets to the latest 5x CLI version.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Phase 2: Plan-then-apply architecture. All operations are first planned,
 * then either printed (dry-run) or executed.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	parse as tomlParse,
	patch as tomlPatch,
} from "@decimalturn/toml-patch";
import { discoverConfigFile } from "../config.js";
import { closeDb, getDb } from "../db/connection.js";
import { getSchemaVersion, runMigrations } from "../db/schema.js";
import {
	type AssetPlan,
	buildUpdatedManifest,
	countPlansByAction,
	type DesiredAsset,
	hashFile,
	type Manifest,
	readManifest,
	reconcileAssets,
	writeManifest,
} from "../managed-assets.js";
import {
	DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE,
	DEFAULT_REVIEW_TEMPLATE,
} from "../templates/default-artifacts.js";
import { getDefaultTemplateRaw, listTemplates } from "../templates/loader.js";
import { version as cliVersion } from "../version.js";
import { DB_FILENAME, resolveControlPlaneRoot } from "./control-plane.js";
import { generateTomlConfig } from "./init.handler.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface UpgradeParams {
	force?: boolean;
	/** Show what would change without writing anything. */
	dryRun?: boolean;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
}

// ---------------------------------------------------------------------------
// Plan Types
// ---------------------------------------------------------------------------

/** Action describing a config key change. */
export interface ConfigAction {
	type: "add" | "rename" | "remove";
	key: string;
	oldKey?: string;
	detail: string;
}

/** Action describing database state and migration. */
export interface DatabaseAction {
	exists: boolean;
	currentVersion?: number;
	targetVersion?: number;
	backupPath?: string;
	detail: string;
}

/** Plan for a single harness's assets. */
export interface HarnessUpgradePlan {
	harnessName: string;
	scope: "project";
	assets: AssetPlan[];
}

/** Complete upgrade plan for all phases. */
export interface UpgradePlan {
	/** Absolute path to the control-plane root. */
	controlPlaneRoot: string;
	/** State directory path (relative to controlPlaneRoot or absolute). */
	stateDir: string;
	/** Config actions (key additions, renames, removals). */
	config: ConfigAction[];
	/** Database migration action. */
	database: DatabaseAction;
	/** Template reconciliation plans. */
	templates: AssetPlan[];
	/** Harness asset reconciliation plans (project scope only). */
	harnesses: HarnessUpgradePlan[];
}

// ---------------------------------------------------------------------------
// Config translators (JS → TOML one-time, TOML → TOML incremental)
// ---------------------------------------------------------------------------

/**
 * Known deprecated keys and their replacements.
 * Used for both the JS→TOML migration and advisory messages.
 */
const DEPRECATED_RENAMES: Record<string, string> = {
	maxAutoIterations: "maxStepsPerRun",
};

/** Keys that should be dropped entirely (no replacement). */
const DEPRECATED_REMOVED = new Set(["author.adapter", "reviewer.adapter"]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v != null && !Array.isArray(v);
}

/**
 * Transform a raw v0 config object into a clean v1 object.
 * - Renames deprecated keys
 * - Drops dead keys
 * - Returns advisory notes for the user
 */
function transformConfigObject(raw: Record<string, unknown>): {
	config: Record<string, unknown>;
	notes: ConfigAction[];
} {
	const config = { ...raw };
	const notes: ConfigAction[] = [];

	// Rename deprecated top-level keys
	for (const [oldKey, newKey] of Object.entries(DEPRECATED_RENAMES)) {
		if (oldKey in config && !(newKey in config)) {
			config[newKey] = config[oldKey];
			delete config[oldKey];
			notes.push({
				type: "rename",
				key: newKey,
				oldKey,
				detail: `Renamed "${oldKey}" to "${newKey}"`,
			});
		} else if (oldKey in config && newKey in config) {
			delete config[oldKey];
			notes.push({
				type: "remove",
				key: oldKey,
				detail: `Removed "${oldKey}" (superseded by "${newKey}" already in config)`,
			});
		}
	}

	// Drop dead nested keys
	for (const dotPath of DEPRECATED_REMOVED) {
		const parts = dotPath.split(".");
		if (parts.length === 2) {
			const [section, key] = parts as [string, string];
			const sectionObj = config[section];
			if (isRecord(sectionObj) && key in sectionObj) {
				const cleaned = { ...sectionObj };
				delete cleaned[key];
				config[section] = cleaned;
				notes.push({
					type: "remove",
					key: dotPath,
					detail: `Removed "${dotPath}" (no longer used)`,
				});
			}
		}
	}

	return { config, notes };
}

/**
 * Detect missing keys from the default template that should be added.
 */
function detectMissingKeys(
	userParsed: Record<string, unknown>,
	defaultParsed: Record<string, unknown>,
	path = "",
): Array<{ key: string; value: unknown }> {
	const missing: Array<{ key: string; value: unknown }> = [];

	for (const [key, defaultValue] of Object.entries(defaultParsed)) {
		const fullKey = path ? `${path}.${key}` : key;

		if (!(key in userParsed)) {
			missing.push({ key: fullKey, value: defaultValue });
		} else if (isRecord(defaultValue) && isRecord(userParsed[key])) {
			// Recurse into nested objects
			const nested = detectMissingKeys(
				userParsed[key] as Record<string, unknown>,
				defaultValue,
				fullKey,
			);
			missing.push(...nested);
		}
	}

	return missing;
}

/**
 * Extract commented-out keys from raw TOML content.
 * Returns a Set of dotted key paths that are commented out in the template.
 *
 * Example:
 *   # provider = "opencode"  -> "author.provider"
 *   # [author.harnessModels]   -> "author.harnessModels" (table header)
 */
function extractCommentedOutKeys(tomlContent: string): Set<string> {
	const commentedKeys = new Set<string>();
	const lines = tomlContent.split("\n");
	let currentSection = "";

	for (const line of lines) {
		const trimmed = line.trim();

		// Check for commented table headers like "# [author]" or "# [author.harnessModels]"
		const tableMatch = trimmed.match(/^#\s*\[([^\]]+)\]\s*$/);
		if (tableMatch) {
			const tablePath = tableMatch[1];
			if (tablePath) {
				// The entire table/section is commented out
				commentedKeys.add(tablePath);
			}
			continue;
		}

		// Check for active table headers like "[author]" or "[author.harnessModels]"
		const activeTableMatch = trimmed.match(/^\[([^\]]+)\]\s*$/);
		if (activeTableMatch && !trimmed.startsWith("#")) {
			currentSection = activeTableMatch[1] ?? "";
			continue;
		}

		// Check for commented key-value pairs like "# provider = ..."
		const commentMatch = trimmed.match(/^#\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
		if (commentMatch) {
			const key = commentMatch[1];
			if (key) {
				const fullKey = currentSection ? `${currentSection}.${key}` : key;
				commentedKeys.add(fullKey);
			}
		}
	}

	return commentedKeys;
}

/**
 * Format a value as TOML for commented-out keys.
 */
function formatTomlValue(value: unknown): string {
	if (typeof value === "string") {
		// Check if it needs quoting
		if (value.includes('"') || value.includes("\n") || value.includes("#")) {
			return JSON.stringify(value);
		}
		if (/^[a-zA-Z0-9_.-]+$/.test(value)) {
			return `"${value}"`;
		}
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		const items = value.map((v) => formatTomlValue(v)).join(", ");
		return `[${items}]`;
	}
	return String(value);
}

/**
 * Append commented-out keys to TOML content.
 * Returns the updated TOML content with commented-out keys added.
 */
function appendCommentedOutKeys(
	tomlContent: string,
	commentedOutKeys: Set<string>,
	missing: Array<{ key: string; value: unknown }>,
): string {
	// Filter to only missing keys that are commented out
	const missingCommentedKeys = missing.filter(({ key }) => {
		const keyParts = key.split(".");
		// Check the full key
		if (commentedOutKeys.has(key)) return true;
		// Check parent sections
		for (let i = 1; i < keyParts.length; i++) {
			const parentPath = keyParts.slice(0, i).join(".");
			if (commentedOutKeys.has(parentPath)) return true;
		}
		return false;
	});

	if (missingCommentedKeys.length === 0) {
		return tomlContent;
	}

	const lines = tomlContent.split("\n");
	const result: string[] = [...lines];

	// Group keys by section
	const keysBySection = new Map<
		string,
		Array<{ key: string; value: unknown }>
	>();
	const topLevelKeys: Array<{ key: string; value: unknown }> = [];

	for (const item of missingCommentedKeys) {
		const keyParts = item.key.split(".");
		if (keyParts.length === 1) {
			topLevelKeys.push(item);
		} else {
			const section = keyParts[0];
			if (!section) continue;
			const restKey = keyParts.slice(1).join(".");
			if (!keysBySection.has(section)) {
				keysBySection.set(section, []);
			}
			keysBySection.get(section)?.push({ key: restKey, value: item.value });
		}
	}

	// Find section positions in the file
	const sectionPositions = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]?.trim();
		const match = trimmed?.match(/^\[([^\]]+)\]\s*$/);
		if (match?.[1]) {
			sectionPositions.set(match[1], i);
		}
	}

	// Insert top-level keys at the end of the file (before any trailing empty lines)
	if (topLevelKeys.length > 0) {
		// Find the last non-empty line
		let insertPos = result.length;
		while (insertPos > 0 && result[insertPos - 1]?.trim() === "") {
			insertPos--;
		}

		// Check if we need a blank line before
		if (insertPos > 0 && result[insertPos - 1]?.trim() !== "") {
			result.splice(insertPos, 0, "");
			insertPos++;
		}

		for (const { key, value } of topLevelKeys) {
			result.splice(insertPos, 0, `# ${key} = ${formatTomlValue(value)}`);
			insertPos++;
		}
	}

	// Insert nested keys into their respective sections
	for (const [section, keys] of keysBySection) {
		const sectionPos = sectionPositions.get(section);
		if (sectionPos === undefined) continue;

		// Find where to insert within this section (before next section or EOF)
		let insertPos = sectionPos + 1;
		while (
			insertPos < result.length &&
			!result[insertPos]?.trim()?.startsWith("[")
		) {
			insertPos++;
		}

		// Insert keys in reverse order to maintain position
		for (let i = keys.length - 1; i >= 0; i--) {
			const { key, value } = keys[i] ?? {};
			if (key === undefined || value === undefined) continue;
			result.splice(insertPos, 0, `# ${key} = ${formatTomlValue(value)}`);
		}
	}

	return result.join("\n");
}

/**
 * Set a nested value in an object, creating intermediate objects as needed.
 */
function setNestedValue(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const parts = path.split(".");
	if (parts.length === 0) return;

	let current: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		if (!part) continue;
		if (!(part in current) || !isRecord(current[part])) {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	const lastPart = parts[parts.length - 1];
	if (lastPart) {
		current[lastPart] = value;
	}
}

// ---------------------------------------------------------------------------
// Config upgrade
// ---------------------------------------------------------------------------

/**
 * Build config actions for the upgrade plan.
 */
async function buildConfigActions(
	controlPlaneRoot: string,
): Promise<ConfigAction[]> {
	const configPath = discoverConfigFile(controlPlaneRoot, controlPlaneRoot);
	const actions: ConfigAction[] = [];

	if (!configPath) {
		// No config file found — will be created
		actions.push({
			type: "add",
			key: "config",
			detail: "Will create 5x.toml with defaults",
		});
		return actions;
	}

	if (configPath.endsWith(".toml")) {
		// TOML → TOML incremental upgrade
		return buildTomlConfigActions(configPath);
	}

	// JS → TOML one-time migration
	return buildJsToTomlActions(controlPlaneRoot, configPath);
}

function buildTomlConfigActions(configPath: string): ConfigAction[] {
	const actions: ConfigAction[] = [];
	const existingToml = readFileSync(configPath, "utf-8");
	const parsed = tomlParse(existingToml) as Record<string, unknown>;

	const { notes } = transformConfigObject(parsed);
	actions.push(...notes);

	// Detect missing keys from default template
	const defaultToml = generateTomlConfig();
	const defaultParsed = tomlParse(defaultToml) as Record<string, unknown>;
	const missing = detectMissingKeys(parsed, defaultParsed);

	// Extract commented-out keys from the template to note in actions
	const commentedOutKeys = extractCommentedOutKeys(defaultToml);

	for (const { key } of missing) {
		const keyParts = key.split(".");
		let isCommentedOut = false;

		// Check if key itself is commented out
		if (commentedOutKeys.has(key)) {
			isCommentedOut = true;
		} else {
			// Check if any parent section is commented out
			for (let i = 1; i < keyParts.length; i++) {
				const parentPath = keyParts.slice(0, i).join(".");
				if (commentedOutKeys.has(parentPath)) {
					isCommentedOut = true;
					break;
				}
			}
		}

		actions.push({
			type: "add",
			key,
			detail: isCommentedOut
				? `Will add missing key "${key}" (commented out)`
				: `Will add missing key "${key}"`,
		});
	}

	return actions;
}

async function buildJsToTomlActions(
	_controlPlaneRoot: string,
	jsPath: string,
): Promise<ConfigAction[]> {
	const actions: ConfigAction[] = [];

	// Import the old JS config
	let rawConfig: Record<string, unknown>;
	try {
		const mod = await import(jsPath);
		rawConfig = mod.default ?? mod;
		if (!isRecord(rawConfig)) {
			actions.push({
				type: "add",
				key: "config",
				detail: `Could not read ${jsPath} — export is not a plain object. Skipping config migration.`,
			});
			return actions;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		actions.push({
			type: "add",
			key: "config",
			detail: `Could not import ${jsPath}: ${msg}. Skipping config migration.`,
		});
		return actions;
	}

	const { notes } = transformConfigObject(rawConfig as Record<string, unknown>);
	actions.push(
		{
			type: "add",
			key: "config",
			detail: "Will create 5x.toml from existing config",
		},
		{
			type: "add",
			key: "config.bak",
			detail: `Will rename ${jsPath} to ${jsPath}.bak`,
		},
		...notes,
	);

	return actions;
}

/**
 * Apply config actions.
 */
async function applyConfigActions(
	controlPlaneRoot: string,
	actions: ConfigAction[],
): Promise<string[]> {
	const log: string[] = [];
	const configPath = discoverConfigFile(controlPlaneRoot, controlPlaneRoot);

	if (!configPath) {
		log.push("  No config file found — creating 5x.toml with defaults");
		const toml = generateTomlConfig();
		writeFileSync(join(controlPlaneRoot, "5x.toml"), toml, "utf-8");
		return log;
	}

	if (configPath.endsWith(".toml")) {
		// TOML → TOML incremental upgrade
		return applyTomlConfigUpgrade(configPath, actions, log);
	}

	// JS → TOML one-time migration
	return applyJsToTomlMigration(controlPlaneRoot, configPath, actions, log);
}

function applyTomlConfigUpgrade(
	configPath: string,
	_actions: ConfigAction[],
	log: string[],
): string[] {
	const existingToml = readFileSync(configPath, "utf-8");
	const parsed = tomlParse(existingToml) as Record<string, unknown>;

	const { config: transformed, notes } = transformConfigObject(parsed);

	// Detect missing keys from default template
	const defaultToml = generateTomlConfig();
	const defaultParsed = tomlParse(defaultToml) as Record<string, unknown>;
	const missing = detectMissingKeys(parsed, defaultParsed);

	// Extract commented-out keys from the template
	const commentedOutKeys = extractCommentedOutKeys(defaultToml);

	// Separate missing keys into active and commented
	const activeMissing: Array<{ key: string; value: unknown }> = [];
	const commentedMissing: Array<{ key: string; value: unknown }> = [];

	for (const item of missing) {
		const keyParts = item.key.split(".");
		let isCommentedOut = false;

		// Check if key itself is commented out
		if (commentedOutKeys.has(item.key)) {
			isCommentedOut = true;
		} else {
			// Check if any parent section is commented out
			for (let i = 1; i < keyParts.length; i++) {
				const parentPath = keyParts.slice(0, i).join(".");
				if (commentedOutKeys.has(parentPath)) {
					isCommentedOut = true;
					break;
				}
			}
		}

		if (isCommentedOut) {
			commentedMissing.push(item);
		} else {
			activeMissing.push(item);
		}
	}

	// Add active missing keys to transform
	for (const { key, value } of activeMissing) {
		setNestedValue(transformed, key, value);
	}

	if (notes.length === 0 && missing.length === 0) {
		log.push("  5x.toml is already up-to-date");
		return log;
	}

	let patched = tomlPatch(existingToml, transformed);

	// Append commented-out keys
	patched = appendCommentedOutKeys(patched, commentedOutKeys, commentedMissing);

	writeFileSync(configPath, patched, "utf-8");
	log.push("  Updated 5x.toml:");
	for (const note of notes) {
		log.push(`    ${note.detail}`);
	}
	for (const { key } of activeMissing) {
		log.push(`    Added missing key "${key}"`);
	}
	for (const { key } of commentedMissing) {
		log.push(`    Added missing key "${key}" (commented out)`);
	}
	return log;
}

async function applyJsToTomlMigration(
	controlPlaneRoot: string,
	jsPath: string,
	_actions: ConfigAction[],
	log: string[],
): Promise<string[]> {
	// Import the old JS config
	let rawConfig: Record<string, unknown>;
	try {
		const mod = await import(jsPath);
		rawConfig = mod.default ?? mod;
		if (!isRecord(rawConfig)) {
			log.push(
				`  Could not read ${jsPath} — export is not a plain object. Skipping config migration.`,
			);
			return log;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.push(
			`  Could not import ${jsPath}: ${msg}. Skipping config migration.`,
		);
		return log;
	}

	// Transform
	const { config: transformed, notes } = transformConfigObject(
		rawConfig as Record<string, unknown>,
	);

	// Patch our curated TOML template with the user's values
	const template = generateTomlConfig();
	const toml = tomlPatch(template, transformed);

	// Write new TOML config
	const tomlPath = join(controlPlaneRoot, "5x.toml");
	writeFileSync(tomlPath, toml, "utf-8");
	log.push("  Created 5x.toml from existing config");

	// Rename old JS config to .bak
	const bakPath = `${jsPath}.bak`;
	renameSync(jsPath, bakPath);
	log.push(`  Renamed ${jsPath} to ${bakPath}`);

	for (const note of notes) {
		log.push(`    ${note.detail}`);
	}

	return log;
}

// ---------------------------------------------------------------------------
// Database upgrade
// ---------------------------------------------------------------------------

function buildDatabaseAction(
	controlPlaneRoot: string,
	stateDir: string,
): DatabaseAction {
	const dbPath = join(
		stateDir.startsWith("/") ? stateDir : join(controlPlaneRoot, stateDir),
		DB_FILENAME,
	);

	if (!existsSync(dbPath)) {
		return {
			exists: false,
			detail: "No database found — will be created on first command",
		};
	}

	// Back up before attempting migration
	const bakPath = `${dbPath}.v0.bak`;
	const backupDetail = existsSync(bakPath)
		? undefined
		: `Will back up to ${bakPath}`;

	// Get current version (best effort — might fail if schema is incompatible)
	let currentVersion = 0;
	try {
		const db = getDb(controlPlaneRoot, join(stateDir, DB_FILENAME));
		currentVersion = getSchemaVersion(db);
		closeDb();
	} catch {
		// Schema might be too old or incompatible — assume v0
		currentVersion = 0;
	}

	// Target version from schema migrations
	const targetVersion = getLatestSchemaVersion();

	return {
		exists: true,
		currentVersion,
		targetVersion,
		backupPath: backupDetail ? bakPath : undefined,
		detail:
			currentVersion >= targetVersion
				? `Database is already at v${currentVersion} — up-to-date`
				: `Will migrate database from v${currentVersion} to v${targetVersion}`,
	};
}

function getLatestSchemaVersion(): number {
	// Import schema to get the max migration version
	// This is a simplified version — in reality we'd inspect the migrations
	return 3; // Placeholder — actual value should come from schema.ts
}

function applyDatabaseUpgrade(
	controlPlaneRoot: string,
	stateDir: string,
	action: DatabaseAction,
): string[] {
	const log: string[] = [];

	if (!action.exists) {
		log.push("  No database found — will be created on first command");
		return log;
	}

	const dbPath = join(
		stateDir.startsWith("/") ? stateDir : join(controlPlaneRoot, stateDir),
		DB_FILENAME,
	);

	// Back up before attempting migration
	if (action.backupPath && !existsSync(action.backupPath)) {
		const { copyFileSync } = require("node:fs");
		copyFileSync(dbPath, action.backupPath);
		log.push(`  Backed up database to ${action.backupPath}`);
	}

	// Close any existing connection before migration attempt
	closeDb();

	try {
		const db = getDb(controlPlaneRoot, join(stateDir, DB_FILENAME));
		const versionBefore = getSchemaVersion(db);
		runMigrations(db);
		const versionAfter = getSchemaVersion(db);

		if (versionAfter > versionBefore) {
			log.push(
				`  Migrated database from v${versionBefore} to v${versionAfter}`,
			);
		} else {
			log.push(`  Database is already at v${versionAfter} — up-to-date`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.push(`  Database migration failed: ${msg}`);
		log.push("  Migration aborted — database backup preserved");
	}

	return log;
}

// ---------------------------------------------------------------------------
// Template reconciliation
// ---------------------------------------------------------------------------

function buildTemplateDesiredAssets(
	controlPlaneRoot: string,
	manifest: Manifest | null,
): DesiredAsset[] {
	const assets: DesiredAsset[] = [];

	// Core templates — always managed
	assets.push({
		relativePath: join(".5x", "templates", "implementation-plan-template.md"),
		owner: "template",
		content: DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE,
	});
	assets.push({
		relativePath: join(".5x", "templates", "review-template.md"),
		owner: "template",
		content: DEFAULT_REVIEW_TEMPLATE,
	});

	// Prompt templates — only include if already on disk or in manifest
	// Users opt-in to on-disk templates via `5x init --install-templates`
	const promptTemplates = listTemplates();
	const _promptsDir = join(controlPlaneRoot, ".5x", "templates", "prompts");

	for (const tmpl of promptTemplates) {
		const relativePath = join(".5x", "templates", "prompts", `${tmpl.name}.md`);
		const absolutePath = join(controlPlaneRoot, relativePath);
		const inManifest = manifest?.entries.some(
			(e) => e.relativePath === relativePath,
		);

		// Only include if already on disk or tracked in manifest
		if (existsSync(absolutePath) || inManifest) {
			assets.push({
				relativePath,
				owner: "prompt-template",
				content: getDefaultTemplateRaw(tmpl.name),
			});
		}
	}

	return assets;
}

function buildTemplatePlans(
	controlPlaneRoot: string,
	manifest: Manifest | null,
	force: boolean,
): AssetPlan[] {
	const desired = buildTemplateDesiredAssets(controlPlaneRoot, manifest);

	// Build disk hash function that resolves paths correctly
	const diskHashFn = (relativePath: string): string | null => {
		const absolutePath = join(controlPlaneRoot, relativePath);
		return hashFile(absolutePath);
	};

	const plans = reconcileAssets(desired, manifest, diskHashFn, cliVersion);

	if (force) {
		// In force mode, convert conflicts to updates
		return plans.map((plan) => {
			if (plan.action === "conflict") {
				return { ...plan, action: "update", detail: "Force overwrite" };
			}
			if (plan.action === "stale-modified") {
				return { ...plan, action: "remove", detail: "Force remove" };
			}
			return plan;
		});
	}

	return plans;
}

function applyTemplatePlans(
	controlPlaneRoot: string,
	plans: AssetPlan[],
	desiredAssets: DesiredAsset[],
): string[] {
	const log: string[] = [];
	const desiredByPath = new Map<string, DesiredAsset>();
	for (const asset of desiredAssets) {
		desiredByPath.set(asset.relativePath, asset);
	}

	for (const plan of plans) {
		const absolutePath = join(controlPlaneRoot, plan.relativePath);

		switch (plan.action) {
			case "create":
			case "update": {
				const asset = desiredByPath.get(plan.relativePath);
				if (!asset) continue;
				mkdirSync(join(absolutePath, ".."), { recursive: true });
				writeFileSync(absolutePath, asset.content, "utf-8");
				const action = plan.action === "create" ? "Created" : "Updated";
				log.push(`  ${action} ${plan.relativePath}`);
				break;
			}
			case "remove": {
				if (existsSync(absolutePath)) {
					unlinkSync(absolutePath);
					log.push(`  Removed ${plan.relativePath} (stale)`);
				}
				break;
			}
			case "skip":
				if (plan.detail?.includes("adopt")) {
					log.push(`  Adopted ${plan.relativePath} (matches bundled)`);
				}
				break;
			case "conflict":
				log.push(
					`  Conflict: ${plan.relativePath} — ${plan.detail || "User modified"}`,
				);
				break;
			case "stale-modified":
				log.push(`  Preserved ${plan.relativePath} (stale but user-modified)`);
				break;
		}
	}

	if (log.length === 0) {
		log.push("  All templates up-to-date");
	}

	return log;
}

// ---------------------------------------------------------------------------
// Harness upgrade (project scope only)
// ---------------------------------------------------------------------------

function buildHarnessPlans(
	_controlPlaneRoot: string,
	_manifest: Manifest | null,
	_force: boolean,
): HarnessUpgradePlan[] {
	// Placeholder — Phase 5 will implement full harness refresh
	// For now, return empty array (harnesses are handled separately)
	return [];
}

function _applyHarnessPlans(
	_controlPlaneRoot: string,
	_plans: HarnessUpgradePlan[],
): string[] {
	// Placeholder — Phase 5 will implement full harness refresh
	return [];
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

export async function buildUpgradePlan(
	params: UpgradeParams,
): Promise<UpgradePlan> {
	const force = Boolean(params.force);
	const startDir = params.startDir ?? ".";

	// Resolve control plane root once — anchors all paths
	const { controlPlaneRoot, stateDir } = resolveControlPlaneRoot(startDir);

	// Read existing manifest (or null on first run)
	const manifestPath = join(
		stateDir.startsWith("/") ? stateDir : join(controlPlaneRoot, stateDir),
		"upgrade-manifest.json",
	);
	const manifest = readManifest(manifestPath);

	// 1. Config actions
	const configActions = await buildConfigActions(controlPlaneRoot);

	// 2. Database action
	const databaseAction = buildDatabaseAction(controlPlaneRoot, stateDir);

	// 3. Template plans
	const templatePlans = buildTemplatePlans(controlPlaneRoot, manifest, force);

	// 4. Harness plans (project scope only)
	const harnessPlans = buildHarnessPlans(controlPlaneRoot, manifest, force);

	return {
		controlPlaneRoot,
		stateDir,
		config: configActions,
		database: databaseAction,
		templates: templatePlans,
		harnesses: harnessPlans,
	};
}

// ---------------------------------------------------------------------------
// Plan application
// ---------------------------------------------------------------------------

export async function applyUpgradePlan(
	plan: UpgradePlan,
	_params: UpgradeParams,
): Promise<void> {
	const { controlPlaneRoot, stateDir } = plan;

	// Read current manifest (may have been updated during dry-run)
	const manifestPath = join(
		stateDir.startsWith("/") ? stateDir : join(controlPlaneRoot, stateDir),
		"upgrade-manifest.json",
	);
	const manifest = readManifest(manifestPath);

	console.log("Config:");
	const configLog = await applyConfigActions(controlPlaneRoot, plan.config);
	for (const line of configLog) console.log(line);
	console.log();

	console.log("Database:");
	const dbLog = applyDatabaseUpgrade(controlPlaneRoot, stateDir, plan.database);
	for (const line of dbLog) console.log(line);
	console.log();

	console.log("Templates:");
	const desiredAssets = buildTemplateDesiredAssets(controlPlaneRoot, manifest);
	const templateLog = applyTemplatePlans(
		controlPlaneRoot,
		plan.templates,
		desiredAssets,
	);
	for (const line of templateLog) console.log(line);
	console.log();

	// Build new manifest from template plans only (harnesses Phase 5)
	const writePlans = plan.templates.filter(
		(p) =>
			p.action === "create" || p.action === "update" || p.action === "skip",
	);
	const newManifest = buildUpdatedManifest(
		desiredAssets,
		writePlans,
		cliVersion,
	);

	// Only write manifest if we have entries or there was an existing manifest
	if (newManifest.entries.length > 0 || plan.templates.length > 0) {
		writeManifest(manifestPath, newManifest);
	}
}

// ---------------------------------------------------------------------------
// Plan printing
// ---------------------------------------------------------------------------

function printUpgradePlan(plan: UpgradePlan): void {
	console.log("5x upgrade --dry-run\n");

	// Config
	console.log("Config:");
	if (plan.config.length === 0) {
		console.log("  5x.toml is already up-to-date");
	} else {
		for (const action of plan.config) {
			console.log(`  ${action.detail}`);
		}
	}
	console.log();

	// Database
	console.log("Database:");
	console.log(`  ${plan.database.detail}`);
	if (plan.database.backupPath) {
		console.log(`  Will back up to ${plan.database.backupPath}`);
	}
	console.log();

	// Templates
	console.log("Templates:");
	const counts = countPlansByAction(plan.templates);
	const summaries: string[] = [];
	if (counts.create > 0) summaries.push(`${counts.create} to create`);
	if (counts.update > 0) summaries.push(`${counts.update} to update`);
	if (counts.remove > 0) summaries.push(`${counts.remove} to remove`);
	if (counts.conflict > 0) summaries.push(`${counts.conflict} conflicts`);
	if (counts["stale-modified"] > 0)
		summaries.push(`${counts["stale-modified"]} stale-modified`);
	if (counts.skip > 0) summaries.push(`${counts.skip} unchanged`);

	if (summaries.length === 0) {
		console.log("  All templates up-to-date");
	} else {
		console.log(`  ${summaries.join("; ")}`);
	}

	for (const planItem of plan.templates) {
		if (planItem.action === "conflict") {
			console.log(
				`  ! ${planItem.relativePath}: ${planItem.detail || "User modified"}`,
			);
		} else if (planItem.action === "stale-modified") {
			console.log(
				`  ~ ${planItem.relativePath}: ${planItem.detail || "Stale but user-modified (preserved)"}`,
			);
		} else if (
			planItem.action === "create" ||
			planItem.action === "update" ||
			planItem.action === "remove"
		) {
			console.log(`  + ${planItem.relativePath}: ${planItem.action}`);
		}
	}
	console.log();

	// Harnesses (Phase 5)
	console.log("Harnesses:");
	if (plan.harnesses.length === 0) {
		console.log("  No project-scope harness assets to refresh");
	} else {
		for (const harness of plan.harnesses) {
			const hCounts = countPlansByAction(harness.assets);
			console.log(`  ${harness.harnessName}: ${harness.assets.length} assets`);
			if (hCounts.conflict > 0) {
				console.log(
					`    (${hCounts.conflict} conflicts — use --force to overwrite)`,
				);
			}
		}
	}
	console.log();

	console.log("Dry-run complete. No changes were made.");
	console.log("Run without --dry-run to apply these changes.");
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function runUpgrade(params: UpgradeParams): Promise<void> {
	const dryRun = Boolean(params.dryRun);

	console.log(dryRun ? "5x upgrade --dry-run\n" : "5x upgrade\n");

	// Build the plan
	const plan = await buildUpgradePlan(params);

	if (dryRun) {
		// In dry-run mode, just print the plan
		printUpgradePlan(plan);
	} else {
		// In normal mode, apply the plan
		await applyUpgradePlan(plan, params);
		console.log("Upgrade complete.");
	}
}
