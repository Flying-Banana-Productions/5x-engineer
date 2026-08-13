/**
 * Tests for `compareManifest` — the two-tier freshness comparison.
 *
 * Phase 4 (201-harness-freshness).
 *
 * The load-bearing invariants, stated once here so the cases below read as
 * checks against them rather than as trivia:
 *   - nothing that cannot be proven fresh ever reads `fresh`;
 *   - Tier 1 never asserts a lossless refresh, because it cannot see hand-edits;
 *   - an unverified baseline is terminal for `status`, whatever the fingerprint
 *     over its retained inputs says.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	compareManifest,
	computeFingerprint,
	type HarnessManifest,
	hashContent,
	MANIFEST_FILENAME,
	MANIFEST_VERSION,
	type ManifestInputs,
	makeAssetReader,
	normalizeInputs,
	type RawManifestInputs,
	writeManifest,
} from "../../../src/harnesses/manifest.js";
import type { RenderedAsset } from "../../../src/harnesses/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-compare-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const BASE_INPUTS: RawManifestInputs = {
	authorModel: "anthropic/claude-sonnet-4-6",
	reviewerModel: "anthropic/claude-opus-4-1",
	authorDelegationMode: "native",
	reviewerDelegationMode: "native",
	cliVersion: "1.2.2",
	harnessPluginVersion: "1.2.2",
	plugin: {},
};

const SKILL_PATH = "skills/5x-plan/SKILL.md";
const AGENT_PATH = "agents/5x-plan-author.md";

/** Write an asset under `rootDir` and return its manifest entry. */
function writeAsset(
	rootDir: string,
	relPath: string,
	content: string,
): { path: string; sha256: string } {
	const abs = join(rootDir, ...relPath.split("/"));
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf-8");
	return { path: relPath, sha256: hashContent(content) };
}

function makeManifest(overrides?: Partial<HarnessManifest>): HarnessManifest {
	const inputs: ManifestInputs =
		overrides?.inputs ?? normalizeInputs(BASE_INPUTS);
	return {
		manifestVersion: MANIFEST_VERSION,
		harness: "opencode",
		scope: "project",
		hash: computeFingerprint(inputs),
		configResolved: true,
		baseline: "verified",
		installedFrom: { projectRoot: "/home/me/dev/foo", contextDir: "" },
		inputs,
		installedAt: "2026-08-09T00:00:00.000Z",
		assets: [],
		// `hash` above is derived from whichever `inputs` the caller supplied, so
		// an overriding case only has to name `inputs`.
		...overrides,
	};
}

/** Tier 1 compare against a manifest written into a fresh temp root. */
function compareTier1(args: {
	manifest?: Partial<HarnessManifest>;
	current?: Partial<RawManifestInputs>;
	installed?: boolean;
	scope?: "project" | "user";
	currentContextDir?: string;
	rootDir?: string;
}) {
	const rootDir = args.rootDir ?? makeTmpDir();
	if (args.manifest !== undefined) {
		writeManifest(rootDir, makeManifest(args.manifest));
	}
	return compareManifest({
		harness: "opencode",
		scope: args.scope ?? "project",
		rootDir,
		installed: args.installed ?? true,
		current: { ...BASE_INPUTS, ...args.current },
		currentContextDir: args.currentContextDir ?? "",
	});
}

// ---------------------------------------------------------------------------
// Tier 1 status matrix
// ---------------------------------------------------------------------------

describe("compareManifest — Tier 1 status matrix", () => {
	test("no managed assets on disk reports not-installed and evaluates nothing", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({
				rootDir: dir,
				manifest: {},
				installed: false,
			});
			expect(report.status).toBe("not-installed");
			expect(report.reason).toBeNull();
			expect(report.losslessRefresh).toBe(false);
			expect(report.losslessBlockers).toEqual([]);
			expect(report.baseline).toBeNull();
			expect(report.installedFrom).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("assets with no manifest report unknown / no-manifest", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({ rootDir: dir });
			expect(report.status).toBe("unknown");
			expect(report.reason).toBe("no-manifest");
			expect(report.losslessBlockers).toEqual(["no-manifest"]);
			expect(report.baseline).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a present-but-invalid manifest reports unknown / manifest-unreadable", () => {
		const dir = makeTmpDir();
		try {
			writeFileSync(join(dir, MANIFEST_FILENAME), "{ not json", "utf-8");
			const report = compareTier1({ rootDir: dir });
			expect(report.status).toBe("unknown");
			expect(report.reason).toBe("manifest-unreadable");
			expect(report.losslessBlockers).toEqual(["no-manifest"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a future manifestVersion reads as unreadable, never fresh", () => {
		const dir = makeTmpDir();
		try {
			writeFileSync(
				join(dir, MANIFEST_FILENAME),
				JSON.stringify(makeManifest({ manifestVersion: 99 })),
				"utf-8",
			);
			const report = compareTier1({ rootDir: dir });
			expect(report.status).toBe("unknown");
			expect(report.reason).toBe("manifest-unreadable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The hazard: `normalizeInputs` supplies defaults for every absent field, so
	// an incomplete recorded `inputs` still fingerprint-matches the current
	// config and would read `fresh` while describing a bake nobody performed. A
	// hand-edited or partially-committed manifest must fail closed instead.
	const incompleteInputs: Array<
		[string, (inputs: Record<string, unknown>) => void]
	> = [
		["plugin", (i) => delete i.plugin],
		["authorModel", (i) => delete i.authorModel],
		["reviewerModel", (i) => delete i.reviewerModel],
		["authorDelegationMode", (i) => delete i.authorDelegationMode],
		["reviewerDelegationMode", (i) => delete i.reviewerDelegationMode],
		["cliVersion", (i) => delete i.cliVersion],
		["harnessPluginVersion", (i) => delete i.harnessPluginVersion],
	];

	for (const [field, mutate] of incompleteInputs) {
		test(`a manifest missing inputs.${field} reads unreadable, never fresh`, () => {
			const dir = makeTmpDir();
			try {
				const raw = JSON.parse(JSON.stringify(makeManifest())) as Record<
					string,
					unknown
				>;
				mutate(raw.inputs as Record<string, unknown>);
				// The recorded `hash` is untouched and still matches the normalized
				// current inputs — precisely why the shape guard, not the
				// fingerprint, has to catch this.
				expect(raw.hash).toBe(computeFingerprint(normalizeInputs(BASE_INPUTS)));
				writeFileSync(
					join(dir, MANIFEST_FILENAME),
					JSON.stringify(raw),
					"utf-8",
				);

				const report = compareTier1({ rootDir: dir });
				expect(report.status).toBe("unknown");
				expect(report.reason).toBe("manifest-unreadable");
				expect(report.losslessRefresh).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("a manifest missing installedFrom.contextDir reads unreadable, never fresh", () => {
		const dir = makeTmpDir();
		try {
			const raw = JSON.parse(JSON.stringify(makeManifest())) as Record<
				string,
				unknown
			>;
			delete (raw.installedFrom as Record<string, unknown>).contextDir;
			writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(raw), "utf-8");

			const report = compareTier1({ rootDir: dir });
			expect(report.status).toBe("unknown");
			expect(report.reason).toBe("manifest-unreadable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a plugin-contributed input set of strings and numbers stays valid", () => {
		const dir = makeTmpDir();
		try {
			const inputs = normalizeInputs({
				...BASE_INPUTS,
				plugin: { theme: "dark", depth: 3 },
			});
			const report = compareTier1({
				rootDir: dir,
				manifest: { inputs },
				current: { plugin: { theme: "dark", depth: 3 } },
			});
			expect(report.status).toBe("fresh");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("configResolved: false reports unknown / config-unresolved", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({
				rootDir: dir,
				manifest: { configResolved: false },
			});
			expect(report.status).toBe("unknown");
			expect(report.reason).toBe("config-unresolved");
			expect(report.losslessBlockers).toContain("config-unresolved");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("matching inputs on a verified baseline report fresh", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({ rootDir: dir, manifest: {} });
			expect(report.status).toBe("fresh");
			expect(report.reason).toBeNull();
			expect(report.inputDeltas).toEqual([]);
			expect(report.baseline).toBe("verified");
			expect(report.installedFrom?.contextDir).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a manifest with zero recorded assets still compares on inputs", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({ rootDir: dir, manifest: { assets: [] } });
			expect(report.status).toBe("fresh");
			expect(report.assetDeltas).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Per-input staleness
// ---------------------------------------------------------------------------

describe("compareManifest — input changes", () => {
	const cases: Array<{
		name: string;
		current: Partial<RawManifestInputs>;
		key: string;
		installed: string | null;
		expected: string | null;
	}> = [
		{
			name: "author.model",
			current: { authorModel: "anthropic/claude-opus-4-1" },
			key: "author.model",
			installed: "anthropic/claude-sonnet-4-6",
			expected: "anthropic/claude-opus-4-1",
		},
		{
			name: "reviewer.model",
			current: { reviewerModel: "openai/gpt-5" },
			key: "reviewer.model",
			installed: "anthropic/claude-opus-4-1",
			expected: "openai/gpt-5",
		},
		{
			name: "author.delegationMode",
			current: { authorDelegationMode: "invoke" },
			key: "author.delegationMode",
			installed: "native",
			expected: "invoke",
		},
		{
			name: "reviewer.delegationMode",
			current: { reviewerDelegationMode: "invoke" },
			key: "reviewer.delegationMode",
			installed: "native",
			expected: "invoke",
		},
		{
			name: "cliVersion",
			current: { cliVersion: "1.3.0" },
			key: "cliVersion",
			installed: "1.2.2",
			expected: "1.3.0",
		},
		{
			name: "harnessPluginVersion",
			current: { harnessPluginVersion: "9.9.9" },
			key: "harnessPluginVersion",
			installed: "1.2.2",
			expected: "9.9.9",
		},
	];

	for (const c of cases) {
		test(`${c.name} change reports stale / inputs-changed with only that delta`, () => {
			const dir = makeTmpDir();
			try {
				const report = compareTier1({
					rootDir: dir,
					manifest: {},
					current: c.current,
				});
				expect(report.status).toBe("stale");
				expect(report.reason).toBe("inputs-changed");
				expect(report.inputDeltas).toEqual([
					{ key: c.key, installed: c.installed, current: c.expected },
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("clearing a model reports the unset side as null", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({
				rootDir: dir,
				manifest: {},
				current: { authorModel: undefined },
			});
			expect(report.inputDeltas).toEqual([
				{
					key: "author.model",
					installed: "anthropic/claude-sonnet-4-6",
					current: null,
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a differing plugin input yields a plugin.<key> delta", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({
				rootDir: dir,
				manifest: {
					inputs: normalizeInputs({
						...BASE_INPUTS,
						plugin: { theme: "dark" },
					}),
				},
				current: { plugin: { theme: "light" } },
			});
			expect(report.status).toBe("stale");
			expect(report.inputDeltas).toEqual([
				{ key: "plugin.theme", installed: "dark", current: "light" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Unverified baselines
// ---------------------------------------------------------------------------

describe("compareManifest — unverified baseline", () => {
	test("inputs matching the current config are still unknown, never fresh", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({
				rootDir: dir,
				manifest: { baseline: "unverified" },
			});
			expect(report.status).toBe("unknown");
			expect(report.reason).toBe("baseline-unverified");
			expect(report.inputDeltas).toEqual([]);
			expect(report.baseline).toBe("unverified");
			expect(report.losslessBlockers).toContain("baseline-unverified");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("retained prior inputs still populate inputDeltas so the warning can name the change", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({
				rootDir: dir,
				manifest: { baseline: "unverified" },
				current: { authorModel: "anthropic/claude-opus-4-1" },
			});
			expect(report.status).toBe("unknown");
			expect(report.reason).toBe("baseline-unverified");
			expect(report.inputDeltas).toEqual([
				{
					key: "author.model",
					installed: "anthropic/claude-sonnet-4-6",
					current: "anthropic/claude-opus-4-1",
				},
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("config-unresolved outranks an unverified baseline in the reason", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({
				rootDir: dir,
				manifest: { baseline: "unverified", configResolved: false },
			});
			expect(report.reason).toBe("config-unresolved");
			expect(report.losslessBlockers).toEqual(
				expect.arrayContaining(["config-unresolved", "baseline-unverified"]),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Tier 2
// ---------------------------------------------------------------------------

/** Build a Tier 2 comparison over real files in a temp root. */
function compareTier2(args: {
	rootDir: string;
	manifest: Partial<HarnessManifest>;
	rendered?: RenderedAsset[];
	current?: Partial<RawManifestInputs>;
	scope?: "project" | "user";
	currentContextDir?: string;
}) {
	writeManifest(args.rootDir, makeManifest(args.manifest));
	return compareManifest({
		harness: "opencode",
		scope: args.scope ?? "project",
		rootDir: args.rootDir,
		installed: true,
		current: { ...BASE_INPUTS, ...args.current },
		currentContextDir: args.currentContextDir ?? "",
		...(args.rendered ? { rendered: args.rendered } : {}),
		readAsset: makeAssetReader(args.rootDir),
	});
}

describe("compareManifest — Tier 2", () => {
	test("an untouched, fully rendered install is fresh and losslessly refreshable", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "skill body");
			const agent = writeAsset(dir, AGENT_PATH, "agent body");
			const report = compareTier2({
				rootDir: dir,
				manifest: { assets: [skill, agent] },
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "skill body",
					},
					{
						kind: "agent",
						name: "5x-plan-author",
						path: AGENT_PATH,
						content: "agent body",
					},
				],
			});
			expect(report.tier).toBe(2);
			expect(report.status).toBe("fresh");
			expect(report.assetDeltas).toEqual([]);
			expect(report.losslessRefresh).toBe(true);
			expect(report.losslessBlockers).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a hand-edited file is modified — stale / assets-modified, and blocks refresh", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "skill body");
			writeAsset(dir, SKILL_PATH, "skill body + user edit");
			const report = compareTier2({
				rootDir: dir,
				manifest: { assets: [skill] },
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "skill body",
					},
				],
			});
			expect(report.status).toBe("stale");
			expect(report.reason).toBe("assets-modified");
			expect(report.assetDeltas).toEqual([
				{ path: SKILL_PATH, state: "modified" },
			]);
			expect(report.losslessRefresh).toBe(false);
			expect(report.losslessBlockers).toEqual(["assets-modified"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a re-render that differs from the recorded hash is drifted", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "skill body");
			const report = compareTier2({
				rootDir: dir,
				manifest: { assets: [skill] },
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "skill body v2",
					},
				],
			});
			expect(report.status).toBe("stale");
			expect(report.reason).toBe("assets-drifted");
			expect(report.assetDeltas).toEqual([
				{ path: SKILL_PATH, state: "drifted" },
			]);
			// Drift alone is exactly what sync exists to rewrite.
			expect(report.losslessRefresh).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a newly rendered path is added; a no-longer-rendered path is orphaned", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "skill body");
			const agent = writeAsset(dir, AGENT_PATH, "agent body");
			const report = compareTier2({
				rootDir: dir,
				manifest: { assets: [skill, agent] },
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "skill body",
					},
					{
						kind: "skill",
						name: "5x-new",
						path: "skills/5x-new/SKILL.md",
						content: "new skill",
					},
				],
			});
			expect(report.assetDeltas).toEqual([
				{ path: AGENT_PATH, state: "orphaned" },
				{ path: "skills/5x-new/SKILL.md", state: "added" },
			]);
			expect(report.status).toBe("stale");
			expect(report.reason).toBe("assets-drifted");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a recorded asset deleted from disk is missing", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier2({
				rootDir: dir,
				manifest: {
					assets: [{ path: SKILL_PATH, sha256: hashContent("skill body") }],
				},
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "skill body",
					},
				],
			});
			expect(report.assetDeltas).toEqual([
				{ path: SKILL_PATH, state: "missing" },
			]);
			expect(report.status).toBe("stale");
			expect(report.reason).toBe("assets-drifted");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("one file can be both modified and drifted", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "recorded body");
			writeAsset(dir, SKILL_PATH, "hand-edited body");
			const report = compareTier2({
				rootDir: dir,
				manifest: { assets: [skill] },
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "re-rendered body",
					},
				],
			});
			expect(report.assetDeltas).toEqual([
				{ path: SKILL_PATH, state: "drifted" },
				{ path: SKILL_PATH, state: "modified" },
			]);
			// The hand-edit is what blocks the refresh, so it wins the reason.
			expect(report.reason).toBe("assets-modified");
			expect(report.losslessRefresh).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an input change outranks the drift it necessarily causes", () => {
		const dir = makeTmpDir();
		try {
			const agent = writeAsset(dir, AGENT_PATH, "model: A");
			const report = compareTier2({
				rootDir: dir,
				manifest: { assets: [agent] },
				current: { authorModel: "anthropic/claude-opus-4-1" },
				rendered: [
					{
						kind: "agent",
						name: "5x-plan-author",
						path: AGENT_PATH,
						content: "model: B",
					},
				],
			});
			expect(report.status).toBe("stale");
			expect(report.reason).toBe("inputs-changed");
			expect(report.inputDeltas[0]?.key).toBe("author.model");
			expect(report.assetDeltas).toEqual([
				{ path: AGENT_PATH, state: "drifted" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("without a render, Tier 2 still detects hand-edits (degraded mode)", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "skill body");
			writeAsset(dir, SKILL_PATH, "edited");
			const report = compareTier2({
				rootDir: dir,
				manifest: { assets: [skill] },
			});
			expect(report.tier).toBe(2);
			expect(report.reason).toBe("assets-modified");
			expect(report.assetDeltas).toEqual([
				{ path: SKILL_PATH, state: "modified" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Lossless-refresh predicate
// ---------------------------------------------------------------------------

describe("compareManifest — lossless-refresh predicate", () => {
	test("Tier 1 never reports losslessRefresh: true, even with no blockers", () => {
		const dir = makeTmpDir();
		try {
			const report = compareTier1({
				rootDir: dir,
				manifest: {},
				current: { authorModel: "anthropic/claude-opus-4-1" },
			});
			expect(report.tier).toBe(1);
			expect(report.status).toBe("stale");
			expect(report.losslessBlockers).toEqual([]);
			expect(report.losslessRefresh).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unverified baseline is never lossless, even at Tier 2 with no edits", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "skill body");
			const report = compareTier2({
				rootDir: dir,
				manifest: { assets: [skill], baseline: "unverified" },
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "skill body",
					},
				],
			});
			expect(report.losslessRefresh).toBe(false);
			expect(report.losslessBlockers).toEqual(["baseline-unverified"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("user scope with a perfect match is still blocked as shared-user-scope", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "skill body");
			const report = compareTier2({
				rootDir: dir,
				scope: "user",
				manifest: { assets: [skill], scope: "user" },
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "skill body",
					},
				],
			});
			expect(report.status).toBe("fresh");
			expect(report.losslessRefresh).toBe(false);
			expect(report.losslessBlockers).toEqual(["shared-user-scope"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a differing install context is blocked as context-mismatch", () => {
		const dir = makeTmpDir();
		try {
			const skill = writeAsset(dir, SKILL_PATH, "skill body");
			const report = compareTier2({
				rootDir: dir,
				manifest: {
					assets: [skill],
					installedFrom: {
						projectRoot: "/home/me/dev/foo",
						contextDir: "packages/api",
					},
				},
				rendered: [
					{
						kind: "skill",
						name: "5x-plan",
						path: SKILL_PATH,
						content: "skill body",
					},
				],
				currentContextDir: "",
			});
			expect(report.losslessRefresh).toBe(false);
			expect(report.losslessBlockers).toEqual(["context-mismatch"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a no-manifest report blocks refresh and reports no baseline", () => {
		const dir = makeTmpDir();
		try {
			const report = compareManifest({
				harness: "opencode",
				scope: "project",
				rootDir: dir,
				installed: true,
				current: BASE_INPUTS,
				currentContextDir: "",
				rendered: [],
				readAsset: makeAssetReader(dir),
			});
			expect(report.losslessRefresh).toBe(false);
			expect(report.losslessBlockers).toEqual(["no-manifest"]);
			expect(report.baseline).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
