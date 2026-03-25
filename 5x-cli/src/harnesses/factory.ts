/**
 * Harness plugin factory — resolves and loads harness plugins.
 *
 * Discovery follows the same convention as the provider factory:
 *   - Short names  → @5x-ai/harness-{name}  (e.g. "opencode" → @5x-ai/harness-opencode)
 *   - Scoped names → used as-is              (e.g. "@acme/harness-cursor")
 *
 * Resolution order (external-first so third-party packages can override bundled):
 *   1. Try dynamic import of the resolved package name.
 *   2. If module-not-found AND name matches a bundled harness → return bundled.
 *   3. If module-not-found and not bundled → throw HarnessNotFoundError.
 *
 * Framework-independent: no CLI framework imports.
 */

import type { HarnessPlugin } from "./types.js";

// ---------------------------------------------------------------------------
// Bundled harnesses (lazy-loaded)
// ---------------------------------------------------------------------------

const BUNDLED_HARNESSES: Record<
	string,
	() => Promise<{ default: HarnessPlugin }>
> = {
	opencode: () => import("./opencode/plugin.js"),
	universal: () => import("./universal/plugin.js"),
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class HarnessNotFoundError extends Error {
	readonly code = "HARNESS_NOT_FOUND";
	readonly exitCode = 2;

	constructor(harnessName: string, packageName: string) {
		super(
			`Harness "${harnessName}" not found. Install it with:\n` +
				`  npm install ${packageName}\n\n` +
				`Or if using bun:\n` +
				`  bun add ${packageName}`,
		);
		this.name = "HarnessNotFoundError";
	}
}

export class InvalidHarnessError extends Error {
	readonly code = "INVALID_HARNESS";
	readonly exitCode = 2;

	constructor(_harnessName: string, packageName: string) {
		super(
			`Harness package "${packageName}" does not export a valid HarnessPlugin.\n` +
				`Expected default export: { name: string, description: string, supportedScopes: string[], ` +
				`locations: { resolve: fn }, describe: fn, install: fn, uninstall: fn }`,
		);
		this.name = "InvalidHarnessError";
	}
}

// ---------------------------------------------------------------------------
// Package name resolution
// ---------------------------------------------------------------------------

export function resolvePackageName(harnessName: string): string {
	if (harnessName.startsWith("@")) {
		return harnessName;
	}
	return `@5x-ai/harness-${harnessName}`;
}

// ---------------------------------------------------------------------------
// Plugin loading
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Loaded plugin wrapper
// ---------------------------------------------------------------------------

/** A loaded harness plugin with source metadata. */
export interface LoadedHarnessPlugin {
	plugin: HarnessPlugin;
	source: "bundled" | "external";
}

/**
 * Validate that a loaded module default export satisfies the HarnessPlugin
 * shape (duck-type check).
 */
export function isValidPlugin(obj: unknown): obj is HarnessPlugin {
	if (!obj || typeof obj !== "object") return false;
	const p = obj as Record<string, unknown>;
	return (
		typeof p.name === "string" &&
		typeof p.description === "string" &&
		Array.isArray(p.supportedScopes) &&
		typeof p.install === "function" &&
		typeof p.uninstall === "function" &&
		typeof p.describe === "function" &&
		p.locations != null &&
		typeof p.locations === "object" &&
		typeof (p.locations as Record<string, unknown>).resolve === "function"
	);
}

/**
 * Load a harness plugin by name.
 *
 * Tries external package first, falls back to bundled if the external
 * module is not installed. Returns a `LoadedHarnessPlugin` that wraps
 * the plugin with a `source` field indicating whether it was loaded
 * from an external package or the bundled registry.
 */
export async function loadHarnessPlugin(
	harnessName: string,
	/** @internal — override dynamic import for testing. */
	importFn?: (specifier: string) => Promise<Record<string, unknown>>,
): Promise<LoadedHarnessPlugin> {
	const packageName = resolvePackageName(harnessName);
	const doImport =
		importFn ?? ((s: string) => import(s) as Promise<Record<string, unknown>>);

	// Try external package first (allows third-party overrides of bundled)
	try {
		const mod = await doImport(packageName);
		const plugin = mod.default;

		if (!isValidPlugin(plugin)) {
			throw new InvalidHarnessError(harnessName, packageName);
		}
		return { plugin, source: "external" };
	} catch (err) {
		// Check if the error is "module not found"
		const message =
			err instanceof Error
				? err.message
				: typeof (err as Record<string, unknown>)?.message === "string"
					? ((err as Record<string, unknown>).message as string)
					: String(err);
		const code =
			typeof (err as Record<string, unknown>)?.code === "string"
				? ((err as Record<string, unknown>).code as string)
				: "";

		const isNotFound =
			message.includes("Cannot find module") ||
			message.includes("Cannot find package") ||
			message.includes("Module not found") ||
			code === "ERR_MODULE_NOT_FOUND";

		if (!isNotFound) {
			// Re-throw InvalidHarnessError and unexpected errors
			throw err;
		}

		// Fall back to bundled harness
		const bundledLoader = BUNDLED_HARNESSES[harnessName];
		if (bundledLoader) {
			const mod = await bundledLoader();
			return { plugin: mod.default, source: "bundled" };
		}

		throw new HarnessNotFoundError(harnessName, packageName);
	}
}

// ---------------------------------------------------------------------------
// Registry queries
// ---------------------------------------------------------------------------

/**
 * List all bundled harness names.
 */
export function listBundledHarnesses(): string[] {
	return Object.keys(BUNDLED_HARNESSES);
}
