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

type StreamEvent = {
	type: string;
	properties?: Record<string, unknown>;
};

function abortError(): Error {
	const err = new Error("aborted");
	err.name = "AbortError";
	return err;
}

function createSignalAwareStream(
	events: StreamEvent[],
	signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
			let index = 0;
			return {
				async next() {
					if (signal?.aborted) throw abortError();

					if (index < events.length) {
						const value = events[index] as StreamEvent;
						index += 1;
						return { value, done: false };
					}

					await new Promise((_resolve, reject) => {
						if (!signal) return;
						if (signal.aborted) {
							reject(abortError());
							return;
						}
						signal.addEventListener("abort", () => reject(abortError()), {
							once: true,
						});
					});

					throw abortError();
				},
			};
		},
	};
}

function createDecisionEvents(
	sessionId: string,
	messageId: string,
	text: string,
): StreamEvent[] {
	return [
		{
			type: "message.updated",
			properties: {
				info: { id: messageId, sessionID: sessionId, role: "user" },
			},
		},
		{
			type: "message.part.updated",
			properties: {
				part: {
					type: "text",
					sessionID: sessionId,
					messageID: messageId,
					text,
				},
			},
		},
	];
}

function createMockClient(
	streamEvents: StreamEvent[] = [],
	streamFactory?: (signal?: AbortSignal) => AsyncIterable<StreamEvent>,
) {
	const sessionId = "sess-1";
	return {
		session: {
			create: mock(async () => ({ data: { id: sessionId }, error: undefined })),
			delete: mock(async () => ({ data: true, error: undefined })),
			prompt: mock(async () => ({ data: {}, error: undefined })),
		},
		event: {
			subscribe: mock(
				async (_opts?: unknown, req?: { signal?: AbortSignal }) => ({
					stream: streamFactory
						? streamFactory(req?.signal)
						: createSignalAwareStream(streamEvents, req?.signal),
				}),
			),
		},
	} as unknown as import("@opencode-ai/sdk/v2").OpencodeClient;
}

function createMockTuiController(active = true): TuiController & {
	_simulateExit: (code?: number, isUserCancellation?: boolean) => void;
} {
	const exitHandlers = new Set<
		(info: { code: number | undefined; isUserCancellation: boolean }) => void
	>();
	let _active = active;

	return {
		get active() {
			return _active;
		},
		get attached() {
			return active;
		},
		selectSession: mock(async () => {}),
		showToast: mock(async () => {}),
		onExit(handler) {
			if (!_active) {
				handler({ code: 0, isUserCancellation: false });
				return () => {};
			}
			exitHandlers.add(handler);
			return () => exitHandlers.delete(handler);
		},
		kill: mock(() => {}),
		_simulateExit(code = 0, isUserCancellation = false) {
			_active = false;
			for (const handler of exitHandlers) {
				handler({ code, isUserCancellation });
			}
			exitHandlers.clear();
		},
	};
}

function captureConsoleLogs(run: () => Promise<void>): Promise<string[]> {
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map((arg) => String(arg)).join(" "));
	};
	return run()
		.finally(() => {
			console.log = originalLog;
		})
		.then(() => logs);
}

describe("createTuiPhaseGate", () => {
	test("resolves continue from explicit user message", async () => {
		const client = createMockClient(
			createDecisionEvents("sess-1", "msg-1", "continue"),
		);
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Test",
			qualityPassed: true,
		};

		const result = await gate(summary);
		expect(result).toBe("continue");
		expect(client.session.create).toHaveBeenCalledTimes(1);
		expect(client.session.delete).toHaveBeenCalledTimes(1);
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	test("blocks until a user message arrives", async () => {
		const delayedStream = async function* (signal?: AbortSignal) {
			yield {
				type: "message.updated",
				properties: {
					info: { id: "assistant-1", sessionID: "sess-1", role: "assistant" },
				},
			} satisfies StreamEvent;

			await new Promise((resolve) => setTimeout(resolve, 30));
			if (signal?.aborted) throw abortError();

			yield createDecisionEvents(
				"sess-1",
				"msg-2",
				"continue",
			)[0] as StreamEvent;
			yield createDecisionEvents(
				"sess-1",
				"msg-2",
				"continue",
			)[1] as StreamEvent;
		};

		const client = createMockClient([], delayedStream);
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		const summary: PhaseSummary = {
			phaseNumber: "1",
			phaseTitle: "Block test",
			qualityPassed: true,
		};

		const startedAt = Date.now();
		await expect(gate(summary)).resolves.toBe("continue");
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
	});

	test("times out to abort", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui, { timeoutMs: 20 });

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Timeout",
			qualityPassed: true,
		};

		await expect(gate(summary)).resolves.toBe("abort");
	});

	test("aborts when signal is aborted", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const controller = new AbortController();
		const gate = createTuiPhaseGate(client, tui, { signal: controller.signal });

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Abort",
			qualityPassed: true,
		};

		const pending = gate(summary);
		controller.abort();
		await expect(pending).resolves.toBe("abort");
	});

	test("falls back to headless gate when TUI exits mid-wait", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPhaseGate(client, tui);

		const summary: PhaseSummary = {
			phaseNumber: "3",
			phaseTitle: "Exit fallback",
			qualityPassed: true,
		};

		const logs = await captureConsoleLogs(async () => {
			const pending = gate(summary);
			setTimeout(() => tui._simulateExit(1, false), 0);
			await expect(pending).resolves.toBe("exit");
		});

		expect(logs.some((line) => line.includes("Phase 3"))).toBe(true);
	});
});

describe("createTuiEscalationGate", () => {
	test("resolves continue with guidance from user text", async () => {
		const client = createMockClient(
			createDecisionEvents("sess-1", "msg-1", "continue: fix tests first"),
		);
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);

		const event: EscalationEvent = { reason: "Needs human", iteration: 1 };
		const result = await gate(event);

		expect(result.action).toBe("continue");
		expect("guidance" in result ? result.guidance : undefined).toBe(
			"fix tests first",
		);
		expect(client.session.prompt).not.toHaveBeenCalled();
	});

	test("resolves approve from user text", async () => {
		const client = createMockClient(
			createDecisionEvents("sess-1", "msg-1", "approve"),
		);
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);

		const event: EscalationEvent = { reason: "Needs human", iteration: 1 };
		await expect(gate(event)).resolves.toEqual({ action: "approve" });
	});

	test("times out to abort", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui, { timeoutMs: 20 });

		const event: EscalationEvent = { reason: "Needs human", iteration: 1 };
		await expect(gate(event)).resolves.toEqual({ action: "abort" });
	});

	test("aborts when signal is aborted", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const controller = new AbortController();
		const gate = createTuiEscalationGate(client, tui, {
			signal: controller.signal,
		});

		const event: EscalationEvent = { reason: "Needs human", iteration: 1 };
		const pending = gate(event);
		controller.abort();
		await expect(pending).resolves.toEqual({ action: "abort" });
	});

	test("falls back to headless gate when TUI exits mid-wait", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiEscalationGate(client, tui);

		const event: EscalationEvent = { reason: "Needs human", iteration: 1 };
		const logs = await captureConsoleLogs(async () => {
			const pending = gate(event);
			setTimeout(() => tui._simulateExit(1, false), 0);
			await expect(pending).resolves.toEqual({ action: "abort" });
		});

		expect(logs.some((line) => line.includes("Escalation"))).toBe(true);
	});
});

describe("createTuiResumeGate", () => {
	test("resolves start-fresh from user text", async () => {
		const client = createMockClient(
			createDecisionEvents("sess-1", "msg-1", "start fresh"),
		);
		const tui = createMockTuiController();
		const gate = createTuiResumeGate(client, tui);

		await expect(gate("run-1", "3", "EXECUTE")).resolves.toBe("start-fresh");
	});

	test("creates/selects gate session with configured directory", async () => {
		const client = createMockClient(
			createDecisionEvents("sess-1", "msg-1", "resume"),
		);
		const tui = createMockTuiController();
		const gate = createTuiResumeGate(client, tui, { directory: "/repo" });

		await expect(gate("run-1234", "3", "EXECUTE")).resolves.toBe("resume");
		expect(client.session.create).toHaveBeenCalledWith({
			title: "Resume: Run run-1234",
			directory: "/repo",
		});
		expect(tui.selectSession).toHaveBeenCalledWith("sess-1", "/repo");
	});

	test("times out to abort", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiResumeGate(client, tui, { timeoutMs: 20 });

		await expect(gate("run-1", "3", "EXECUTE")).resolves.toBe("abort");
	});

	test("aborts when signal is aborted", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const controller = new AbortController();
		const gate = createTuiResumeGate(client, tui, {
			signal: controller.signal,
		});

		const pending = gate("run-1", "3", "EXECUTE");
		controller.abort();
		await expect(pending).resolves.toBe("abort");
	});

	test("falls back to headless gate when TUI exits mid-wait", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiResumeGate(client, tui);

		const logs = await captureConsoleLogs(async () => {
			const pending = gate("run-1", "3", "EXECUTE");
			setTimeout(() => tui._simulateExit(1, false), 0);
			await expect(pending).resolves.toBe("abort");
		});

		expect(logs.some((line) => line.includes("Found interrupted run"))).toBe(
			true,
		);
	});
});

describe("plan-review gate wrappers", () => {
	test("human gate maps escalation response to action", async () => {
		const client = createMockClient(
			createDecisionEvents("sess-1", "msg-1", "approve"),
		);
		const tui = createMockTuiController();
		const gate = createTuiHumanGate(client, tui);

		const event: EscalationEvent = { reason: "review", iteration: 1 };
		await expect(gate(event)).resolves.toBe("approve");
	});

	test("plan-review resume gate delegates to resume parser", async () => {
		const client = createMockClient(
			createDecisionEvents("sess-1", "msg-1", "resume"),
		);
		const tui = createMockTuiController();
		const gate = createTuiPlanReviewResumeGate(client, tui);

		await expect(gate("run-1", 5)).resolves.toBe("resume");
	});

	test("human gate timeout resolves abort", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiHumanGate(client, tui, { timeoutMs: 20 });

		const event: EscalationEvent = { reason: "review", iteration: 1 };
		await expect(gate(event)).resolves.toBe("abort");
	});

	test("plan-review resume gate timeout resolves abort", async () => {
		const client = createMockClient();
		const tui = createMockTuiController();
		const gate = createTuiPlanReviewResumeGate(client, tui, { timeoutMs: 20 });

		await expect(gate("run-1", 5)).resolves.toBe("abort");
	});
});

describe("DEFAULT_GATE_TIMEOUT_MS", () => {
	test("is 30 minutes", () => {
		expect(DEFAULT_GATE_TIMEOUT_MS).toBe(30 * 60 * 1000);
	});
});
