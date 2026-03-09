/**
 * Upgrade command handler — business logic for migrating a project's config,
 * database, and templates to the latest 5x CLI version.
 *
 * Framework-independent: no citty imports.
 */

import {
	copyFileSync,
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	parse as tomlParse,
	patch as tomlPatch,
} from "@decimalturn/toml-patch";
import { discoverConfigFile } from "../config.js";
import { closeDb, getDb } from "../db/connection.js";
import { getSchemaVersion, runMigrations } from "../db/schema.js";
import {
	ensurePromptTemplates,
	ensureTemplateFiles,
	generateTomlConfig,
} from "./init.handler.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface UpgradeParams {
	force?: boolean;
}

// ---------------------------------------------------------------------------
// Config translators  (JS → TOML one-time, TOML → TOML incremental)
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
	notes: string[];
} {
	const config = { ...raw };
	const notes: string[] = [];

	// Rename deprecated top-level keys
	for (const [oldKey, newKey] of Object.entries(DEPRECATED_RENAMES)) {
		if (oldKey in config && !(newKey in config)) {
			config[newKey] = config[oldKey];
			delete config[oldKey];
			notes.push(
				`  Renamed "${oldKey}" to "${newKey}" (value: ${config[newKey]})`,
			);
		} else if (oldKey in config && newKey in config) {
			delete config[oldKey];
			notes.push(
				`  Removed "${oldKey}" (superseded by "${newKey}" already in config)`,
			);
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
				notes.push(`  Removed "${dotPath}" (no longer used)`);
			}
		}
	}

	return { config, notes };
}

// ---------------------------------------------------------------------------
// Config upgrade
// ---------------------------------------------------------------------------

/**
 * Upgrade the config file.  Two paths:
 *
 * 1. **JS → TOML** (one-time): import the JS config, transform, patch our
 *    commented TOML template with the user's values, write `5x.toml`, rename
 *    the old file to `.bak`.
 *
 * 2. **TOML → TOML** (incremental): parse existing TOML, add any missing keys
 *    with defaults, write back via `patch()` to preserve comments.
 */
async function upgradeConfig(projectRoot: string): Promise<string[]> {
	const configPath = discoverConfigFile(projectRoot);
	const log: string[] = [];

	if (!configPath) {
		log.push("  No config file found — creating 5x.toml with defaults");
		const toml = generateTomlConfig();
		writeFileSync(join(projectRoot, "5x.toml"), toml, "utf-8");
		return log;
	}

	if (configPath.endsWith(".toml")) {
		// TOML → TOML incremental upgrade
		return upgradeTomlConfig(configPath, log);
	}

	// JS → TOML one-time migration
	return upgradeJsToToml(projectRoot, configPath, log);
}

function upgradeTomlConfig(configPath: string, log: string[]): string[] {
	const existingToml = readFileSync(configPath, "utf-8");
	// Use raw TOML parse — NOT Zod-parsed — so we only transform keys the
	// user actually wrote. Zod fills in ALL defaults (including deprecated ones
	// like maxAutoIterations), which would trigger false-positive transforms.
	const parsed = tomlParse(existingToml) as Record<string, unknown>;

	const { config: transformed, notes } = transformConfigObject(parsed);

	if (notes.length === 0) {
		log.push("  5x.toml is already up-to-date");
		return log;
	}

	const patched = tomlPatch(existingToml, transformed);
	writeFileSync(configPath, patched, "utf-8");
	log.push("  Updated 5x.toml:");
	log.push(...notes);
	return log;
}

async function upgradeJsToToml(
	projectRoot: string,
	jsPath: string,
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
	const tomlPath = join(projectRoot, "5x.toml");
	writeFileSync(tomlPath, toml, "utf-8");
	log.push("  Created 5x.toml from existing config");

	// Rename old JS config to .bak
	const bakPath = `${jsPath}.bak`;
	renameSync(jsPath, bakPath);
	log.push(`  Renamed ${jsPath} to ${bakPath}`);

	if (notes.length > 0) {
		log.push(...notes);
	}

	return log;
}

// ---------------------------------------------------------------------------
// Database upgrade
// ---------------------------------------------------------------------------

function upgradeDatabase(projectRoot: string, dbRelPath: string): string[] {
	const dbPath = resolve(projectRoot, dbRelPath);
	const log: string[] = [];

	if (!existsSync(dbPath)) {
		log.push("  No database found — will be created on first command");
		return log;
	}

	// Back up before attempting migration
	const bakPath = `${dbPath}.v0.bak`;
	if (!existsSync(bakPath)) {
		copyFileSync(dbPath, bakPath);
		log.push(`  Backed up database to ${bakPath}`);
	}

	// Close any existing connection before migration attempt
	closeDb();

	try {
		const db = getDb(projectRoot, dbRelPath);
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
		log.push("  Deleting database and creating fresh (v0 data backed up)");

		// Close before deleting
		closeDb();

		try {
			unlinkSync(dbPath);
			// Also remove WAL/SHM files if present
			for (const suffix of ["-wal", "-shm"]) {
				const walPath = `${dbPath}${suffix}`;
				if (existsSync(walPath)) unlinkSync(walPath);
			}
		} catch {
			// File might already be gone
		}

		// Create fresh DB
		try {
			const db = getDb(projectRoot, dbRelPath);
			runMigrations(db);
			const version = getSchemaVersion(db);
			log.push(`  Created fresh database at v${version}`);
		} catch (err2) {
			const msg2 = err2 instanceof Error ? err2.message : String(err2);
			log.push(`  Failed to create fresh database: ${msg2}`);
		}
	}

	return log;
}

// ---------------------------------------------------------------------------
// Template refresh
// ---------------------------------------------------------------------------

function refreshTemplates(projectRoot: string, force: boolean): string[] {
	const log: string[] = [];

	const templateResult = ensureTemplateFiles(projectRoot, force);
	for (const name of templateResult.created) {
		log.push(`  Created .5x/templates/${name}`);
	}
	for (const name of templateResult.overwritten) {
		log.push(`  Updated .5x/templates/${name}`);
	}
	for (const name of templateResult.skipped) {
		log.push(`  Skipped .5x/templates/${name} (unchanged)`);
	}

	const promptResult = ensurePromptTemplates(projectRoot, force);
	for (const name of promptResult.created) {
		log.push(`  Created .5x/templates/prompts/${name}`);
	}
	for (const name of promptResult.overwritten) {
		log.push(`  Updated .5x/templates/prompts/${name}`);
	}
	for (const name of promptResult.skipped) {
		log.push(`  Skipped .5x/templates/prompts/${name} (unchanged)`);
	}

	if (
		templateResult.created.length === 0 &&
		templateResult.overwritten.length === 0 &&
		promptResult.created.length === 0 &&
		promptResult.overwritten.length === 0
	) {
		log.push("  All templates up-to-date");
	}

	return log;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function runUpgrade(params: UpgradeParams): Promise<void> {
	const projectRoot = resolve(".");
	const force = Boolean(params.force);

	console.log("5x upgrade\n");

	// 1. Config
	console.log("Config:");
	const configLog = await upgradeConfig(projectRoot);
	for (const line of configLog) console.log(line);
	console.log();

	// 2. Database — need config to know DB path
	// Re-discover config after potential migration
	const configPath = discoverConfigFile(projectRoot);
	let dbRelPath = ".5x/5x.db";
	if (configPath) {
		try {
			if (configPath.endsWith(".toml")) {
				const raw = tomlParse(readFileSync(configPath, "utf-8"));
				if (
					isRecord(raw) &&
					isRecord(raw.db) &&
					typeof raw.db.path === "string"
				) {
					dbRelPath = raw.db.path;
				}
			} else {
				const mod = await import(configPath);
				const raw = mod.default ?? mod;
				if (
					isRecord(raw) &&
					isRecord(raw.db) &&
					typeof raw.db.path === "string"
				) {
					dbRelPath = raw.db.path;
				}
			}
		} catch {
			// Fall back to default DB path
		}
	}

	console.log("Database:");
	const dbLog = upgradeDatabase(projectRoot, dbRelPath);
	for (const line of dbLog) console.log(line);
	console.log();

	// 3. Templates
	console.log("Templates:");
	const templateLog = refreshTemplates(projectRoot, force);
	for (const line of templateLog) console.log(line);
	console.log();

	console.log("Upgrade complete.");
}
