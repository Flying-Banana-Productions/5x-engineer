/**
 * Shared command context helpers.
 *
 * Eliminates repeated project-root / config / DB / migration boilerplate
 * across command handlers.
 */

import type { Database } from "bun:sqlite";
import type { FiveXConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { resolveProjectRoot } from "../project-root.js";

export interface ProjectContext {
	projectRoot: string;
	config: FiveXConfig;
}

export interface DbContext extends ProjectContext {
	db: Database;
}

/**
 * Resolve project root and load config. For commands that don't need DB
 * (diff, plan, quality, invoke).
 * @param opts.startDir - Starting directory for project root resolution
 * @param opts.providerNames - Provider names to suppress unknown-key warnings for
 */
export async function resolveProjectContext(opts?: {
	startDir?: string;
	providerNames?: Set<string>;
}): Promise<ProjectContext> {
	const projectRoot = resolveProjectRoot(opts?.startDir);
	const { config } = await loadConfig(projectRoot, opts?.providerNames);
	return { projectRoot, config };
}

/**
 * Resolve project root, load config, open DB, and run migrations.
 * For commands that need DB (run, worktree).
 * @param opts.startDir - Starting directory for project root resolution
 * @param opts.providerNames - Provider names to suppress unknown-key warnings for
 * @param opts.migrate - Run DB migrations (default: true)
 */
export async function resolveDbContext(opts?: {
	startDir?: string;
	providerNames?: Set<string>;
	migrate?: boolean;
}): Promise<DbContext> {
	const { projectRoot, config } = await resolveProjectContext({
		startDir: opts?.startDir,
		providerNames: opts?.providerNames,
	});
	const db = getDb(projectRoot, config.db.path);
	if (opts?.migrate !== false) {
		runMigrations(db);
	}
	return { projectRoot, config, db };
}
