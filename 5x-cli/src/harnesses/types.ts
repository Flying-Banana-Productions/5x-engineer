/**
 * Harness plugin contract.
 *
 * A harness plugin adapts the 5x workflow for a specific AI coding agent
 * (OpenCode, Claude Code, Cursor, etc.). It installs skills and agent
 * profiles into the correct locations for that harness.
 *
 * Bundled harnesses implement this interface directly. Third-party
 * harness packages export it as the default export:
 *
 *   export default { name, description, supportedScopes, install } satisfies HarnessPlugin;
 *
 * Discovery follows the same convention as providers:
 *   - Short names  → @5x-ai/harness-{name}
 *   - Scoped names → used as-is
 */

import type { InstallSummary, UninstallSummary } from "./installer.js";
import type { HarnessLocations } from "./locations.js";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** A harness install scope: project-local or user-global. */
export type HarnessScope = "project" | "user";

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

/** Context provided to a harness plugin's install function. */
export interface HarnessInstallContext {
	/** Target scope for this install. */
	scope: HarnessScope;
	/** Absolute path to the project root (git checkout root or cwd). */
	projectRoot: string;
	/** Whether to overwrite existing files. */
	force: boolean;
	/**
	 * Resolved model strings for agent frontmatter (from `5x.toml` `[author]` /
	 * `[reviewer]`, including optional `harnessModels.<harnessName>` for the
	 * harness being installed — see `resolveHarnessModelForRole` in config).
	 */
	config: {
		authorModel?: string;
		reviewerModel?: string;
		authorDelegationMode?: "native" | "invoke";
		reviewerDelegationMode?: "native" | "invoke";
	};
	/** Home directory override for user scope — defaults to `homedir()` from `node:os`. */
	homeDir?: string;
}

/** Result returned by a harness plugin's install function. */
export interface HarnessInstallResult {
	/** Summary of installed skill files. */
	skills: InstallSummary;
	/** Summary of installed agent profile files. */
	agents: InstallSummary;
	/** Summary of installed rule files. */
	rules?: InstallSummary;
	/** Explicitly unsupported asset types for this scope. */
	unsupported?: {
		rules?: boolean;
	};
	/** Optional human-readable warnings for install output. */
	warnings?: string[];
}

// ---------------------------------------------------------------------------
// Describe / Uninstall
// ---------------------------------------------------------------------------

/** Names of managed skills and agents for a harness plugin. */
export interface HarnessDescription {
	skillNames: string[];
	agentNames: string[];
	ruleNames?: string[];
	capabilities?: {
		rules?: boolean;
	};
}

/** Context provided to a harness plugin's uninstall function. */
export interface HarnessUninstallContext {
	/** Target scope for this uninstall. */
	scope: HarnessScope;
	/** Absolute path to the project root (git checkout root or cwd). */
	projectRoot: string;
	/** Home directory override for user scope — defaults to `homedir()` from `node:os`. */
	homeDir?: string;
}

/** Result returned by a harness plugin's uninstall function. */
export interface HarnessUninstallResult {
	/** Summary of uninstalled skill files. */
	skills: UninstallSummary;
	/** Summary of uninstalled agent profile files. */
	agents: UninstallSummary;
	/** Summary of uninstalled rule files. */
	rules?: UninstallSummary;
	/** Explicitly unsupported asset types for this scope. */
	unsupported?: {
		rules?: boolean;
	};
}

// ---------------------------------------------------------------------------
// Rendered assets
// ---------------------------------------------------------------------------

/**
 * One rendered asset, produced without writing to disk.
 *
 * `install()` consumes exactly these, so the dry render used by the Tier 2
 * freshness check (201 §2.2) can never drift from what install actually
 * writes — one render path, not two.
 */
export interface RenderedAsset {
	kind: "skill" | "agent" | "rule";
	/** Asset name without directory or extension (e.g. "5x-plan", "5x-plan-author"). */
	name: string;
	/** Path relative to `locations.rootDir`, POSIX separators. */
	path: string;
	content: string;
}

/**
 * A harness plugin that can install skills and agent profiles for
 * a specific AI coding harness.
 */
export interface HarnessPlugin {
	/** Unique harness name (e.g. "opencode", "claude-code"). */
	readonly name: string;
	/** Short description shown in `5x harness list`. */
	readonly description: string;
	/** Scopes this harness supports. Drives --scope validation. */
	readonly supportedScopes: HarnessScope[];
	/** Path resolver for harness install locations. */
	readonly locations: {
		resolve(
			scope: HarnessScope,
			projectRoot: string,
			homeDir?: string,
		): HarnessLocations;
	};
	/** Return names of managed assets (optionally scope-aware). */
	describe(scope?: HarnessScope): HarnessDescription;
	/** Install skills and agent profiles for this harness. */
	install(ctx: HarnessInstallContext): Promise<HarnessInstallResult>;
	/** Uninstall skills and agent profiles for this harness. */
	uninstall(ctx: HarnessUninstallContext): Promise<HarnessUninstallResult>;

	/**
	 * Render every managed asset for this context **without writing**.
	 *
	 * Enables the Tier 2 freshness check (201 §2.2) and is the single render
	 * path `install()` itself consumes. Optional so external plugins written
	 * against the earlier contract remain valid; omitting it degrades Tier 2
	 * to on-disk-vs-recorded hash comparison (hand-edit detection only).
	 */
	renderAssets?(ctx: HarnessInstallContext): Promise<RenderedAsset[]>;

	/**
	 * Extra fingerprint inputs for harnesses that bake something outside the
	 * common set. Stored under `inputs.plugin` in the manifest so it can never
	 * collide with the common inputs (D1). No bundled plugin implements this.
	 */
	fingerprintInputs?(
		ctx: HarnessInstallContext,
	): Record<string, string | number>;

	/**
	 * Plugin version for the manifest fingerprint. Bundled plugins omit it —
	 * the CLI version is used, since they ship with the CLI.
	 */
	readonly version?: string;
}
