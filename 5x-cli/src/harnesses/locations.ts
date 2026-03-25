/**
 * Harness install location registry.
 *
 * Describes the correct install paths for supported harnesses at both
 * project scope and user scope. Each harness may have different directory
 * conventions — this module provides a stable abstraction over those
 * differences.
 *
 * Phase 2 (014-harness-native-subagent-orchestration):
 * Starting with OpenCode. Other harnesses (Claude Code, Cursor) can be
 * added later as separate entries.
 *
 * OpenCode paths verified against official docs (March 2026):
 *   - Project: .opencode/agents/  .opencode/skills/
 *   - User:    ~/.config/opencode/agents/  ~/.config/opencode/skills/
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A harness install scope: project-local or user-global. */
export type HarnessScope = "project" | "user";

/**
 * Resolved install paths for one scope of one harness.
 * Both `agentsDir` and `skillsDir` are absolute paths.
 */
export interface HarnessLocations {
	/** Absolute path to the harness install root for this scope. */
	rootDir: string;
	/** Absolute path to the agents directory for this scope. */
	agentsDir: string;
	/** Absolute path to the skills directory for this scope. */
	skillsDir: string;
	/** Optional absolute path to rules directory for this scope. */
	rulesDir?: string;
}

/**
 * Install location resolver for a named harness.
 * Provides both project and user roots so callers can install
 * into the correct directories without hard-coding paths.
 */
export interface HarnessLocationResolver {
	name: string;
	/** Resolve install paths for the given scope. */
	resolve(
		scope: HarnessScope,
		projectRoot: string,
		homeDir?: string,
	): HarnessLocations;
}

// ---------------------------------------------------------------------------
// OpenCode location resolver
// ---------------------------------------------------------------------------

/**
 * OpenCode harness location resolver.
 *
 * Paths verified against OpenCode documentation:
 * - Project scope: .opencode/agents/  and .opencode/skills/
 * - User scope:    ~/.config/opencode/agents/  and ~/.config/opencode/skills/
 *
 * Note: OpenCode uses ~/.config/opencode/ (XDG-style), NOT ~/.opencode/.
 * This asymmetry cannot be represented by a single-string installRoot.
 */
export const opencodeLocationResolver: HarnessLocationResolver = {
	name: "opencode",
	resolve(
		scope: HarnessScope,
		projectRoot: string,
		homeDir?: string,
	): HarnessLocations {
		if (scope === "project") {
			const base = join(projectRoot, ".opencode");
			return {
				rootDir: base,
				agentsDir: join(base, "agents"),
				skillsDir: join(base, "skills"),
			};
		}

		// user scope: XDG config directory (respect HOME env var for testability)
		const home = homeDir ?? process.env.HOME ?? homedir();
		const base = join(home, ".config", "opencode");
		return {
			rootDir: base,
			agentsDir: join(base, "agents"),
			skillsDir: join(base, "skills"),
		};
	},
};

// ---------------------------------------------------------------------------
// Universal location resolver
// ---------------------------------------------------------------------------

/**
 * Universal harness location resolver.
 *
 * Uses agentskills.io convention paths:
 * - Project scope: <project>/.agents/agents/ and <project>/.agents/skills/
 * - User scope:    ~/.agents/agents/ and ~/.agents/skills/
 */
export const universalLocationResolver: HarnessLocationResolver = {
	name: "universal",
	resolve(
		scope: HarnessScope,
		projectRoot: string,
		homeDir?: string,
	): HarnessLocations {
		if (scope === "project") {
			const base = join(projectRoot, ".agents");
			return {
				rootDir: base,
				agentsDir: join(base, "agents"),
				skillsDir: join(base, "skills"),
			};
		}

		const home = homeDir ?? process.env.HOME ?? homedir();
		const base = join(home, ".agents");
		return {
			rootDir: base,
			agentsDir: join(base, "agents"),
			skillsDir: join(base, "skills"),
		};
	},
};

// ---------------------------------------------------------------------------
// Cursor location resolver
// ---------------------------------------------------------------------------

/**
 * Cursor harness location resolver.
 *
 * Uses Cursor's native project/user asset paths:
 * - Project scope: <project>/.cursor/{skills,agents,rules}
 * - User scope:    ~/.cursor/{skills,agents}
 *
 * Note: user-scope rules are intentionally not file-backed in v1.
 */
export const cursorLocationResolver: HarnessLocationResolver = {
	name: "cursor",
	resolve(
		scope: HarnessScope,
		projectRoot: string,
		homeDir?: string,
	): HarnessLocations {
		if (scope === "project") {
			const base = join(projectRoot, ".cursor");
			return {
				rootDir: base,
				agentsDir: join(base, "agents"),
				skillsDir: join(base, "skills"),
				rulesDir: join(base, "rules"),
			};
		}

		const home = homeDir ?? process.env.HOME ?? homedir();
		const base = join(home, ".cursor");
		return {
			rootDir: base,
			agentsDir: join(base, "agents"),
			skillsDir: join(base, "skills"),
		};
	},
};
