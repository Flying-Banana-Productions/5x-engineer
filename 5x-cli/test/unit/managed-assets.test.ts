/**
 * Unit tests for managed-assets module.
 *
 * Covers manifest read/write, hashing, and all reconciliation branches.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssetPlan,
	buildUpdatedManifest,
	countPlansByAction,
	type DesiredAsset,
	hashContent,
	hashFile,
	type Manifest,
	readManifest,
	reconcileAssets,
	writeManifest,
} from "../../src/managed-assets.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-managed-assets-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

describe("hashContent", () => {
	test("produces deterministic SHA-256 hex digest", () => {
		const content = "test content";
		const hash1 = hashContent(content);
		const hash2 = hashContent(content);
		expect(hash1).toBe(hash2);
		expect(hash1).toMatch(/^[a-f0-9]{64}$/);
	});

	test("produces different hashes for different content", () => {
		const hash1 = hashContent("content A");
		const hash2 = hashContent("content B");
		expect(hash1).not.toBe(hash2);
	});
});

describe("hashFile", () => {
	test("returns null for non-existent file", () => {
		const tmp = makeTmpDir();
		try {
			const hash = hashFile(join(tmp, "nonexistent.txt"));
			expect(hash).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("returns correct hash for existing file", () => {
		const tmp = makeTmpDir();
		try {
			const content = "file content";
			const filePath = join(tmp, "test.txt");
			writeFileSync(filePath, content, "utf-8");
			const hash = hashFile(filePath);
			expect(hash).toBe(hashContent(content));
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

describe("readManifest / writeManifest", () => {
	test("round-trip manifest read/write", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "manifest.json");
			const manifest: Manifest = {
				version: 1,
				entries: [
					{
						relativePath: "templates/test.md",
						owner: "template",
						contentHash: "abc123",
						cliVersion: "1.0.0",
					},
				],
			};

			writeManifest(manifestPath, manifest);
			const read = readManifest(manifestPath);

			expect(read).toEqual(manifest);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("readManifest returns null for non-existent file", () => {
		const tmp = makeTmpDir();
		try {
			const manifest = readManifest(join(tmp, "nonexistent.json"));
			expect(manifest).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("readManifest returns null for malformed JSON", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "manifest.json");
			writeFileSync(manifestPath, "not valid json", "utf-8");
			const read = readManifest(manifestPath);
			expect(read).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("readManifest returns null for wrong version", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "manifest.json");
			writeFileSync(
				manifestPath,
				JSON.stringify({ version: 2, entries: [] }),
				"utf-8",
			);
			const read = readManifest(manifestPath);
			expect(read).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("writeManifest creates parent directories", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "nested", "deep", "manifest.json");
			const manifest: Manifest = { version: 1, entries: [] };

			writeManifest(manifestPath, manifest);

			expect(existsSync(manifestPath)).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe("reconcileAssets", () => {
	test("create: desired not on disk and not in manifest", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "new.txt", owner: "template", content: "new content" },
		];
		const diskHashes: Record<string, string | null> = { "new.txt": null };
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, null, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("create");
		expect(plans[0]?.relativePath).toBe("new.txt");
	});

	test("create: desired not on disk but in manifest (was deleted)", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "deleted.txt", owner: "template", content: "content" },
		];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "deleted.txt",
					owner: "template",
					contentHash: hashContent("old content"),
					cliVersion: "0.9.0",
				},
			],
		};
		const diskHashes: Record<string, string | null> = { "deleted.txt": null };
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, manifest, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("create");
		expect(plans[0]?.detail).toContain("re-create");
	});

	test("update: desired on disk, in manifest, disk hash = manifest hash", () => {
		const content = "new bundled content";
		const oldContent = "old content";
		const desired: DesiredAsset[] = [
			{ relativePath: "update.txt", owner: "template", content },
		];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "update.txt",
					owner: "template",
					contentHash: hashContent(oldContent),
					cliVersion: "0.9.0",
				},
			],
		};
		const diskHashes: Record<string, string | null> = {
			"update.txt": hashContent(oldContent),
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, manifest, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("update");
	});

	test("skip: desired on disk, in manifest, new content equals disk hash", () => {
		const content = "same content";
		const desired: DesiredAsset[] = [
			{ relativePath: "skip.txt", owner: "template", content },
		];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "skip.txt",
					owner: "template",
					contentHash: hashContent(content),
					cliVersion: "0.9.0",
				},
			],
		};
		const diskHashes: Record<string, string | null> = {
			"skip.txt": hashContent(content),
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, manifest, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("skip");
	});

	test("conflict: desired on disk, in manifest, disk hash ≠ manifest hash", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "conflict.txt", owner: "template", content: "bundled" },
		];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "conflict.txt",
					owner: "template",
					contentHash: hashContent("original"),
					cliVersion: "0.9.0",
				},
			],
		};
		const diskHashes: Record<string, string | null> = {
			"conflict.txt": hashContent("user modified"),
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, manifest, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("conflict");
	});

	test("bootstrap skip: file on disk matches bundled content exactly", () => {
		const content = "bundled content";
		const desired: DesiredAsset[] = [
			{ relativePath: "bootstrap.txt", owner: "template", content },
		];
		const diskHashes: Record<string, string | null> = {
			"bootstrap.txt": hashContent(content),
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, null, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("skip");
		expect(plans[0]?.detail).toContain("adopt");
	});

	test("bootstrap conflict: file on disk differs from bundled content", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "custom.txt", owner: "template", content: "bundled" },
		];
		const diskHashes: Record<string, string | null> = {
			"custom.txt": hashContent("user customized"),
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, null, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("conflict");
		expect(plans[0]?.detail).toContain("customized");
	});

	test("remove: manifest entry with no desired, disk hash = manifest hash", () => {
		const content = "stale content";
		const desired: DesiredAsset[] = [];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "stale.txt",
					owner: "template",
					contentHash: hashContent(content),
					cliVersion: "0.9.0",
				},
			],
		};
		const diskHashes: Record<string, string | null> = {
			"stale.txt": hashContent(content),
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, manifest, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("remove");
	});

	test("stale-modified: manifest entry with no desired, disk hash ≠ manifest hash", () => {
		const desired: DesiredAsset[] = [];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "stale-mod.txt",
					owner: "template",
					contentHash: hashContent("original"),
					cliVersion: "0.9.0",
				},
			],
		};
		const diskHashes: Record<string, string | null> = {
			"stale-mod.txt": hashContent("user modified stale"),
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, manifest, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("stale-modified");
	});

	test("silent drop: manifest entry with no desired, file missing from disk", () => {
		const desired: DesiredAsset[] = [];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "gone.txt",
					owner: "template",
					contentHash: hashContent("content"),
					cliVersion: "0.9.0",
				},
			],
		};
		const diskHashes: Record<string, string | null> = { "gone.txt": null };
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, manifest, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(0);
	});

	test("bootstrap with empty manifest and mixed files", () => {
		const bundledA = "bundled A";
		const bundledB = "bundled B";
		const desired: DesiredAsset[] = [
			{ relativePath: "a.txt", owner: "template", content: bundledA },
			{ relativePath: "b.txt", owner: "template", content: bundledB },
			{ relativePath: "c.txt", owner: "template", content: "new" },
		];
		const diskHashes: Record<string, string | null> = {
			"a.txt": hashContent(bundledA), // matches - adopt
			"b.txt": hashContent("custom"), // differs - conflict
			"c.txt": null, // doesn't exist - create
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, null, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(3);
		const planA = plans.find((p) => p.relativePath === "a.txt");
		const planB = plans.find((p) => p.relativePath === "b.txt");
		const planC = plans.find((p) => p.relativePath === "c.txt");
		expect(planA?.action).toBe("skip");
		expect(planB?.action).toBe("conflict");
		expect(planC?.action).toBe("create");
	});

	test("full stale cleanup with empty desired", () => {
		const content1 = "stale 1";
		const _content2 = "stale 2";
		const desired: DesiredAsset[] = [];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "stale1.txt",
					owner: "template",
					contentHash: hashContent(content1),
					cliVersion: "0.9.0",
				},
				{
					relativePath: "stale2.txt",
					owner: "template",
					contentHash: hashContent("original"),
					cliVersion: "0.9.0",
				},
			],
		};
		const diskHashes: Record<string, string | null> = {
			"stale1.txt": hashContent(content1), // unmodified - remove
			"stale2.txt": hashContent("modified"), // modified - stale-modified
		};
		const diskHashFn = (p: string) => diskHashes[p] ?? null;

		const plans = reconcileAssets(desired, manifest, diskHashFn, "1.0.0");

		expect(plans).toHaveLength(2);
		const planStale1 = plans.find((p) => p.relativePath === "stale1.txt");
		const planStale2 = plans.find((p) => p.relativePath === "stale2.txt");
		expect(planStale1?.action).toBe("remove");
		expect(planStale2?.action).toBe("stale-modified");
	});
});

// ---------------------------------------------------------------------------
// buildUpdatedManifest
// ---------------------------------------------------------------------------

describe("buildUpdatedManifest", () => {
	test("includes entries for create, update, and skip actions", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "create.txt", owner: "template", content: "new" },
			{ relativePath: "update.txt", owner: "template", content: "updated" },
			{ relativePath: "skip.txt", owner: "template", content: "same" },
		];
		const plans: AssetPlan[] = [
			{ relativePath: "create.txt", owner: "template", action: "create" },
			{ relativePath: "update.txt", owner: "template", action: "update" },
			{ relativePath: "skip.txt", owner: "template", action: "skip" },
		];

		const manifest = buildUpdatedManifest(desired, plans, "1.0.0");

		expect(manifest.entries).toHaveLength(3);
		expect(manifest.entries.map((e) => e.relativePath).sort()).toEqual([
			"create.txt",
			"skip.txt",
			"update.txt",
		]);
	});

	test("excludes remove and stale-modified actions", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "keep.txt", owner: "template", content: "keep" },
		];
		const plans: AssetPlan[] = [
			{ relativePath: "keep.txt", owner: "template", action: "skip" },
			{ relativePath: "remove.txt", owner: "template", action: "remove" },
			{
				relativePath: "stale.txt",
				owner: "template",
				action: "stale-modified",
			},
		];

		const manifest = buildUpdatedManifest(desired, plans, "1.0.0");

		expect(manifest.entries).toHaveLength(1);
		expect(manifest.entries[0]?.relativePath).toBe("keep.txt");
	});

	test("sets correct content hashes and cli version", () => {
		const content = "test content";
		const desired: DesiredAsset[] = [
			{ relativePath: "test.txt", owner: "template", content },
		];
		const plans: AssetPlan[] = [
			{ relativePath: "test.txt", owner: "template", action: "create" },
		];

		const manifest = buildUpdatedManifest(desired, plans, "2.0.0");

		expect(manifest.entries[0]?.contentHash).toBe(hashContent(content));
		expect(manifest.entries[0]?.cliVersion).toBe("2.0.0");
	});
});

// ---------------------------------------------------------------------------
// countPlansByAction
// ---------------------------------------------------------------------------

describe("countPlansByAction", () => {
	test("counts all action types correctly", () => {
		const plans: AssetPlan[] = [
			{ relativePath: "a", owner: "t", action: "create" },
			{ relativePath: "b", owner: "t", action: "create" },
			{ relativePath: "c", owner: "t", action: "update" },
			{ relativePath: "d", owner: "t", action: "skip" },
			{ relativePath: "e", owner: "t", action: "remove" },
			{ relativePath: "f", owner: "t", action: "conflict" },
			{ relativePath: "g", owner: "t", action: "stale-modified" },
		];

		const counts = countPlansByAction(plans);

		expect(counts.create).toBe(2);
		expect(counts.update).toBe(1);
		expect(counts.skip).toBe(1);
		expect(counts.remove).toBe(1);
		expect(counts.conflict).toBe(1);
		expect(counts["stale-modified"]).toBe(1);
	});
});
