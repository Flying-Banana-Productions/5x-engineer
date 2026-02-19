/**
 * Config-driven adapter factory.
 *
 * `createAndVerifyAdapter()` creates a managed (local) OpenCode adapter and
 * verifies the server is available.
 */

import { OpenCodeAdapter } from "./opencode.js";
import type { AgentAdapter } from "./types.js";

/**
 * Create and verify a managed (local) OpenCode adapter.
 * Spawns a local OpenCode server, verifies health, and returns a ready adapter.
 *
 * The caller MUST call adapter.close() in a finally block to shut down the
 * managed server when done.
 */
export async function createAndVerifyAdapter(
	config: Record<string, unknown>,
): Promise<AgentAdapter> {
	const model = typeof config.model === "string" ? config.model : undefined;
	const adapter = await OpenCodeAdapter.create({ model });
	await adapter.verify();
	return adapter;
}

/**
 * @deprecated Synchronous adapter creation is no longer supported. Server
 * startup is inherently async. Use `createAndVerifyAdapter()` instead.
 */
export function createAdapter(): never {
	throw new Error(
		"createAdapter() is deprecated. " +
			"Use createAndVerifyAdapter() which handles async server startup.",
	);
}
