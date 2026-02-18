/**
 * Config-driven adapter factory.
 *
 * `createAndVerifyAdapter()` creates a managed (local) OpenCode adapter and
 * verifies the server is available.
 *
 * Phase 1: throws with clear message — OpenCode adapter not yet implemented.
 * Phase 3: will implement OpenCodeAdapter and factory will return it.
 */

import type { AgentAdapter } from "./types.js";

/**
 * Create and verify a managed (local) OpenCode adapter.
 * Phase 1: throws — adapter not yet implemented.
 * Phase 3: will create OpenCodeAdapter, verify health, and return it.
 */
export async function createAndVerifyAdapter(
	_config: Record<string, unknown>,
): Promise<AgentAdapter> {
	throw new Error(
		"OpenCode adapter not yet implemented. " +
			"This is Phase 1 of the 5x CLI refactor. " +
			"The adapter will be implemented in Phase 3.",
	);
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
