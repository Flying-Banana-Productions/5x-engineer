/**
 * Config-driven adapter factory.
 *
 * `createAndVerifyAdapter()` creates a managed (local) OpenCode adapter and
 * verifies the server is available.
 */

import { OpenCodeAdapter } from "./opencode.js";
import type { AdapterConfig, AgentAdapter } from "./types.js";

/**
 * Create and verify a managed (local) OpenCode adapter.
 * Spawns a local OpenCode server, verifies health, and returns a ready adapter.
 *
 * The caller MUST call adapter.close() in a finally block to shut down the
 * managed server when done. Consider also calling registerAdapterShutdown()
 * to ensure cleanup on signal-triggered exits.
 *
 * **Model selection:** The config.model value becomes the adapter's default
 * model, typically the author model (e.g. config.author). The reviewer model
 * is passed as a per-invocation override via InvokeOptions.model at each
 * call site, not baked into the adapter.
 */
export async function createAndVerifyAdapter(
	config: AdapterConfig,
): Promise<AgentAdapter> {
	const adapter = await OpenCodeAdapter.create({ model: config.model });
	await adapter.verify();
	return adapter;
}

/**
 * Register adapter cleanup for process exit and signals.
 *
 * Ensures the managed OpenCode server is shut down on SIGINT/SIGTERM.
 * adapter.close() has a synchronous body (server.close()), so it runs
 * correctly from the synchronous "exit" event handler even though the
 * method signature is async.
 *
 * Commands that also use registerLockCleanup() do not need to worry about
 * handler ordering — both cleanup paths are idempotent.
 */
export function registerAdapterShutdown(adapter: AgentAdapter): void {
	const cleanup = () => {
		// adapter.close() is async but its body is synchronous —
		// server.close() executes immediately. The returned Promise
		// is intentionally not awaited (sync "exit" handler context).
		adapter.close();
	};
	process.on("exit", cleanup);
	// Ensure signal-triggered exits go through process.exit() (which fires
	// the "exit" event for cleanup) rather than the default signal handler
	// (which terminates without firing "exit").
	process.on("SIGINT", () => process.exit(130));
	process.on("SIGTERM", () => process.exit(143));
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
