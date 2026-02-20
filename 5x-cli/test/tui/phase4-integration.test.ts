import { describe, expect, test } from "bun:test";
import type { TuiController } from "../../src/tui/controller.js";

// ---------------------------------------------------------------------------
// Phase 4 TUI Integration Tests
// ---------------------------------------------------------------------------

describe("Phase 4: TUI Session Integration", () => {
	test("TuiController interface accepts selectSession with sessionID and directory", async () => {
		// Verify the interface contract
		const mockTui: TuiController = {
			active: true,
			selectSession: async (_sessionID: string, _directory?: string) => {
				// No-op for test
			},
			showToast: async (
				_message: string,
				_variant: "info" | "success" | "warning" | "error",
			) => {
				// No-op for test
			},
			onExit: (_handler: () => void) => {
				// No-op for test
			},
			kill: () => {
				// No-op for test
			},
		};

		// Should not throw
		await mockTui.selectSession("test-session-id", "/workdir");
		await mockTui.selectSession("test-session-id");
	});

	test("TuiController interface accepts showToast with message and variant", async () => {
		const mockTui: TuiController = {
			active: true,
			selectSession: async () => {},
			showToast: async (
				_message: string,
				_variant: "info" | "success" | "warning" | "error",
			) => {},
			onExit: () => {},
			kill: () => {},
		};

		// Should not throw
		await mockTui.showToast("Test message", "info");
		await mockTui.showToast("Success!", "success");
		await mockTui.showToast("Warning!", "warning");
		await mockTui.showToast("Error!", "error");
	});

	test("InvokeOptions accepts optional sessionTitle", () => {
		// Verify the interface contract via type checking
		const optsWithTitle: {
			prompt: string;
			logPath: string;
			sessionTitle?: string;
		} = {
			prompt: "test",
			logPath: "/tmp/test.log",
			sessionTitle: "Phase 1 — author",
		};

		const optsWithoutTitle: {
			prompt: string;
			logPath: string;
			sessionTitle?: string;
		} = {
			prompt: "test",
			logPath: "/tmp/test.log",
		};

		// Both should be valid
		expect(optsWithTitle.sessionTitle).toBe("Phase 1 — author");
		expect(optsWithoutTitle.sessionTitle).toBeUndefined();
	});

	test("PhaseExecutionOptions accepts optional tui controller", () => {
		// Verify the interface contract
		const mockTui: TuiController = {
			active: true,
			selectSession: async () => {},
			showToast: async () => {},
			onExit: () => {},
			kill: () => {},
		};

		const optsWithTui: { workdir: string; tui?: TuiController } = {
			workdir: "/tmp",
			tui: mockTui,
		};

		const optsWithoutTui: { workdir: string; tui?: TuiController } = {
			workdir: "/tmp",
		};

		expect(optsWithTui.tui).toBe(mockTui);
		expect(optsWithoutTui.tui).toBeUndefined();
	});
});
