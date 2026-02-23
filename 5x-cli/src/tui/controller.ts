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
const EXTERNAL_TUI_API_TIMEOUT_MS = 250;
const EXTERNAL_TUI_SYNC_INTERVAL_MS = 500;

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
	/**
	 * Whether this process currently owns terminal I/O via a spawned
	 * `opencode attach` process.
	 */
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
	 * Register a callback for when the spawned TUI process exits.
	 * The callback fires once when the attached TUI child exits.
	 * Returns an unsubscribe function.
	 *
	 * In headless/no-op and external-TUI modes, this is a no-op — no child TUI
	 * process exists, so no exit event is emitted.
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

	/** Optional debug trace sink. */
	trace?: (event: string, data?: unknown) => void;

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

function traceController(
	trace: CreateTuiControllerOptions["trace"] | undefined,
	event: string,
	data?: unknown,
): void {
	try {
		trace?.(`tui.${event}`, data);
	} catch {
		// Never break runtime due to debug tracing.
	}
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
	trace?: (event: string, data?: unknown) => void,
): TuiController {
	let _reachable = false;
	let _killed = false;
	let _lastSessionId: string | undefined;
	let _lastDirectory: string | undefined;
	let syncTimer: ReturnType<typeof setInterval> | undefined;
	let syncInFlight = false;

	const setReachable = (next: boolean) => {
		if (_reachable === next) return;
		_reachable = next;
		traceController(trace, "external.reachable_change", {
			reachable: next,
		});
	};

	const stopSyncLoop = () => {
		if (!syncTimer) return;
		clearInterval(syncTimer);
		syncTimer = undefined;
	};

	const syncCurrentSession = async (): Promise<void> => {
		if (_killed || syncInFlight || !_lastSessionId) return;
		const sessionID = _lastSessionId;
		if (!sessionID) return;
		syncInFlight = true;
		try {
			traceController(trace, "external.sync.probe", {
				sessionID,
				directory: _lastDirectory,
			});
			const result = await callTuiApiWithTimeout((signal) =>
				(
					client.tui.selectSession as unknown as (
						payload: { sessionID: string; directory?: string },
						req?: { signal?: AbortSignal },
					) => Promise<TuiApiResponse>
				)(
					{
						sessionID,
						...(_lastDirectory && { directory: _lastDirectory }),
					},
					{ signal },
				),
			);
			setReachable(apiCallSucceeded(result));
		} finally {
			syncInFlight = false;
		}
	};

	const startSyncLoop = () => {
		if (_killed || syncTimer || !_lastSessionId) return;
		traceController(trace, "external.sync_loop.start", {
			sessionId: _lastSessionId,
			directory: _lastDirectory,
		});
		syncTimer = setInterval(() => {
			void syncCurrentSession();
		}, EXTERNAL_TUI_SYNC_INTERVAL_MS);
		syncTimer.unref?.();
	};

	const probeSession = async (
		sessionID: string,
		directory?: string,
	): Promise<boolean> => {
		traceController(trace, "external.probe.start", { sessionID, directory });
		const result = await callTuiApiWithTimeout((signal) =>
			(
				client.tui.selectSession as unknown as (
					payload: { sessionID: string; directory?: string },
					req?: { signal?: AbortSignal },
				) => Promise<TuiApiResponse>
			)({ sessionID, ...(directory && { directory }) }, { signal }),
		);
		const ok = apiCallSucceeded(result);
		traceController(trace, "external.probe.done", { sessionID, ok });
		return ok;
	};

	const callTuiApiWithTimeout = async (
		call: (signal: AbortSignal) => Promise<TuiApiResponse>,
	): Promise<TuiApiResponse> => {
		const timeoutController = new AbortController();
		const timeout = setTimeout(
			() => timeoutController.abort(),
			EXTERNAL_TUI_API_TIMEOUT_MS,
		);
		timeout.unref?.();
		try {
			return await call(timeoutController.signal);
		} catch {
			traceController(trace, "external.api.error");
			return undefined;
		} finally {
			clearTimeout(timeout);
		}
	};

	process.stderr.write(`OpenCode server: ${serverUrl}\n`);
	process.stderr.write(
		`Attach TUI in another terminal: opencode attach ${serverUrl} --dir ${JSON.stringify(workdir)}\n`,
	);
	traceController(trace, "external.instructions_printed", {
		serverUrl,
		workdir,
	});

	return {
		get active() {
			return false;
		},
		get attached() {
			return false;
		},
		async selectSession(sessionID: string, directory?: string) {
			if (_killed) return;
			traceController(trace, "external.select_session", {
				sessionID,
				directory,
			});
			_lastSessionId = sessionID;
			_lastDirectory = directory;
			startSyncLoop();

			void (async () => {
				setReachable(await probeSession(sessionID, directory));
			})();
		},
		async showToast(
			message: string,
			variant: "info" | "success" | "warning" | "error",
		) {
			if (_killed) return;
			traceController(trace, "external.show_toast", { variant });

			void (async () => {
				const result = await callTuiApiWithTimeout((signal) =>
					(
						client.tui.showToast as unknown as (
							payload: {
								message: string;
								variant: "info" | "success" | "warning" | "error";
							},
							req?: { signal?: AbortSignal },
						) => Promise<TuiApiResponse>
					)({ message, variant }, { signal }),
				);

				if (apiCallSucceeded(result)) {
					setReachable(true);
					return;
				}

				setReachable(false);
				startSyncLoop();
			})();
		},
		onExit(_handler: (info: TuiExitInfo) => void) {
			return () => {};
		},
		kill() {
			_killed = true;
			traceController(trace, "external.kill");
			stopSyncLoop();
		},
	};
}

// ---------------------------------------------------------------------------
// Active TUI controller
// ---------------------------------------------------------------------------

function createActiveController(
	proc: { exited: Promise<number | undefined>; kill(): void },
	client: OpencodeClient,
	trace?: (event: string, data?: unknown) => void,
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
		traceController(trace, "attached.exit", _exitInfo);
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
			traceController(trace, "attached.select_session.start", {
				sessionID,
				directory,
			});

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
					if (apiCallSucceeded(withDirResult)) {
						traceController(trace, "attached.select_session.ok", {
							withDirectory: true,
						});
						return;
					}
				} catch {
					// Fallback to session-only below.
				}

				if (directory) {
					try {
						const withoutDirResult =
							await client.tui.selectSession(withoutDirectory);
						if (apiCallSucceeded(withoutDirResult)) {
							traceController(trace, "attached.select_session.ok", {
								withDirectory: false,
							});
							return;
						}
					} catch {
						// Retry below.
					}
				}
			}

			// Best-effort only: if TUI is not ready/disconnected, continue silently.
			traceController(trace, "attached.select_session.give_up", {
				sessionID,
				directory,
			});
		},

		async showToast(
			message: string,
			variant: "info" | "success" | "warning" | "error",
		) {
			if (!_active) return;
			try {
				const result = await client.tui.showToast({ message, variant });
				if (apiCallSucceeded(result)) {
					traceController(trace, "attached.show_toast.ok", { variant });
					return;
				}
			} catch {
				// TUI may have disconnected — ignore
			}
			traceController(trace, "attached.show_toast.failed", { variant });
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
			traceController(trace, "attached.kill");
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
		traceController(opts.trace, "mode.noop", { reason: "disabled" });
		return createNoopController();
	}

	if (!opts.autoAttach) {
		traceController(opts.trace, "mode.external", {
			serverUrl: opts.serverUrl,
			workdir: opts.workdir,
		});
		return createExternalController(
			opts.client,
			opts.serverUrl,
			opts.workdir,
			opts.trace,
		);
	}

	// Pre-attach startup message (written BEFORE TUI takes over)
	process.stderr.write("Starting OpenCode...\n");
	traceController(opts.trace, "mode.attached.spawn_start", {
		serverUrl: opts.serverUrl,
		workdir: opts.workdir,
	});

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
		traceController(opts.trace, "mode.attached.spawn_failed", { reason });
		return createNoopController();
	}

	traceController(opts.trace, "mode.attached.spawn_ok");
	return createActiveController(proc, opts.client, opts.trace);
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
