import { describe, expect, mock, test } from "bun:test";
import {
	_createActiveControllerForTest,
	_createNoopControllerForTest,
	createTuiController,
} from "../../src/tui/controller.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock OpenCode client with TUI methods. */
function createMockClient() {
	return {
		tui: {
			selectSession: mock(async () => ({ data: true, error: undefined })),
			showToast: mock(async () => ({ data: true, error: undefined })),
		},
	} as unknown as import("@opencode-ai/sdk/v2").OpencodeClient;
}

/** Create a controllable mock process. */
function createMockProcess() {
	let resolveExited: (code: number | undefined) => void;
	const exited = new Promise<number | undefined>((resolve) => {
		resolveExited = resolve;
	});
	const killFn = mock(() => {});

	return {
		proc: { exited, kill: killFn },
		exit: (code?: number) => resolveExited?.(code ?? 0),
		killFn,
	};
}

// ---------------------------------------------------------------------------
// No-op controller (headless mode)
// ---------------------------------------------------------------------------

describe("no-op TuiController (headless)", () => {
	test("createTuiController({ enabled: false }) returns no-op controller", () => {
		const controller = createTuiController({
			serverUrl: "http://127.0.0.1:12345",
			workdir: "/tmp",
			client: createMockClient(),
			enabled: false,
		});

		expect(controller.active).toBe(false);
	});

	test("no-op controller active is always false", () => {
		const controller = _createNoopControllerForTest();
		expect(controller.active).toBe(false);
	});

	test("no-op controller selectSession resolves without side effects", async () => {
		const controller = _createNoopControllerForTest();
		// Should not throw
		await controller.selectSession("sess-123", "/tmp");
	});

	test("no-op controller showToast resolves without side effects", async () => {
		const controller = _createNoopControllerForTest();
		// Should not throw
		await controller.showToast("Hello", "info");
	});

	test("no-op controller onExit does not fire handler (no TUI was started)", () => {
		// The no-op controller represents headless mode — no TUI process was ever
		// spawned, so there is no exit event. The handler must NOT be called.
		// (Previously the handler fired immediately, causing a spurious "TUI exited"
		// message on every headless run — P0.5 fix.)
		const controller = _createNoopControllerForTest();
		const handler = mock(() => {});
		controller.onExit(handler);
		expect(handler).not.toHaveBeenCalled();
	});

	test("no-op controller kill is a no-op", () => {
		const controller = _createNoopControllerForTest();
		// Should not throw
		controller.kill();
	});

	test("createTuiController falls back to no-op when spawn throws (P1.5)", () => {
		// If the opencode binary is not on PATH, Bun.spawn throws. The controller
		// must return a no-op controller and write a warning to stderr rather than
		// propagating the error.
		const throwingSpawner = (): never => {
			throw new Error("spawn ENOENT: opencode not found");
		};
		// Suppress stderr for this test
		const origWrite = process.stderr.write.bind(process.stderr);
		const stderrLines: string[] = [];
		process.stderr.write = (chunk: string | Uint8Array) => {
			stderrLines.push(typeof chunk === "string" ? chunk : String(chunk));
			return true;
		};
		try {
			const controller = createTuiController(
				{
					serverUrl: "http://127.0.0.1:12345",
					workdir: "/tmp",
					client: createMockClient(),
					enabled: true,
				},
				throwingSpawner,
			);

			// Should have fallen back to headless no-op controller
			expect(controller.active).toBe(false);
			// Should have written a warning to stderr
			const allOutput = stderrLines.join("");
			expect(allOutput).toContain("Warning: Failed to spawn opencode TUI");
			expect(allOutput).toContain("spawn ENOENT");
		} finally {
			process.stderr.write = origWrite;
		}
	});
});

// ---------------------------------------------------------------------------
// Active controller
// ---------------------------------------------------------------------------

describe("active TuiController", () => {
	test("active is true before process exits", () => {
		const { proc } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		expect(controller.active).toBe(true);
	});

	test("active becomes false after process exits", async () => {
		const { proc, exit } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		expect(controller.active).toBe(true);
		exit(0);
		// Allow microtask queue to flush
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(controller.active).toBe(false);
	});

	test("selectSession calls client.tui.selectSession when active", async () => {
		const { proc } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		await controller.selectSession("sess-abc", "/workdir");
		expect(client.tui.selectSession).toHaveBeenCalledTimes(1);
		expect(client.tui.selectSession).toHaveBeenCalledWith({
			sessionID: "sess-abc",
			directory: "/workdir",
		});
	});

	test("selectSession is no-op after process exits", async () => {
		const { proc, exit } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		exit(0);
		await new Promise((resolve) => setTimeout(resolve, 10));

		await controller.selectSession("sess-abc");
		expect(client.tui.selectSession).not.toHaveBeenCalled();
	});

	test("selectSession without directory omits it from call", async () => {
		const { proc } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		await controller.selectSession("sess-abc");
		expect(client.tui.selectSession).toHaveBeenCalledWith({
			sessionID: "sess-abc",
		});
	});

	test("showToast calls client.tui.showToast when active", async () => {
		const { proc } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		await controller.showToast("Phase 1 complete", "success");
		expect(client.tui.showToast).toHaveBeenCalledTimes(1);
		expect(client.tui.showToast).toHaveBeenCalledWith({
			message: "Phase 1 complete",
			variant: "success",
		});
	});

	test("showToast is no-op after process exits", async () => {
		const { proc, exit } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		exit(0);
		await new Promise((resolve) => setTimeout(resolve, 10));

		await controller.showToast("test", "info");
		expect(client.tui.showToast).not.toHaveBeenCalled();
	});

	test("showToast swallows client errors", async () => {
		const { proc } = createMockProcess();
		const client = createMockClient();
		(client.tui.showToast as ReturnType<typeof mock>).mockImplementation(
			async () => {
				throw new Error("TUI disconnected");
			},
		);
		const controller = _createActiveControllerForTest(proc, client);

		// Should not throw
		await controller.showToast("test", "error");
	});

	test("selectSession swallows client errors", async () => {
		const { proc } = createMockProcess();
		const client = createMockClient();
		(client.tui.selectSession as ReturnType<typeof mock>).mockImplementation(
			async () => {
				throw new Error("TUI disconnected");
			},
		);
		const controller = _createActiveControllerForTest(proc, client);

		// Should not throw
		await controller.selectSession("sess-abc");
	});

	test("onExit handler fires when process exits", async () => {
		const { proc, exit } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		const handler = mock(() => {});
		controller.onExit(handler);

		expect(handler).not.toHaveBeenCalled();
		exit(0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("onExit fires immediately if process already exited", async () => {
		const { proc, exit } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		exit(0);
		await new Promise((resolve) => setTimeout(resolve, 10));

		const handler = mock(() => {});
		controller.onExit(handler);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	test("multiple onExit handlers all fire", async () => {
		const { proc, exit } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		const handler1 = mock(() => {});
		const handler2 = mock(() => {});
		controller.onExit(handler1);
		controller.onExit(handler2);

		exit(0);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(handler1).toHaveBeenCalledTimes(1);
		expect(handler2).toHaveBeenCalledTimes(1);
	});

	test("onExit handler errors are swallowed", async () => {
		const { proc, exit } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		const handler1 = mock(() => {
			throw new Error("handler crash");
		});
		const handler2 = mock(() => {});
		controller.onExit(handler1);
		controller.onExit(handler2);

		exit(0);
		await new Promise((resolve) => setTimeout(resolve, 10));

		// handler2 should still fire despite handler1 throwing
		expect(handler1).toHaveBeenCalledTimes(1);
		expect(handler2).toHaveBeenCalledTimes(1);
	});

	test("kill calls process kill", () => {
		const { proc, killFn } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		controller.kill();
		expect(killFn).toHaveBeenCalledTimes(1);
	});

	test("kill is no-op after process exits", async () => {
		const { proc, exit, killFn } = createMockProcess();
		const client = createMockClient();
		const controller = _createActiveControllerForTest(proc, client);

		exit(0);
		await new Promise((resolve) => setTimeout(resolve, 10));

		controller.kill();
		expect(killFn).not.toHaveBeenCalled();
	});

	test("kill swallows errors from process.kill()", () => {
		const { proc } = createMockProcess();
		const client = createMockClient();
		// Override kill to throw
		proc.kill = mock(() => {
			throw new Error("already dead");
		});
		const controller = _createActiveControllerForTest(proc, client);

		// Should not throw
		controller.kill();
	});
});

// ---------------------------------------------------------------------------
// TUI detection / shouldEnableTui
// ---------------------------------------------------------------------------

describe("shouldEnableTui", () => {
	// Import dynamically to avoid side effects
	const { shouldEnableTui } = require("../../src/tui/detect.js");

	test("returns false when --quiet is set", () => {
		expect(shouldEnableTui({ quiet: true })).toBe(false);
	});

	test("returns false when --no-tui is set", () => {
		expect(shouldEnableTui({ "no-tui": true })).toBe(false);
	});

	test("returns false when --quiet and --no-tui are both set", () => {
		expect(shouldEnableTui({ quiet: true, "no-tui": true })).toBe(false);
	});

	// Note: We cannot reliably test TTY detection in a test runner because
	// process.stdin.isTTY and process.stdout.isTTY depend on the test
	// runner's environment. The function is simple enough that the flag
	// tests above + code review of the TTY check suffice.
});
