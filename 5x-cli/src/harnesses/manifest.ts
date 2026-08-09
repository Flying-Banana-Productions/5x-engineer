/**
 * Harness asset manifest — schema, canonicalization, hashing, read/write.
 *
 * `5x harness install` *compiles* harness assets: per-role model strings are
 * baked into agent frontmatter and delegation mode selects which skill
 * sections render. The manifest is the record of which inputs produced the
 * files sitting on disk, so staleness becomes decidable.
 *
 * Phase 1 (201-harness-freshness):
 * This module is deliberately harness-agnostic and dependency-free — no
 * imports from `factory.ts` or any harness plugin module, no CLI framework,
 * no Zod.
 * Every consumer (`harness install`/`sync`, `run init`, `config set`,
 * `upgrade`, and eventually `doctor`) sits outside the installer layer, and
 * Tier 1 freshness checks run on hot paths where a plugin load would be too
 * expensive (D7).
 *
 * The manifest file lives at `locations.rootDir` (not in `.5x/`) so it lives
 * and dies with the assets it describes: it travels with a committed
 * project-scope `.opencode/`, survives `.5x/` deletion, and never desyncs
 * when another project reinstalls shared user-scope assets.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join as pathJoin, posix } from "node:path";
import type { HarnessScope } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Manifest filename, written at `locations.rootDir`.
 *
 * The leading dot keeps it inert against harness *config* discovery
 * (`.opencode/opencode.json`, `.cursor/mcp.json` live at the same level);
 * asset discovery is inert by construction because all three shipped
 * harnesses read assets from subdirectories (D8, verified in Phase 0).
 */
export const MANIFEST_FILENAME = ".5x-manifest.json";

/** Current manifest schema version. A higher version on disk reads as unknown. */
export const MANIFEST_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One installed file, path relative to `locations.rootDir`, POSIX separators. */
export interface ManifestAssetEntry {
	path: string;
	sha256: string;
}

/**
 * The normalized baked-input surface (§2.2). `null` means "not baked"
 * (e.g. no model configured) and is distinct from the empty string.
 */
export interface ManifestInputs {
	authorModel: string | null;
	reviewerModel: string | null;
	authorDelegationMode: "native" | "invoke" | null;
	reviewerDelegationMode: "native" | "invoke" | null;
	/** `src/version.ts` value at install time. */
	cliVersion: string;
	/** Bundled plugins report the CLI version; external packages report their own. */
	harnessPluginVersion: string;
	/** Optional plugin-contributed inputs (D1). Empty for all bundled plugins. */
	plugin: Record<string, string | number>;
}

/** Raw (un-normalized) inputs as the install handler collects them. */
export interface RawManifestInputs {
	authorModel?: string;
	reviewerModel?: string;
	authorDelegationMode?: "native" | "invoke";
	reviewerDelegationMode?: "native" | "invoke";
	cliVersion: string;
	harnessPluginVersion: string;
	plugin?: Record<string, string | number>;
}

export interface ManifestProvenance {
	/** Absolute; advisory only; never compared for equality (§2.1). */
	projectRoot: string;
	/** Relative to `projectRoot`, POSIX separators, "" for the root context. */
	contextDir: string;
}

/**
 * Whether the recorded `inputs` are a trustworthy freshness baseline.
 *
 * - `"verified"`: at write time every asset the plugin renders for this
 *   context byte-matched the file on disk, so `inputs`/`hash` describe
 *   exactly what is installed. Only this value can ever compare `fresh`.
 * - `"unverified"`: the installed file set is a mixture — e.g. a non-force
 *   `harness install` skipped existing agent files (`installer.ts:100-104`)
 *   while skills were re-rendered. `inputs` then describe the last verified
 *   bake (retained from a prior manifest) or, absent one, the attempted bake
 *   for diagnostics only. Compares as `unknown` until `sync` re-establishes
 *   a baseline.
 */
export type ManifestBaseline = "verified" | "unverified";

export interface HarnessManifest {
	manifestVersion: number;
	harness: string;
	scope: HarnessScope;
	/** "sha256:<hex>" over the canonicalized `inputs`. */
	hash: string;
	/** false when config resolution threw at install time (§2.1). */
	configResolved: boolean;
	/** Trust level of `inputs`/`hash` as a freshness baseline (§3.2). */
	baseline: ManifestBaseline;
	installedFrom: ManifestProvenance;
	/**
	 * The baked-input surface `hash` covers. Meaningful as a baseline only
	 * when `baseline === "verified"`; otherwise diagnostic (drives warning
	 * copy) and never a basis for `fresh`.
	 */
	inputs: ManifestInputs;
	/** ISO-8601 UTC of the last manifest write. */
	installedAt: string;
	/**
	 * Always the true on-disk bytes at write time, regardless of `baseline`,
	 * so hand-edit detection stays accurate across partial installs.
	 */
	assets: ManifestAssetEntry[];
}

// ---------------------------------------------------------------------------
// Canonicalization and hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace.
 *
 * Arrays keep their order (position is meaningful). Non-JSON values
 * (`undefined`, functions, symbols, bigints, `NaN`/`Infinity`) throw rather
 * than being silently dropped — a fingerprint that quietly ignores an input
 * is worse than no fingerprint.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value, "$")) ?? "null";
}

function canonicalize(value: unknown, path: string): unknown {
	if (value === null) return null;

	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			if (!Number.isFinite(value)) {
				throw new Error(
					`canonicalJson: non-finite number at ${path} is not representable in JSON`,
				);
			}
			return value;
		case "object":
			break;
		default:
			throw new Error(
				`canonicalJson: value of type "${typeof value}" at ${path} is not representable in JSON`,
			);
	}

	if (Array.isArray(value)) {
		return value.map((entry, i) => canonicalize(entry, `${path}[${i}]`));
	}

	const source = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		out[key] = canonicalize(source[key], `${path}.${key}`);
	}
	return out;
}

/**
 * Normalize raw install inputs so semantically-equal configs hash equal:
 * model strings trimmed, `undefined`/blank collapsed to `null`, delegation
 * mode defaulted explicitly (anything that is not `"invoke"` renders native —
 * matching `authorNative = mode !== "invoke"` in `opencode/plugin.ts`), and
 * plugin inputs sorted.
 */
export function normalizeInputs(raw: RawManifestInputs): ManifestInputs {
	return {
		authorModel: normalizeModel(raw.authorModel),
		reviewerModel: normalizeModel(raw.reviewerModel),
		authorDelegationMode: normalizeDelegationMode(raw.authorDelegationMode),
		reviewerDelegationMode: normalizeDelegationMode(raw.reviewerDelegationMode),
		cliVersion: raw.cliVersion,
		harnessPluginVersion: raw.harnessPluginVersion,
		plugin: normalizePluginInputs(raw.plugin),
	};
}

/** `undefined`, `""` and whitespace-only all mean "not baked" → `null`. */
function normalizeModel(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/** Only an explicit `"invoke"` means invoke; everything else renders native. */
function normalizeDelegationMode(
	value: "native" | "invoke" | undefined,
): "native" | "invoke" {
	return value === "invoke" ? "invoke" : "native";
}

/** Absent plugin inputs are `{}`; present ones get a stable key order. */
function normalizePluginInputs(
	value: Record<string, string | number> | undefined,
): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	if (!value) return out;

	for (const key of Object.keys(value).sort()) {
		const entry = value[key];
		if (entry === undefined) continue;
		out[key] = entry;
	}
	return out;
}

/** "sha256:<hex>" over `canonicalJson(inputs)`. */
export function computeFingerprint(inputs: ManifestInputs): string {
	return `sha256:${sha256(canonicalJson(inputs))}`;
}

/** "<hex>" sha256 of a UTF-8 file body. Used for `assets[].sha256`. */
export function hashContent(content: string): string {
	return sha256(content);
}

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path to the manifest for a harness install root. */
export function manifestPath(rootDir: string): string {
	return pathJoin(rootDir, MANIFEST_FILENAME);
}

/**
 * Normalize an absolute asset path to a manifest-relative POSIX path.
 *
 * Both separators are accepted on either platform, so a manifest written on
 * Windows records the same `skills/5x-plan/SKILL.md` a Linux install does and
 * a committed project-scope manifest compares equal across machines.
 */
export function toManifestPath(rootDir: string, absolutePath: string): string {
	return posix.relative(toPosixPath(rootDir), toPosixPath(absolutePath));
}

function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/");
}

/**
 * Thrown when a harness's asset directories are not under its `rootDir`, so a
 * `rootDir`-relative manifest cannot represent them.
 */
export class ManifestPathEscapeError extends Error {
	readonly code = "MANIFEST_PATH_ESCAPE";
	readonly exitCode = 2;

	constructor(rootDir: string, offending: Array<{ key: string; dir: string }>) {
		super(
			`Harness asset directories must live under the install root, but ` +
				`${offending.map((o) => `${o.key} (${o.dir})`).join(", ")} ` +
				`${offending.length === 1 ? "is" : "are"} outside "${rootDir}".\n` +
				`A rootDir-relative manifest cannot describe them — the location ` +
				`resolver needs to keep asset directories under rootDir.`,
		);
		this.name = "ManifestPathEscapeError";
	}
}

/**
 * Assert that a resolver's asset directories all sit under `rootDir`.
 *
 * Manifest asset paths are recorded relative to `rootDir`, which holds for all
 * three shipped resolvers (`locations.ts`). This guard makes a future resolver
 * that breaks the assumption fail loudly at the manifest write rather than
 * silently recording `../../` paths that no consumer can resolve.
 */
export function assertAssetPathsUnderRoot(
	rootDir: string,
	locations: { skillsDir: string; agentsDir: string; rulesDir?: string },
): void {
	const candidates: Array<{ key: string; dir: string | undefined }> = [
		{ key: "skillsDir", dir: locations.skillsDir },
		{ key: "agentsDir", dir: locations.agentsDir },
		{ key: "rulesDir", dir: locations.rulesDir },
	];

	const offending: Array<{ key: string; dir: string }> = [];
	for (const { key, dir } of candidates) {
		if (dir === undefined) continue;
		if (!isUnderRoot(rootDir, dir)) offending.push({ key, dir });
	}

	if (offending.length > 0) {
		throw new ManifestPathEscapeError(rootDir, offending);
	}
}

/** True when `dir` is `rootDir` itself or a descendant of it. */
function isUnderRoot(rootDir: string, dir: string): boolean {
	const relative = toManifestPath(rootDir, dir);
	if (relative === "") return true;
	if (relative === ".." || relative.startsWith("../")) return false;
	// An absolute result means the two paths share no common base at all.
	return !posix.isAbsolute(relative);
}

// ---------------------------------------------------------------------------
// Read / write / remove
// ---------------------------------------------------------------------------

/**
 * Read the manifest at `rootDir`.
 *
 * Returns `null` on: missing file, unreadable file, invalid JSON, shape
 * mismatch, or `manifestVersion > MANIFEST_VERSION`. Never throws. Callers
 * treat `null` as unknown/stale (§4) — failing closed means a corrupt stamp
 * prompts a sync rather than silently asserting freshness.
 */
export function readManifest(rootDir: string): HarnessManifest | null {
	let raw: string;
	try {
		raw = readFileSync(manifestPath(rootDir), "utf-8");
	} catch {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	return isHarnessManifest(parsed) ? parsed : null;
}

/** Writes pretty-printed JSON + trailing newline. Creates `rootDir` if absent. */
export function writeManifest(
	rootDir: string,
	manifest: HarnessManifest,
): void {
	mkdirSync(rootDir, { recursive: true });
	writeFileSync(
		manifestPath(rootDir),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf-8",
	);
}

/** Returns true if a manifest existed and was removed. */
export function removeManifest(rootDir: string): boolean {
	const path = manifestPath(rootDir);
	if (!existsSync(path)) return false;

	try {
		rmSync(path);
		return true;
	} catch {
		// Concurrent removal or a permissions failure — report "not removed".
		return false;
	}
}

// ---------------------------------------------------------------------------
// Shape guard
// ---------------------------------------------------------------------------

/**
 * Hand-written shape guard rather than Zod: this runs on Tier 1 hot paths and
 * the module stays dependency-free.
 *
 * A missing or unrecognized `baseline` is *not* defaulted to `"verified"` —
 * an old or hand-written manifest fails closed to unknown rather than
 * asserting a baseline nobody verified.
 */
function isHarnessManifest(value: unknown): value is HarnessManifest {
	if (!isPlainObject(value)) return false;

	const m = value as Record<string, unknown>;

	if (typeof m.manifestVersion !== "number") return false;
	if (!Number.isFinite(m.manifestVersion)) return false;
	if (m.manifestVersion > MANIFEST_VERSION) return false;

	if (typeof m.harness !== "string") return false;
	if (m.scope !== "project" && m.scope !== "user") return false;
	if (typeof m.hash !== "string") return false;
	if (typeof m.configResolved !== "boolean") return false;
	if (m.baseline !== "verified" && m.baseline !== "unverified") return false;
	if (typeof m.installedAt !== "string") return false;
	if (!isPlainObject(m.inputs)) return false;
	if (!isPlainObject(m.installedFrom)) return false;

	if (!Array.isArray(m.assets)) return false;
	for (const asset of m.assets) {
		if (!isPlainObject(asset)) return false;
		const entry = asset as Record<string, unknown>;
		if (typeof entry.path !== "string") return false;
		if (typeof entry.sha256 !== "string") return false;
	}

	return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
