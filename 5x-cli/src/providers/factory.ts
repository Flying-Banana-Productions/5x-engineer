/**
 * Provider factory — resolves provider config and instantiates the correct provider.
 *
 * - For "opencode": uses direct import (bundled provider, no plugin indirection).
 * - For any other name: dynamically imports an npm package by convention:
 *   - Short names → `@5x-ai/provider-{name}`
 *   - Full package names (starting with @) → used as-is
 *
 * Forward-compatible with missing config keys (P1.1): if `config.author.provider`
 * or `config.reviewer.provider` is absent (Phase 8 hasn't landed), defaults to "opencode".
 * Similarly, if `config.opencode.url` is absent, uses managed mode.
 */

import type { FiveXConfig } from "../config.js";
import { OpenCodeProvider } from "./opencode.js";
import type { AgentProvider, ProviderPlugin } from "./types.js";

// ---------------------------------------------------------------------------
// Error types (using simple classes until Phase 3 CliError is available)
// ---------------------------------------------------------------------------

export class ProviderNotFoundError extends Error {
	readonly code = "PROVIDER_NOT_FOUND";
	readonly exitCode = 2;

	constructor(providerName: string, packageName: string) {
		super(
			`Provider "${providerName}" not found. Install it with:\n` +
				`  npm install ${packageName}\n\n` +
				`Or if using bun:\n` +
				`  bun add ${packageName}`,
		);
		this.name = "ProviderNotFoundError";
	}
}

export class InvalidProviderError extends Error {
	readonly code = "INVALID_PROVIDER";
	readonly exitCode = 2;

	constructor(_providerName: string, packageName: string) {
		super(
			`Provider package "${packageName}" does not export a valid ProviderPlugin.\n` +
				`Expected: { name: string, create: (config?) => Promise<AgentProvider> }\n` +
				`Got a default export that is missing the required 'create' function.`,
		);
		this.name = "InvalidProviderError";
	}
}

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

function resolvePackageName(providerName: string): string {
	if (providerName.startsWith("@")) {
		return providerName;
	}
	return `@5x-ai/provider-${providerName}`;
}

async function loadPlugin(providerName: string): Promise<ProviderPlugin> {
	const packageName = resolvePackageName(providerName);

	let mod: Record<string, unknown>;
	try {
		mod = (await import(packageName)) as Record<string, unknown>;
	} catch (err) {
		// Bun's ResolveMessage is NOT an instanceof Error, so check message on any object.
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

		if (
			message.includes("Cannot find module") ||
			message.includes("Cannot find package") ||
			message.includes("Module not found") ||
			code === "ERR_MODULE_NOT_FOUND"
		) {
			throw new ProviderNotFoundError(providerName, packageName);
		}
		throw err;
	}

	const plugin = mod.default as ProviderPlugin | undefined;
	if (
		!plugin ||
		typeof plugin !== "object" ||
		typeof plugin.create !== "function"
	) {
		throw new InvalidProviderError(providerName, packageName);
	}

	return plugin;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a provider for the given role based on config.
 *
 * Forward-compatible: if config keys from Phase 8 aren't present yet,
 * defaults to "opencode" in managed mode.
 */
export async function createProvider(
	role: "author" | "reviewer",
	config: FiveXConfig,
): Promise<AgentProvider> {
	// Forward-compatible: read provider from config if present (Phase 8 adds this field).
	// Cast through unknown to avoid type error before Phase 8 extends the schema.
	const roleConfig = config[role] as Record<string, unknown>;
	const providerName =
		typeof roleConfig?.provider === "string" ? roleConfig.provider : "opencode";

	if (providerName === "opencode") {
		return createOpenCodeProvider(config, roleConfig);
	}

	// External plugin via dynamic import
	const pluginConfig = getPluginConfig(providerName, config);
	const plugin = await loadPlugin(providerName);
	return plugin.create(pluginConfig);
}

/**
 * Create the bundled OpenCode provider (managed or external).
 */
async function createOpenCodeProvider(
	config: FiveXConfig,
	roleConfig: Record<string, unknown>,
): Promise<AgentProvider> {
	// Forward-compatible: read opencode config if present (Phase 8 adds this key).
	const opencodeConfig = (config as Record<string, unknown>).opencode as
		| Record<string, unknown>
		| undefined;
	const url =
		typeof opencodeConfig?.url === "string" ? opencodeConfig.url : undefined;
	const model =
		typeof roleConfig?.model === "string" ? roleConfig.model : undefined;

	if (url) {
		// External mode: connect to running server
		return OpenCodeProvider.createExternal(url, { model });
	}

	// Managed mode: spawn local server
	const provider = await OpenCodeProvider.createManaged({ model });
	await provider.verify();
	return provider;
}

/**
 * Extract plugin-specific config from the top-level config.
 * E.g. if provider is "codex", looks for config.codex.
 */
function getPluginConfig(
	providerName: string,
	config: FiveXConfig,
): Record<string, unknown> | undefined {
	const raw = config as Record<string, unknown>;
	const pluginConfig = raw[providerName];
	if (pluginConfig && typeof pluginConfig === "object") {
		return pluginConfig as Record<string, unknown>;
	}
	return undefined;
}
