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

// Tracks whether signal handlers have already been registered, preventing
// duplicate SIGINT/SIGTERM handlers if registerAdapterShutdown() is called
// more than once (e.g., in tests or future multi-adapter scenarios).
let _signalHandlersRegistered = false;

export interface RegisterAdapterShutdownOptions {
	/** Whether TUI mode is active (affects signal handling). */
	tuiMode?: boolean;
	/** AbortController for cooperative cancellation in TUI mode. */
	cancelController?: AbortController;
}

/**
 * Register adapter cleanup for process exit and signals.
 *
 * Ensures the managed OpenCode server is shut down on SIGINT/SIGTERM.
 * adapter.close() has a synchronous body (server.close()), so it runs
 * correctly from the synchronous "exit" event handler even though the
 * method signature is async.
 *
 * Safe to call multiple times: the "exit" handler is adapter-specific and
 * registered each time (idempotent via adapter.close()'s own guard), but the
 * shared SIGINT/SIGTERM handlers are registered only once per process.
 *
 * Commands that also use registerLockCleanup() do not need to worry about
 * handler ordering — both cleanup paths are idempotent.
 *
 * Phase 3: TUI mode uses cooperative cancellation (no process.exit() in signals)
 * to allow finally blocks to run. Headless mode preserves existing behavior.
 */
export function registerAdapterShutdown(
	adapter: AgentAdapter,
	opts: RegisterAdapterShutdownOptions = {},
): void {
	const cleanup = () => {
		// adapter.close() is async but its body is synchronous —
		// server.close() executes immediately. The returned Promise
		// is intentionally not awaited (sync "exit" handler context).
		adapter.close();
	};
	process.on("exit", cleanup);

	if (opts.tuiMode) {
		// TUI mode: Ctrl-C goes to TUI first; we rely on tuiProcess.exited to
		// cooperatively cancel. SIGINT/SIGTERM still need handlers to prevent
		// abrupt termination if somehow delivered to the parent directly.
		// Guard with _signalHandlersRegistered to prevent duplicate handlers.
		if (!_signalHandlersRegistered) {
			_signalHandlersRegistered = true;
			process.once("SIGINT", () => {
				opts.cancelController?.abort();
				process.exitCode = 130;
			});
			process.once("SIGTERM", () => {
				opts.cancelController?.abort();
				process.exitCode = 143;
			});
		}
	} else {
		// Headless mode: convert signal to process.exit() to trigger the "exit" event
		if (!_signalHandlersRegistered) {
			_signalHandlersRegistered = true;
			process.on("SIGINT", () => process.exit(130));
			process.on("SIGTERM", () => process.exit(143));
		}
	}
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
