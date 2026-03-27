/**
 * Unit tests for managed-assets module — manifest read/write, hashing, and
 * reconciliation logic including bootstrap adoption vs conflict.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssetAction,
	buildUpdatedManifest,
	type DesiredAsset,
	hashContent,
	hashFile,
	type Manifest,
	readManifest,
	reconcileAssets,
	writeManifest,
} from "../../src/managed-assets.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
// Hashing tests
// ---------------------------------------------------------------------------

describe("hashContent", () => {
	test("returns consistent SHA-256 hex digest", () => {
		const content = "Hello, World!";
		const hash1 = hashContent(content);
		const hash2 = hashContent(content);
		expect(hash1).toBe(hash2);
		expect(hash1).toHaveLength(64);
		expect(hash1).toMatch(/^[a-f0-9]+$/);
	});

	test("different content produces different hashes", () => {
		const hash1 = hashContent("content A");
		const hash2 = hashContent("content B");
		expect(hash1).not.toBe(hash2);
	});

	test("empty string produces valid hash", () => {
		const hash = hashContent("");
		expect(hash).toHaveLength(64);
	});
});

describe("hashFile", () => {
	test("returns hash of existing file", () => {
		const tmp = makeTmpDir();
		try {
			const filePath = join(tmp, "test.txt");
			const content = "test content";
			writeFileSync(filePath, content, "utf-8");

			const hash = hashFile(filePath);
			expect(hash).toBe(hashContent(content));
		} finally {
			cleanupDir(tmp);
		}
	});

	test("returns null for non-existent file", () => {
		const tmp = makeTmpDir();
		try {
			const hash = hashFile(join(tmp, "nonexistent.txt"));
			expect(hash).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// Manifest I/O tests
// ---------------------------------------------------------------------------

describe("readManifest", () => {
	test("reads and parses valid manifest", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "manifest.json");
			const manifest: Manifest = {
				version: 1,
				entries: [
					{
						relativePath: ".5x/templates/test.md",
						owner: "template",
						contentHash: "abc123",
						cliVersion: "1.0.0",
					},
				],
			};
			writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

			const result = readManifest(manifestPath);
			expect(result).toEqual(manifest);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("returns null for non-existent file", () => {
		const tmp = makeTmpDir();
		try {
			const result = readManifest(join(tmp, "nonexistent.json"));
			expect(result).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("returns null for malformed JSON", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "manifest.json");
			writeFileSync(manifestPath, "not valid json", "utf-8");

			const result = readManifest(manifestPath);
			expect(result).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("returns null for invalid manifest version", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "manifest.json");
			writeFileSync(
				manifestPath,
				JSON.stringify({ version: 2, entries: [] }),
				"utf-8",
			);

			const result = readManifest(manifestPath);
			expect(result).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("returns null for missing required fields", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "manifest.json");
			writeFileSync(
				manifestPath,
				JSON.stringify({
					version: 1,
					entries: [{ relativePath: "test.md", owner: "template" }],
				}),
				"utf-8",
			);

			const result = readManifest(manifestPath);
			expect(result).toBeNull();
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("writeManifest", () => {
	test("writes manifest atomically", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "subdir", "manifest.json");
			const manifest: Manifest = {
				version: 1,
				entries: [
					{
						relativePath: "test.md",
						owner: "template",
						contentHash: "abc123",
						cliVersion: "1.0.0",
					},
				],
			};

			writeManifest(manifestPath, manifest);

			expect(existsSync(manifestPath)).toBe(true);
			const content = readFileSync(manifestPath, "utf-8");
			expect(JSON.parse(content)).toEqual(manifest);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("creates parent directories", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "a", "b", "c", "manifest.json");
			const manifest: Manifest = { version: 1, entries: [] };

			writeManifest(manifestPath, manifest);

			expect(existsSync(manifestPath)).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("round-trip read/write", () => {
		const tmp = makeTmpDir();
		try {
			const manifestPath = join(tmp, "manifest.json");
			const manifest: Manifest = {
				version: 1,
				entries: [
					{
						relativePath: "a.md",
						owner: "template",
						contentHash: "hash-a",
						cliVersion: "1.0.0",
					},
					{
						relativePath: "b.md",
						owner: "prompt-template",
						contentHash: "hash-b",
						cliVersion: "1.1.0",
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
});

// ---------------------------------------------------------------------------
// Reconciliation tests
// ---------------------------------------------------------------------------

describe("reconcileAssets", () => {
	const sampleContent = "sample content";
	const sampleHash = hashContent(sampleContent);
	const modifiedContent = "modified content";
	const modifiedHash = hashContent(modifiedContent);

	test("desired asset not on disk and not in manifest → create", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: sampleContent, owner: "template" },
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", null);

		const plans = reconcileAssets(
			desired,
			null,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "test.md",
			owner: "template",
			action: "create",
		});
	});

	test("desired asset not on disk but in manifest → create (re-create)", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: sampleContent, owner: "template" },
		];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "test.md",
					owner: "template",
					contentHash: sampleHash,
					cliVersion: "1.0.0",
				},
			],
		};
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", null); // File was deleted

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "test.md",
			action: "create",
			detail: expect.stringContaining("re-creating"),
		});
	});

	test("desired asset on disk, in manifest, disk hash = manifest hash, new content differs → update", () => {
		const newContent = "new bundled content";
		const _newHash = hashContent(newContent);
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: newContent, owner: "template" },
		];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "test.md",
					owner: "template",
					contentHash: sampleHash, // Old hash in manifest
					cliVersion: "1.0.0",
				},
			],
		};
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", sampleHash); // Disk still has old content

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "test.md",
			action: "update",
			detail: expect.stringContaining("safe to update"),
		});
	});

	test("desired asset on disk, in manifest, disk hash = manifest hash, new content same → skip", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: sampleContent, owner: "template" },
		];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "test.md",
					owner: "template",
					contentHash: sampleHash,
					cliVersion: "1.0.0",
				},
			],
		};
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", sampleHash);

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "test.md",
			action: "skip",
			detail: expect.stringContaining("content unchanged"),
		});
	});

	test("desired asset on disk, in manifest, disk hash ≠ manifest hash → conflict", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: sampleContent, owner: "template" },
		];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "test.md",
					owner: "template",
					contentHash: sampleHash,
					cliVersion: "1.0.0",
				},
			],
		};
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", modifiedHash); // User modified the file

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "test.md",
			action: "conflict",
			detail: expect.stringContaining("user-modified"),
		});
	});

	test("bootstrap: desired asset on disk, NOT in manifest, disk hash = desired content hash → skip (adopt)", () => {
		// File exists and matches exactly what we would write (bootstrap adoption)
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: sampleContent, owner: "template" },
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", sampleHash); // Matches bundled content

		const plans = reconcileAssets(
			desired,
			null,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "test.md",
			action: "skip",
			detail: expect.stringContaining("matches bundled content"),
		});
	});

	test("bootstrap: desired asset on disk, NOT in manifest, disk hash ≠ desired content hash → conflict", () => {
		// File exists but has been customized by user — should NOT be adopted
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: sampleContent, owner: "template" },
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", modifiedHash); // Different from bundled

		const plans = reconcileAssets(
			desired,
			null,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "test.md",
			action: "conflict",
			detail: expect.stringContaining("customized"),
		});
	});

	test("manifest entry with no desired asset, disk hash = manifest hash → remove", () => {
		const desired: DesiredAsset[] = []; // Nothing desired
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "stale.md",
					owner: "template",
					contentHash: sampleHash,
					cliVersion: "1.0.0",
				},
			],
		};
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("stale.md", sampleHash); // Unmodified stale file

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "stale.md",
			action: "remove",
			detail: expect.stringContaining("stale bundled file"),
		});
	});

	test("manifest entry with no desired asset, disk hash ≠ manifest hash → stale-modified", () => {
		const desired: DesiredAsset[] = [];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "stale.md",
					owner: "template",
					contentHash: sampleHash,
					cliVersion: "1.0.0",
				},
			],
		};
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("stale.md", modifiedHash); // User modified the stale file

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			relativePath: "stale.md",
			action: "stale-modified",
			detail: expect.stringContaining("was modified"),
		});
	});

	test("manifest entry with no desired asset, file missing from disk → silently dropped", () => {
		const desired: DesiredAsset[] = [];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "gone.md",
					owner: "template",
					contentHash: sampleHash,
					cliVersion: "1.0.0",
				},
			],
		};
		const diskHashes = new Map<string, string | null>();
		// No entry for "gone.md" — file is missing

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(0);
	});

	test("empty manifest (bootstrap case) with multiple assets", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "a.md", content: "content A", owner: "template" },
			{ relativePath: "b.md", content: "content B", owner: "template" },
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("a.md", hashContent("content A")); // Matches
		diskHashes.set("b.md", hashContent("modified B")); // Diverges

		const plans = reconcileAssets(
			desired,
			null,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(2);
		const planA = plans.find((p) => p.relativePath === "a.md");
		const planB = plans.find((p) => p.relativePath === "b.md");
		expect(planA?.action).toBe("skip");
		expect(planB?.action).toBe("conflict");
	});

	test("empty desired set (full stale cleanup)", () => {
		const desired: DesiredAsset[] = [];
		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "stale1.md",
					owner: "template",
					contentHash: sampleHash,
					cliVersion: "1.0.0",
				},
				{
					relativePath: "stale2.md",
					owner: "template",
					contentHash: sampleHash,
					cliVersion: "1.0.0",
				},
			],
		};
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("stale1.md", sampleHash); // Unmodified
		diskHashes.set("stale2.md", modifiedHash); // Modified

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(2);
		const plan1 = plans.find((p) => p.relativePath === "stale1.md");
		const plan2 = plans.find((p) => p.relativePath === "stale2.md");
		expect(plan1?.action).toBe("remove");
		expect(plan2?.action).toBe("stale-modified");
	});

	test("bootstrap adoption: pre-existing file matching bundled content is adopted", () => {
		// This is the "happy path" bootstrap — file is exactly what we would write
		const desired: DesiredAsset[] = [
			{
				relativePath: "bootstrap.md",
				content: sampleContent,
				owner: "template",
			},
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("bootstrap.md", sampleHash);

		const plans = reconcileAssets(
			desired,
			null,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("skip");
		expect(plans[0]?.detail).toContain("adopted");
	});

	test("bootstrap conflict: pre-existing file with user edits is flagged as conflict", () => {
		// File exists but has been customized — should NOT be adopted into manifest
		const desired: DesiredAsset[] = [
			{
				relativePath: "customized.md",
				content: sampleContent,
				owner: "template",
			},
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("customized.md", modifiedHash);

		const plans = reconcileAssets(
			desired,
			null,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(1);
		expect(plans[0]?.action).toBe("conflict");
		expect(plans[0]?.detail).toContain("will not be adopted");
	});

	test("complex scenario with mixed actions", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "create-me.md", content: "new", owner: "template" },
			{ relativePath: "update-me.md", content: "v2", owner: "template" },
			{ relativePath: "skip-me.md", content: "same", owner: "template" },
			{ relativePath: "bootstrap-ok.md", content: "fresh", owner: "template" },
			{
				relativePath: "bootstrap-conflict.md",
				content: "fresh",
				owner: "template",
			},
		];

		const _v2Hash = hashContent("v2");
		const sameHash = hashContent("same");
		const freshHash = hashContent("fresh");

		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "update-me.md",
					owner: "template",
					contentHash: hashContent("v1"), // Old version
					cliVersion: "1.0.0",
				},
				{
					relativePath: "skip-me.md",
					owner: "template",
					contentHash: sameHash,
					cliVersion: "1.0.0",
				},
				{
					relativePath: "stale-remove.md",
					owner: "template",
					contentHash: hashContent("old-stale"),
					cliVersion: "1.0.0",
				},
				{
					relativePath: "stale-modified.md",
					owner: "template",
					contentHash: hashContent("old-stale"),
					cliVersion: "1.0.0",
				},
			],
		};

		const diskHashes = new Map<string, string | null>();
		diskHashes.set("create-me.md", null); // Not on disk
		diskHashes.set("update-me.md", hashContent("v1")); // Matches manifest (unmodified)
		diskHashes.set("skip-me.md", sameHash); // Matches
		diskHashes.set("bootstrap-ok.md", freshHash); // Matches bundled
		diskHashes.set("bootstrap-conflict.md", hashContent("custom")); // Diverges
		diskHashes.set("stale-remove.md", hashContent("old-stale")); // Matches manifest
		diskHashes.set("stale-modified.md", hashContent("user-edited")); // Diverges

		const plans = reconcileAssets(
			desired,
			manifest,
			(p) => diskHashes.get(p) ?? null,
		);

		expect(plans).toHaveLength(7);

		const byPath = new Map(plans.map((p) => [p.relativePath, p]));
		expect(byPath.get("create-me.md")?.action).toBe("create");
		expect(byPath.get("update-me.md")?.action).toBe("update");
		expect(byPath.get("skip-me.md")?.action).toBe("skip");
		expect(byPath.get("bootstrap-ok.md")?.action).toBe("skip");
		expect(byPath.get("bootstrap-conflict.md")?.action).toBe("conflict");
		expect(byPath.get("stale-remove.md")?.action).toBe("remove");
		expect(byPath.get("stale-modified.md")?.action).toBe("stale-modified");
	});
});

// ---------------------------------------------------------------------------
// buildUpdatedManifest tests
// ---------------------------------------------------------------------------

describe("buildUpdatedManifest", () => {
	test("includes entries for created assets", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: "content", owner: "template" },
		];
		const plans = [
			{ relativePath: "test.md", owner: "template", action: "create" as const },
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", hashContent("content"));

		const result = buildUpdatedManifest(
			desired,
			plans,
			null,
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({
			relativePath: "test.md",
			owner: "template",
			contentHash: hashContent("content"),
			cliVersion: "1.0.0",
		});
	});

	test("includes entries for updated assets", () => {
		const newContent = "new content";
		const newHash = hashContent(newContent);
		const desired: DesiredAsset[] = [
			{ relativePath: "test.md", content: newContent, owner: "template" },
		];
		const plans = [
			{ relativePath: "test.md", owner: "template", action: "update" as const },
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("test.md", newHash);

		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "test.md",
					owner: "template",
					contentHash: hashContent("old content"),
					cliVersion: "0.9.0",
				},
			],
		};

		const result = buildUpdatedManifest(
			desired,
			plans,
			manifest,
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.contentHash).toBe(newHash);
		expect(result.entries[0]?.cliVersion).toBe("1.0.0");
	});

	test("bootstrap adoption adds entries for skipped matching files", () => {
		const content = "bundled content";
		const contentHash = hashContent(content);
		const desired: DesiredAsset[] = [
			{ relativePath: "bootstrap.md", content, owner: "template" },
		];
		const plans = [
			{
				relativePath: "bootstrap.md",
				owner: "template",
				action: "skip" as const,
				detail: "matches bundled content",
			},
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("bootstrap.md", contentHash);

		const result = buildUpdatedManifest(
			desired,
			plans,
			null, // No previous manifest
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]).toMatchObject({
			relativePath: "bootstrap.md",
			owner: "template",
			contentHash,
			cliVersion: "1.0.0",
		});
	});

	test("conflict files are NOT added to manifest", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "conflict.md", content: "bundled", owner: "template" },
		];
		const plans = [
			{
				relativePath: "conflict.md",
				owner: "template",
				action: "conflict" as const,
			},
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("conflict.md", hashContent("user modified"));

		const result = buildUpdatedManifest(
			desired,
			plans,
			null,
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		expect(result.entries).toHaveLength(0);
	});

	test("removed files are dropped from manifest", () => {
		const desired: DesiredAsset[] = [];
		const plans = [
			{
				relativePath: "removed.md",
				owner: "template",
				action: "remove" as const,
			},
		];
		const diskHashes = new Map<string, string | null>();
		// File was removed

		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "removed.md",
					owner: "template",
					contentHash: "abc123",
					cliVersion: "0.9.0",
				},
			],
		};

		const result = buildUpdatedManifest(
			desired,
			plans,
			manifest,
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		expect(result.entries).toHaveLength(0);
	});

	test("stale-modified files are dropped from manifest", () => {
		const desired: DesiredAsset[] = [];
		const plans = [
			{
				relativePath: "stale-modified.md",
				owner: "template",
				action: "stale-modified" as const,
			},
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("stale-modified.md", hashContent("user edited"));

		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "stale-modified.md",
					owner: "template",
					contentHash: "old-hash",
					cliVersion: "0.9.0",
				},
			],
		};

		const result = buildUpdatedManifest(
			desired,
			plans,
			manifest,
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		expect(result.entries).toHaveLength(0);
	});

	test("preserves untracked manifest entries", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "desired.md", content: "content", owner: "template" },
		];
		const plans = [
			{
				relativePath: "desired.md",
				owner: "template",
				action: "create" as const,
			},
		];
		const diskHashes = new Map<string, string | null>();
		diskHashes.set("desired.md", hashContent("content"));
		diskHashes.set("untracked.md", "untracked-hash");

		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "untracked.md",
					owner: "other",
					contentHash: "untracked-hash",
					cliVersion: "0.9.0",
				},
			],
		};

		const result = buildUpdatedManifest(
			desired,
			plans,
			manifest,
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		expect(result.entries).toHaveLength(2);
		const paths = result.entries.map((e) => e.relativePath);
		expect(paths).toContain("desired.md");
		expect(paths).toContain("untracked.md");
	});

	test("drops manifest entries for files that no longer exist on disk", () => {
		const desired: DesiredAsset[] = [];
		const plans: Array<{
			relativePath: string;
			owner: string;
			action: AssetAction;
		}> = [];
		const diskHashes = new Map<string, string | null>();
		// No entries — files are gone

		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "gone.md",
					owner: "template",
					contentHash: "abc123",
					cliVersion: "0.9.0",
				},
			],
		};

		const result = buildUpdatedManifest(
			desired,
			plans,
			manifest,
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		expect(result.entries).toHaveLength(0);
	});

	test("handles mixed operations correctly", () => {
		const desired: DesiredAsset[] = [
			{ relativePath: "create.md", content: "new", owner: "template" },
			{ relativePath: "update.md", content: "v2", owner: "template" },
		];

		const plans = [
			{
				relativePath: "create.md",
				owner: "template",
				action: "create" as const,
			},
			{
				relativePath: "update.md",
				owner: "template",
				action: "update" as const,
			},
		];

		const diskHashes = new Map<string, string | null>();
		diskHashes.set("create.md", hashContent("new"));
		diskHashes.set("update.md", hashContent("v2"));

		const manifest: Manifest = {
			version: 1,
			entries: [
				{
					relativePath: "update.md",
					owner: "template",
					contentHash: hashContent("v1"),
					cliVersion: "0.9.0",
				},
				{
					relativePath: "remove.md",
					owner: "template",
					contentHash: hashContent("old"),
					cliVersion: "0.9.0",
				},
			],
		};

		const result = buildUpdatedManifest(
			desired,
			plans,
			manifest,
			(p) => diskHashes.get(p) ?? null,
			"1.0.0",
		);

		// Should have create.md, update.md (remove.md was in manifest but gone from disk)
		expect(result.entries).toHaveLength(2);
		const paths = result.entries.map((e) => e.relativePath).sort();
		expect(paths).toEqual(["create.md", "update.md"]);
	});
});
