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
	/** Model config extracted from 5x.toml (may be empty). */
	config: {
		authorModel?: string;
		reviewerModel?: string;
	};
	/** Home directory override for user scope — defaults to process.env.HOME or homedir(). */
	homeDir?: string;
}

/** Result returned by a harness plugin's install function. */
export interface HarnessInstallResult {
	/** Summary of installed skill files. */
	skills: InstallSummary;
	/** Summary of installed agent profile files. */
	agents: InstallSummary;
}

// ---------------------------------------------------------------------------
// Describe / Uninstall
// ---------------------------------------------------------------------------

/** Names of managed skills and agents for a harness plugin. */
export interface HarnessDescription {
	skillNames: string[];
	agentNames: string[];
}

/** Context provided to a harness plugin's uninstall function. */
export interface HarnessUninstallContext {
	/** Target scope for this uninstall. */
	scope: HarnessScope;
	/** Absolute path to the project root (git checkout root or cwd). */
	projectRoot: string;
	/** Home directory override for user scope — defaults to process.env.HOME or homedir(). */
	homeDir?: string;
}

/** Result returned by a harness plugin's uninstall function. */
export interface HarnessUninstallResult {
	/** Summary of uninstalled skill files. */
	skills: UninstallSummary;
	/** Summary of uninstalled agent profile files. */
	agents: UninstallSummary;
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
	/** Return names of managed skills and agents. */
	describe(): HarnessDescription;
	/** Install skills and agent profiles for this harness. */
	install(ctx: HarnessInstallContext): Promise<HarnessInstallResult>;
	/** Uninstall skills and agent profiles for this harness. */
	uninstall(ctx: HarnessUninstallContext): Promise<HarnessUninstallResult>;
}
