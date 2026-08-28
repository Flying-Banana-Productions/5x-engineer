/**
 * Unit tests for CLI SIGINT/SIGTERM lifecycle.
 *
 * Uses an injected host so tests never mutate process signal listeners or
 * `process.exit` (required under `bun test --concurrent`).
 */

import { describe, expect, test } from "bun:test";
import {
	_resetCliLifecycleForTest,
	CLI_SIGINT_GRACE_MS,
	type CliLifecycleHost,
	disarmCliLifecycle,
	getCliAbortCause,
	getCliAbortSignal,
	installCliLifecycle,
} from "../../src/cli-lifecycle.js";

interface FakeHost {
	host: CliLifecycleHost;
	exitCodes: number[];
	sigintCount: () => number;
	sigtermCount: () => number;
	emit: (event: "SIGINT" | "SIGTERM") => void;
	timerMs: () => number | undefined;
	timerCleared: () => boolean;
	fireGrace: () => void;
}

function createFakeHost(): FakeHost {
	const listeners: Record<"SIGINT" | "SIGTERM", Array<() => void>> = {
		SIGINT: [],
		SIGTERM: [],
	};
	const exitCodes: number[] = [];
	let timer: { cb: () => void; ms: number } | null = null;
	let cleared = false;

	const host: CliLifecycleHost = {
		on(event, listener) {
			listeners[event].push(listener);
		},
		off(event, listener) {
			listeners[event] = listeners[event].filter((l) => l !== listener);
		},
		exit(code) {
			exitCodes.push(code);
		},
		setTimeout(callback, ms) {
			timer = { cb: callback, ms };
			cleared = false;
			return timer;
		},
		clearTimeout() {
			cleared = true;
		},
	};

	return {
		host,
		exitCodes,
		sigintCount: () => listeners.SIGINT.length,
		sigtermCount: () => listeners.SIGTERM.length,
		emit(event) {
			for (const listener of [...listeners[event]]) {
				listener();
			}
		},
		timerMs: () => timer?.ms,
		timerCleared: () => cleared,
		fireGrace() {
			if (timer && !cleared) timer.cb();
		},
	};
}

/** Serialize access to the module singleton under `--concurrent`. */
let chain = Promise.resolve();

function serial(name: string, fn: () => void | Promise<void>): void {
	test(name, async () => {
		let release!: () => void;
		const prev = chain;
		chain = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			_resetCliLifecycleForTest();
			await fn();
		} finally {
			_resetCliLifecycleForTest();
			release();
		}
	});
}

describe("getCliAbortSignal before install", () => {
	serial("returns a never-aborted signal and undefined cause", () => {
		expect(getCliAbortSignal().aborted).toBe(false);
		expect(getCliAbortCause()).toBeUndefined();
	});
});

describe("installCliLifecycle", () => {
	serial("is idempotent (no duplicate listeners)", () => {
		const fake = createFakeHost();
		const first = installCliLifecycle({ host: fake.host });
		const second = installCliLifecycle({ host: fake.host });
		expect(second).toBe(first);
		expect(fake.sigintCount()).toBe(1);
		expect(fake.sigtermCount()).toBe(1);
	});
});

describe("first signal", () => {
	serial("SIGINT aborts without exiting and records cause", () => {
		const fake = createFakeHost();
		const signal = installCliLifecycle({ host: fake.host });
		expect(signal).toBe(getCliAbortSignal());

		fake.emit("SIGINT");

		expect(getCliAbortSignal().aborted).toBe(true);
		expect(getCliAbortCause()).toBe("SIGINT");
		expect(fake.exitCodes).toEqual([]);
		expect(fake.timerMs()).toBe(CLI_SIGINT_GRACE_MS);
		expect(fake.timerCleared()).toBe(false);
	});

	serial("SIGTERM aborts without exiting and records cause", () => {
		const fake = createFakeHost();
		installCliLifecycle({ host: fake.host });

		fake.emit("SIGTERM");

		expect(getCliAbortSignal().aborted).toBe(true);
		expect(getCliAbortCause()).toBe("SIGTERM");
		expect(fake.exitCodes).toEqual([]);
		expect(fake.timerMs()).toBe(CLI_SIGINT_GRACE_MS);
	});
});

describe("second signal", () => {
	serial(
		"second SIGINT force-exits 130 once; subsequent signals are no-ops",
		() => {
			const fake = createFakeHost();
			installCliLifecycle({ host: fake.host });

			fake.emit("SIGINT");
			expect(fake.exitCodes).toEqual([]);

			fake.emit("SIGINT");
			expect(fake.exitCodes).toEqual([130]);

			fake.emit("SIGINT");
			fake.emit("SIGTERM");
			expect(fake.exitCodes).toEqual([130]);
		},
	);

	serial("second SIGTERM force-exits 143 once", () => {
		const fake = createFakeHost();
		installCliLifecycle({ host: fake.host });

		fake.emit("SIGTERM");
		fake.emit("SIGTERM");
		expect(fake.exitCodes).toEqual([143]);

		fake.emit("SIGTERM");
		expect(fake.exitCodes).toEqual([143]);
	});
});

describe("grace timeout", () => {
	serial("force-exits 130 if still armed after SIGINT", () => {
		const fake = createFakeHost();
		installCliLifecycle({ host: fake.host });

		fake.emit("SIGINT");
		fake.fireGrace();

		expect(fake.exitCodes).toEqual([130]);
	});

	serial("force-exits 143 if still armed after SIGTERM", () => {
		const fake = createFakeHost();
		installCliLifecycle({ host: fake.host });

		fake.emit("SIGTERM");
		fake.fireGrace();

		expect(fake.exitCodes).toEqual([143]);
	});
});

describe("disarmCliLifecycle", () => {
	serial("cancels the grace timer; process does not later force-exit", () => {
		const fake = createFakeHost();
		installCliLifecycle({ host: fake.host });

		fake.emit("SIGINT");
		disarmCliLifecycle();

		expect(fake.timerCleared()).toBe(true);
		fake.fireGrace();
		fake.emit("SIGINT");
		fake.emit("SIGTERM");
		expect(fake.exitCodes).toEqual([]);
	});
});
