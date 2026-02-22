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

// Attach startup can be slow enough that immediate focus attempts fail.
// Retry for several seconds so early gate/session switches are visible.
const SELECT_SESSION_RETRY_DELAYS_MS = [0, 80, 160, 320, 500, 800, 1200];

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Controller for TUI ownership lifecycle.
 *
 * Callers interact with a single interface regardless of whether TUI mode
 * is active or headless. When headless, all methods are no-ops.
 */
export interface TuiController {
	/** Whether a TUI is currently connected and owning output. */
	readonly active: boolean;

	/**
	 * True when `opencode attach` was spawned by this process.
	 * False for headless/no-op fallback controllers.
	 */
	readonly attached: boolean;

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
	 * The callback fires once when the TUI process exits.
	 * Returns an unsubscribe function.
	 *
	 * In headless mode (no-op controller), this is a no-op — the handler is
	 * never called, because no TUI was ever started and therefore no exit event
	 * occurs. Callers should gate registration on `isTuiMode` if they only want
	 * to react to actual TUI exits.
	 *
	 * In active mode, fires immediately if the TUI has already exited.
	 */
	onExit(handler: (info: TuiExitInfo) => void): () => void;

	/**
	 * Kill the TUI process. Idempotent — safe to call multiple times.
	 */
	kill(): void;
}

export interface TuiExitInfo {
	code: number | undefined;
	isUserCancellation: boolean;
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
	 * Auto-attach TUI from this process (legacy behavior).
	 * When false, run in external-TUI mode: print attach command and continue
	 * headless until a user-attached TUI is detected.
	 */
	autoAttach?: boolean;

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
		get attached() {
			return false;
		},
		async selectSession() {},
		async showToast() {},
		onExit(_handler) {
			// TUI never started — no exit event will fire; handler is not called.
			// Callers should gate onExit registration on isTuiMode so that
			// headless code paths do not receive spurious "TUI exited" callbacks.
			return () => {};
		},
		kill() {},
	};
}

type TuiApiResponse = { data?: boolean; error?: unknown } | undefined;

function apiCallSucceeded(result: TuiApiResponse): boolean {
	return result?.data === true;
}

function createExternalController(
	client: OpencodeClient,
	serverUrl: string,
	workdir: string,
): TuiController {
	let _active = false;
	let _killed = false;
	let _lastSessionId: string | undefined;
	let _lastDirectory: string | undefined;
	let reconnectTimer: ReturnType<typeof setInterval> | undefined;
	let reconnectInFlight = false;
	const exitHandlers = new Set<(info: TuiExitInfo) => void>();

	const emitExit = () => {
		for (const handler of exitHandlers) {
			try {
				handler({ code: undefined, isUserCancellation: false });
			} catch {
				// Swallow handler errors.
			}
		}
	};

	const setActive = (next: boolean) => {
		if (_active === next) return;
		_active = next;
		if (!_active) emitExit();
	};

	const stopReconnectLoop = () => {
		if (!reconnectTimer) return;
		clearInterval(reconnectTimer);
		reconnectTimer = undefined;
	};

	const startReconnectLoop = () => {
		if (_killed || reconnectTimer || !_lastSessionId) return;
		reconnectTimer = setInterval(async () => {
			if (_killed || reconnectInFlight || !_lastSessionId) return;
			reconnectInFlight = true;
			try {
				const result = await client.tui.selectSession({
					sessionID: _lastSessionId,
					...(_lastDirectory && { directory: _lastDirectory }),
				});
				if (apiCallSucceeded(result)) {
					setActive(true);
					stopReconnectLoop();
				}
			} catch {
				// Continue retrying.
			} finally {
				reconnectInFlight = false;
			}
		}, 1000);
		reconnectTimer.unref?.();
	};

	process.stderr.write(`OpenCode server: ${serverUrl}\n`);
	process.stderr.write(
		`Attach TUI in another terminal: opencode attach ${serverUrl} --dir ${JSON.stringify(workdir)}\n`,
	);

	return {
		get active() {
			return _active;
		},
		get attached() {
			return false;
		},
		async selectSession(sessionID: string, directory?: string) {
			if (_killed) return;
			_lastSessionId = sessionID;
			_lastDirectory = directory;

			for (const delayMs of SELECT_SESSION_RETRY_DELAYS_MS) {
				if (_killed) return;
				if (delayMs > 0) await sleep(delayMs);
				if (_killed) return;

				try {
					const result = await client.tui.selectSession({
						sessionID,
						...(directory && { directory }),
					});
					if (apiCallSucceeded(result)) {
						setActive(true);
						stopReconnectLoop();
						return;
					}
				} catch {
					// Retry below.
				}
			}

			if (_active) setActive(false);
			startReconnectLoop();
		},
		async showToast(
			message: string,
			variant: "info" | "success" | "warning" | "error",
		) {
			if (_killed) return;
			try {
				const result = await client.tui.showToast({ message, variant });
				if (apiCallSucceeded(result)) {
					setActive(true);
					return;
				}
			} catch {
				// Ignore below.
			}

			if (_active) setActive(false);
			startReconnectLoop();
		},
		onExit(handler: (info: TuiExitInfo) => void) {
			exitHandlers.add(handler);
			return () => {
				exitHandlers.delete(handler);
			};
		},
		kill() {
			_killed = true;
			stopReconnectLoop();
		},
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
	let _exitInfo: TuiExitInfo | undefined;
	const exitHandlers = new Set<(info: TuiExitInfo) => void>();

	// Monitor process exit
	proc.exited.then((code) => {
		_active = false;
		_exitInfo = {
			code,
			isUserCancellation: code === 130 || code === 143,
		};
		for (const handler of exitHandlers) {
			try {
				handler(_exitInfo);
			} catch {
				// Swallow errors in exit handlers
			}
		}
		exitHandlers.clear();
	});

	return {
		get active() {
			return _active;
		},

		get attached() {
			return true;
		},

		async selectSession(sessionID: string, directory?: string) {
			if (!_active) return;

			const withDirectory = {
				sessionID,
				...(directory && { directory }),
			};
			const withoutDirectory = { sessionID };

			for (const delayMs of SELECT_SESSION_RETRY_DELAYS_MS) {
				if (!_active) return;
				if (delayMs > 0) {
					await sleep(delayMs);
					if (!_active) return;
				}

				try {
					const withDirResult = await client.tui.selectSession(withDirectory);
					if (apiCallSucceeded(withDirResult)) return;
				} catch {
					// Fallback to session-only below.
				}

				if (directory) {
					try {
						const withoutDirResult =
							await client.tui.selectSession(withoutDirectory);
						if (apiCallSucceeded(withoutDirResult)) return;
					} catch {
						// Retry below.
					}
				}
			}

			// Best-effort only: if TUI is not ready/disconnected, continue silently.
		},

		async showToast(
			message: string,
			variant: "info" | "success" | "warning" | "error",
		) {
			if (!_active) return;
			try {
				const result = await client.tui.showToast({ message, variant });
				if (apiCallSucceeded(result)) return;
			} catch {
				// TUI may have disconnected — ignore
			}
		},

		onExit(handler: (info: TuiExitInfo) => void) {
			if (!_active) {
				// Already exited — fire immediately
				handler(
					_exitInfo ?? {
						code: undefined,
						isUserCancellation: false,
					},
				);
				return () => {};
			}
			exitHandlers.add(handler);
			return () => {
				exitHandlers.delete(handler);
			};
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

/** Minimal spawn result used internally and in tests. */
export type SpawnResult = {
	exited: Promise<number | undefined>;
	kill(): void;
};

/**
 * Default spawner: calls Bun.spawn to start `opencode attach`.
 * Extracted so tests can inject a throwing spawner to exercise the fallback.
 */
function defaultSpawner(serverUrl: string, workdir: string): SpawnResult {
	const spawned = Bun.spawn(
		["opencode", "attach", serverUrl, "--dir", workdir],
		{ stdio: ["inherit", "inherit", "inherit"] },
	);
	return { exited: spawned.exited, kill: () => spawned.kill() };
}

/**
 * Create a TUI controller.
 *
 * - enabled=false: no-op controller
 * - enabled=true + autoAttach=true: spawn `opencode attach` in this terminal
 * - enabled=true + autoAttach=false: external attach mode (print URL/command)
 *
 * In all modes, `controller.active` means a TUI currently owns output.
 */
export function createTuiController(
	opts: CreateTuiControllerOptions,
	_spawner?: (serverUrl: string, workdir: string) => SpawnResult,
): TuiController {
	if (!opts.enabled) {
		return createNoopController();
	}

	if (!opts.autoAttach) {
		return createExternalController(opts.client, opts.serverUrl, opts.workdir);
	}

	// Pre-attach startup message (written BEFORE TUI takes over)
	process.stderr.write("Starting OpenCode...\n");

	// Spawn the TUI process. If the `opencode` binary is not on PATH (or spawn
	// otherwise fails), fall back to headless with a warning rather than a hard
	// crash (Phase 6 fallback, partially implemented here per P1.5).
	const spawner = _spawner ?? defaultSpawner;
	let proc: SpawnResult;
	try {
		proc = spawner(opts.serverUrl, opts.workdir);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`Warning: Failed to spawn opencode TUI — continuing headless. (${reason})\n`,
		);
		return createNoopController();
	}

	return createActiveController(proc, opts.client);
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
