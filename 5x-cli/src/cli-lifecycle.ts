/**
 * Process-wide SIGINT/SIGTERM owner for the CLI.
 *
 * First signal aborts in-flight work without exiting so commands (e.g. prompt
 * CAS-abandon) can still use SQLite. A second signal or the grace timer
 * force-exits. `disarmCliLifecycle()` cancels the grace timer when the
 * command unwinds (`parseAsync` returns).
 *
 * DB close and lock release stay on `process.on("exit")` — never on the
 * signal itself.
 */

export const CLI_SIGINT_GRACE_MS = 2_000;

export type CliAbortCause = "SIGINT" | "SIGTERM";

export interface CliLifecycleHost {
	on(event: CliAbortCause, listener: () => void): void;
	off(event: CliAbortCause, listener: () => void): void;
	exit(code: number): void;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(id: unknown): void;
}

export interface InstallCliLifecycleOptions {
	/** Override the grace window. Production uses `CLI_SIGINT_GRACE_MS`. */
	graceMs?: number;
	/** Process I/O seam for unit tests. Defaults to `process` / timers. */
	host?: CliLifecycleHost;
}

const idleController = new AbortController();

let installed = false;
let controller: AbortController | null = null;
let cause: CliAbortCause | undefined;
let graceTimer: unknown = null;
let forceExited = false;
let disarmed = false;
let graceMs = CLI_SIGINT_GRACE_MS;
let host: CliLifecycleHost | null = null;
let sigintListener: (() => void) | null = null;
let sigtermListener: (() => void) | null = null;

function processHost(): CliLifecycleHost {
	return {
		on(event, listener) {
			process.on(event, listener);
		},
		off(event, listener) {
			process.off(event, listener);
		},
		exit(code) {
			process.exit(code);
		},
		setTimeout(callback, ms) {
			return setTimeout(callback, ms);
		},
		clearTimeout(id) {
			clearTimeout(id as ReturnType<typeof setTimeout>);
		},
	};
}

function exitCodeFor(signal: CliAbortCause): number {
	return signal === "SIGTERM" ? 143 : 130;
}

function clearGrace(): void {
	if (graceTimer !== null && host) {
		host.clearTimeout(graceTimer);
	}
	graceTimer = null;
}

function forceExit(code: number): void {
	if (forceExited || disarmed) return;
	forceExited = true;
	clearGrace();
	host?.exit(code);
}

function scheduleGrace(signal: CliAbortCause): void {
	if (!host) return;
	clearGrace();
	graceTimer = host.setTimeout(() => {
		forceExit(exitCodeFor(signal));
	}, graceMs);
}

function onSignal(signal: CliAbortCause): void {
	if (forceExited || disarmed) return;
	if (cause !== undefined) {
		forceExit(exitCodeFor(signal));
		return;
	}
	cause = signal;
	controller?.abort();
	scheduleGrace(signal);
}

/**
 * Register SIGINT/SIGTERM once. Idempotent: a second call returns the
 * existing signal and does not add duplicate listeners.
 */
export function installCliLifecycle(
	opts?: InstallCliLifecycleOptions,
): AbortSignal {
	if (installed && controller) {
		return controller.signal;
	}

	host = opts?.host ?? processHost();
	graceMs = opts?.graceMs ?? CLI_SIGINT_GRACE_MS;
	controller = new AbortController();
	cause = undefined;
	forceExited = false;
	disarmed = false;
	graceTimer = null;

	sigintListener = () => onSignal("SIGINT");
	sigtermListener = () => onSignal("SIGTERM");
	host.on("SIGINT", sigintListener);
	host.on("SIGTERM", sigtermListener);
	installed = true;

	return controller.signal;
}

/** Process abort signal. Never-aborted until `installCliLifecycle()` and a signal. */
export function getCliAbortSignal(): AbortSignal {
	return controller?.signal ?? idleController.signal;
}

/** `"SIGINT"` / `"SIGTERM"` after the first signal; otherwise `undefined`. */
export function getCliAbortCause(): CliAbortCause | undefined {
	return cause;
}

/**
 * Cancel the grace timer. Call when `parseAsync` returns so a completed
 * command (e.g. `run watch` after SIGINT) keeps its own exit code.
 */
export function disarmCliLifecycle(): void {
	disarmed = true;
	clearGrace();
}

/**
 * Reset module state. Only for testing.
 * @internal
 */
export function _resetCliLifecycleForTest(): void {
	clearGrace();
	if (host && sigintListener) {
		host.off("SIGINT", sigintListener);
	}
	if (host && sigtermListener) {
		host.off("SIGTERM", sigtermListener);
	}
	installed = false;
	controller = null;
	cause = undefined;
	graceTimer = null;
	forceExited = false;
	disarmed = false;
	graceMs = CLI_SIGINT_GRACE_MS;
	host = null;
	sigintListener = null;
	sigtermListener = null;
}
