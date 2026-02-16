/**
 * Config-driven adapter factory.
 *
 * Creates adapter instances from config. Validates adapter availability
 * on creation (logs a warning if the binary/SDK is not found).
 */

import { ClaudeCodeAdapter } from "./claude-code.js";
import type { AdapterConfig, AgentAdapter } from "./types.js";

/**
 * Create an agent adapter from config.
 *
 * @throws if the adapter type is unknown.
 */
export function createAdapter(config: AdapterConfig): AgentAdapter {
	switch (config.adapter) {
		case "claude-code":
			return new ClaudeCodeAdapter();

		case "opencode":
			// Phase 6 — OpenCode adapter not yet implemented
			throw new Error(
				`Adapter "opencode" is not yet implemented. Use "claude-code" for now.`,
			);

		default:
			throw new Error(
				`Unknown adapter: ${config.adapter as string}. Valid adapters: claude-code, opencode.`,
			);
	}
}

/**
 * Create an adapter and verify it is available.
 * Returns the adapter if available; throws if not.
 */
export async function createAndVerifyAdapter(
	config: AdapterConfig,
): Promise<AgentAdapter> {
	const adapter = createAdapter(config);
	const available = await adapter.isAvailable();
	if (!available) {
		throw new Error(
			`Adapter "${config.adapter}" is configured but not available. ` +
				`Ensure the "${config.adapter === "claude-code" ? "claude" : "opencode"}" CLI is installed and on your PATH.`,
		);
	}
	return adapter;
}
