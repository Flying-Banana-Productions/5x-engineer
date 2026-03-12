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

import type { SkillMetadata } from "../skills/loader.js";
import type { InstallSummary } from "./installer.js";

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
	/** Bundled 5x skills — the plugin decides which (if any) to install. */
	skills: SkillMetadata[];
	/** Model config extracted from 5x.toml (may be empty). */
	config: {
		authorModel?: string;
		reviewerModel?: string;
	};
}

/** Result returned by a harness plugin's install function. */
export interface HarnessInstallResult {
	/** Summary of installed skill files. */
	skills: InstallSummary;
	/** Summary of installed agent profile files. */
	agents: InstallSummary;
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
	/** Install skills and agent profiles for this harness. */
	install(ctx: HarnessInstallContext): Promise<HarnessInstallResult>;
}
