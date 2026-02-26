/**
 * TUI controller — manages external `opencode attach` integration.
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
 * - `opencode attach <url> --dir <workdir>` — CLI supports `--dir` flag.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

// Attach startup can be slow enough that immediate focus attempts fail.
// Retry for several seconds so early gate/session switches are visible.
const SELECT_SESSION_RETRY_DELAYS_MS = [0, 80, 160, 320, 500, 800, 1200];
const ATTACHED_SELECT_SESSION_RETRY_INTERVAL_MS = 1000;
const ATTACHED_TUI_API_TIMEOUT_MS = 750;
const EXTERNAL_TUI_API_TIMEOUT_MS = 250;
const EXTERNAL_TUI_SYNC_INTERVAL_MS = 500;

type ExternalEvent = { type?: string; properties?: Record<string, unknown> };

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
	 * Whether a TUI is currently reachable for API operations
	 * (session select, toasts, TUI-native gates).
	 *
	 * This is true in external mode once a user-attached TUI becomes reachable.
	 * This is false for headless mode and for external mode before attach.
	 */
	readonly active: boolean;

	/**
	 * Reserved for compatibility with older internals.
	 * Runtime controllers returned by createTuiController() always report false.
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
	 * Register a callback for when a spawned TUI process exits.
	 * Returns an unsubscribe function.
	 *
	 * In headless/no-op and external-TUI modes, this is a no-op.
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
	let syncSuppressedByUserControl = false;
	const eventWatcherAbort = new AbortController();

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

	const startEventWatcher = () => {
		const subscribe = (
			client as unknown as {
				event?: {
					subscribe?: (
						filter?: unknown,
						req?: { signal?: AbortSignal },
					) => Promise<{ stream: AsyncIterable<ExternalEvent> }>;
				};
			}
		).event?.subscribe;
		if (!subscribe) return;

		void (async () => {
			try {
				const { stream } = await subscribe(undefined, {
					signal: eventWatcherAbort.signal,
				});

				for await (const event of stream) {
					if (_killed) return;
					const type = event?.type;
					if (typeof type !== "string") continue;

					if (type.startsWith("tui.")) {
						setReachable(true);
					}

					if (type === "tui.command.execute" || type === "tui.session.select") {
						if (!syncSuppressedByUserControl) {
							syncSuppressedByUserControl = true;
							traceController(trace, "external.sync.suppressed_by_user", {
								type,
							});
							stopSyncLoop();
						}
					}
				}
			} catch {
				if (!_killed && !eventWatcherAbort.signal.aborted) {
					traceController(trace, "external.event_watcher.error");
				}
			}
		})();
	};

	const syncCurrentSession = async (): Promise<void> => {
		if (
			_killed ||
			syncInFlight ||
			!_lastSessionId ||
			syncSuppressedByUserControl
		)
			return;
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
			const ok = apiCallSucceeded(result);
			setReachable(ok);
		} finally {
			syncInFlight = false;
		}
	};

	const startSyncLoop = () => {
		if (_killed || syncTimer || !_lastSessionId || syncSuppressedByUserControl)
			return;
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
	startEventWatcher();

	return {
		get active() {
			return _reachable;
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
			const targetChanged =
				sessionID !== _lastSessionId || directory !== _lastDirectory;
			_lastSessionId = sessionID;
			_lastDirectory = directory;
			if (targetChanged || syncSuppressedByUserControl) {
				syncSuppressedByUserControl = false;
				traceController(trace, "external.sync.resumed", {
					reason: targetChanged ? "target_changed" : "manual_select",
				});
			}
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
				syncSuppressedByUserControl = false;
				traceController(trace, "external.sync.resumed", {
					reason: "toast_failed",
				});
				startSyncLoop();
			})();
		},
		onExit(_handler: (info: TuiExitInfo) => void) {
			return () => {};
		},
		kill() {
			_killed = true;
			setReachable(false);
			traceController(trace, "external.kill");
			eventWatcherAbort.abort();
			stopSyncLoop();
		},
	};
}

// ---------------------------------------------------------------------------
// Active TUI controller
// ---------------------------------------------------------------------------

type SpawnResult = {
	exited: Promise<number | undefined>;
	kill(): void;
};

function createActiveController(
	initialProc: { exited: Promise<number | undefined>; kill(): void },
	client: OpencodeClient,
	respawn?: (sessionID: string, directory?: string) => SpawnResult,
	trace?: (event: string, data?: unknown) => void,
): TuiController {
	let proc = initialProc;
	let _active = true;
	let _exitInfo: TuiExitInfo | undefined;
	const exitHandlers = new Set<(info: TuiExitInfo) => void>();
	let requestedSessionId: string | undefined;
	let requestedDirectory: string | undefined;
	let selectLoopRunning = false;
	let hasRespawnedForSession = false;
	let attachGeneration = 0;

	const isCurrentTarget = (sessionID: string, directory?: string): boolean =>
		sessionID === requestedSessionId && directory === requestedDirectory;

	const callAttachedTuiApiWithTimeout = async (
		call: () => Promise<TuiApiResponse>,
	): Promise<TuiApiResponse> => {
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeoutResult = new Promise<TuiApiResponse>((resolve) => {
				timeoutId = setTimeout(
					() => resolve(undefined),
					ATTACHED_TUI_API_TIMEOUT_MS,
				);
				timeoutId.unref?.();
			});

			return await Promise.race([call().catch(() => undefined), timeoutResult]);
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
		}
	};

	const trySelectSessionWithRetries = async (
		sessionID: string,
		directory?: string,
	): Promise<boolean> => {
		const withDirectory = {
			sessionID,
			...(directory && { directory }),
		};
		const withoutDirectory = { sessionID };

		for (const delayMs of SELECT_SESSION_RETRY_DELAYS_MS) {
			if (!_active || !isCurrentTarget(sessionID, directory)) return false;
			if (delayMs > 0) {
				await sleep(delayMs);
				if (!_active || !isCurrentTarget(sessionID, directory)) return false;
			}

			try {
				const withDirResult = await callAttachedTuiApiWithTimeout(() =>
					client.tui.selectSession(withDirectory),
				);
				if (apiCallSucceeded(withDirResult)) {
					traceController(trace, "attached.select_session.ok", {
						sessionID,
						withDirectory: true,
					});
					return true;
				}
			} catch {
				// Fallback to session-only below.
			}

			if (directory) {
				try {
					const withoutDirResult = await callAttachedTuiApiWithTimeout(() =>
						client.tui.selectSession(withoutDirectory),
					);
					if (apiCallSucceeded(withoutDirResult)) {
						traceController(trace, "attached.select_session.ok", {
							sessionID,
							withDirectory: false,
						});
						return true;
					}
				} catch {
					// Retry below.
				}
			}
		}

		return false;
	};

	const runSelectLoop = async (): Promise<void> => {
		if (selectLoopRunning) return;
		selectLoopRunning = true;
		try {
			while (_active && requestedSessionId) {
				const sessionID = requestedSessionId;
				const directory = requestedDirectory;
				const ok = await trySelectSessionWithRetries(sessionID, directory);

				if (!_active) return;

				if (!isCurrentTarget(sessionID, directory)) {
					continue;
				}

				if (ok) {
					return;
				}

				traceController(trace, "attached.select_session.retry_later", {
					sessionID,
					directory,
				});
				await sleep(ATTACHED_SELECT_SESSION_RETRY_INTERVAL_MS);
			}
		} finally {
			selectLoopRunning = false;
		}
	};

	const monitorProc = (
		trackedProc: { exited: Promise<number | undefined>; kill(): void },
		generation: number,
	) => {
		trackedProc.exited.then((code) => {
			if (generation !== attachGeneration) return;

			_active = false;
			requestedSessionId = undefined;
			requestedDirectory = undefined;
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
	};

	monitorProc(proc, attachGeneration);

	return {
		get active() {
			return _active;
		},

		get attached() {
			return true;
		},

		async selectSession(sessionID: string, directory?: string) {
			if (!_active) return;

			if (respawn && !hasRespawnedForSession) {
				try {
					traceController(trace, "attached.respawn.start", {
						sessionID,
						directory,
					});
					const previousProc = proc;
					try {
						previousProc.kill();
					} catch {
						// ignore
					}
					await Promise.race([previousProc.exited, sleep(300)]);

					const nextProc = respawn(sessionID, directory);
					proc = nextProc;
					attachGeneration += 1;
					hasRespawnedForSession = true;
					monitorProc(proc, attachGeneration);
					traceController(trace, "attached.respawn.ok", {
						sessionID,
						directory,
					});
				} catch (err) {
					traceController(trace, "attached.respawn.error", {
						sessionID,
						directory,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			requestedSessionId = sessionID;
			requestedDirectory = directory;
			traceController(trace, "attached.select_session.start", {
				sessionID,
				directory,
			});
			void runSelectLoop();
		},

		async showToast(
			message: string,
			variant: "info" | "success" | "warning" | "error",
		) {
			if (!_active) return;
			try {
				const result = await callAttachedTuiApiWithTimeout(() =>
					client.tui.showToast({ message, variant }),
				);
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

/**
 * Create a TUI controller.
 *
 * - enabled=false: no-op controller
 * - enabled=true: external attach mode (print URL/command)
 *
 * In all modes, `controller.active` means TUI APIs are currently reachable.
 * Terminal ownership is indicated by `controller.attached`.
 */
export function createTuiController(
	opts: CreateTuiControllerOptions,
): TuiController {
	if (!opts.enabled) {
		traceController(opts.trace, "mode.noop", { reason: "disabled" });
		return createNoopController();
	}
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
