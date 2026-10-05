/**
 * Shared command context helpers.
 *
 * Eliminates repeated project-root / config / DB / migration boilerplate
 * across command handlers.
 */

import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { FiveXConfig } from "../config.js";
import { loadConfig, resolveLayeredConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { resolveProjectRoot } from "../project-root.js";
import {
	type ControlPlaneResult,
	controlPlaneDbPath,
	normalizeDbPath,
	resolveControlPlaneRoot,
} from "./control-plane.js";

export interface ProjectContext {
	projectRoot: string;
	config: FiveXConfig;
}

export interface DbContext extends ProjectContext {
	db: Database;
	/** Control-plane resolution result. Present when resolved via control-plane. */
	controlPlane?: ControlPlaneResult;
}

/**
 * Resolve project root and load config. For commands that don't need DB
 * (diff, plan, quality, invoke).
 *
 * When `contextDir` is provided, uses plan-path-anchored config layering
 * (Phase 1c): root config from `projectRoot`, nearest config from
 * `contextDir`. Merge: Zod defaults ← root ← nearest (deep merge for
 * objects, replace for arrays, `db` always from root).
 *
 * @param opts.startDir - Starting directory for project root resolution
 * @param opts.providerNames - Provider names to suppress unknown-key warnings for
 * @param opts.contextDir - Optional directory for plan-path-anchored config layering
 */
export async function resolveProjectContext(opts?: {
	startDir?: string;
	providerNames?: Set<string>;
	contextDir?: string;
}): Promise<ProjectContext> {
	const projectRoot = resolveProjectRoot(opts?.startDir);

	if (opts?.contextDir) {
		// Use layered config resolution
		const { config } = await resolveLayeredConfig(projectRoot, opts.contextDir);
		return { projectRoot, config };
	}

	const { config } = await loadConfig(
		projectRoot,
		opts?.providerNames,
		undefined,
		projectRoot,
	);
	return { projectRoot, config };
}

/**
 * Resolve project root, load config, open DB, and run migrations.
 * For commands that need DB (run, worktree).
 *
 * Uses the control-plane resolver to determine DB location:
 * - In managed/isolated mode: DB is at `controlPlaneDbPath(root, stateDir)`
 *   (absolute `stateDir` is the state root; relative joins under the root).
 * - In 'none' mode: bootstraps at the same canonical root, using root-owned config.
 *
 * @param opts.startDir - Starting directory for project root resolution
 * @param opts.providerNames - Provider names to suppress unknown-key warnings for
 * @param opts.migrate - Run DB migrations (default: true)
 * @param opts.contextDir - Optional directory for plan-path-anchored config layering
 */
export async function resolveDbContext(opts?: {
	startDir?: string;
	providerNames?: Set<string>;
	migrate?: boolean;
	contextDir?: string;
}): Promise<DbContext> {
	// Default contextDir to startDir/CWD so layered config resolution is
	// always active. This ensures sub-project 5x.toml overrides (e.g.
	// paths.plans) are picked up without callers opting in explicitly.
	const effectiveContextDir =
		opts?.contextDir ?? opts?.startDir ?? resolve(".");

	// Resolve control-plane root first for DB location
	const controlPlane = resolveControlPlaneRoot(opts?.startDir);
	const projectRoot = controlPlane.controlPlaneRoot;
	const { config } = await resolveLayeredConfig(
		projectRoot,
		effectiveContextDir,
	);
	// Full config loading is authoritative during bootstrap (including JS/MJS
	// configs). Return the same state path that is used to open the database.
	if (controlPlane.mode === "none") {
		controlPlane.stateDir = normalizeDbPath(config.db.path);
	}
	const db = getDb(
		projectRoot,
		controlPlaneDbPath(projectRoot, controlPlane.stateDir),
	);

	if (opts?.migrate !== false) {
		try {
			runMigrations(db);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Database upgrade required. Run "5x upgrade" to fix.\n\nDetails: ${msg}`,
			);
		}
	}

	return { projectRoot, config, db, controlPlane };
}
