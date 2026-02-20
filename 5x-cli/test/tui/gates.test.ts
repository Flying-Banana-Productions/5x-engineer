import { describe, expect, mock, test } from "bun:test";
import type { EscalationEvent, PhaseSummary } from "../../src/gates/human.js";
import type { TuiController } from "../../src/tui/controller.js";
import {
	createTuiEscalationGate,
	createTuiHumanGate,
	createTuiPhaseGate,
	createTuiPlanReviewResumeGate,
	createTuiResumeGate,
	DEFAULT_GATE_TIMEOUT_MS,
} from "../../src/tui/gates.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock OpenCode client with session methods. */
function createMockClient() {
	let sessionIdCounter = 0;
	const sessions = new Map<string, { id: string; title: string }>();

	return {
		session: {
			create: mock(async (opts: { title?: string }) => {
				const id = `sess-${++sessionIdCounter}`;
				sessions.set(id, { id, title: opts.title ?? "Untitled" });
				return { data: { id }, error: undefined };
			}),
			delete: mock(async (_opts: { sessionID: string }) => {
				return { data: true, error: undefined };
			}),
			prompt: mock(async (_opts: { sessionID: string }) => {
				// Default mock returns "continue" - tests can override
				return {
					data: {
						info: {
							structured: { action: "continue" },
						},
					},
					error: undefined,
				};
			}),
		},
		tui: {
			selectSession: mock(async () => ({ data: true, error: undefined })),
			showToast: mock(async () => ({ data: true, error: undefined })),
		},
	} as unknown as import("@opencode-ai/sdk/v2").OpencodeClient;
}

/** Create a mock TUI controller. */
function createMockTuiController(active = true): TuiController {
	const exitHandlers: Array<() => void> = [];
	let _active = active;

	return {
		get active() {
			return _active;
		},
		set active(value: boolean) {
			_active = value;
		},
		selectSession: mock(async () => {}),
		showToast: mock(async () => {}),
		onExit: (handler: () => void) => {
			if (!_active) {
				handler();
				return;
			}
			exitHandlers.push(handler);
		},
		kill: mock(() => {}),
		// Test helper to simulate exit
		_simulateExit() {
			_active = false;
			for (const handler of exitHandlers) {
				try {
					handler();
				} catch {
					// Swallow errors
				}
			}
		},
	} as unknown as TuiController & { _simulateExit: () => void };
}

// ---------------------------------------------------------------------------
// Phase Gate Tests
// ---------------------------------------------------------------------------

describe("createTuiPhaseGate", () => {
	test("returns gate function", () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);
		expect(typeof gate).toBe("function");
	});

	test("gate resolves 'continue' when user selects continue", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test Phase",
			qualityPassed: true,
		};

		const result = await gate(summary);
		expect(result).toBe("continue");
	});

	test("gate resolves 'review' when user selects review", async () => {
		const client = createMockClient();
		// Override prompt to return "review"
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "review" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test Phase",
			qualityPassed: true,
		};

		const result = await gate(summary);
		expect(result).toBe("review");
	});

	test("gate resolves 'abort' when user selects abort", async () => {
		const client = createMockClient();
		// Override prompt to return "abort"
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "abort" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test Phase",
			qualityPassed: true,
		};

		const result = await gate(summary);
		expect(result).toBe("abort");
	});

	test("gate shows toast notification", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test Phase",
			qualityPassed: true,
		};

		await gate(summary);
		expect(tui.showToast).toHaveBeenCalled();
		const mockCalls = (tui.showToast as ReturnType<typeof mock>).mock.calls;
		expect(mockCalls[0]?.[0]).toContain("Phase 3 complete");
	});

	test("gate creates and cleans up session", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test Phase",
			qualityPassed: true,
		};

		await gate(summary);
		expect(client.session.create).toHaveBeenCalled();
		expect(client.session.delete).toHaveBeenCalled();
	});

	test("gate rejects when TUI exits", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		// Simulate TUI exit before gate is called
		(tui as unknown as { _simulateExit: () => void })._simulateExit();

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test Phase",
			qualityPassed: true,
		};

		await expect(gate(summary)).rejects.toThrow("TUI exited");
	});

	test("gate rejects on abort signal", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const controller = new AbortController();
		const gate = createTuiPhaseGate(client, tui, { signal: controller.signal });

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test Phase",
			qualityPassed: true,
		};

		// Abort immediately
		controller.abort();

		await expect(gate(summary)).rejects.toThrow("aborted");
	});

	test("gate respects custom timeout", async () => {
		const client = createMockClient();
		// Make prompt hang
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			() => new Promise(() => {}),
		);
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui, { timeoutMs: 50 });

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test Phase",
			qualityPassed: true,
		};

		await expect(gate(summary)).rejects.toThrow("timed out");
	});
});

// ---------------------------------------------------------------------------
// Escalation Gate Tests
// ---------------------------------------------------------------------------

describe("createTuiEscalationGate", () => {
	test("returns gate function", () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);
		expect(typeof gate).toBe("function");
	});

	test("gate resolves with 'continue' action", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);

		const event: EscalationEvent = {
			reason: "Test escalation",
			iteration: 1,
		};

		const result = await gate(event);
		expect(result.action).toBe("continue");
	});

	test("gate resolves with 'approve' action", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "approve" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);

		const event: EscalationEvent = {
			reason: "Test escalation",
			iteration: 1,
		};

		const result = await gate(event);
		expect(result.action).toBe("approve");
	});

	test("gate resolves with 'abort' action", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "abort" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);

		const event: EscalationEvent = {
			reason: "Test escalation",
			iteration: 1,
		};

		const result = await gate(event);
		expect(result.action).toBe("abort");
	});

	test("gate includes guidance when continuing", async () => {
		const client = createMockClient();
		let callCount = 0;
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => {
				callCount++;
				if (callCount === 1) {
					return {
						data: { info: { structured: { action: "continue" } } },
						error: undefined,
					};
				}
				return {
					data: { info: { structured: { guidance: "Fix the tests" } } },
					error: undefined,
				};
			},
		);
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);

		const event: EscalationEvent = {
			reason: "Test escalation",
			iteration: 1,
		};

		const result = await gate(event);
		expect(result.action).toBe("continue");
		expect("guidance" in result ? result.guidance : undefined).toBe(
			"Fix the tests",
		);
	});

	test("gate shows error toast", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);

		const event: EscalationEvent = {
			reason: "Test escalation",
			iteration: 1,
		};

		await gate(event);
		expect(tui.showToast).toHaveBeenCalled();
		const mockCalls = (tui.showToast as ReturnType<typeof mock>).mock.calls;
		expect(mockCalls[0]?.[1]).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// Resume Gate Tests
// ---------------------------------------------------------------------------

describe("createTuiResumeGate", () => {
	test("returns gate function", () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiResumeGate(client, tui);
		expect(typeof gate).toBe("function");
	});

	test("gate resolves 'resume' when user selects resume", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "resume" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiResumeGate(client, tui);

		const result = await gate("run-123", "3", "EXECUTE");
		expect(result).toBe("resume");
	});

	test("gate resolves 'start-fresh' when user selects start-fresh", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "start-fresh" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiResumeGate(client, tui);

		const result = await gate("run-123", "3", "EXECUTE");
		expect(result).toBe("start-fresh");
	});

	test("gate resolves 'abort' when user selects abort", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "abort" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiResumeGate(client, tui);

		const result = await gate("run-123", "3", "EXECUTE");
		expect(result).toBe("abort");
	});
});

// ---------------------------------------------------------------------------
// Human Gate Tests (Plan Review)
// ---------------------------------------------------------------------------

describe("createTuiHumanGate", () => {
	test("returns gate function", () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiHumanGate(client, tui);
		expect(typeof gate).toBe("function");
	});

	test("gate resolves 'continue' when user selects continue", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiHumanGate(client, tui);

		const event: EscalationEvent = {
			reason: "Test escalation",
			iteration: 1,
		};

		const result = await gate(event);
		expect(result).toBe("continue");
	});

	test("gate resolves 'approve' when user selects approve", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "approve" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiHumanGate(client, tui);

		const event: EscalationEvent = {
			reason: "Test escalation",
			iteration: 1,
		};

		const result = await gate(event);
		expect(result).toBe("approve");
	});

	test("gate resolves 'abort' when user selects abort", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "abort" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiHumanGate(client, tui);

		const event: EscalationEvent = {
			reason: "Test escalation",
			iteration: 1,
		};

		const result = await gate(event);
		expect(result).toBe("abort");
	});
});

// ---------------------------------------------------------------------------
// Plan Review Resume Gate Tests
// ---------------------------------------------------------------------------

describe("createTuiPlanReviewResumeGate", () => {
	test("returns gate function", () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPlanReviewResumeGate(client, tui);
		expect(typeof gate).toBe("function");
	});

	test("gate resolves 'resume' when user selects resume", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "resume" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiPlanReviewResumeGate(client, tui);

		const result = await gate("run-123", 5);
		expect(result).toBe("resume");
	});

	test("gate resolves 'start-fresh' when user selects start-fresh", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "start-fresh" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiPlanReviewResumeGate(client, tui);

		const result = await gate("run-123", 5);
		expect(result).toBe("start-fresh");
	});

	test("gate resolves 'abort' when user selects abort", async () => {
		const client = createMockClient();
		(client.session.prompt as ReturnType<typeof mock>).mockImplementation(
			async () => ({
				data: { info: { structured: { action: "abort" } } },
				error: undefined,
			}),
		);
		const tui = createMockTuiController();
		const gate = createTuiPlanReviewResumeGate(client, tui);

		const result = await gate("run-123", 5);
		expect(result).toBe("abort");
	});
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("DEFAULT_GATE_TIMEOUT_MS", () => {
	test("default timeout is 30 minutes", () => {
		expect(DEFAULT_GATE_TIMEOUT_MS).toBe(30 * 60 * 1000);
	});
});
