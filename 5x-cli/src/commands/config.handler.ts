/**
 * Config command handler — business logic for `5x config` subcommands.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Subcommands:
 * - show: Display the resolved config as a JSON envelope
 */

import { resolve } from "node:path";
import { type LayeredConfigResult, resolveLayeredConfig } from "../config.js";
import {
	type ConfigKeyMeta,
	computeLocalKeys,
	flattenConfig,
	getConfigRegistry,
	isRegistryKeyOrRecordDescendant,
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
