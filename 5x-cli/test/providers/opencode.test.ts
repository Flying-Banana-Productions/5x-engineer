/**
 * Integration tests for OpenCodeProvider.
 *
 * Uses mock client/server pattern from test/agents/opencode.test.ts.
 * Tests cover: managed mode lifecycle, external mode, structured output,
 * session resume, timeout, cancellation, and AgentEvent stream mapping.
 */

import { describe, expect, mock, test } from "bun:test";
import {
	createProvider,
	InvalidProviderError,
	ProviderNotFoundError,
} from "../../src/providers/factory.js";
import {
	AgentCancellationError,
	AgentTimeoutError,
	OpenCodeProvider,
	parseModel,
} from "../../src/providers/opencode.js";
import type { AgentEvent } from "../../src/providers/types.js";

// ---------------------------------------------------------------------------
// Mock helpers (adapted from test/agents/opencode.test.ts)
// ---------------------------------------------------------------------------

function createMockClient(
	overrides: {
		sessionCreate?: (...args: unknown[]) => Promise<unknown>;
		sessionPrompt?: (...args: unknown[]) => Promise<unknown>;
		sessionAbort?: (...args: unknown[]) => Promise<unknown>;
		sessionList?: (...args: unknown[]) => Promise<unknown>;
		sessionGet?: (...args: unknown[]) => Promise<unknown>;
		sessionMessages?: (...args: unknown[]) => Promise<unknown>;
		eventSubscribe?: (...args: unknown[]) => Promise<unknown>;
	} = {},
) {
	const defaultSession = {
		id: "sess-test-123",
		projectID: "proj-1",
		directory: "/tmp/work",
		title: "test",
		version: "1",
		time: { created: Date.now(), updated: Date.now() },
	};

	return {
		session: {
			create:
				overrides.sessionCreate ??
				(async () => ({
					data: defaultSession,
					error: undefined,
				})),
			prompt:
				overrides.sessionPrompt ??
				(async () => ({
					data: {
						info: {
							id: "msg-1",
							sessionID: "sess-test-123",
							role: "assistant",
							structured: { result: "complete", commit: "abc123" },
							tokens: {
								input: 100,
								output: 50,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.005,
							error: undefined,
							time: { created: Date.now(), completed: Date.now() },
						},
						parts: [{ type: "text", text: "Task completed." }],
					},
					error: undefined,
				})),
			abort:
				overrides.sessionAbort ??
				(async () => ({ data: true, error: undefined })),
			list:
				overrides.sessionList ?? (async () => ({ data: [], error: undefined })),
			get:
				overrides.sessionGet ??
				(async () => ({
					data: { ...defaultSession },
					error: undefined,
				})),
			messages:
				overrides.sessionMessages ??
				(async () => ({ data: [], error: undefined })),
		},
		event: {
			subscribe:
				overrides.eventSubscribe ??
				(async () => ({
					stream: (async function* () {
						// Empty stream
					})(),
				})),
		},
	};
}

function createMockServer(url = "http://127.0.0.1:51234") {
	return {
		url,
		close: mock(() => {}),
	};
}

function createTestProvider(
	clientOverrides: Parameters<typeof createMockClient>[0] = {},
	opts: { model?: string; external?: boolean } = {},
): {
	provider: OpenCodeProvider;
	client: ReturnType<typeof createMockClient>;
	server: ReturnType<typeof createMockServer> | null;
} {
	const client = createMockClient(clientOverrides);
	const server = opts.external ? null : createMockServer();
	const provider = new OpenCodeProvider(
		client as unknown as ConstructorParameters<typeof OpenCodeProvider>[0],
		server,
		opts.model,
	);
	return { provider, client, server };
}

// ---------------------------------------------------------------------------
// parseModel
// ---------------------------------------------------------------------------

describe("parseModel", () => {
	test("parses valid provider/model string", () => {
		expect(parseModel("anthropic/claude-sonnet-4-6")).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-6",
		});
	});

	test("handles model with multiple slashes", () => {
		expect(parseModel("openai/gpt-4/turbo")).toEqual({
			providerID: "openai",
			modelID: "gpt-4/turbo",
		});
	});

	test("throws on missing slash", () => {
		expect(() => parseModel("just-a-model")).toThrow("Invalid model format");
	});

	test("throws on leading slash", () => {
		expect(() => parseModel("/model")).toThrow("Invalid model format");
	});
});

// ---------------------------------------------------------------------------
// OpenCodeProvider — verify
// ---------------------------------------------------------------------------

describe("OpenCodeProvider.verify", () => {
	test("succeeds when server is reachable", async () => {
		const { provider } = createTestProvider();
		await expect(provider.verify()).resolves.toBeUndefined();
	});

	test("throws when health check fails", async () => {
		const { provider } = createTestProvider({
			sessionList: async () => {
				throw new Error("connection refused");
			},
		});
		await expect(provider.verify()).rejects.toThrow(
			"OpenCode server health check failed",
		);
	});

	test("throws when server returns error", async () => {
		const { provider } = createTestProvider({
			sessionList: async () => ({
				data: undefined,
				error: { message: "server error" },
			}),
		});
		await expect(provider.verify()).rejects.toThrow(
			"OpenCode server health check failed",
		);
	});
});

// ---------------------------------------------------------------------------
// OpenCodeProvider — close
// ---------------------------------------------------------------------------

describe("OpenCodeProvider.close", () => {
	test("calls server.close() on managed provider", async () => {
		const { provider, server } = createTestProvider();
		await provider.close();
		expect(server?.close).toHaveBeenCalledTimes(1);
	});

	test("is idempotent", async () => {
		const { provider, server } = createTestProvider();
		await provider.close();
		await provider.close();
		expect(server?.close).toHaveBeenCalledTimes(1);
	});

	test("does not throw on external mode", async () => {
		const { provider } = createTestProvider({}, { external: true });
		await expect(provider.close()).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// OpenCodeProvider — startSession
// ---------------------------------------------------------------------------

describe("OpenCodeProvider.startSession", () => {
	test("creates a session and returns AgentSession", async () => {
		const { provider } = createTestProvider();
		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp/work",
		});

		expect(session.id).toBe("sess-test-123");
		expect(typeof session.run).toBe("function");
		expect(typeof session.runStreamed).toBe("function");
	});

	test("passes directory to session.create", async () => {
		const createFn = mock(async () => ({
			data: { id: "sess-new" },
			error: undefined,
		}));
		const { provider } = createTestProvider({ sessionCreate: createFn });

		await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp/myproject",
		});

		expect(createFn).toHaveBeenCalledTimes(1);
		const args = createFn.mock.calls[0] as unknown[];
		const params = args[0] as Record<string, unknown>;
		expect(params.directory).toBe("/tmp/myproject");
	});

	test("throws on session creation failure", async () => {
		const { provider } = createTestProvider({
			sessionCreate: async () => ({
				data: undefined,
				error: { message: "out of quota" },
			}),
		});

		await expect(
			provider.startSession({
				model: "anthropic/claude-sonnet-4-6",
				workingDirectory: "/tmp",
			}),
		).rejects.toThrow("Failed to create session");
	});
});

// ---------------------------------------------------------------------------
// OpenCodeProvider — resumeSession
// ---------------------------------------------------------------------------

describe("OpenCodeProvider.resumeSession", () => {
	test("retrieves existing session", async () => {
		const { provider } = createTestProvider();
		const session = await provider.resumeSession("sess-test-123");
		expect(session.id).toBe("sess-test-123");
	});

	test("throws on non-existent session", async () => {
		const { provider } = createTestProvider({
			sessionGet: async () => ({
				data: undefined,
				error: { message: "not found" },
			}),
		});

		await expect(provider.resumeSession("non-existent")).rejects.toThrow(
			'Failed to resume session "non-existent"',
		);
	});
});

// ---------------------------------------------------------------------------
// AgentSession.run — structured output
// ---------------------------------------------------------------------------

describe("AgentSession.run", () => {
	test("executes prompt and returns RunResult without schema", async () => {
		const { provider } = createTestProvider();
		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});

		const result = await session.run("Implement the feature");
		expect(result.sessionId).toBe("sess-test-123");
		expect(result.tokens.in).toBe(100);
		expect(result.tokens.out).toBe(50);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.structured).toBeUndefined();
	});

	test("extracts structured output with AuthorStatus schema", async () => {
		let promptCount = 0;
		const { provider } = createTestProvider({
			sessionPrompt: async () => {
				promptCount++;
				if (promptCount === 1) {
					// Execute prompt — no structured output
					return {
						data: {
							info: {
								id: "msg-1",
								role: "assistant",
								tokens: { input: 200, output: 100 },
								time: { created: Date.now(), completed: Date.now() },
							},
							parts: [{ type: "text", text: "I implemented the feature." }],
						},
						error: undefined,
					};
				}
				// Summary prompt — with structured output
				return {
					data: {
						info: {
							id: "msg-2",
							role: "assistant",
							structured: { result: "complete", commit: "abc123" },
							tokens: { input: 50, output: 30 },
							cost: 0.003,
							time: { created: Date.now(), completed: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});

		const result = await session.run("Implement the feature", {
			outputSchema: {
				type: "object",
				properties: {
					result: {
						type: "string",
						enum: ["complete", "needs_human", "failed"],
					},
					commit: { type: "string" },
				},
				required: ["result"],
			},
		});

		expect(result.structured).toEqual({ result: "complete", commit: "abc123" });
		expect(result.costUsd).toBe(0.003);
		expect(promptCount).toBe(2); // execute + summary
	});

	test("extracts structured output with ReviewerVerdict schema", async () => {
		let promptCount = 0;
		const { provider } = createTestProvider({
			sessionPrompt: async () => {
				promptCount++;
				if (promptCount === 1) {
					return {
						data: {
							info: {
								id: "msg-1",
								role: "assistant",
								tokens: { input: 200, output: 150 },
								time: { created: Date.now(), completed: Date.now() },
							},
							parts: [{ type: "text", text: "Review complete." }],
						},
						error: undefined,
					};
				}
				return {
					data: {
						info: {
							id: "msg-2",
							role: "assistant",
							structured: {
								readiness: "ready_with_corrections",
								items: [
									{
										id: "P1.1",
										title: "Missing test",
										action: "auto_fix",
										reason: "No test coverage for edge case",
									},
								],
							},
							tokens: { input: 50, output: 40 },
							time: { created: Date.now(), completed: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});

		const result = await session.run("Review this phase", {
			outputSchema: {
				type: "object",
				properties: {
					readiness: {
						type: "string",
						enum: ["ready", "ready_with_corrections", "not_ready"],
					},
					items: { type: "array" },
				},
				required: ["readiness", "items"],
			},
		});

		expect(result.structured).toEqual({
			readiness: "ready_with_corrections",
			items: [
				{
					id: "P1.1",
					title: "Missing test",
					action: "auto_fix",
					reason: "No test coverage for edge case",
				},
			],
		});
	});

	test("passes model override to prompt call", async () => {
		const promptFn = mock(async () => ({
			data: {
				info: {
					id: "msg-1",
					role: "assistant",
					tokens: { input: 10, output: 5 },
					time: { created: Date.now(), completed: Date.now() },
				},
				parts: [],
			},
			error: undefined,
		}));

		const { provider } = createTestProvider(
			{ sessionPrompt: promptFn },
			{ model: "anthropic/claude-sonnet-4-6" },
		);

		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});
		await session.run("test");

		expect(promptFn).toHaveBeenCalledTimes(1);
		const args = promptFn.mock.calls[0] as unknown[];
		const params = args[0] as Record<string, unknown>;
		expect(params.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-6",
		});
	});
});

// ---------------------------------------------------------------------------
// AgentSession.run — timeout / cancellation
// ---------------------------------------------------------------------------

describe("AgentSession.run — timeout", () => {
	test("throws AgentTimeoutError when run exceeds timeout", async () => {
		const { provider } = createTestProvider({
			sessionPrompt: async () => {
				// Simulate slow response
				await new Promise((resolve) => setTimeout(resolve, 2000));
				return {
					data: { info: { tokens: { input: 0, output: 0 } }, parts: [] },
					error: undefined,
				};
			},
		});

		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});

		await expect(
			session.run("slow task", { timeout: 0.1 }), // 100ms
		).rejects.toBeInstanceOf(AgentTimeoutError);
	});

	test("throws AgentCancellationError on external AbortSignal", async () => {
		const controller = new AbortController();
		const { provider } = createTestProvider({
			sessionPrompt: async () => {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				return {
					data: { info: { tokens: { input: 0, output: 0 } }, parts: [] },
					error: undefined,
				};
			},
		});

		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});

		// Abort after 50ms
		setTimeout(() => controller.abort(), 50);

		await expect(
			session.run("cancelled task", { signal: controller.signal }),
		).rejects.toBeInstanceOf(AgentCancellationError);
	});

	test("aborts the session on timeout", async () => {
		const abortFn = mock(async () => ({ data: true, error: undefined }));
		const { provider } = createTestProvider({
			sessionPrompt: async () => {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				return {
					data: { info: { tokens: { input: 0, output: 0 } }, parts: [] },
					error: undefined,
				};
			},
			sessionAbort: abortFn,
		});

		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});

		try {
			await session.run("slow task", { timeout: 0.1 });
		} catch {
			// Expected
		}

		expect(abortFn).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// AgentSession.runStreamed — AgentEvent mapping
// ---------------------------------------------------------------------------

describe("AgentSession.runStreamed", () => {
	test("emits AgentEvent objects from SSE stream", async () => {
		const sessionId = "sess-test-123";
		const { provider } = createTestProvider({
			eventSubscribe: async () => ({
				stream: (async function* () {
					// text delta
					yield {
						type: "message.part.updated",
						properties: {
							sessionID: sessionId,
							part: { id: "p1", type: "text" },
							delta: "Hello ",
						},
					};
					// more text
					yield {
						type: "message.part.updated",
						properties: {
							sessionID: sessionId,
							part: { id: "p1", type: "text" },
							delta: "world!",
						},
					};
					// reasoning
					yield {
						type: "message.part.updated",
						properties: {
							sessionID: sessionId,
							part: { id: "p2", type: "reasoning" },
							delta: "Let me think...",
						},
					};
					// tool start
					yield {
						type: "message.part.updated",
						properties: {
							sessionID: sessionId,
							part: {
								id: "p3",
								type: "tool",
								tool: "bash",
								state: { status: "running", input: { command: "ls -la" } },
							},
						},
					};
					// tool end
					yield {
						type: "message.part.updated",
						properties: {
							sessionID: sessionId,
							part: {
								id: "p3",
								type: "tool",
								tool: "bash",
								state: {
									status: "completed",
									input: { command: "ls -la" },
									output: "file.txt\ndir/",
								},
							},
						},
					};
				})(),
			}),
			// Delay prompt slightly so SSE events are consumed before prompt completes
			sessionPrompt: async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return {
					data: {
						info: {
							id: "msg-1",
							role: "assistant",
							tokens: { input: 50, output: 25 },
							cost: 0.001,
							time: { created: Date.now(), completed: Date.now() },
						},
						parts: [{ type: "text", text: "Hello world!" }],
					},
					error: undefined,
				};
			},
		});

		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});

		const events: AgentEvent[] = [];
		for await (const event of session.runStreamed("Do something")) {
			events.push(event);
		}

		// Should have text events, reasoning, tool events, usage, done
		const textEvents = events.filter((e) => e.type === "text");
		expect(textEvents.length).toBeGreaterThanOrEqual(2);
		expect(textEvents[0]).toEqual({ type: "text", delta: "Hello " });
		expect(textEvents[1]).toEqual({ type: "text", delta: "world!" });

		const reasoningEvents = events.filter((e) => e.type === "reasoning");
		expect(reasoningEvents.length).toBeGreaterThanOrEqual(1);
		expect(reasoningEvents[0]).toEqual({
			type: "reasoning",
			delta: "Let me think...",
		});

		const toolStartEvents = events.filter((e) => e.type === "tool_start");
		expect(toolStartEvents.length).toBeGreaterThanOrEqual(1);
		expect(toolStartEvents[0]).toEqual({
			type: "tool_start",
			tool: "bash",
			input_summary: "ls -la",
		});

		const toolEndEvents = events.filter((e) => e.type === "tool_end");
		expect(toolEndEvents.length).toBeGreaterThanOrEqual(1);
		expect(toolEndEvents[0]).toMatchObject({
			type: "tool_end",
			tool: "bash",
			error: false,
		});

		// Should end with usage + done
		const doneEvents = events.filter((e) => e.type === "done");
		expect(doneEvents.length).toBe(1);
		const done = doneEvents[0] as Extract<AgentEvent, { type: "done" }>;
		expect(done.result.sessionId).toBe("sess-test-123");
		expect(done.result.tokens.in).toBe(50);
		expect(done.result.tokens.out).toBe(25);
	});

	test("filters events to target session only", async () => {
		const sessionId = "sess-test-123";
		const { provider } = createTestProvider({
			eventSubscribe: async () => ({
				stream: (async function* () {
					// Event from another session — should be filtered
					yield {
						type: "message.part.updated",
						properties: {
							sessionID: "other-session",
							part: { id: "p0", type: "text" },
							delta: "SHOULD NOT APPEAR",
						},
					};
					// Event from target session
					yield {
						type: "message.part.updated",
						properties: {
							sessionID: sessionId,
							part: { id: "p1", type: "text" },
							delta: "visible",
						},
					};
				})(),
			}),
			sessionPrompt: async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return {
					data: {
						info: {
							id: "msg-1",
							role: "assistant",
							tokens: { input: 10, output: 5 },
							time: { created: Date.now(), completed: Date.now() },
						},
						parts: [{ type: "text", text: "visible" }],
					},
					error: undefined,
				};
			},
		});

		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp",
		});

		const events: AgentEvent[] = [];
		for await (const event of session.runStreamed("test")) {
			events.push(event);
		}

		const textEvents = events.filter((e) => e.type === "text");
		for (const e of textEvents) {
			expect((e as Extract<AgentEvent, { type: "text" }>).delta).not.toBe(
				"SHOULD NOT APPEAR",
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

describe("createProvider", () => {
	test("defaults to opencode when provider not specified", async () => {
		// This will try to spawn a real OpenCode server, which may fail in CI.
		// The test validates the code path, not the server availability.
		const config = {
			author: { model: "anthropic/claude-sonnet-4-6" },
			reviewer: {},
			qualityGates: [],
			worktree: {},
			paths: {
				plans: "docs/development",
				reviews: "docs/development/reviews",
				archive: "docs/archive",
				templates: {
					plan: "docs/_implementation_plan_template.md",
					review: "docs/development/reviews/_review_template.md",
				},
			},
			db: { path: ".5x/5x.db" },
			maxReviewIterations: 5,
			maxQualityRetries: 3,
			maxAutoIterations: 10,
			maxAutoRetries: 3,
		};

		try {
			const provider = await createProvider(
				"author",
				config as Parameters<typeof createProvider>[1],
			);
			// If we get here, OpenCode is available
			expect(typeof provider.startSession).toBe("function");
			expect(typeof provider.close).toBe("function");
			await provider.close();
		} catch (err) {
			// Expected if OpenCode not installed
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toMatch(/OpenCode server/);
		}
	});

	test("throws ProviderNotFoundError for missing plugin", async () => {
		const config = {
			author: { provider: "nonexistent-provider-xyz" },
			reviewer: {},
			qualityGates: [],
			worktree: {},
			paths: {
				plans: "docs/development",
				reviews: "docs/development/reviews",
				archive: "docs/archive",
				templates: {
					plan: "docs/_implementation_plan_template.md",
					review: "docs/development/reviews/_review_template.md",
				},
			},
			db: { path: ".5x/5x.db" },
			maxReviewIterations: 5,
			maxQualityRetries: 3,
			maxAutoIterations: 10,
			maxAutoRetries: 3,
		};

		await expect(
			createProvider("author", config as Parameters<typeof createProvider>[1]),
		).rejects.toBeInstanceOf(ProviderNotFoundError);
	});
});

// ---------------------------------------------------------------------------
// External mode
// ---------------------------------------------------------------------------

describe("OpenCodeProvider — external mode", () => {
	test("createExternal connects without spawning server", () => {
		// This is a synchronous operation — just creates the client
		const provider = OpenCodeProvider.createExternal("http://localhost:3000", {
			model: "anthropic/claude-sonnet-4-6",
		});
		expect(provider.serverUrl).toBe("(external)");
	});

	test("close is a no-op in external mode", async () => {
		const { provider } = createTestProvider({}, { external: true });
		// Should not throw
		await provider.close();
		await provider.close(); // idempotent
	});
});

// ---------------------------------------------------------------------------
// Managed mode lifecycle (full flow)
// ---------------------------------------------------------------------------

describe("OpenCodeProvider — managed lifecycle", () => {
	test("create → startSession → run → close", async () => {
		let promptCount = 0;
		const { provider } = createTestProvider({
			sessionPrompt: async () => {
				promptCount++;
				return {
					data: {
						info: {
							id: `msg-${promptCount}`,
							role: "assistant",
							structured:
								promptCount === 2
									? { result: "complete", commit: "abc123" }
									: undefined,
							tokens: { input: 100, output: 50 },
							cost: 0.005,
							time: { created: Date.now(), completed: Date.now() },
						},
						parts: [{ type: "text", text: "Done." }],
					},
					error: undefined,
				};
			},
		});

		// Verify
		await provider.verify();

		// Start session
		const session = await provider.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp/work",
		});
		expect(session.id).toBe("sess-test-123");

		// Run with structured output
		const result = await session.run("implement feature", {
			outputSchema: {
				type: "object",
				properties: { result: { type: "string" }, commit: { type: "string" } },
				required: ["result"],
			},
		});
		expect(result.structured).toEqual({ result: "complete", commit: "abc123" });
		expect(result.tokens.in).toBe(100);
		expect(result.tokens.out).toBe(50);
		expect(result.costUsd).toBe(0.005);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		// Close
		await provider.close();
	});
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

describe("Error classes", () => {
	test("AgentTimeoutError is an Error", () => {
		const err = new AgentTimeoutError("timed out");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("AgentTimeoutError");
		expect(err.message).toBe("timed out");
	});

	test("AgentCancellationError is an Error", () => {
		const err = new AgentCancellationError("cancelled");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("AgentCancellationError");
		expect(err.message).toBe("cancelled");
	});

	test("ProviderNotFoundError has code and exitCode", () => {
		const err = new ProviderNotFoundError("codex", "@5x-ai/provider-codex");
		expect(err.code).toBe("PROVIDER_NOT_FOUND");
		expect(err.exitCode).toBe(2);
		expect(err.message).toContain("codex");
		expect(err.message).toContain("npm install");
	});

	test("InvalidProviderError has code and exitCode", () => {
		const err = new InvalidProviderError("bad", "@5x-ai/provider-bad");
		expect(err.code).toBe("INVALID_PROVIDER");
		expect(err.exitCode).toBe(2);
		expect(err.message).toContain("ProviderPlugin");
	});
});
