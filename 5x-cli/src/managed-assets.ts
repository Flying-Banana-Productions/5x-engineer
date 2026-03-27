/**
 * Managed asset manifest — tracks project-scope managed files with content
 * hashes for safe upgrade reconciliation.
 *
 * The manifest enables:
 * - Safe auto-update: files matching recorded hash can be overwritten
 * - Conflict detection: files with modified hashes are reported
 * - Stale cleanup: removed bundled files can be cleaned up if unmodified
 * - Bootstrap adoption: existing files matching bundled content are adopted
 *
 * @module managed-assets
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync as fsMkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Single manifest entry for a managed file.
 */
export interface ManifestEntry {
	/** Path relative to the control-plane root (e.g., ".5x/templates/review-template.md"). */
	relativePath: string;
	/** Logical owner (e.g., "template", "prompt-template", "harness:opencode:skill"). */
	owner: string;
	/** SHA-256 hex digest of the file content at last write. */
	contentHash: string;
	/** CLI version that last wrote the entry. */
	cliVersion: string;
}

/**
 * Manifest file format — versioned for future migrations.
 */
export interface Manifest {
	/** Manifest format version. */
	version: 1;
	/** Managed file entries. */
	entries: ManifestEntry[];
}

/**
 * Action classification for a managed asset during reconciliation.
 */
export type AssetAction =
	| "create" // Write new file (not on disk, not in manifest)
	| "update" // Overwrite existing file (disk hash matches manifest)
	| "skip" // No change needed (disk matches desired content)
	| "remove" // Delete stale file (not in desired, disk matches manifest)
	| "conflict" // User-modified file (disk hash differs from manifest)
	| "stale-modified"; // Stale file that was user-modified (keep and report)

/**
 * Planned action for a single managed asset.
 */
export interface AssetPlan {
	/** Path relative to the control-plane root. */
	relativePath: string;
	/** Logical owner. */
	owner: string;
	/** Action to take. */
	action: AssetAction;
	/** Optional detail string for logging (e.g., conflict reason). */
	detail?: string;
}

/**
 * Desired asset from a plugin or template source.
 */
export interface DesiredAsset {
	/** Path relative to the control-plane root. */
	relativePath: string;
	/** Content to write. */
	content: string;
	/** Logical owner. */
	owner: string;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of content.
 * @param content — string content to hash
 * @returns 64-character hex hash
 */
export function hashContent(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Compute SHA-256 hex digest of a file.
 * @param absolutePath — absolute path to the file
 * @returns 64-character hex hash, or null if file does not exist
 */
export function hashFile(absolutePath: string): string | null {
	try {
		const content = readFileSync(absolutePath, "utf-8");
		return hashContent(content);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse the manifest file.
 * @param manifestPath — absolute path to the manifest file
 * @returns Parsed manifest, or null if file does not exist or is malformed
 */
export function readManifest(manifestPath: string): Manifest | null {
	try {
		const content = readFileSync(manifestPath, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		if (!isValidManifest(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Type guard for manifest validation.
 */
function isValidManifest(obj: unknown): obj is Manifest {
	if (typeof obj !== "object" || obj === null) return false;
	const m = obj as Record<string, unknown>;
	if (m.version !== 1) return false;
	if (!Array.isArray(m.entries)) return false;
	for (const entry of m.entries) {
		if (typeof entry !== "object" || entry === null) return false;
		const e = entry as Record<string, unknown>;
		if (typeof e.relativePath !== "string") return false;
		if (typeof e.owner !== "string") return false;
		if (typeof e.contentHash !== "string") return false;
		if (typeof e.cliVersion !== "string") return false;
	}
	return true;
}

/**
 * Atomically write the manifest file.
 * Creates parent directories if needed.
 * @param manifestPath — absolute path to the manifest file
 * @param manifest — manifest to write
 */
export function writeManifest(manifestPath: string, manifest: Manifest): void {
	const dir = dirname(manifestPath);
	if (!existsSync(dir)) {
		fsMkdirSync(dir, { recursive: true });
	}
	const tmpPath = `${manifestPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
	renameSync(tmpPath, manifestPath);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Build a lookup for manifest entries by relativePath.
 */
function buildManifestLookup(
	manifest: Manifest | null,
): Map<string, ManifestEntry> {
	const lookup = new Map<string, ManifestEntry>();
	if (!manifest) return lookup;
	for (const entry of manifest.entries) {
		lookup.set(entry.relativePath, entry);
	}
	return lookup;
}

/**
 * Build a lookup for desired assets by relativePath.
 */
function buildDesiredLookup(
	desired: DesiredAsset[],
): Map<string, DesiredAsset> {
	const lookup = new Map<string, DesiredAsset>();
	for (const asset of desired) {
		lookup.set(asset.relativePath, asset);
	}
	return lookup;
}

/**
 * Core reconciliation logic.
 *
 * Compares desired assets against the current manifest and on-disk state,
 * producing a plan of classified actions.
 *
 * Rules:
 * - Desired asset not on disk and not in manifest → `create`
 * - Desired asset not on disk but in manifest → `create` (was deleted, re-create)
 * - Desired asset on disk, in manifest, disk hash = manifest hash → `update`
 *   (unless new content hash equals disk hash → `skip`)
 * - Desired asset on disk, in manifest, disk hash ≠ manifest hash → `conflict`
 * - Desired asset on disk, NOT in manifest (bootstrap), disk hash = desired content hash →
 *   `skip` (adopt after apply with bundled hash as baseline)
 * - Desired asset on disk, NOT in manifest (bootstrap), disk hash ≠ desired content hash →
 *   `conflict` (do NOT adopt; report conflict immediately)
 * - Manifest entry with no matching desired asset, disk hash = manifest hash → `remove`
 *   (stale, unmodified)
 * - Manifest entry with no matching desired asset, disk hash ≠ manifest hash → `stale-modified`
 *   (stale but user-edited; keep and report)
 * - Manifest entry with no matching desired asset, file missing from disk → silently drop
 *
 * @param desired — list of assets that should exist
 * @param manifest — current manifest (null on first run)
 * @param diskHashFn — function that returns the hash of a file on disk (or null if missing)
 * @returns array of asset plans describing what to do
 */
export function reconcileAssets(
	desired: DesiredAsset[],
	manifest: Manifest | null,
	diskHashFn: (relativePath: string) => string | null,
): AssetPlan[] {
	const plans: AssetPlan[] = [];
	const manifestLookup = buildManifestLookup(manifest);
	const desiredLookup = buildDesiredLookup(desired);

	// Process all desired assets
	for (const asset of desired) {
		const relativePath = asset.relativePath;
		const manifestEntry = manifestLookup.get(relativePath);
		const diskHash = diskHashFn(relativePath);
		const desiredHash = hashContent(asset.content);

		if (!manifestEntry) {
			// Bootstrap case: file not tracked in manifest yet
			if (diskHash === null) {
				// File doesn't exist on disk → create
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "create",
				});
			} else if (diskHash === desiredHash) {
				// File exists and matches bundled content → skip (will be adopted after apply)
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "skip",
					detail: "matches bundled content — will be adopted",
				});
			} else {
				// File exists but has been customized → conflict (do NOT adopt)
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "conflict",
					detail:
						"file exists but has been customized — will not be adopted into manifest",
				});
			}
		} else {
			// File is tracked in manifest
			if (diskHash === null) {
				// File was deleted from disk → re-create
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "create",
					detail: "was deleted from disk — re-creating",
				});
			} else if (diskHash === manifestEntry.contentHash) {
				// File on disk matches manifest (unmodified)
				if (desiredHash === diskHash) {
					// No change needed
					plans.push({
						relativePath,
						owner: asset.owner,
						action: "skip",
						detail: "content unchanged",
					});
				} else {
					// Safe to update (unmodified)
					plans.push({
						relativePath,
						owner: asset.owner,
						action: "update",
						detail: "safe to update (unmodified)",
					});
				}
			} else {
				// File was modified by user
				plans.push({
					relativePath,
					owner: asset.owner,
					action: "conflict",
					detail: "user-modified — skipping (use --force to overwrite)",
				});
			}
		}
	}

	// Process manifest entries that have no matching desired asset (stale files)
	if (manifest) {
		for (const entry of manifest.entries) {
			if (desiredLookup.has(entry.relativePath)) continue;

			const diskHash = diskHashFn(entry.relativePath);

			if (diskHash === null) {
				// File already gone — will be dropped from manifest silently
				continue;
			}

			if (diskHash === entry.contentHash) {
				// Stale and unmodified — safe to remove
				plans.push({
					relativePath: entry.relativePath,
					owner: entry.owner,
					action: "remove",
					detail: "stale bundled file — unmodified, removing",
				});
			} else {
				// Stale but was modified by user
				plans.push({
					relativePath: entry.relativePath,
					owner: entry.owner,
					action: "stale-modified",
					detail:
						"stale bundled file — was modified, preserving (use --force to remove)",
				});
			}
		}
	}

	return plans;
}

// ---------------------------------------------------------------------------
// Manifest Update (after apply)
// ---------------------------------------------------------------------------

/**
 * Build an updated manifest after applying a plan.
 *
 * - Includes entries for all successfully applied assets (create, update)
 * - Includes entries for skipped assets that were already in manifest (preserve)
 * - Includes entries for bootstrap-adopted assets (files that matched bundled content)
 * - Excludes removed assets
 * - Excludes entries for files that no longer exist on disk
 *
 * @param desired — desired assets with their content
 * @param plans — the plan that was applied
 * @param manifest — previous manifest (null for first run)
 * @param diskHashFn — function to get current disk hash
 * @param cliVersion — current CLI version string
 * @returns updated manifest
 */
export function buildUpdatedManifest(
	desired: DesiredAsset[],
	plans: AssetPlan[],
	manifest: Manifest | null,
	diskHashFn: (relativePath: string) => string | null,
	cliVersion: string,
): Manifest {
	const planLookup = new Map<string, AssetPlan>();
	for (const plan of plans) {
		planLookup.set(plan.relativePath, plan);
	}

	const desiredLookup = buildDesiredLookup(desired);
	const oldManifestLookup = buildManifestLookup(manifest);

	const entries: ManifestEntry[] = [];

	// Process all desired assets
	for (const asset of desired) {
		const relativePath = asset.relativePath;
		const plan = planLookup.get(relativePath);
		const oldEntry = oldManifestLookup.get(relativePath);

		if (!plan) {
			// No plan for this asset — preserve old entry if exists
			if (oldEntry && diskHashFn(relativePath) !== null) {
				entries.push(oldEntry);
			}
			continue;
		}

		switch (plan.action) {
			case "create":
			case "update": {
				// Successfully applied — record new hash
				const diskHash = diskHashFn(relativePath);
				if (diskHash !== null) {
					entries.push({
						relativePath,
						owner: asset.owner,
						contentHash: diskHash,
						cliVersion,
					});
				}
				break;
			}
			case "skip": {
				// Check if this was a bootstrap adoption
				const diskHash = diskHashFn(relativePath);
				if (diskHash !== null) {
					if (oldEntry) {
						// Was already in manifest — preserve
						entries.push(oldEntry);
					} else {
						// Bootstrap adoption — add to manifest with bundled hash as baseline
						entries.push({
							relativePath,
							owner: asset.owner,
							contentHash: diskHash,
							cliVersion,
						});
					}
				}
				break;
			}
			case "conflict":
			case "stale-modified":
			case "remove": {
				// Don't include in manifest
				break;
			}
		}
	}

	// Process manifest entries not in desired (preserve those we didn't touch)
	if (manifest) {
		for (const entry of manifest.entries) {
			if (desiredLookup.has(entry.relativePath)) continue;

			const plan = planLookup.get(entry.relativePath);
			if (plan?.action === "remove" || plan?.action === "stale-modified") {
				// These were explicitly handled — don't preserve
				continue;
			}

			// Check if file still exists
			if (diskHashFn(entry.relativePath) !== null) {
				entries.push(entry);
			}
			// Otherwise silently dropped (already gone)
		}
	}

	return { version: 1, entries };
}
