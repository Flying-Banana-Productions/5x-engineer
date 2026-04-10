/**
 * Config command handler — business logic for `5x config` subcommands.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Subcommands:
 * - show: Display the resolved config as a JSON envelope
 * - set / unset / add / remove: TOML mutation with comment-preserving patches
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	parse as tomlParse,
	patch as tomlPatch,
} from "@decimalturn/toml-patch";
import {
	discoverConfigFile,
	type LayeredConfigResult,
	resolveLayeredConfig,
} from "../config.js";
import {
	type ConfigKeyMeta,
	computeLocalKeys,
	flattenConfig,
	getConfigRegistry,
	isRegistryKeyOrRecordDescendant,
	resolveWritableArrayConfigKey,
	resolveWritableConfigKey,
	type WritableKeyResolution,
} from "../config-registry.js";
import { getOutputFormat, outputError, outputSuccess } from "../output.js";
import { resolveAnsi } from "../utils/ansi.js";
import { resolveControlPlaneRoot } from "./control-plane.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigShowEntry {
	key: string;
	description: string;
	type: string;
	default: unknown;
	value: unknown;
	isLocal: boolean;
	/** When `type` is `enum`, all valid options from the Zod schema. */
	enumValues?: string[];
}

export interface ConfigShowOutput {
	files: string[];
	entries: ConfigShowEntry[];
}

export interface ConfigShowParams {
	/** Starting directory for control-plane root resolution (testability). */
	startDir?: string;
	/** Directory for plan-path-anchored config layering. Defaults to cwd. */
	contextDir?: string;
	/** When set, only this dotted key (must match a shown entry). */
	key?: string;
}

export interface ConfigSetParams {
	key: string;
	value: string;
	local?: boolean;
	startDir?: string;
	contextDir?: string;
}

export interface ConfigUnsetParams {
	key: string;
	local?: boolean;
	startDir?: string;
	contextDir?: string;
}

export interface ConfigAddParams {
	key: string;
	value: string;
	local?: boolean;
	startDir?: string;
	contextDir?: string;
}

export interface ConfigRemoveParams {
	key: string;
	value: string;
	local?: boolean;
	startDir?: string;
	contextDir?: string;
}

// ---------------------------------------------------------------------------
// Target path resolution & active source (config set / unset)
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk upward from `startDir` to `stopDir` (inclusive) and return the first
 * existing `5x.toml` path, or null if none.
 */
export function discoverNearestTomlPath(
	startDir: string,
	stopDir: string,
): string | null {
	let dir = resolve(startDir);
	const boundary = resolve(stopDir);
	const root = resolve("/");

	while (true) {
		const candidate = join(dir, "5x.toml");
		if (existsSync(candidate)) {
			return candidate;
		}
		if (dir === boundary) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir || dir === root) {
			break;
		}
		dir = parent;
	}

	return null;
}

function mergeConfigObjects(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };

	for (const key of Object.keys(override)) {
		const baseVal = base[key];
		const overVal = override[key];

		if (Array.isArray(overVal)) {
			result[key] = overVal;
		} else if (isPlainRecord(overVal) && isPlainRecord(baseVal)) {
			result[key] = mergeConfigObjects(baseVal, overVal);
		} else {
			result[key] = overVal;
		}
	}

	return result;
}

export interface ResolveTargetConfigPathResult {
	controlPlaneRoot: string;
	targetPath: string;
}

/**
 * Resolve the TOML file path that `config set` / `unset` should read/write.
 */
export function resolveTargetConfigPath(params: {
	startDir?: string;
	contextDir?: string;
	local?: boolean;
}): ResolveTargetConfigPathResult {
	const cp = resolveControlPlaneRoot(params.startDir);
	const controlPlaneRoot = resolve(cp.controlPlaneRoot);
	const contextDir = resolve(params.contextDir ?? process.cwd());

	const relToRoot = relative(controlPlaneRoot, contextDir);
	const contextInsideRoot =
		relToRoot === "" || (!relToRoot.startsWith("..") && !isAbsolute(relToRoot));

	if (!contextInsideRoot) {
		outputError(
			"INVALID_ARGS",
			`Config context directory must be inside the control plane root: ${controlPlaneRoot}`,
		);
	}

	let baseToml: string;
	if (contextDir === controlPlaneRoot) {
		baseToml = join(controlPlaneRoot, "5x.toml");
	} else {
		const nearest = discoverNearestTomlPath(contextDir, controlPlaneRoot);
		baseToml = nearest ?? join(controlPlaneRoot, "5x.toml");
	}

	const targetPath = params.local
		? join(dirname(baseToml), "5x.toml.local")
		: baseToml;

	return { controlPlaneRoot, targetPath };
}

export type ActiveConfigSourceKind = "toml" | "js" | "none";

/**
 * Classify the primary config file discovered from `contextDir` (same walk as
 * {@link discoverConfigFile}), bounded by the control-plane root.
 */
export function detectActiveConfigSource(
	controlPlaneRoot: string,
	contextDir: string,
): ActiveConfigSourceKind {
	const root = resolve(controlPlaneRoot);
	const ctx = resolve(contextDir);

	const relToRoot = relative(root, ctx);
	const contextInsideRoot =
		relToRoot === "" || (!relToRoot.startsWith("..") && !isAbsolute(relToRoot));

	if (!contextInsideRoot) {
		return "none";
	}

	const discoveryStart = ctx === root ? root : ctx;
	const primary = discoverConfigFile(discoveryStart, root);
	if (!primary) {
		return "none";
	}
	if (primary.endsWith(".toml")) {
		return "toml";
	}
	return "js";
}

function isRootDbConfigTarget(
	targetPath: string,
	controlPlaneRoot: string,
): boolean {
	const r = resolve(controlPlaneRoot);
	const p = resolve(targetPath);
	return (
		p === resolve(join(r, "5x.toml")) || p === resolve(join(r, "5x.toml.local"))
	);
}

function buildNestedFromDotted(
	dotted: string,
	value: unknown,
): Record<string, unknown> {
	const parts = dotted.split(".");
	if (parts.length === 0) {
		return {};
	}

	let cur: Record<string, unknown> = {};
	const root = cur;

	for (let i = 0; i < parts.length - 1; i++) {
		const seg = parts[i];
		if (seg === undefined) {
			return root;
		}
		const next: Record<string, unknown> = {};
		cur[seg] = next;
		cur = next;
	}
	const last = parts[parts.length - 1];
	if (last === undefined) {
		return root;
	}
	cur[last] = value as unknown;
	return root;
}

function coerceConfigValue(
	resolution: WritableKeyResolution,
	raw: string,
): unknown {
	if (resolution.kind === "recordChild") {
		return raw;
	}

	const meta = resolution.meta;
	const t = meta.type;

	if (t === "string") {
		return raw;
	}

	if (t === "number") {
		const n = Number(raw);
		if (!Number.isFinite(n) || !Number.isInteger(n)) {
			outputError(
				"INVALID_ARGS",
				`Invalid number for ${meta.key}: expected an integer, got "${raw}"`,
			);
		}
		return n;
	}

	if (t === "boolean") {
		if (raw === "true") {
			return true;
		}
		if (raw === "false") {
			return false;
		}
		outputError(
			"INVALID_ARGS",
			`Invalid boolean for ${meta.key}: use "true" or "false" (got "${raw}")`,
		);
	}

	if (t === "enum") {
		const allowed = meta.allowedValues;
		if (allowed && !allowed.includes(raw)) {
			outputError(
				"INVALID_ARGS",
				`Invalid value for ${meta.key}: must be one of ${allowed.join(", ")}`,
			);
		}
		return raw;
	}

	outputError(
		"INVALID_ARGS",
		`Cannot set ${meta.key} via config set (type: ${t})`,
	);
}

/** Direct children allowed under `[paths]` in 5x.toml (see PathsSchema). */
const VALID_PATHS_TABLE_KEYS = new Set([
	"plans",
	"reviews",
	"planReviews",
	"runReviews",
	"archive",
	"templates",
]);

/**
 * `toml-patch` may print new root-level keys immediately after a `[paths]` block
 * with no `[table]` boundary; TOML then parses them as nested under `paths`.
 * Move those keys back to the document root so dotted keys like `qualityGates`
 * match the schema and `removeDottedKey` works.
 */
function liftKeysMisnestedUnderPaths(parsed: Record<string, unknown>): void {
	const paths = parsed.paths;
	if (!isPlainRecord(paths)) {
		return;
	}
	for (const k of Object.keys(paths)) {
		if (VALID_PATHS_TABLE_KEYS.has(k)) {
			continue;
		}
		if (!(k in parsed)) {
			parsed[k] = paths[k];
			delete paths[k];
		}
	}
}

function readStringArrayAtKey(
	parsed: Record<string, unknown>,
	key: string,
): string[] {
	const cur = getDottedValue(parsed, key);
	if (cur === undefined) {
		return [];
	}
	if (!Array.isArray(cur)) {
		outputError(
			"INVALID_ARGS",
			`Existing ${key} is not an array — fix the file or unset the key first.`,
		);
	}
	for (const el of cur) {
		if (typeof el !== "string") {
			outputError(
				"INVALID_ARGS",
				`Existing ${key} must be a string array (non-string element found).`,
			);
		}
	}
	return cur as string[];
}

function assertWritableSource(
	kind: ActiveConfigSourceKind,
	primaryPath: string | null,
): void {
	if (kind !== "js") {
		return;
	}
	const label = primaryPath
		? (primaryPath.split(/[/\\]/).pop() ?? primaryPath)
		: "5x.config.js";
	outputError(
		"INVALID_ARGS",
		`Active config is ${label}. Run \`5x upgrade\` to migrate to 5x.toml before using this command.`,
	);
}

function getDottedValue(obj: Record<string, unknown>, dotted: string): unknown {
	const parts = dotted.split(".");
	let cur: unknown = obj;
	for (const p of parts) {
		if (!isPlainRecord(cur) || !(p in cur)) {
			return undefined;
		}
		cur = cur[p] as unknown;
	}
	return cur;
}

function removeDottedKey(
	obj: Record<string, unknown>,
	dotted: string,
): boolean {
	const parts = dotted.split(".");
	let cur: unknown = obj;
	const stack: { parent: Record<string, unknown>; key: string }[] = [];

	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === undefined) {
			return false;
		}
		if (!isPlainRecord(cur) || !(p in cur)) {
			return false;
		}
		if (i === parts.length - 1) {
			delete (cur as Record<string, unknown>)[p];
			for (let s = stack.length - 1; s >= 0; s--) {
				const entry = stack[s];
				if (!entry) {
					break;
				}
				const { parent, key } = entry;
				const ch = parent[key];
				if (
					isPlainRecord(ch) &&
					Object.keys(ch as Record<string, unknown>).length === 0
				) {
					delete parent[key];
				} else {
					break;
				}
			}
			return true;
		}
		stack.push({ parent: cur as Record<string, unknown>, key: p });
		cur = (cur as Record<string, unknown>)[p];
	}
	return false;
}

function pruneEmptyTables(obj: Record<string, unknown>): void {
	for (const k of Object.keys(obj)) {
		const v = obj[k];
		if (isPlainRecord(v)) {
			pruneEmptyTables(v);
			if (Object.keys(v).length === 0) {
				delete obj[k];
			}
		}
	}
}

function isDocumentEmpty(parsed: Record<string, unknown>): boolean {
	pruneEmptyTables(parsed);
	return Object.keys(parsed).length === 0;
}

// ---------------------------------------------------------------------------
// Build show output (pure — unit-tested)
// ---------------------------------------------------------------------------

function computeEffectiveDefault(
	meta: ConfigKeyMeta,
	controlPlaneRootAbs: string,
): unknown {
	const d = meta.default;
	if (meta.key.startsWith("paths.")) {
		if (typeof d === "string") {
			return resolve(controlPlaneRootAbs, d);
		}
		return d;
	}
	return d;
}

function valuesEqualForDisplay(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a === undefined && b === undefined) return true;
	if (a === null && b === null) return true;
	if (typeof a === "object" && typeof b === "object" && a && b) {
		try {
			return JSON.stringify(a) === JSON.stringify(b);
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Build the rich `config show` payload from layered resolution result.
 */
export function buildConfigShowOutput(
	layered: LayeredConfigResult,
	controlPlaneRoot: string,
): ConfigShowOutput {
	const registry = getConfigRegistry();
	const cpRoot = resolve(controlPlaneRoot);
	const flat = flattenConfig(layered.config as Record<string, unknown>);
	const localKeys = computeLocalKeys(layered.localRaws);

	const effectiveDefaults = new Map<string, unknown>();
	for (const meta of registry) {
		if (meta.type === "record") continue;
		effectiveDefaults.set(meta.key, computeEffectiveDefault(meta, cpRoot));
	}

	const files: string[] = [];
	if (layered.rootConfigPath) files.push(layered.rootConfigPath);
	if (layered.nearestConfigPath) files.push(layered.nearestConfigPath);
	for (const p of layered.localPaths) files.push(p);

	const entries: ConfigShowEntry[] = [];

	for (const meta of registry) {
		if (meta.type === "record") {
			const prefix = `${meta.key}.`;
			const childKeys = [...flat.keys()].filter((k) => k.startsWith(prefix));
			for (const ck of childKeys.sort()) {
				entries.push({
					key: ck,
					description: meta.description,
					type: "string",
					default: undefined,
					value: flat.get(ck),
					isLocal: localKeys.has(ck),
				});
			}
			continue;
		}

		const value = flat.has(meta.key) ? flat.get(meta.key) : undefined;
		entries.push({
			key: meta.key,
			description: meta.description,
			type: meta.type,
			default: effectiveDefaults.get(meta.key),
			value,
			isLocal: localKeys.has(meta.key),
			...(meta.type === "enum" && meta.allowedValues !== undefined
				? { enumValues: [...meta.allowedValues] }
				: {}),
		});
	}

	const covered = new Set(entries.map((e) => e.key));
	for (const k of flat.keys()) {
		if (covered.has(k)) continue;
		if (isRegistryKeyOrRecordDescendant(k, registry)) continue;
		entries.push({
			key: k,
			description: "(unrecognized)",
			type: "unknown",
			default: undefined,
			value: flat.get(k),
			isLocal: localKeys.has(k),
		});
	}

	entries.sort((a, b) => a.key.localeCompare(b.key));

	return { files, entries };
}

/** Labeled rows for the `Config files:` header (matches {@link buildConfigShowOutput}'s `files` order). */
export function buildConfigFileRows(
	layered: LayeredConfigResult,
): { label: string; path: string }[] {
	const rows: { label: string; path: string }[] = [];
	if (layered.rootConfigPath) {
		rows.push({ label: "root", path: layered.rootConfigPath });
	}
	if (layered.nearestConfigPath) {
		rows.push({ label: "nearest", path: layered.nearestConfigPath });
	}
	for (const p of layered.localPaths) {
		rows.push({ label: "local", path: p });
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

function formatValueCell(value: unknown): string {
	if (value === undefined || value === null) return "-";
	if (typeof value === "string" && value === "") return '""';
	if (Array.isArray(value)) {
		return value.length === 0 ? "[]" : JSON.stringify(value);
	}
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function dimIf(
	text: string,
	dim: boolean,
	ansi: ReturnType<typeof resolveAnsi>,
): string {
	if (!dim || !ansi.dim) return text;
	return `${ansi.dim}${text}${ansi.reset}`;
}

function formatConfigShowText(
	data: ConfigShowOutput,
	fileRows: { label: string; path: string }[],
): void {
	const ansi = resolveAnsi();

	console.log("Config files:");
	if (fileRows.length === 0) {
		console.log(dimIf("  (none)", true, ansi));
	} else {
		for (const { label, path } of fileRows) {
			console.log(`  ${label.padEnd(8)} ${path}`);
		}
	}

	console.log("");
	const rows = data.entries;
	const keyW = Math.min(
		56,
		Math.max(32, ...rows.map((e) => e.key.length), "Key".length),
	);
	const valW = Math.max(
		24,
		...rows.map((e) => formatValueCell(e.value).length),
		"Value".length,
	);
	const defW = Math.max(
		16,
		...rows.map((e) => formatValueCell(e.default).length),
		"Default".length,
	);

	const header = `${"Key".padEnd(keyW)}  ${"Value".padEnd(valW)}  ${"Default".padEnd(defW)}  Local`;
	console.log(header);
	console.log(
		`${"-".repeat(keyW)}  ${"-".repeat(valW)}  ${"-".repeat(defW)}  -----`,
	);

	for (const e of rows) {
		const vStr = formatValueCell(e.value);
		const dStr = formatValueCell(e.default);
		const same = valuesEqualForDisplay(e.value, e.default);
		const localMark = e.isLocal ? "*" : "";

		const keyPart =
			e.key.length > keyW ? `${e.key.slice(0, keyW - 1)}~` : e.key;
		const valCell =
			vStr.length > valW ? `${vStr.slice(0, valW - 1)}~` : vStr.padEnd(valW);
		const defCell =
			dStr.length > defW ? `${dStr.slice(0, defW - 1)}~` : dStr.padEnd(defW);

		console.log(
			`${keyPart.padEnd(keyW)}  ${dimIf(valCell, same, ansi)}  ${dimIf(defCell, same, ansi)}  ${localMark}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function configShow(params: ConfigShowParams = {}): Promise<void> {
	const controlPlane = resolveControlPlaneRoot(params.startDir);
	const contextDir = params.contextDir ?? process.cwd();

	const layered = await resolveLayeredConfig(
		controlPlane.controlPlaneRoot,
		contextDir,
	);

	const output = buildConfigShowOutput(layered, controlPlane.controlPlaneRoot);
	const fileRows = buildConfigFileRows(layered);

	if (params.key) {
		const entry = output.entries.find((e) => e.key === params.key);
		if (!entry) {
			outputError("INVALID_ARGS", `Unknown config key: ${params.key}`);
		}
		if (getOutputFormat() === "text") {
			outputSuccess(entry, () => {
				console.log(formatValueCell(entry.value));
			});
			return;
		}
		outputSuccess(entry);
		return;
	}

	outputSuccess(output, () => formatConfigShowText(output, fileRows));
}

// ---------------------------------------------------------------------------
// config set / unset
// ---------------------------------------------------------------------------

export async function configSet(params: ConfigSetParams): Promise<void> {
	const registry = getConfigRegistry();
	const key = params.key.trim();
	const resolved = resolveWritableConfigKey(key, registry);
	if (!resolved.ok) {
		outputError("INVALID_ARGS", resolved.message);
	}

	const { controlPlaneRoot, targetPath } = resolveTargetConfigPath({
		startDir: params.startDir,
		contextDir: params.contextDir,
		local: params.local,
	});

	const contextDir = resolve(params.contextDir ?? process.cwd());
	const activeKind = detectActiveConfigSource(controlPlaneRoot, contextDir);
	const primaryPath = discoverConfigFile(
		contextDir === resolve(controlPlaneRoot) ? controlPlaneRoot : contextDir,
		controlPlaneRoot,
	);
	assertWritableSource(activeKind, primaryPath);

	if (key.startsWith("db.") || key === "db") {
		if (!isRootDbConfigTarget(targetPath, controlPlaneRoot)) {
			outputError(
				"INVALID_ARGS",
				"db config is root-only; set db.* keys in the root 5x.toml (or root 5x.toml.local).",
			);
		}
	}

	const coerced = coerceConfigValue(resolved.resolution, params.value);

	const patchObj = buildNestedFromDotted(key, coerced);
	const existingText = existsSync(targetPath)
		? readFileSync(targetPath, "utf-8")
		: "";
	const existingParsed = (
		existingText.trim() === ""
			? {}
			: (tomlParse(existingText) as Record<string, unknown>)
	) as Record<string, unknown>;
	liftKeysMisnestedUnderPaths(existingParsed);
	const merged = mergeConfigObjects(existingParsed, patchObj);
	const newToml = tomlPatch(existingText === "" ? "\n" : existingText, merged);

	writeFileSync(targetPath, newToml, "utf-8");

	outputSuccess({ key, value: coerced, path: targetPath }, (d) => {
		console.log(`Set ${d.key} = ${JSON.stringify(d.value)}`);
		console.log(`Wrote ${d.path}`);
	});
}

export async function configUnset(params: ConfigUnsetParams): Promise<void> {
	const registry = getConfigRegistry();
	const key = params.key.trim();
	const resolved = resolveWritableConfigKey(key, registry);
	if (!resolved.ok) {
		outputError("INVALID_ARGS", resolved.message);
	}

	const { controlPlaneRoot, targetPath } = resolveTargetConfigPath({
		startDir: params.startDir,
		contextDir: params.contextDir,
		local: params.local,
	});

	const contextDir = resolve(params.contextDir ?? process.cwd());
	const activeKind = detectActiveConfigSource(controlPlaneRoot, contextDir);
	const primaryPath = discoverConfigFile(
		contextDir === resolve(controlPlaneRoot) ? controlPlaneRoot : contextDir,
		controlPlaneRoot,
	);
	assertWritableSource(activeKind, primaryPath);

	if (key.startsWith("db.") || key === "db") {
		if (!isRootDbConfigTarget(targetPath, controlPlaneRoot)) {
			outputError(
				"INVALID_ARGS",
				"db config is root-only; unset db.* keys in the root 5x.toml (or root 5x.toml.local).",
			);
		}
	}

	if (!existsSync(targetPath)) {
		outputSuccess({ key, path: targetPath, noop: true as const }, (d) => {
			console.log(`No file at ${d.path} — nothing to unset for ${d.key}`);
		});
		return;
	}

	const existingText = readFileSync(targetPath, "utf-8");
	const existingParsed = tomlParse(existingText) as Record<string, unknown>;
	liftKeysMisnestedUnderPaths(existingParsed);

	if (getDottedValue(existingParsed, key) === undefined) {
		outputSuccess({ key, path: targetPath, noop: true as const }, (d) => {
			console.log(`Key ${d.key} not present in ${d.path} — nothing to unset`);
		});
		return;
	}

	const clone = structuredClone(existingParsed) as Record<string, unknown>;
	removeDottedKey(clone, key);
	pruneEmptyTables(clone);

	if (isDocumentEmpty(clone)) {
		unlinkSync(targetPath);
		outputSuccess({ key, path: targetPath, removed: true as const }, (d) => {
			console.log(`Removed last key — deleted ${d.path}`);
		});
		return;
	}

	const newToml = tomlPatch(existingText, clone);
	writeFileSync(targetPath, newToml, "utf-8");

	outputSuccess({ key, path: targetPath }, (d) => {
		console.log(`Unset ${d.key}`);
		console.log(`Wrote ${d.path}`);
	});
}

// ---------------------------------------------------------------------------
// config add / remove (array keys)
// ---------------------------------------------------------------------------

export async function configAdd(params: ConfigAddParams): Promise<void> {
	const registry = getConfigRegistry();
	const key = params.key.trim();
	const resolved = resolveWritableArrayConfigKey(key, registry);
	if (!resolved.ok) {
		outputError("INVALID_ARGS", resolved.message);
	}
	const meta = resolved.meta;
	if (meta.type !== "string[]") {
		outputError(
			"INVALID_ARGS",
			`config add is only implemented for string array keys (got ${meta.type}).`,
		);
	}
	const value = params.value;

	const { controlPlaneRoot, targetPath } = resolveTargetConfigPath({
		startDir: params.startDir,
		contextDir: params.contextDir,
		local: params.local,
	});

	const contextDir = resolve(params.contextDir ?? process.cwd());
	const activeKind = detectActiveConfigSource(controlPlaneRoot, contextDir);
	const primaryPath = discoverConfigFile(
		contextDir === resolve(controlPlaneRoot) ? controlPlaneRoot : contextDir,
		controlPlaneRoot,
	);
	assertWritableSource(activeKind, primaryPath);

	if (key.startsWith("db.") || key === "db") {
		if (!isRootDbConfigTarget(targetPath, controlPlaneRoot)) {
			outputError(
				"INVALID_ARGS",
				"db config is root-only; edit db.* keys in the root 5x.toml (or root 5x.toml.local).",
			);
		}
	}

	const existingText = existsSync(targetPath)
		? readFileSync(targetPath, "utf-8")
		: "";
	const existingParsed = (
		existingText.trim() === ""
			? {}
			: (tomlParse(existingText) as Record<string, unknown>)
	) as Record<string, unknown>;
	liftKeysMisnestedUnderPaths(existingParsed);

	const current = readStringArrayAtKey(existingParsed, key);
	if (current.includes(value)) {
		outputSuccess(
			{ key, value, path: targetPath, noop: true as const },
			(d) => {
				console.log(
					`Value ${JSON.stringify(d.value)} already in ${d.key} — no change`,
				);
				console.log(d.path);
			},
		);
		return;
	}

	const next = [...current, value];
	const patchObj = buildNestedFromDotted(key, next);
	const merged = mergeConfigObjects(existingParsed, patchObj);
	const newToml = tomlPatch(existingText === "" ? "\n" : existingText, merged);

	writeFileSync(targetPath, newToml, "utf-8");

	outputSuccess({ key, value, path: targetPath, array: next }, (d) => {
		console.log(`Added ${JSON.stringify(d.value)} to ${d.key}`);
		console.log(`Wrote ${d.path}`);
	});
}

export async function configRemove(params: ConfigRemoveParams): Promise<void> {
	const registry = getConfigRegistry();
	const key = params.key.trim();
	const resolved = resolveWritableArrayConfigKey(key, registry);
	if (!resolved.ok) {
		outputError("INVALID_ARGS", resolved.message);
	}
	const meta = resolved.meta;
	if (meta.type !== "string[]") {
		outputError(
			"INVALID_ARGS",
			`config remove is only implemented for string array keys (got ${meta.type}).`,
		);
	}
	const value = params.value;

	const { controlPlaneRoot, targetPath } = resolveTargetConfigPath({
		startDir: params.startDir,
		contextDir: params.contextDir,
		local: params.local,
	});

	const contextDir = resolve(params.contextDir ?? process.cwd());
	const activeKind = detectActiveConfigSource(controlPlaneRoot, contextDir);
	const primaryPath = discoverConfigFile(
		contextDir === resolve(controlPlaneRoot) ? controlPlaneRoot : contextDir,
		controlPlaneRoot,
	);
	assertWritableSource(activeKind, primaryPath);

	if (key.startsWith("db.") || key === "db") {
		if (!isRootDbConfigTarget(targetPath, controlPlaneRoot)) {
			outputError(
				"INVALID_ARGS",
				"db config is root-only; edit db.* keys in the root 5x.toml (or root 5x.toml.local).",
			);
		}
	}

	if (!existsSync(targetPath)) {
		outputSuccess(
			{ key, value, path: targetPath, noop: true as const },
			(d) => {
				console.log(`No file at ${d.path} — nothing to remove for ${d.key}`);
			},
		);
		return;
	}

	const existingText = readFileSync(targetPath, "utf-8");
	const existingParsed = tomlParse(existingText) as Record<string, unknown>;
	liftKeysMisnestedUnderPaths(existingParsed);

	if (getDottedValue(existingParsed, key) === undefined) {
		outputSuccess(
			{ key, value, path: targetPath, noop: true as const },
			(d) => {
				console.log(
					`Key ${d.key} not present in ${d.path} — nothing to remove`,
				);
			},
		);
		return;
	}

	const current = readStringArrayAtKey(existingParsed, key);
	if (!current.includes(value)) {
		outputSuccess(
			{ key, value, path: targetPath, noop: true as const },
			(d) => {
				console.log(
					`Value ${JSON.stringify(d.value)} not in ${d.key} — no change`,
				);
				console.log(d.path);
			},
		);
		return;
	}

	const next = current.filter((x) => x !== value);

	if (next.length === 0) {
		const clone = structuredClone(existingParsed) as Record<string, unknown>;
		removeDottedKey(clone, key);
		pruneEmptyTables(clone);

		if (isDocumentEmpty(clone)) {
			unlinkSync(targetPath);
			outputSuccess(
				{ key, value, path: targetPath, removedFile: true as const },
				(d) => {
					console.log(`Removed last gate — deleted ${d.path}`);
				},
			);
			return;
		}

		const newToml = tomlPatch(existingText, clone);
		writeFileSync(targetPath, newToml, "utf-8");
		outputSuccess({ key, value, path: targetPath }, (d) => {
			console.log(`Removed ${JSON.stringify(d.value)} from ${d.key}`);
			console.log(`Wrote ${d.path}`);
		});
		return;
	}

	const patchObj = buildNestedFromDotted(key, next);
	const merged = mergeConfigObjects(existingParsed, patchObj);
	const newToml = tomlPatch(existingText, merged);
	writeFileSync(targetPath, newToml, "utf-8");

	outputSuccess({ key, value, path: targetPath, array: next }, (d) => {
		console.log(`Removed ${JSON.stringify(d.value)} from ${d.key}`);
		console.log(`Wrote ${d.path}`);
	});
}
