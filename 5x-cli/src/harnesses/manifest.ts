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
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join as pathJoin, posix } from "node:path";
import type { InstallSummary } from "./installer.js";
import type { HarnessScope, RenderedAsset } from "./types.js";

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

/**
 * Raw (un-normalized) inputs as the install handler collects them.
 *
 * `null` is accepted alongside `undefined` so an already-normalized
 * `ManifestInputs` (e.g. one retained from a prior manifest) can be fed back
 * through `normalizeInputs` unchanged — normalization is idempotent.
 */
export interface RawManifestInputs {
	authorModel?: string | null;
	reviewerModel?: string | null;
	authorDelegationMode?: "native" | "invoke" | null;
	reviewerDelegationMode?: "native" | "invoke" | null;
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

/** `undefined`, `null`, `""` and whitespace-only all mean "not baked" → `null`. */
function normalizeModel(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/** Only an explicit `"invoke"` means invoke; everything else renders native. */
function normalizeDelegationMode(
	value: "native" | "invoke" | null | undefined,
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
 * True when `relPath` is a manifest-representable path: relative to `rootDir`,
 * POSIX-separated, and provably staying underneath it.
 *
 * Every recorded path is resolved against `rootDir` before being read and
 * hashed, so a path that escapes would make the manifest read and record files
 * outside the install root. Rejected: the empty path, absolute paths (POSIX or
 * Windows drive-qualified), any `.`/`..`/empty segment, embedded backslashes
 * (a separator on Windows, so `..\..\x` would traverse), and NUL bytes.
 */
export function isSafeManifestPath(relPath: string): boolean {
	if (relPath === "") return false;
	if (relPath.includes("\0")) return false;
	if (relPath.includes("\\")) return false;
	if (posix.isAbsolute(relPath)) return false;
	if (/^[a-zA-Z]:/.test(relPath)) return false;

	return relPath
		.split("/")
		.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Thrown when something the manifest must describe cannot be expressed as a
 * `rootDir`-relative path — either a harness's asset *directories* sit outside
 * `rootDir`, or a declared asset *path* escapes it.
 */
export class ManifestPathEscapeError extends Error {
	readonly code = "MANIFEST_PATH_ESCAPE";
	readonly exitCode = 2;

	private constructor(message: string) {
		super(message);
		this.name = "ManifestPathEscapeError";
	}

	/** A location resolver whose asset directories are not under `rootDir`. */
	static forDirs(
		rootDir: string,
		offending: Array<{ key: string; dir: string }>,
	): ManifestPathEscapeError {
		return new ManifestPathEscapeError(
			`Harness asset directories must live under the install root, but ` +
				`${offending.map((o) => `${o.key} (${o.dir})`).join(", ")} ` +
				`${offending.length === 1 ? "is" : "are"} outside "${rootDir}".\n` +
				`A rootDir-relative manifest cannot describe them — the location ` +
				`resolver needs to keep asset directories under rootDir.`,
		);
	}

	/** Declared asset paths that do not resolve under `rootDir`. */
	static forAssetPaths(
		rootDir: string,
		source: string,
		paths: string[],
	): ManifestPathEscapeError {
		return new ManifestPathEscapeError(
			`${source} declared asset ${paths.length === 1 ? "path" : "paths"} ` +
				`that ${paths.length === 1 ? "does" : "do"} not stay under the ` +
				`install root "${rootDir}": ${paths.map((p) => `"${p}"`).join(", ")}.\n` +
				`Manifest asset paths must be relative to rootDir with POSIX ` +
				`separators and no "..", so the manifest can never read or record ` +
				`files outside the install root.`,
		);
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
		throw ManifestPathEscapeError.forDirs(rootDir, offending);
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
// Install-time inventory: collect → verify → build
// ---------------------------------------------------------------------------

/** Asset directories for one harness scope, as `locations.resolve()` returns them. */
export interface ManifestAssetDirs {
	skillsDir: string;
	agentsDir: string;
	rulesDir?: string;
}

/**
 * One `InstallSummary` tagged with the asset kind it describes.
 *
 * The summaries report bare names (`5x-plan/SKILL.md`, `5x-plan-author.md`),
 * so the kind is what resolves them against the right directory.
 */
export interface KindedInstallSummary {
	kind: RenderedAsset["kind"];
	summary: InstallSummary;
}

/**
 * Hash the on-disk bytes of every path this install could have touched.
 *
 * The path set is the union of (a) the plugin's rendered asset paths, (b) every
 * path named by an `InstallSummary` (`created ∪ overwritten ∪ skipped` — a
 * skipped file is still installed, just not rewritten), and (c) paths a prior
 * manifest recorded that still exist. Files that fail to read are omitted
 * rather than recorded with a bogus hash.
 *
 * Bytes always come from disk, never from the rendered string: the manifest's
 * `assets` must describe what is actually installed even when `install()`
 * preserved an existing file (§3.2).
 *
 * Every path is proven to stay under `rootDir` twice over. Lexically first:
 * plugin- and installer-supplied paths that traverse or go absolute throw
 * `MANIFEST_PATH_ESCAPE` (that is a bug in the harness), while prior-manifest
 * paths are untrusted on-disk data and are dropped silently instead
 * (`readManifest` already rejects such a manifest). Then physically: each
 * surviving path is `realpath`-resolved against the resolved root before it is
 * read, so a lexically innocent path routed through a symlinked directory
 * inside the root cannot make this hash an external file. Escapes found that
 * way are dropped, which fails closed through `verifyInstalledInventory`.
 */
export function collectInstalledAssets(args: {
	rootDir: string;
	locations: ManifestAssetDirs;
	/** `null` when the plugin does not implement `renderAssets()`. */
	rendered: RenderedAsset[] | null;
	summaries: KindedInstallSummary[];
	/** Manifest present before this install, if any. */
	prior: HarnessManifest | null;
}): Map<string, string> {
	const paths = new Set<string>();

	const renderedEscapes = (args.rendered ?? [])
		.map((asset) => asset.path)
		.filter((path) => !isSafeManifestPath(path));
	if (renderedEscapes.length > 0) {
		throw ManifestPathEscapeError.forAssetPaths(
			args.rootDir,
			"renderAssets()",
			renderedEscapes,
		);
	}
	for (const asset of args.rendered ?? []) {
		paths.add(asset.path);
	}

	const summaryEscapes: string[] = [];
	for (const { kind, summary } of args.summaries) {
		const dir = assetDirForKind(kind, args.locations);
		if (!dir) continue;
		for (const entry of [
			...summary.created,
			...summary.overwritten,
			...summary.skipped,
		]) {
			// Relativizing against rootDir catches both a traversing entry and an
			// asset directory that itself sits outside the root.
			const relPath = toManifestPath(
				args.rootDir,
				joinManifestPath(dir, entry),
			);
			if (!isSafeManifestPath(entry) || !isSafeManifestPath(relPath)) {
				summaryEscapes.push(entry);
				continue;
			}
			paths.add(relPath);
		}
	}
	if (summaryEscapes.length > 0) {
		throw ManifestPathEscapeError.forAssetPaths(
			args.rootDir,
			"The install summary",
			summaryEscapes,
		);
	}

	for (const asset of args.prior?.assets ?? []) {
		if (!isSafeManifestPath(asset.path)) continue;
		paths.add(asset.path);
	}

	const realRootDir = realRoot(args.rootDir);

	const onDisk = new Map<string, string>();
	for (const relPath of [...paths].sort()) {
		const resolved = resolveInsideRoot(realRootDir, relPath);
		if (resolved === null) continue;

		let content: string;
		try {
			content = readFileSync(resolved, "utf-8");
		} catch {
			// Unreadable (permissions, a directory, a race) — omit it entirely.
			continue;
		}
		onDisk.set(relPath, hashContent(content));
	}

	return onDisk;
}

/**
 * `rootDir` with every symlink in it resolved, so containment checks compare
 * real locations rather than the path the caller happened to spell.
 *
 * Install roots legitimately sit under symlinks (`/tmp` on macOS, a symlinked
 * `~/.config`, a dotfile-manager'd home), and resolving the root is what keeps
 * those from reading as escapes. Falls back to the literal path when the root
 * does not exist yet — nothing under it will resolve either, so every candidate
 * is dropped.
 */
function realRoot(rootDir: string): string {
	try {
		return realpathSync(rootDir);
	} catch {
		return rootDir;
	}
}

/**
 * Resolve a manifest-relative path to a real, symlink-free absolute path that
 * provably stays under `realRootDir`, or `null` when it does not.
 *
 * `isSafeManifestPath` is *lexical* only, and lexical safety is not containment:
 * an innocent-looking `skills/5x-plan/SKILL.md` can traverse a symlinked
 * directory inside the install root and land on an arbitrary external file,
 * which `readFileSync` would follow and hash. Resolving first — and then reading
 * the resolved path rather than the spelled one — is what makes the manifest's
 * root-relative contract true of the bytes it records.
 *
 * Missing paths return `null` and are simply omitted, the same as any other
 * unreadable path: a recorded asset that no longer exists has nothing to hash.
 * An escape is dropped rather than thrown, because a symlink is on-disk state
 * (a user's dotfile manager, not a harness bug) and failing the whole install
 * over it would be disproportionate. Dropping fails closed instead: a rendered
 * asset that disappears from `onDisk` makes `verifyInstalledInventory` false, so
 * the manifest records `baseline: "unverified"` and asks for a `sync`.
 */
function resolveInsideRoot(
	realRootDir: string,
	relPath: string,
): string | null {
	let resolved: string;
	try {
		resolved = realpathSync(joinManifestPath(realRootDir, relPath));
	} catch {
		// Missing, unreadable, or a broken/looping symlink.
		return null;
	}

	return isUnderRoot(realRootDir, resolved) ? resolved : null;
}

/**
 * An asset reader for Tier 2: manifest-relative path → file contents, or `null`
 * when the path is absent, unreadable, or not manifest-representable.
 *
 * Recorded paths are untrusted input (a manifest can be committed, or hand
 * edited), so reads go through the same lexical *and* symlink containment
 * `collectInstalledAssets` uses — Tier 2 must never be steerable into hashing a
 * file outside the install root. The root is resolved once per reader.
 */
export function makeAssetReader(
	rootDir: string,
): (relPath: string) => string | null {
	const realRootDir = realRoot(rootDir);

	return (relPath) => {
		if (!isSafeManifestPath(relPath)) return null;

		const resolved = resolveInsideRoot(realRootDir, relPath);
		if (resolved === null) return null;

		try {
			return readFileSync(resolved, "utf-8");
		} catch {
			return null;
		}
	};
}

function assetDirForKind(
	kind: RenderedAsset["kind"],
	locations: ManifestAssetDirs,
): string | undefined {
	switch (kind) {
		case "skill":
			return locations.skillsDir;
		case "agent":
			return locations.agentsDir;
		case "rule":
			return locations.rulesDir;
	}
}

/** Join a POSIX-relative manifest path onto a platform-native base directory. */
function joinManifestPath(baseDir: string, relPath: string): string {
	return pathJoin(baseDir, ...relPath.split("/"));
}

/**
 * True only when every asset the plugin renders for this context is present on
 * disk with byte-identical content.
 *
 * A single skipped-stale agent file (or any other drift) makes this false, and
 * a false result forbids adopting the current inputs as the freshness baseline
 * (§3.2) — that is what stops a plain reinstall after a model change from
 * stamping a fingerprint over bytes it did not produce.
 *
 * Plugins without `renderAssets()` have no render to compare against, so the
 * fallback is the conservative structural rule: verified iff every summary
 * skipped nothing. That can under-report freshness for an external plugin that
 * legitimately skips byte-identical files; under-reporting costs one `sync`,
 * over-reporting costs a silent stale bake.
 */
export function verifyInstalledInventory(args: {
	/** `null` when the plugin does not implement `renderAssets()`. */
	rendered: RenderedAsset[] | null;
	/** Manifest-relative path → sha256 of the on-disk bytes. */
	onDisk: Map<string, string>;
	/** Every `InstallSummary` the plugin returned — the fallback evidence. */
	summaries: InstallSummary[];
}): boolean {
	if (args.rendered) {
		for (const asset of args.rendered) {
			const actual = args.onDisk.get(asset.path);
			if (actual === undefined) return false;
			if (actual !== hashContent(asset.content)) return false;
		}
		return true;
	}

	return args.summaries.every((summary) => summary.skipped.length === 0);
}

/** Manifest `assets` entries from a collected on-disk hash map, path-sorted. */
export function assetsFromOnDisk(
	onDisk: Map<string, string>,
): ManifestAssetEntry[] {
	return [...onDisk.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([path, sha256]) => ({ path, sha256 }));
}

/**
 * Assemble a manifest, recomputing `hash` from the `inputs` it is handed so the
 * two can never disagree.
 *
 * `baseline` is explicit and has no default: the caller must have decided,
 * via `verifyInstalledInventory`, whether these inputs are a trustworthy
 * baseline. `installedFrom`/`installedAt` always describe *this* write, not the
 * baseline — an unverified manifest is already blocked from reading `fresh`,
 * so recording the true provenance of the last write cannot mislead.
 *
 * Asserts the resolver's asset directories *and* every recorded asset path live
 * under `rootDir`, since every recorded path is `rootDir`-relative. This is the
 * single write chokepoint, so no manifest can be written naming a file outside
 * the install root.
 */
export function buildManifest(args: {
	harness: string;
	scope: HarnessScope;
	rootDir: string;
	locations: ManifestAssetDirs;
	projectRoot: string;
	/** Relative to `projectRoot`, POSIX separators, "" for the root context. */
	contextDir: string;
	baseline: ManifestBaseline;
	configResolved: boolean;
	inputs: RawManifestInputs;
	assets: ManifestAssetEntry[];
	/** ISO-8601 UTC; defaults to now. Injectable for deterministic tests. */
	installedAt?: string;
}): HarnessManifest {
	assertAssetPathsUnderRoot(args.rootDir, args.locations);

	const escapes = args.assets
		.map((asset) => asset.path)
		.filter((path) => !isSafeManifestPath(path));
	if (escapes.length > 0) {
		throw ManifestPathEscapeError.forAssetPaths(
			args.rootDir,
			"The manifest asset set",
			escapes,
		);
	}

	const inputs = normalizeInputs(args.inputs);

	return {
		manifestVersion: MANIFEST_VERSION,
		harness: args.harness,
		scope: args.scope,
		hash: computeFingerprint(inputs),
		configResolved: args.configResolved,
		baseline: args.baseline,
		installedFrom: {
			projectRoot: args.projectRoot,
			contextDir: args.contextDir,
		},
		inputs,
		installedAt: args.installedAt ?? new Date().toISOString(),
		assets: args.assets,
	};
}

// ---------------------------------------------------------------------------
// Freshness comparison (Tier 1 / Tier 2)
// ---------------------------------------------------------------------------

export type FreshnessStatus = "fresh" | "stale" | "unknown" | "not-installed";

export type FreshnessReason =
	| "no-manifest"
	| "manifest-unreadable"
	| "config-unresolved"
	/** `baseline: "unverified"` — a partial install never established a baseline (§3.2). */
	| "baseline-unverified"
	| "inputs-changed"
	| "assets-drifted"
	| "assets-modified"
	| null;

export interface InputDelta {
	/** Dotted config-facing key, e.g. "author.model". */
	key: string;
	installed: string | null;
	current: string | null;
}

export type AssetDeltaState =
	/** on-disk ≠ recorded → user hand-edited it (blocks lossless refresh) */
	| "modified"
	/** recorded, absent on disk */
	| "missing"
	/** re-render ≠ recorded → bundled-template or config drift; sync will rewrite */
	| "drifted"
	/** re-render produced a path not in the manifest; sync will create it */
	| "added"
	/** recorded path no longer rendered; sync will remove it */
	| "orphaned";

export interface AssetDelta {
	path: string;
	state: AssetDeltaState;
}

export type LosslessBlocker =
	| "shared-user-scope"
	| "context-mismatch"
	| "assets-modified"
	| "no-manifest"
	| "config-unresolved"
	| "baseline-unverified";

export interface FreshnessReport {
	harness: string;
	scope: HarnessScope;
	rootDir: string;
	tier: 1 | 2;
	status: FreshnessStatus;
	reason: FreshnessReason;
	inputDeltas: InputDelta[];
	/** Empty at Tier 1. */
	assetDeltas: AssetDelta[];
	/** Safety gate only — never a permission to write (Phase 7.1). */
	losslessRefresh: boolean;
	losslessBlockers: LosslessBlocker[];
	installedFrom: ManifestProvenance | null;
	/** `null` when there is no readable manifest. */
	baseline: ManifestBaseline | null;
}

export interface CompareArgs {
	harness: string;
	scope: HarnessScope;
	rootDir: string;
	/** True when any managed asset exists on disk (drives "not-installed"). */
	installed: boolean;
	/** Inputs resolved from config right now, pre-normalization. */
	current: RawManifestInputs;
	/** Context resolving config right now, relative to projectRoot, POSIX. */
	currentContextDir: string;
	/** Tier 2 only: freshly rendered assets. Omit for Tier 1. */
	rendered?: RenderedAsset[];
	/** Tier 2 only: reads a manifest-relative path; returns null if absent. */
	readAsset?: (relPath: string) => string | null;
}

/** Manifest input field → the config-facing key a warning names it by. */
const INPUT_DELTA_KEYS: Array<{
	field: keyof Omit<ManifestInputs, "plugin">;
	key: string;
}> = [
	{ field: "authorModel", key: "author.model" },
	{ field: "reviewerModel", key: "reviewer.model" },
	{ field: "authorDelegationMode", key: "author.delegationMode" },
	{ field: "reviewerDelegationMode", key: "reviewer.delegationMode" },
	{ field: "cliVersion", key: "cliVersion" },
	{ field: "harnessPluginVersion", key: "harnessPluginVersion" },
];

/**
 * Compare what is installed at `rootDir` against the config resolving right now.
 *
 * Tier 1 (the default, and the only tier on hot paths) compares fingerprints —
 * no plugin load, no render, one small file read. Tier 2 additionally compares
 * per-file hashes, which is what makes template drift and user hand-edits
 * visible; it is selected by supplying `readAsset` (plus `rendered`, when the
 * plugin implements `renderAssets()` — without it Tier 2 degrades to on-disk vs
 * recorded, i.e. hand-edit detection only).
 *
 * Failure is always closed: anything that cannot be proven fresh reads
 * `unknown`, never `fresh`, so no fire point falls silent and no caller can
 * auto-refresh on the strength of a baseline nobody verified.
 */
export function compareManifest(args: CompareArgs): FreshnessReport {
	const tier: 1 | 2 = args.readAsset ? 2 : 1;

	const base = {
		harness: args.harness,
		scope: args.scope,
		rootDir: args.rootDir,
		tier,
	} as const;

	// 1. Nothing installed — nothing to be stale about, and no blocker means
	//    anything, since there is no refresh to perform.
	if (!args.installed) {
		return {
			...base,
			status: "not-installed",
			reason: null,
			inputDeltas: [],
			assetDeltas: [],
			losslessRefresh: false,
			losslessBlockers: [],
			installedFrom: null,
			baseline: null,
		};
	}

	// 2. No usable manifest — assets exist but nothing records what produced
	//    them. A manifest file that is present but rejected is reported
	//    separately, since "corrupt" and "never stamped" ask for the same fix
	//    but are worth different diagnostics.
	const manifest = readManifest(args.rootDir);
	if (!manifest) {
		return {
			...base,
			status: "unknown",
			reason: existsSync(manifestPath(args.rootDir))
				? "manifest-unreadable"
				: "no-manifest",
			inputDeltas: [],
			assetDeltas: [],
			losslessRefresh: false,
			losslessBlockers: ["no-manifest"],
			installedFrom: null,
			baseline: null,
		};
	}

	const current = normalizeInputs(args.current);
	const inputDeltas = computeInputDeltas(manifest.inputs, current);
	const assetDeltas =
		tier === 2 ? computeAssetDeltas(manifest, args) : ([] as AssetDelta[]);

	const blockers: LosslessBlocker[] = [];
	// 3. Config resolution threw at install time, so the recorded inputs are an
	//    accident rather than an intention — treated exactly like a missing
	//    manifest (§2.1).
	if (!manifest.configResolved) blockers.push("config-unresolved");
	// 4. A partial install never established a baseline. Evaluated before the
	//    fingerprint compare and terminal for `status`: the fingerprint over
	//    retained inputs would otherwise decide the verdict (§3.2).
	if (manifest.baseline !== "verified") blockers.push("baseline-unverified");
	// D4 — one physical asset copy serves N projects at user scope, and
	// `installedFrom.projectRoot` is explicitly non-comparable.
	if (args.scope === "user") blockers.push("shared-user-scope");
	if (manifest.installedFrom.contextDir !== args.currentContextDir) {
		blockers.push("context-mismatch");
	}
	const modified = assetDeltas.some((delta) => delta.state === "modified");
	if (modified) blockers.push("assets-modified");

	const unknownReason: FreshnessReason | null = !manifest.configResolved
		? "config-unresolved"
		: manifest.baseline !== "verified"
			? "baseline-unverified"
			: null;

	let status: FreshnessStatus;
	let reason: FreshnessReason;
	if (unknownReason) {
		status = "unknown";
		reason = unknownReason;
	} else if (modified) {
		// A hand-edit is the case that blocks refresh, so it outranks the rest
		// in reporting.
		status = "stale";
		reason = "assets-modified";
	} else if (computeFingerprint(current) !== manifest.hash) {
		// More specific than the drift it necessarily causes at Tier 2: an input
		// change names the field the user changed, drift only names files.
		status = "stale";
		reason = "inputs-changed";
	} else if (assetDeltas.length > 0) {
		status = "stale";
		reason = "assets-drifted";
	} else {
		status = "fresh";
		reason = null;
	}

	return {
		...base,
		status,
		reason,
		inputDeltas,
		assetDeltas,
		// Tier 1 cannot observe hand-edits, so it can never assert a lossless
		// refresh — that is what makes auto-sync on incomplete evidence
		// impossible (§4.2).
		losslessRefresh: tier === 2 && blockers.length === 0,
		losslessBlockers: blockers,
		installedFrom: manifest.installedFrom,
		baseline: manifest.baseline,
	};
}

/**
 * Field-by-field diff of the recorded baseline against the inputs resolving now.
 *
 * Only changed fields are returned — warning copy shows exactly what moved, and
 * a warning padded with unchanged lines is one users learn to skip.
 */
function computeInputDeltas(
	installed: ManifestInputs,
	current: ManifestInputs,
): InputDelta[] {
	const deltas: InputDelta[] = [];

	for (const { field, key } of INPUT_DELTA_KEYS) {
		const before = installed[field] ?? null;
		const after = current[field] ?? null;
		if (before !== after) {
			deltas.push({ key, installed: before, current: after });
		}
	}

	const installedPlugin = installed.plugin ?? {};
	const currentPlugin = current.plugin ?? {};
	const pluginKeys = [
		...new Set([
			...Object.keys(installedPlugin),
			...Object.keys(currentPlugin),
		]),
	].sort();
	for (const key of pluginKeys) {
		const before = installedPlugin[key];
		const after = currentPlugin[key];
		if (before !== after) {
			deltas.push({
				key: `plugin.${key}`,
				installed: before === undefined ? null : String(before),
				current: after === undefined ? null : String(after),
			});
		}
	}

	return deltas;
}

/**
 * Tier 2 per-file comparison: recorded vs on disk, and recorded vs re-render.
 *
 * A path can legitimately appear twice — a file the user edited *and* whose
 * template moved is both `modified` and `drifted`, and collapsing that would
 * hide the edit that blocks the refresh.
 */
function computeAssetDeltas(
	manifest: HarnessManifest,
	args: CompareArgs,
): AssetDelta[] {
	const readAsset = args.readAsset;
	if (!readAsset) return [];

	const deltas: AssetDelta[] = [];
	const recorded = new Map(
		manifest.assets.map((asset) => [asset.path, asset.sha256]),
	);

	for (const asset of manifest.assets) {
		const content = readAsset(asset.path);
		if (content === null) {
			deltas.push({ path: asset.path, state: "missing" });
			continue;
		}
		if (hashContent(content) !== asset.sha256) {
			deltas.push({ path: asset.path, state: "modified" });
		}
	}

	// Without a render there is nothing to compare templates against — hand-edit
	// detection above is the safety-critical half and still applies.
	if (!args.rendered) return sortAssetDeltas(deltas);

	const renderedPaths = new Set<string>();
	for (const asset of args.rendered) {
		renderedPaths.add(asset.path);
		const recordedHash = recorded.get(asset.path);
		if (recordedHash === undefined) {
			deltas.push({ path: asset.path, state: "added" });
			continue;
		}
		if (hashContent(asset.content) !== recordedHash) {
			deltas.push({ path: asset.path, state: "drifted" });
		}
	}

	for (const asset of manifest.assets) {
		if (!renderedPaths.has(asset.path)) {
			deltas.push({ path: asset.path, state: "orphaned" });
		}
	}

	return sortAssetDeltas(deltas);
}

function sortAssetDeltas(deltas: AssetDelta[]): AssetDelta[] {
	return deltas.sort(
		(a, b) => a.path.localeCompare(b.path) || a.state.localeCompare(b.state),
	);
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
 *
 * An asset path that does not stay under `rootDir` rejects the whole manifest
 * for the same reason: consumers resolve these paths against `rootDir` to read
 * and re-hash them, so a traversal entry in an untrusted (committed, or
 * hand-edited) manifest must never reach them.
 *
 * `inputs` and `installedFrom` are validated field-by-field rather than as bare
 * objects. A partial `inputs` is the sharpest false-fresh hazard in the whole
 * module: `normalizeInputs` fills absent fields with their defaults (`plugin`
 * to `{}`, delegation modes to `"native"`), so a hand-edited manifest that
 * simply *drops* `inputs.plugin` would still fingerprint-match the current
 * config and read `fresh` while describing a bake nobody performed. Incomplete
 * stamps must fail closed to `manifest-unreadable`/`unknown`.
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
	if (!isManifestInputs(m.inputs)) return false;
	if (!isManifestProvenance(m.installedFrom)) return false;

	if (!Array.isArray(m.assets)) return false;
	for (const asset of m.assets) {
		if (!isPlainObject(asset)) return false;
		const entry = asset as Record<string, unknown>;
		if (typeof entry.path !== "string") return false;
		if (typeof entry.sha256 !== "string") return false;
		if (!isSafeManifestPath(entry.path)) return false;
	}

	return true;
}

/**
 * Every field of {@link ManifestInputs} must be present with its exact type —
 * absent is not "default", it is corrupt. See the note on `isHarnessManifest`.
 */
function isManifestInputs(value: unknown): value is ManifestInputs {
	if (!isPlainObject(value)) return false;

	if (!isNullableString(value.authorModel)) return false;
	if (!isNullableString(value.reviewerModel)) return false;
	if (!isNullableDelegationMode(value.authorDelegationMode)) return false;
	if (!isNullableDelegationMode(value.reviewerDelegationMode)) return false;
	if (typeof value.cliVersion !== "string") return false;
	if (typeof value.harnessPluginVersion !== "string") return false;

	// `plugin` is the external-harness escape hatch (D1), so its keys are open
	// but its value types are not — anything else cannot round-trip through
	// `canonicalJson` and would poison the fingerprint.
	if (!isPlainObject(value.plugin)) return false;
	for (const entry of Object.values(value.plugin)) {
		if (typeof entry === "string") continue;
		if (typeof entry === "number" && Number.isFinite(entry)) continue;
		return false;
	}

	return true;
}

function isManifestProvenance(value: unknown): value is ManifestProvenance {
	if (!isPlainObject(value)) return false;
	if (typeof value.projectRoot !== "string") return false;
	if (typeof value.contextDir !== "string") return false;
	return true;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isNullableDelegationMode(
	value: unknown,
): value is "native" | "invoke" | null {
	return value === null || value === "native" || value === "invoke";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
