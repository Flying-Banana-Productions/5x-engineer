/**
 * Managed-asset manifest module.
 *
 * Tracks project-scope managed files (templates, prompt templates, harness assets)
 * with content hashes for safe reconciliation during upgrades.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single entry in the managed-asset manifest. */
export interface ManifestEntry {
	/** Path relative to the control-plane root. */
	relativePath: string;
	/** Logical owner string (e.g., 'template', 'prompt-template', 'harness:opencode:skill'). */
	owner: string;
	/** SHA-256 hex digest of the file content at last write. */
	contentHash: string;
	/** CLI version that last wrote the entry. */
	cliVersion: string;
}

/** The managed-asset manifest structure. */
export interface Manifest {
	version: 1;
	entries: ManifestEntry[];
}

/** Classification of asset actions during reconciliation. */
export type AssetAction =
	| "create"
	| "update"
	| "skip"
	| "remove"
	| "conflict"
	| "stale-modified";

/** A single planned action for a managed asset. */
export interface AssetPlan {
	relativePath: string;
	owner: string;
	action: AssetAction;
	detail?: string;
}

/** Desired state of a managed asset. */
export interface DesiredAsset {
	relativePath: string;
	owner: string;
	content: string;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of content.
 */
export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Compute SHA-256 hex digest of a file.
 * Returns null if the file does not exist.
 */
export function hashFile(absolutePath: string): string | null {
	if (!existsSync(absolutePath)) return null;
	const content = readFileSync(absolutePath, "utf-8");
	return hashContent(content);
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

const MANIFEST_VERSION = 1;

/**
 * Read the manifest from disk.
 * Returns null if the file does not exist or is malformed.
 */
export function readManifest(manifestPath: string): Manifest | null {
	if (!existsSync(manifestPath)) return null;
	try {
		const content = readFileSync(manifestPath, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"version" in parsed &&
			(parsed as Manifest).version === MANIFEST_VERSION &&
			"entries" in parsed &&
			Array.isArray((parsed as Manifest).entries)
		) {
			return parsed as Manifest;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Write the manifest atomically.
 * Creates parent directories if needed.
 */
export function writeManifest(manifestPath: string, manifest: Manifest): void {
	const dir = dirname(manifestPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tmpPath = `${manifestPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
	renameSync(tmpPath, manifestPath);
}

// ---------------------------------------------------------------------------
// Reconciliation Logic
// ---------------------------------------------------------------------------

/**
 * Reconcile desired assets against the manifest and current disk state.
 *
 * Returns a plan of actions to bring the on-disk state in line with the
 * desired state, respecting user modifications.
 *
 * The diskHashFn is a function that takes a relative path and returns the
 * current content hash of that file on disk (or null if not present).
 * This allows the reconciler to work with any path resolution strategy.
 */
export function reconcileAssets(
	desired: DesiredAsset[],
	manifest: Manifest | null,
	diskHashFn: (relativePath: string) => string | null,
	_cliVersion: string,
): AssetPlan[] {
	const plans: AssetPlan[] = [];
	const manifestEntries = manifest?.entries ?? [];
	const desiredPaths = new Set(desired.map((d) => d.relativePath));

	// Build lookup map for manifest entries
	const manifestByPath = new Map<string, ManifestEntry>();
	for (const entry of manifestEntries) {
		manifestByPath.set(entry.relativePath, entry);
	}

	// Process each desired asset
	for (const asset of desired) {
		const relativePath = asset.relativePath;
		const desiredHash = hashContent(asset.content);
		const diskHash = diskHashFn(relativePath);
		const entry = manifestByPath.get(relativePath);

		if (!entry) {
			// Bootstrap case: no manifest entry
			if (diskHash === null) {
				// File doesn't exist → create
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "create",
				});
			} else if (diskHash === desiredHash) {
				// On-disk matches bundled content → skip, will adopt after apply
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "skip",
					detail:
						"File matches bundled content (will be adopted into manifest)",
				});
			} else {
				// On-disk differs from bundled → conflict
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "conflict",
					detail: "File has been customized (differs from bundled content)",
				});
			}
		} else {
			// Have manifest entry
			if (diskHash === null) {
				// File was deleted → re-create
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "create",
					detail: "File was deleted (will be re-created)",
				});
			} else if (diskHash !== entry.contentHash) {
				// User modified the file → conflict
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "conflict",
					detail: "File has been modified since last upgrade",
				});
			} else if (desiredHash === diskHash) {
				// Content unchanged → skip
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "skip",
					detail: "Content unchanged",
				});
			} else {
				// Safe to update (manifest hash matches disk)
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "update",
				});
			}
		}
	}

	// Check for stale entries (in manifest but not in desired)
	for (const entry of manifestEntries) {
		if (desiredPaths.has(entry.relativePath)) continue;

		const diskHash = diskHashFn(entry.relativePath);

		if (diskHash === null) {
		} else if (diskHash === entry.contentHash) {
			// Stale and unmodified → remove
			plans.push({
				relativePath: entry.relativePath,
				owner: entry.owner,
				action: "remove",
				detail: "Asset removed from bundled set (unmodified)",
			});
		} else {
			// Stale but user modified → preserve
			plans.push({
				relativePath: entry.relativePath,
				owner: entry.owner,
				action: "stale-modified",
				detail: "Asset removed from bundled set but has user modifications",
			});
		}
	}

	return plans;
}

/**
 * Build the updated manifest after applying a plan.
 *
 * This produces the new manifest state based on the executed plan.
 * Files that were created, updated, or skipped (bootstrap adoption) get
 * new entries with the desired content hash.
 * Files that were removed or had conflicts/stale-modified are omitted.
 */
export function buildUpdatedManifest(
	desired: DesiredAsset[],
	plans: AssetPlan[],
	cliVersion: string,
): Manifest {
	const planByPath = new Map<string, AssetPlan>();
	for (const plan of plans) {
		planByPath.set(plan.relativePath, plan);
	}

	const desiredByPath = new Map<string, DesiredAsset>();
	for (const asset of desired) {
		desiredByPath.set(asset.relativePath, asset);
	}

	const entries: ManifestEntry[] = [];

	for (const plan of plans) {
		// Only include entries for files that should be in the manifest
		if (plan.action === "remove") continue;
		if (plan.action === "stale-modified") {
			// Keep the stale modified entry in the manifest so we don't lose track
			// This is a bit tricky - we need the old entry's hash
			// For now, we skip adding stale-modified to the new manifest
			// The old manifest entry will be lost, which is acceptable
			// because the file stays on disk and will be flagged as conflict
			// if it ever reappears in desired
			continue;
		}

		const asset = desiredByPath.get(plan.relativePath);
		if (!asset) {
			// This is a stale entry that we're preserving info for
			continue;
		}

		entries.push({
			relativePath: plan.relativePath,
			owner: plan.owner,
			contentHash: hashContent(asset.content),
			cliVersion,
		});
	}

	return { version: 1, entries };
}

/**
 * Filter plans to get only those that would write to disk.
 */
export function getWritePlans(plans: AssetPlan[]): AssetPlan[] {
	return plans.filter(
		(p) =>
			p.action === "create" || p.action === "update" || p.action === "remove",
	);
}

/**
 * Count plans by action type.
 */
export function countPlansByAction(
	plans: AssetPlan[],
): Record<AssetAction, number> {
	const counts: Record<AssetAction, number> = {
		create: 0,
		update: 0,
		skip: 0,
		remove: 0,
		conflict: 0,
		"stale-modified": 0,
	};
	for (const plan of plans) {
		counts[plan.action]++;
	}
	return counts;
}
