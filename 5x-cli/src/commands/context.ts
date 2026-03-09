/**
 * Shared command context helpers.
 *
 * Eliminates repeated project-root / config / DB / migration boilerplate
 * across command handlers.
 */

import type { Database } from "bun:sqlite";
import { isAbsolute, join } from "node:path";
import type { FiveXConfig } from "../config.js";
import { loadConfig, resolveLayeredConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { resolveProjectRoot } from "../project-root.js";
import {
	type ControlPlaneResult,
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

	const { config } = await loadConfig(projectRoot, opts?.providerNames);
	return { projectRoot, config };
}

/**
 * Resolve project root, load config, open DB, and run migrations.
 * For commands that need DB (run, worktree).
 *
 * Uses the control-plane resolver to determine DB location:
 * - In managed mode: DB is at `<controlPlaneRoot>/<stateDir>/5x.db`.
 * - In isolated mode: DB is at `<checkoutRoot>/<stateDir>/5x.db`.
 * - In 'none' mode: falls back to legacy projectRoot-based resolution.
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
	// Resolve control-plane root first for DB location
	const controlPlane = resolveControlPlaneRoot(opts?.startDir);

	if (controlPlane.mode !== "none") {
		// Managed or isolated mode: use control-plane root for config + DB
		const root = controlPlane.controlPlaneRoot;

		// Config resolution: layered when contextDir is provided
		let config: FiveXConfig;
		if (opts?.contextDir) {
			const result = await resolveLayeredConfig(root, opts.contextDir);
			config = result.config;
		} else {
			const result = await loadConfig(root, opts?.providerNames);
			config = result.config;
		}

		// Compute DB path: <stateDir>/5x.db relative to controlPlaneRoot
		// getDb resolves: resolve(projectRoot, dbPath)
		const dbRelPath = isAbsolute(controlPlane.stateDir)
			? join(controlPlane.stateDir, "5x.db")
			: join(controlPlane.stateDir, "5x.db");
		const db = getDb(root, dbRelPath);

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

		return { projectRoot: root, config, db, controlPlane };
	}

	// 'none' mode: fall back to legacy project root resolution
	const { projectRoot, config } = await resolveProjectContext({
		startDir: opts?.startDir,
		providerNames: opts?.providerNames,
		contextDir: opts?.contextDir,
	});
	const db = getDb(projectRoot, config.db.path);

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
