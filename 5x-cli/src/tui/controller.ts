/**
 * TUI controller — manages the `opencode attach` TUI process lifecycle.
 *
 * Phase 2 of 004-impl-5x-cli-tui.
 *
 * ## SDK surface validation (Phase 2 prerequisite)
 *
 * Verified against @opencode-ai/sdk v1.2.6:
 *
 * - `client.tui.showToast({ title?, message, variant, duration? })` — EXISTS.
 *   Returns boolean. `message` and `variant` are required in the body type.
 *
 * - `client.tui.selectSession({ sessionID, directory? })` — EXISTS.
 *   Accepts `directory` as a query parameter. `sessionID` is required in body.
 *
 * - `client.tui.showDialog(...)` — DOES NOT EXIST. No blocking dialog API.
 *   Fallback for Phase 5: use `client.tui.control.next()` / `.response()`
 *   or a retained gate session with first-message subscription + timeout.
 *
 * - `client.tui.control.next()` — EXISTS. Returns `{ path, body }`.
 * - `client.tui.control.response({ body? })` — EXISTS. Returns boolean.
 *
 * - `client.permission.reply({ requestID, reply?, message? })` — EXISTS (preferred).
 *   `reply` accepts "once" | "always" | "reject".
 * - `client.permission.respond(...)` — EXISTS but deprecated.
 * - `client.permission.list()` — EXISTS. Returns `PermissionRequest[]`.
 *
 * - `createOpencodeTui({ project?, model?, session?, agent?, signal?, config? })`
 *   — EXISTS. Spawns `opencode` with `stdio: "inherit"`. Returns `{ close() }`.
 *   Does NOT accept a URL parameter — it starts its own TUI, not attaching to
 *   an existing server. We use `Bun.spawn(["opencode", "attach", url, ...])` instead.
 *
 * - `opencode attach <url> --dir <workdir>` — CLI supports `--dir` flag.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Controller for the TUI process lifecycle.
 *
 * Callers interact with a single interface regardless of whether TUI mode
 * is active or headless. When headless, all methods are no-ops.
 */
export interface TuiController {
	/** Whether the TUI process is currently alive and owning the terminal. */
	readonly active: boolean;

	/**
	 * Focus the TUI on a specific session.
	 * No-op when TUI is not active.
	 */
	selectSession(sessionID: string, directory?: string): Promise<void>;

	/**
	 * Show a toast notification in the TUI.
	 * No-op when TUI is not active.
	 */
	showToast(
		message: string,
		variant: "info" | "success" | "warning" | "error",
	): Promise<void>;

	/**
	 * Register a callback for when the TUI process exits.
	 * The callback fires once. If TUI is already dead (or headless), fires immediately.
	 */
	onExit(handler: () => void): void;

	/**
	 * Kill the TUI process. Idempotent — safe to call multiple times.
	 */
	kill(): void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateTuiControllerOptions {
	/** URL of the running OpenCode server (e.g. "http://127.0.0.1:51234"). */
	serverUrl: string;

	/** Working directory for the TUI (passed as --dir to opencode attach). */
	workdir: string;

	/** OpenCode SDK client — used for TUI API calls (selectSession, showToast). */
	client: OpencodeClient;

	/**
	 * Whether TUI mode is enabled. When false, returns a no-op controller.
	 * Determined by the command layer's TTY detection + flag logic.
	 */
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// No-op controller (headless mode)
// ---------------------------------------------------------------------------

function createNoopController(): TuiController {
	return {
		get active() {
			return false;
		},
		async selectSession() {},
		async showToast() {},
		onExit(handler) {
			// TUI never started — fire immediately
			handler();
		},
		kill() {},
	};
}

// ---------------------------------------------------------------------------
// Active TUI controller
// ---------------------------------------------------------------------------

function createActiveController(
	proc: { exited: Promise<number | undefined>; kill(): void },
	client: OpencodeClient,
): TuiController {
	let _active = true;
	const exitHandlers: Array<() => void> = [];

	// Monitor process exit
	proc.exited.then(() => {
		_active = false;
		for (const handler of exitHandlers) {
			try {
				handler();
			} catch {
				// Swallow errors in exit handlers
			}
		}
		exitHandlers.length = 0;
	});

	return {
		get active() {
			return _active;
		},

		async selectSession(sessionID: string, directory?: string) {
			if (!_active) return;
			try {
				await client.tui.selectSession({
					sessionID,
					...(directory && { directory }),
				});
			} catch {
				// TUI may have disconnected — ignore
			}
		},

		async showToast(
			message: string,
			variant: "info" | "success" | "warning" | "error",
		) {
			if (!_active) return;
			try {
				await client.tui.showToast({ message, variant });
			} catch {
				// TUI may have disconnected — ignore
			}
		},

		onExit(handler: () => void) {
			if (!_active) {
				// Already exited — fire immediately
				handler();
				return;
			}
			exitHandlers.push(handler);
		},

		kill() {
			if (!_active) return;
			try {
				proc.kill();
			} catch {
				// Already dead — ignore
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TUI controller. When `enabled` is true, spawns `opencode attach`
 * with the terminal inherited (stdio: "inherit"). When false, returns a no-op
 * controller with an identical interface.
 *
 * The TUI process takes over stdin/stdout from the point of spawn. After spawn,
 * 5x-cli must not write to stdout/stderr while `controller.active === true`.
 */
export function createTuiController(
	opts: CreateTuiControllerOptions,
): TuiController {
	if (!opts.enabled) {
		return createNoopController();
	}

	// Pre-attach startup message (written BEFORE TUI takes over)
	process.stderr.write("Starting OpenCode...\n");

	// Spawn the TUI process
	const proc = Bun.spawn(
		["opencode", "attach", opts.serverUrl, "--dir", opts.workdir],
		{
			stdio: ["inherit", "inherit", "inherit"],
		},
	);

	return createActiveController(
		{ exited: proc.exited, kill: () => proc.kill() },
		opts.client,
	);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a TUI controller from a pre-existing process-like object.
 * Exported for testing — avoids spawning a real `opencode attach` process.
 *
 * @internal
 */
export function _createActiveControllerForTest(
	proc: { exited: Promise<number | undefined>; kill(): void },
	client: OpencodeClient,
): TuiController {
	return createActiveController(proc, client);
}

export { createNoopController as _createNoopControllerForTest };
