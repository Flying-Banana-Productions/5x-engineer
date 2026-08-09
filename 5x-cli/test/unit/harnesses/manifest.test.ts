/**
 * Tests for the harness asset manifest module — schema, canonical JSON,
 * fingerprinting, and read/write/remove.
 *
 * Phase 1 (201-harness-freshness).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalJson,
	computeFingerprint,
	type HarnessManifest,
	hashContent,
	MANIFEST_FILENAME,
	MANIFEST_VERSION,
	type ManifestInputs,
	manifestPath,
	normalizeInputs,
	readManifest,
	removeManifest,
	toManifestPath,
	writeManifest,
} from "../../../src/harnesses/manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-manifest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeInputs(overrides?: Partial<ManifestInputs>): ManifestInputs {
	return {
		authorModel: "anthropic/claude-sonnet-4-6",
		reviewerModel: "anthropic/claude-opus-4-1",
		authorDelegationMode: "native",
		reviewerDelegationMode: "native",
		cliVersion: "1.2.2",
		harnessPluginVersion: "1.2.2",
		plugin: {},
		...overrides,
	};
}

function makeManifest(overrides?: Partial<HarnessManifest>): HarnessManifest {
	const inputs = overrides?.inputs ?? makeInputs();
	return {
		manifestVersion: MANIFEST_VERSION,
		harness: "opencode",
		scope: "project",
		hash: computeFingerprint(inputs),
		configResolved: true,
		baseline: "verified",
		installedFrom: { projectRoot: "/tmp/project", contextDir: "" },
		inputs,
		installedAt: "2026-08-09T00:00:00.000Z",
		assets: [{ path: "skills/5x-plan/SKILL.md", sha256: hashContent("x") }],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Module isolation (Phase 1 completion gate)
// ---------------------------------------------------------------------------

describe("manifest module isolation", () => {
	test("imports nothing from factory.ts or any plugin module", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../../src/harnesses/manifest.ts"),
			"utf-8",
		);

		const importSpecifiers = [
			...source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)";/gm),
		].map((m) => m[1] ?? "");

		expect(importSpecifiers.length).toBeGreaterThan(0);
		for (const specifier of importSpecifiers) {
			expect(specifier).not.toInclude("factory");
			expect(specifier).not.toInclude("plugin");
		}
		// Dynamic imports would dodge the check above.
		expect(source).not.toInclude("import(");
	});
});

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

describe("canonicalJson", () => {
	test("sorts object keys recursively and emits no whitespace", () => {
		const json = canonicalJson({ b: 1, a: { d: 2, c: [3, 1] } });

		expect(json).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
	});

	test("key order does not change the output", () => {
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});

	test("arrays keep their order", () => {
		expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
		expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
	});

	test("null, booleans, numbers and strings round-trip", () => {
		expect(canonicalJson({ n: null, t: true, i: 1, s: "x" })).toBe(
			'{"i":1,"n":null,"s":"x","t":true}',
		);
	});

	test("rejects undefined", () => {
		expect(() => canonicalJson(undefined)).toThrow(/not representable/);
		expect(() => canonicalJson({ a: undefined })).toThrow(/not representable/);
	});

	test("rejects functions and non-finite numbers", () => {
		expect(() => canonicalJson({ fn: () => 1 })).toThrow(/not representable/);
		expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
		expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(
			/non-finite/,
		);
	});
});

// ---------------------------------------------------------------------------
// normalizeInputs
// ---------------------------------------------------------------------------

describe("normalizeInputs", () => {
	const base = { cliVersion: "1.2.2", harnessPluginVersion: "1.2.2" };

	test("undefined, empty and whitespace-only models normalize to null", () => {
		expect(normalizeInputs({ ...base }).authorModel).toBeNull();
		expect(
			normalizeInputs({ ...base, authorModel: "" }).authorModel,
		).toBeNull();
		expect(
			normalizeInputs({ ...base, authorModel: "   " }).authorModel,
		).toBeNull();
		expect(
			normalizeInputs({ ...base, reviewerModel: "  " }).reviewerModel,
		).toBeNull();
	});

	test("model strings are trimmed", () => {
		expect(
			normalizeInputs({
				...base,
				authorModel: " anthropic/claude-sonnet-4-6 ",
			}).authorModel,
		).toBe("anthropic/claude-sonnet-4-6");
	});

	test("undefined delegation mode defaults to native", () => {
		const inputs = normalizeInputs({ ...base });

		expect(inputs.authorDelegationMode).toBe("native");
		expect(inputs.reviewerDelegationMode).toBe("native");
	});

	test("explicit invoke mode is preserved", () => {
		const inputs = normalizeInputs({
			...base,
			authorDelegationMode: "invoke",
			reviewerDelegationMode: "native",
		});

		expect(inputs.authorDelegationMode).toBe("invoke");
		expect(inputs.reviewerDelegationMode).toBe("native");
	});

	test("absent plugin inputs normalize to {}", () => {
		expect(normalizeInputs({ ...base }).plugin).toEqual({});
	});

	test("plugin keys are sorted", () => {
		const plugin = normalizeInputs({
			...base,
			plugin: { zeta: 1, alpha: "a" },
		}).plugin;

		expect(Object.keys(plugin)).toEqual(["alpha", "zeta"]);
	});
});

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

describe("computeFingerprint", () => {
	test("is prefixed sha256 hex", () => {
		expect(computeFingerprint(makeInputs())).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("configs differing only in key order hash equal", () => {
		const a: ManifestInputs = {
			authorModel: "m/a",
			reviewerModel: "m/r",
			authorDelegationMode: "native",
			reviewerDelegationMode: "invoke",
			cliVersion: "1.2.2",
			harnessPluginVersion: "1.2.2",
			plugin: {},
		};
		const b: ManifestInputs = {
			plugin: {},
			harnessPluginVersion: "1.2.2",
			cliVersion: "1.2.2",
			reviewerDelegationMode: "invoke",
			authorDelegationMode: "native",
			reviewerModel: "m/r",
			authorModel: "m/a",
		};

		expect(computeFingerprint(a)).toBe(computeFingerprint(b));
	});

	test("configs differing only in model whitespace hash equal", () => {
		const raw = { cliVersion: "1.2.2", harnessPluginVersion: "1.2.2" };
		const padded = normalizeInputs({ ...raw, authorModel: "  m/a  " });
		const tight = normalizeInputs({ ...raw, authorModel: "m/a" });

		expect(computeFingerprint(padded)).toBe(computeFingerprint(tight));
	});

	test("changing any one scalar input changes the hash", () => {
		const baseHash = computeFingerprint(makeInputs());
		const mutations: Array<Partial<ManifestInputs>> = [
			{ authorModel: "other/model" },
			{ authorModel: null },
			{ reviewerModel: "other/model" },
			{ reviewerModel: null },
			{ authorDelegationMode: "invoke" },
			{ reviewerDelegationMode: "invoke" },
			{ cliVersion: "1.3.0" },
			{ harnessPluginVersion: "9.9.9" },
		];

		for (const mutation of mutations) {
			expect(computeFingerprint(makeInputs(mutation))).not.toBe(baseHash);
		}
	});

	test("plugin inputs participate in the hash", () => {
		expect(computeFingerprint(makeInputs({ plugin: { a: "1" } }))).not.toBe(
			computeFingerprint(makeInputs()),
		);
		// String "1" and number 1 are distinct bakes.
		expect(computeFingerprint(makeInputs({ plugin: { a: "1" } }))).not.toBe(
			computeFingerprint(makeInputs({ plugin: { a: 1 } })),
		);
	});

	test("plugin: {} and an absent plugin field hash equal", () => {
		const raw = { cliVersion: "1.2.2", harnessPluginVersion: "1.2.2" };

		expect(computeFingerprint(normalizeInputs({ ...raw, plugin: {} }))).toBe(
			computeFingerprint(normalizeInputs({ ...raw })),
		);
	});

	test("baseline is not part of the fingerprint", () => {
		const inputs = makeInputs();
		const verified = makeManifest({ inputs, baseline: "verified" });
		const unverified = makeManifest({ inputs, baseline: "unverified" });

		expect(computeFingerprint(unverified.inputs)).toBe(
			computeFingerprint(verified.inputs),
		);
		expect(unverified.hash).toBe(verified.hash);
	});
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe("hashContent", () => {
	test("is bare sha256 hex, stable, and content-sensitive", () => {
		expect(hashContent("hello")).toMatch(/^[0-9a-f]{64}$/);
		expect(hashContent("hello")).toBe(hashContent("hello"));
		expect(hashContent("hello")).not.toBe(hashContent("hello\n"));
	});

	test("matches the well-known sha256 of the empty string", () => {
		expect(hashContent("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("manifestPath / toManifestPath", () => {
	test("manifestPath joins the filename onto rootDir", () => {
		expect(manifestPath("/tmp/proj/.opencode")).toBe(
			join("/tmp/proj/.opencode", MANIFEST_FILENAME),
		);
	});

	test("emits a POSIX relative path from a POSIX absolute path", () => {
		expect(
			toManifestPath(
				"/tmp/proj/.opencode",
				"/tmp/proj/.opencode/skills/5x-plan/SKILL.md",
			),
		).toBe("skills/5x-plan/SKILL.md");
	});

	test("emits a POSIX relative path from Windows separators", () => {
		expect(
			toManifestPath(
				"C:\\repo\\.opencode",
				"C:\\repo\\.opencode\\skills\\5x-plan\\SKILL.md",
			),
		).toBe("skills/5x-plan/SKILL.md");
	});

	test("mixed separators normalize to the same relative path", () => {
		expect(
			toManifestPath("C:\\repo\\.opencode", "C:/repo/.opencode/agents/5x.md"),
		).toBe("agents/5x.md");
	});
});

// ---------------------------------------------------------------------------
// Read / write / remove
// ---------------------------------------------------------------------------

describe("writeManifest / readManifest", () => {
	test("round-trips a deep-equal manifest including baseline", () => {
		const dir = makeTmpDir();
		const manifest = makeManifest({
			baseline: "unverified",
			installedFrom: { projectRoot: dir, contextDir: "packages/api" },
			assets: [
				{ path: "agents/5x-plan-author.md", sha256: hashContent("a") },
				{ path: "skills/5x-plan/SKILL.md", sha256: hashContent("b") },
			],
		});

		writeManifest(dir, manifest);

		expect(readManifest(dir)).toEqual(manifest);
	});

	test("creates rootDir when absent and writes pretty JSON with a trailing newline", () => {
		const dir = join(makeTmpDir(), "nested", ".opencode");

		writeManifest(dir, makeManifest());

		const raw = readFileSync(join(dir, MANIFEST_FILENAME), "utf-8");
		expect(raw.endsWith("}\n")).toBe(true);
		expect(raw).toInclude('\n  "harness": "opencode"');
	});

	test("returns null when the manifest is missing", () => {
		expect(readManifest(makeTmpDir())).toBeNull();
	});

	test("returns null when rootDir does not exist", () => {
		expect(readManifest(join(makeTmpDir(), "nope"))).toBeNull();
	});

	const corruptions: Array<[string, string]> = [
		["truncated JSON", "{"],
		["a JSON array", "[]"],
		["a JSON scalar", '"nope"'],
		["JSON null", "null"],
		["empty file", ""],
	];

	for (const [label, body] of corruptions) {
		test(`returns null for ${label}`, () => {
			const dir = makeTmpDir();
			writeFileSync(join(dir, MANIFEST_FILENAME), body, "utf-8");

			expect(readManifest(dir)).toBeNull();
		});
	}

	const shapeMutations: Array<[string, (m: Record<string, unknown>) => void]> =
		[
			["a future manifestVersion", (m) => (m.manifestVersion = 99)],
			["a non-numeric manifestVersion", (m) => (m.manifestVersion = "1")],
			["a missing harness", (m) => delete m.harness],
			["an unknown scope", (m) => (m.scope = "global")],
			["a missing hash", (m) => delete m.hash],
			["a non-boolean configResolved", (m) => (m.configResolved = "yes")],
			["a missing baseline", (m) => delete m.baseline],
			["an unknown baseline", (m) => (m.baseline = "yes")],
			["a missing installedAt", (m) => delete m.installedAt],
			["missing inputs", (m) => delete m.inputs],
			["missing installedFrom", (m) => delete m.installedFrom],
			["missing assets", (m) => delete m.assets],
			["a non-array assets", (m) => (m.assets = {})],
			["an asset without a path", (m) => (m.assets = [{ sha256: "abc" }])],
			[
				"an asset with a non-string sha256",
				(m) => (m.assets = [{ path: "a", sha256: 1 }]),
			],
		];

	for (const [label, mutate] of shapeMutations) {
		test(`returns null for ${label}`, () => {
			const dir = makeTmpDir();
			const raw = JSON.parse(JSON.stringify(makeManifest())) as Record<
				string,
				unknown
			>;
			mutate(raw);
			writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(raw), "utf-8");

			expect(readManifest(dir)).toBeNull();
		});
	}

	test("accepts an older manifestVersion", () => {
		const dir = makeTmpDir();
		writeManifest(dir, makeManifest({ manifestVersion: 0 }));

		expect(readManifest(dir)?.manifestVersion).toBe(0);
	});

	test("accepts a manifest with zero assets", () => {
		const dir = makeTmpDir();
		writeManifest(dir, makeManifest({ assets: [] }));

		expect(readManifest(dir)?.assets).toEqual([]);
	});
});

describe("removeManifest", () => {
	test("returns false when no manifest exists", () => {
		expect(removeManifest(makeTmpDir())).toBe(false);
	});

	test("returns true after a write and deletes the file", () => {
		const dir = makeTmpDir();
		writeManifest(dir, makeManifest());

		expect(removeManifest(dir)).toBe(true);
		expect(existsSync(join(dir, MANIFEST_FILENAME))).toBe(false);
		expect(removeManifest(dir)).toBe(false);
	});
});
