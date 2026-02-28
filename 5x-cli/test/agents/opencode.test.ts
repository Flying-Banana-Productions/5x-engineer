import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentTimeoutError,
	OpenCodeAdapter,
	parseModel,
} from "../../src/agents/opencode.js";
import type { InvokeOptions } from "../../src/agents/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock OpenCode client with configurable behavior. */
function createMockClient(
	overrides: {
		sessionCreate?: (...args: unknown[]) => Promise<unknown>;
		sessionPrompt?: (...args: unknown[]) => Promise<unknown>;
		sessionAbort?: (...args: unknown[]) => Promise<unknown>;
		sessionList?: (...args: unknown[]) => Promise<unknown>;
		sessionStatus?: (...args: unknown[]) => Promise<unknown>;
		sessionMessages?: (...args: unknown[]) => Promise<unknown>;
		eventSubscribe?: (...args: unknown[]) => Promise<unknown>;
	} = {},
) {
	const defaultSession = {
		id: "sess-test-123",
		projectID: "proj-1",
		directory: "/tmp",
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
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				})),
			abort:
				overrides.sessionAbort ??
				(async () => ({
					data: true,
					error: undefined,
				})),
			list:
				overrides.sessionList ??
				(async () => ({
					data: [],
					error: undefined,
				})),
			status:
				overrides.sessionStatus ??
				(async () => ({
					data: { "sess-test-123": { type: "idle" } },
					error: undefined,
				})),
			messages:
				overrides.sessionMessages ??
				(async () => ({
					data: [],
					error: undefined,
				})),
		},
		event: {
			subscribe:
				overrides.eventSubscribe ??
				(async () => ({
					stream: (async function* () {
						// Empty stream — yield nothing
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

/** Create an adapter from mock client/server without spawning a real server. */
function createTestAdapter(
	clientOverrides: Parameters<typeof createMockClient>[0] = {},
	opts: { model?: string } = {},
): {
	adapter: OpenCodeAdapter;
	client: ReturnType<typeof createMockClient>;
	server: ReturnType<typeof createMockServer>;
} {
	const client = createMockClient(clientOverrides);
	const server = createMockServer();
	// Use the public constructor directly for testing (avoid spawning real server)
	const adapter = new OpenCodeAdapter(
		client as unknown as ConstructorParameters<typeof OpenCodeAdapter>[0],
		server,
		opts.model,
	);
	return { adapter, client, server };
}

function makeTmpLogPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "5x-test-"));
	return path.join(dir, "test-log.ndjson");
}

function defaultInvokeOpts(
	overrides: Partial<InvokeOptions> = {},
): InvokeOptions {
	return {
		prompt: "Test prompt",
		logPath: makeTmpLogPath(),
		quiet: true,
		timeout: 5, // 5 seconds
		...overrides,
	};
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
// verify()
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter.verify", () => {
	test("succeeds when server is reachable", async () => {
		const { adapter } = createTestAdapter();
		await expect(adapter.verify()).resolves.toBeUndefined();
	});

	test("throws with actionable message when health check fails", async () => {
		const { adapter } = createTestAdapter({
			sessionList: async () => {
				throw new Error("connection refused");
			},
		});
		await expect(adapter.verify()).rejects.toThrow(
			"OpenCode server health check failed",
		);
	});

	test("throws when server returns error", async () => {
		const { adapter } = createTestAdapter({
			sessionList: async () => ({
				data: undefined,
				error: { message: "internal error" },
			}),
		});
		await expect(adapter.verify()).rejects.toThrow(
			"OpenCode server health check failed",
		);
	});
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter.close", () => {
	test("calls server.close()", async () => {
		const { adapter, server } = createTestAdapter();
		await adapter.close();
		expect(server.close).toHaveBeenCalledTimes(1);
	});

	test("is idempotent — safe to call multiple times", async () => {
		const { adapter, server } = createTestAdapter();
		await adapter.close();
		await adapter.close();
		await adapter.close();
		expect(server.close).toHaveBeenCalledTimes(1);
	});

	test("does not throw if server.close() fails", async () => {
		const server = {
			url: "http://127.0.0.1:51234",
			close: () => {
				throw new Error("already closed");
			},
		};
		const client = createMockClient();
		const adapter = new OpenCodeAdapter(
			client as unknown as ConstructorParameters<typeof OpenCodeAdapter>[0],
			server,
		);
		await expect(adapter.close()).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// invokeForStatus
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter.invokeForStatus", () => {
	test("returns typed AuthorStatus on success", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						id: "msg-1",
						sessionID: "sess-1",
						role: "assistant",
						structured: { result: "complete", commit: "abc123", notes: "done" },
						tokens: {
							input: 100,
							output: 50,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.005,
						error: undefined,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		const result = await adapter.invokeForStatus(defaultInvokeOpts());

		expect(result.type).toBe("status");
		expect(result.status.result).toBe("complete");
		expect(result.status.commit).toBe("abc123");
		expect(result.status.notes).toBe("done");
		expect(result.sessionId).toBe("sess-test-123");
		expect(result.tokensIn).toBe(100);
		expect(result.tokensOut).toBe(50);
		expect(result.costUsd).toBe(0.005);
		expect(result.duration).toBeGreaterThanOrEqual(0);
	});

	test("runs execution prompt first, then schema summary prompt", async () => {
		const promptParams: Array<Record<string, unknown>> = [];
		const { adapter } = createTestAdapter({
			sessionPrompt: async (...args: unknown[]) => {
				promptParams.push(args[0] as Record<string, unknown>);
				return {
					data: {
						info: {
							id: `msg-${promptParams.length}`,
							sessionID: "sess-test-123",
							role: "assistant",
							structured: { result: "complete", commit: "abc123" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							error: undefined,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(defaultInvokeOpts());

		expect(promptParams.length).toBe(2);
		expect(promptParams[0]?.format).toBeUndefined();
		expect((promptParams[1]?.format as Record<string, unknown>)?.type).toBe(
			"json_schema",
		);
		expect(promptParams[0]?.parts).toEqual([
			{ type: "text", text: "Test prompt" },
		]);
	});

	test("returns needs_human status with reason", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: { result: "needs_human", reason: "Need clarification" },
						tokens: {
							input: 50,
							output: 20,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.001,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		const result = await adapter.invokeForStatus(defaultInvokeOpts());

		expect(result.status.result).toBe("needs_human");
		expect(result.status.reason).toBe("Need clarification");
	});

	test("uses model override from InvokeOptions", async () => {
		let capturedParams: unknown;
		const { adapter } = createTestAdapter({
			sessionPrompt: async (...args: unknown[]) => {
				capturedParams = args[0];
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(
			defaultInvokeOpts({ model: "openai/gpt-4o" }),
		);

		expect(capturedParams).toBeDefined();
		const params = capturedParams as Record<string, unknown>;
		expect(params.model).toEqual({ providerID: "openai", modelID: "gpt-4o" });
	});

	test("uses default model when no override provided", async () => {
		let capturedParams: unknown;
		const { adapter } = createTestAdapter(
			{
				sessionPrompt: async (...args: unknown[]) => {
					capturedParams = args[0];
					return {
						data: {
							info: {
								structured: { result: "complete", commit: "abc" },
								tokens: {
									input: 10,
									output: 5,
									reasoning: 0,
									cache: { read: 0, write: 0 },
								},
								cost: 0.001,
								time: { created: Date.now() },
							},
							parts: [],
						},
						error: undefined,
					};
				},
			},
			{ model: "anthropic/claude-sonnet-4-6" },
		);

		await adapter.invokeForStatus(defaultInvokeOpts());

		const params = capturedParams as Record<string, unknown>;
		expect(params.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-sonnet-4-6",
		});
	});

	test("escalates on assertAuthorStatus invariant violation", async () => {
		// complete without commit — assertion should catch this if requireCommit
		// is used, but invokeForStatus doesn't set requireCommit by default.
		// However, needs_human without reason DOES trigger:
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: { result: "needs_human" },
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		await expect(adapter.invokeForStatus(defaultInvokeOpts())).rejects.toThrow(
			"AuthorStatus invariant violation",
		);
	});

	test("throws when structured output is null", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: null,
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0,
						error: undefined,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		await expect(adapter.invokeForStatus(defaultInvokeOpts())).rejects.toThrow(
			"Agent did not return structured output",
		);
	});

	test("throws on structured output error", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: null,
						error: {
							name: "StructuredOutputError",
							data: { message: "schema mismatch", retries: 2 },
						},
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		await expect(adapter.invokeForStatus(defaultInvokeOpts())).rejects.toThrow(
			"Structured output validation failed",
		);
	});

	test("throws on session creation failure", async () => {
		const { adapter } = createTestAdapter({
			sessionCreate: async () => ({
				data: undefined,
				error: { message: "server overloaded" },
			}),
		});

		await expect(adapter.invokeForStatus(defaultInvokeOpts())).rejects.toThrow(
			"Failed to create session",
		);
	});

	test("throws on prompt-level error", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: undefined,
				error: { message: "rate limited" },
			}),
		});

		await expect(adapter.invokeForStatus(defaultInvokeOpts())).rejects.toThrow(
			"Agent invocation failed",
		);
	});

	test("invokes onSessionCreated before session.prompt", async () => {
		const calls: string[] = [];
		const { adapter } = createTestAdapter({
			sessionCreate: async () => {
				calls.push("create");
				return {
					data: {
						id: "sess-test-123",
						projectID: "proj-1",
						directory: "/tmp",
						title: "test",
						version: "1",
						time: { created: Date.now(), updated: Date.now() },
					},
					error: undefined,
				};
			},
			sessionPrompt: async () => {
				calls.push("prompt");
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc123" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(
			defaultInvokeOpts({
				onSessionCreated: () => {
					calls.push("hook");
				},
			}),
		);

		expect(calls).toEqual(["create", "hook", "prompt", "prompt"]);
	});

	test("onSessionCreated is best-effort and does not fail invocation", async () => {
		const { adapter } = createTestAdapter();

		const result = await adapter.invokeForStatus(
			defaultInvokeOpts({
				onSessionCreated: () => {
					throw new Error("callback boom");
				},
			}),
		);

		expect(result.type).toBe("status");
		expect(result.status.result).toBe("complete");
	});

	test("onSessionCreated does not block invocation when callback hangs", async () => {
		const { adapter } = createTestAdapter();

		const result = await adapter.invokeForStatus(
			defaultInvokeOpts({
				onSessionCreated: () => new Promise<void>(() => {}),
			}),
		);

		expect(result.type).toBe("status");
		expect(result.status.result).toBe("complete");
	});
});

// ---------------------------------------------------------------------------
// invokeForVerdict
// ---------------------------------------------------------------------------

describe("OpenCodeAdapter.invokeForVerdict", () => {
	test("returns typed ReviewerVerdict on success", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: {
							readiness: "ready",
							items: [],
							summary: "Looks good",
						},
						tokens: {
							input: 200,
							output: 80,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.01,
						error: undefined,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		const result = await adapter.invokeForVerdict(defaultInvokeOpts());

		expect(result.type).toBe("verdict");
		expect(result.verdict.readiness).toBe("ready");
		expect(result.verdict.items).toEqual([]);
		expect(result.verdict.summary).toBe("Looks good");
		expect(result.tokensIn).toBe(200);
		expect(result.tokensOut).toBe(80);
		expect(result.costUsd).toBe(0.01);
	});

	test("returns verdict with items", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: {
							readiness: "ready_with_corrections",
							items: [
								{
									id: "P0.1",
									title: "Fix typo in README",
									action: "auto_fix",
									reason: "Typo found",
									priority: "P1",
								},
							],
						},
						tokens: {
							input: 100,
							output: 60,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.005,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		const result = await adapter.invokeForVerdict(defaultInvokeOpts());

		expect(result.verdict.readiness).toBe("ready_with_corrections");
		expect(result.verdict.items).toHaveLength(1);
		expect(result.verdict.items[0]?.id).toBe("P0.1");
		expect(result.verdict.items[0]?.action).toBe("auto_fix");
	});

	test("escalates on assertReviewerVerdict invariant violation", async () => {
		// not_ready with empty items should fail
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: {
							readiness: "not_ready",
							items: [],
						},
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		await expect(adapter.invokeForVerdict(defaultInvokeOpts())).rejects.toThrow(
			"ReviewerVerdict invariant violation",
		);
	});
});

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

describe("timeout handling", () => {
	test("throws AgentTimeoutError on timeout", async () => {
		const { adapter } = createTestAdapter({
			// Never resolves — simulates a hung agent
			sessionPrompt: () => new Promise(() => {}),
		});

		await expect(
			adapter.invokeForStatus(defaultInvokeOpts({ timeout: 0.001 })), // 1ms
		).rejects.toThrow(AgentTimeoutError);
	});

	test("aborts session on timeout", async () => {
		let abortCalled = false;
		const { adapter } = createTestAdapter({
			// Never resolves — simulates a hung agent
			sessionPrompt: () => new Promise(() => {}),
			sessionAbort: async () => {
				abortCalled = true;
				return { data: true, error: undefined };
			},
		});

		try {
			await adapter.invokeForStatus(defaultInvokeOpts({ timeout: 0.001 })); // 1ms
		} catch {
			// Expected
		}

		// Give abort a tick to fire
		await new Promise((r) => setTimeout(r, 0));
		expect(abortCalled).toBe(true);
	});

	test("other-session events do not reset inactivity timeout", async () => {
		const { adapter } = createTestAdapter({
			eventSubscribe: async (...args: unknown[]) => ({
				stream: (async function* () {
					const opts = args[1] as { signal?: AbortSignal } | undefined;
					const signal = opts?.signal;
					while (!signal?.aborted) {
						yield {
							type: "session.status",
							properties: {
								sessionID: "sess-other-456",
								status: { type: "busy" },
							},
						};
						await new Promise((resolve) => setTimeout(resolve, 1));
					}
				})(),
			}),
			// Never resolves — rely on inactivity timeout to cancel
			sessionPrompt: () => new Promise(() => {}),
		});

		await expect(
			adapter.invokeForStatus(defaultInvokeOpts({ timeout: 0.02 })),
		).rejects.toThrow(AgentTimeoutError);
	});
});

// ---------------------------------------------------------------------------
// SSE event log streaming
// ---------------------------------------------------------------------------

describe("SSE event log streaming", () => {
	test("writes events to log file (even when quiet)", async () => {
		const logPath = makeTmpLogPath();
		const testEvent = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "text",
					sessionID: "sess-test-123",
					text: "hello",
				},
				delta: "hello",
			},
		};

		const { adapter } = createTestAdapter({
			eventSubscribe: async () => ({
				stream: (async function* () {
					yield testEvent;
				})(),
			}),
			// Yield to event loop to let stream process before resolving
			sessionPrompt: async () => {
				await new Promise((r) => setTimeout(r, 0));
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(defaultInvokeOpts({ logPath, quiet: true }));

		// Yield to let log file flush
		await new Promise((r) => setTimeout(r, 0));

		const logContent = fs.readFileSync(logPath, "utf8");
		expect(logContent.length).toBeGreaterThan(0);
		// Each line should be valid JSON
		for (const line of logContent.trim().split("\n")) {
			if (line.trim()) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		}
	});

	test("filters events by session ID", async () => {
		const logPath = makeTmpLogPath();
		const ownEvent = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", sessionID: "sess-test-123" },
				delta: "own",
			},
		};
		const otherEvent = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", sessionID: "sess-other-456" },
				delta: "other",
			},
		};

		const { adapter } = createTestAdapter({
			eventSubscribe: async () => ({
				stream: (async function* () {
					yield ownEvent;
					yield otherEvent;
				})(),
			}),
			// Yield to event loop to let stream process before resolving
			sessionPrompt: async () => {
				await new Promise((r) => setTimeout(r, 0));
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(defaultInvokeOpts({ logPath, quiet: true }));
		await new Promise((r) => setTimeout(r, 0));

		const logContent = fs.readFileSync(logPath, "utf8").trim();
		const lines = logContent.split("\n").filter((l) => l.trim());
		// Only the own-session event should be logged
		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0] ?? "{}");
		expect(parsed.properties.delta).toBe("own");
	});

	test("resolves session for delta events via message/part context", async () => {
		const logPath = makeTmpLogPath();
		const { adapter } = createTestAdapter({
			eventSubscribe: async () => ({
				stream: (async function* () {
					yield {
						type: "message.updated",
						properties: {
							info: {
								id: "msg-ctx-1",
								sessionID: "sess-test-123",
							},
						},
					};
					yield {
						type: "message.part.delta",
						properties: {
							messageID: "msg-ctx-1",
							partID: "prt-ctx-1",
							delta: "hello",
							field: "text",
						},
					};
				})(),
			}),
			sessionPrompt: async () => {
				await new Promise((r) => setTimeout(r, 0));
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(defaultInvokeOpts({ logPath, quiet: true }));
		await new Promise((r) => setTimeout(r, 0));

		const lines = fs
			.readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.trim().length > 0);
		expect(lines.length).toBe(2);
		const parsed = lines.map((line) => JSON.parse(line));
		expect(parsed[1]?.type).toBe("message.part.delta");
	});

	test("accepts camelCase sessionId fields", async () => {
		const logPath = makeTmpLogPath();
		const { adapter } = createTestAdapter({
			eventSubscribe: async () => ({
				stream: (async function* () {
					yield {
						type: "message.part.updated",
						properties: {
							part: {
								type: "text",
								sessionId: "sess-test-123",
								messageId: "msg-1",
								id: "part-1",
								text: "hello",
							},
						},
					};
				})(),
			}),
			sessionPrompt: async () => {
				await new Promise((r) => setTimeout(r, 0));
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(defaultInvokeOpts({ logPath, quiet: true }));
		await new Promise((r) => setTimeout(r, 0));

		const lines = fs
			.readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.trim().length > 0);
		expect(lines.length).toBe(1);
		expect(JSON.parse(lines[0] ?? "{}").type).toBe("message.part.updated");
	});

	test("re-evaluates quiet function while streaming events", async () => {
		const logPath = makeTmpLogPath();
		let quietChecks = 0;

		const { adapter } = createTestAdapter({
			eventSubscribe: async () => ({
				stream: (async function* () {
					yield {
						type: "session.status",
						properties: {
							sessionID: "sess-test-123",
							status: { type: "busy" },
						},
					};
					yield {
						type: "session.status",
						properties: {
							sessionID: "sess-test-123",
							status: { type: "idle" },
						},
					};
				})(),
			}),
			sessionPrompt: async () => {
				await new Promise((r) => setTimeout(r, 0));
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(
			defaultInvokeOpts({
				logPath,
				quiet: () => {
					quietChecks += 1;
					return quietChecks < 2;
				},
			}),
		);

		expect(quietChecks).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// P0.1: SSE subscription abort regression
// ---------------------------------------------------------------------------
// P0.1 — SSE subscription abort regression
// ---------------------------------------------------------------------------

describe("P0.1: SSE subscription is abortable", () => {
	test("invokeForStatus completes even with a never-ending event stream", async () => {
		// Regression: if the SSE stream is idle (no events), the adapter must
		// still return after the prompt resolves — not hang in finally awaiting
		// streamPromise. The signal passed to subscribe() tears down the
		// connection; this mock simulates that by resolving when abort fires
		// (real SDK aborts the underlying fetch, ending the async generator).
		const { adapter } = createTestAdapter({
			eventSubscribe: async (...args: unknown[]) => ({
				stream: (async function* () {
					// Simulate idle SSE connection that only ends when signal fires
					// (mirrors real SDK behavior where fetch abort closes the stream)
					const opts = args[1] as { signal?: AbortSignal } | undefined;
					const signal = opts?.signal;
					if (signal) {
						await new Promise<void>((resolve) => {
							if (signal.aborted) {
								resolve();
								return;
							}
							signal.addEventListener("abort", () => resolve(), {
								once: true,
							});
						});
					}
				})(),
			}),
		});

		const result = await adapter.invokeForStatus(
			defaultInvokeOpts({ timeout: 3 }), // 3 seconds
		);
		expect(result.type).toBe("status");
		expect(result.status.result).toBe("complete");
	});
});

// ---------------------------------------------------------------------------
// P0.2 — External signal cancellation
// ---------------------------------------------------------------------------

describe("P0.2: external signal cancellation", () => {
	test("cancels invocation when opts.signal is aborted", async () => {
		const controller = new AbortController();
		let abortCalled = false;

		const { adapter } = createTestAdapter({
			sessionPrompt: async () => {
				// Never resolves naturally — waits for signal
				await new Promise(() => {});
				return { data: { info: {} }, error: undefined };
			},
			sessionAbort: async () => {
				abortCalled = true;
				return { data: true, error: undefined };
			},
		});

		// Start the invocation
		const invokePromise = adapter.invokeForStatus(
			defaultInvokeOpts({ signal: controller.signal, timeout: 60 }), // 60 seconds - long enough that signal aborts first
		);

		// Yield to let prompt start, then abort
		await new Promise((r) => setTimeout(r, 0));
		controller.abort();

		await expect(invokePromise).rejects.toThrow("Agent invocation cancelled");
		expect(abortCalled).toBe(true);
	});

	test("throws AgentTimeoutError (not cancellation) when timeout fires first", async () => {
		// Ensure timeout is distinguished from external cancel
		const { adapter } = createTestAdapter({
			// Never resolves — simulates a hung agent
			sessionPrompt: () => new Promise(() => {}),
		});

		await expect(
			adapter.invokeForStatus(defaultInvokeOpts({ timeout: 0.001 })), // 1ms
		).rejects.toThrow(AgentTimeoutError);
	});
});

describe("prompt abort recovery", () => {
	test("keeps waiting when prompt request is aborted but session completes", async () => {
		let abortCalled = false;
		let messagesCalls = 0;

		const { adapter } = createTestAdapter({
			sessionPrompt: async () => {
				throw new Error("The operation was aborted.");
			},
			sessionMessages: async () => {
				messagesCalls += 1;
				if (messagesCalls < 2) {
					return {
						data: [
							{
								info: {
									id: "msg-1",
									sessionID: "sess-test-123",
									role: "assistant",
									time: { created: Date.now() },
								},
								parts: [],
							},
						],
						error: undefined,
					};
				}

				return {
					data: [
						{
							info: {
								id: "msg-1",
								sessionID: "sess-test-123",
								role: "assistant",
								time: { created: Date.now(), completed: Date.now() },
								structured: { result: "complete", commit: "abc123" },
								tokens: {
									input: 12,
									output: 8,
									reasoning: 0,
									cache: { read: 0, write: 0 },
								},
								cost: 0.001,
							},
							parts: [],
						},
					],
					error: undefined,
				};
			},
			sessionAbort: async () => {
				abortCalled = true;
				return { data: true, error: undefined };
			},
		});

		const result = await adapter.invokeForStatus(
			defaultInvokeOpts({ timeout: undefined }),
		);

		expect(result.type).toBe("status");
		expect(result.status.result).toBe("complete");
		expect(messagesCalls).toBeGreaterThanOrEqual(2);
		expect(abortCalled).toBe(false);
	});
});

describe("missing structured output recovery", () => {
	test("keeps waiting when initial assistant message is unstructured", async () => {
		let messagesCalls = 0;

		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						id: "msg-partial",
						sessionID: "sess-test-123",
						role: "assistant",
						structured: null,
						tokens: {
							input: 5,
							output: 3,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.001,
						time: { created: Date.now(), completed: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
			sessionMessages: async () => {
				messagesCalls += 1;
				if (messagesCalls === 1) {
					return {
						data: [
							{
								info: {
									id: "msg-final",
									sessionID: "sess-test-123",
									role: "assistant",
									time: { created: Date.now() },
								},
								parts: [],
							},
							{
								info: {
									id: "msg-partial",
									sessionID: "sess-test-123",
									role: "assistant",
									time: { created: Date.now(), completed: Date.now() },
								},
								parts: [],
							},
						],
						error: undefined,
					};
				}

				return {
					data: [
						{
							info: {
								id: "msg-final",
								sessionID: "sess-test-123",
								role: "assistant",
								time: { created: Date.now(), completed: Date.now() },
								structured: { result: "complete", commit: "abc123" },
								tokens: {
									input: 10,
									output: 6,
									reasoning: 0,
									cache: { read: 0, write: 0 },
								},
								cost: 0.001,
							},
							parts: [],
						},
					],
					error: undefined,
				};
			},
		});

		const result = await adapter.invokeForStatus(
			defaultInvokeOpts({ timeout: undefined }),
		);

		expect(result.type).toBe("status");
		expect(result.status.result).toBe("complete");
		expect(messagesCalls).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// P0.3 — Workdir/directory propagation
// ---------------------------------------------------------------------------

describe("P0.3: workdir propagation", () => {
	test("passes workdir as directory to session.create()", async () => {
		let capturedCreateParams: unknown;
		const { adapter } = createTestAdapter({
			sessionCreate: async (...args: unknown[]) => {
				capturedCreateParams = args[0];
				return {
					data: {
						id: "sess-test-123",
						projectID: "proj-1",
						directory: "/my/worktree",
						title: "test",
						version: "1",
						time: { created: Date.now(), updated: Date.now() },
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(
			defaultInvokeOpts({ workdir: "/my/worktree" }),
		);

		expect(capturedCreateParams).toBeDefined();
		const params = capturedCreateParams as Record<string, unknown>;
		expect(params.directory).toBe("/my/worktree");
	});

	test("passes workdir as directory to session.prompt()", async () => {
		let capturedPromptParams: unknown;
		const { adapter } = createTestAdapter({
			sessionPrompt: async (...args: unknown[]) => {
				capturedPromptParams = args[0];
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(
			defaultInvokeOpts({ workdir: "/my/worktree" }),
		);

		expect(capturedPromptParams).toBeDefined();
		const params = capturedPromptParams as Record<string, unknown>;
		expect(params.directory).toBe("/my/worktree");
	});

	test("passes workdir as directory to event.subscribe()", async () => {
		let capturedSubscribeParams: unknown;
		const { adapter } = createTestAdapter({
			eventSubscribe: async (...args: unknown[]) => {
				capturedSubscribeParams = args[0];
				return {
					stream: (async function* () {
						// empty stream
					})(),
				};
			},
		});

		await adapter.invokeForStatus(
			defaultInvokeOpts({ workdir: "/my/worktree" }),
		);

		expect(capturedSubscribeParams).toEqual({ directory: "/my/worktree" });
	});

	test("omits directory when workdir is not provided", async () => {
		let capturedCreateParams: unknown;
		const { adapter } = createTestAdapter({
			sessionCreate: async (...args: unknown[]) => {
				capturedCreateParams = args[0];
				return {
					data: {
						id: "sess-test-123",
						projectID: "proj-1",
						directory: "/tmp",
						title: "test",
						version: "1",
						time: { created: Date.now(), updated: Date.now() },
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(defaultInvokeOpts());

		const params = capturedCreateParams as Record<string, unknown>;
		expect(params.directory).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// P1.1 — costUsd preserves zero
// ---------------------------------------------------------------------------

describe("P1.1: costUsd preserves zero", () => {
	test("costUsd is 0 when SDK reports cost=0 (not undefined)", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: { result: "complete", commit: "abc" },
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0,
						error: undefined,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		const result = await adapter.invokeForStatus(defaultInvokeOpts());
		expect(result.costUsd).toBe(0);
	});

	test("costUsd is undefined when SDK reports cost=undefined", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: { result: "complete", commit: "abc" },
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: undefined,
						error: undefined,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		const result = await adapter.invokeForStatus(defaultInvokeOpts());
		expect(result.costUsd).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// P1.2 — Events without session ID are skipped
// ---------------------------------------------------------------------------

describe("P1.2: events without session ID are skipped", () => {
	test("events lacking session ID are not written to log", async () => {
		const logPath = makeTmpLogPath();
		const ownEvent = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", sessionID: "sess-test-123" },
				delta: "own",
			},
		};
		const globalEvent = {
			type: "system.status",
			properties: {}, // no session ID anywhere
		};

		const { adapter } = createTestAdapter({
			eventSubscribe: async () => ({
				stream: (async function* () {
					yield globalEvent;
					yield ownEvent;
				})(),
			}),
			sessionPrompt: async () => {
				await new Promise((r) => setTimeout(r, 0));
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(defaultInvokeOpts({ logPath, quiet: true }));
		await new Promise((r) => setTimeout(r, 0));

		const logContent = fs.readFileSync(logPath, "utf8").trim();
		const lines = logContent.split("\n").filter((l) => l.trim());
		// Only the own-session event should be logged; global event is skipped
		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0] ?? "{}");
		expect(parsed.properties.delta).toBe("own");
	});
});

// ---------------------------------------------------------------------------
// Factory enabled (Phase 5)
// ---------------------------------------------------------------------------

describe("factory creates real adapter (Phase 5)", () => {
	test("createAndVerifyAdapter works or rejects with actionable message", async () => {
		const { createAndVerifyAdapter } = await import(
			"../../src/agents/factory.js"
		);
		// Hermetic: passes whether OpenCode server is available or not.
		// If available, validates the adapter interface; if not, validates
		// the error is actionable (matches factory.test.ts pattern).
		let adapter: Awaited<ReturnType<typeof createAndVerifyAdapter>> | null =
			null;
		try {
			adapter = await createAndVerifyAdapter({});
			// If we get here, the server started — validate the interface
			expect(typeof adapter.invokeForStatus).toBe("function");
			expect(typeof adapter.invokeForVerdict).toBe("function");
			expect(typeof adapter.verify).toBe("function");
			expect(typeof adapter.close).toBe("function");
		} catch (err) {
			// Server unavailable — validate error is actionable
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toMatch(/OpenCode server/);
		} finally {
			await adapter?.close();
		}
	});
});

// ---------------------------------------------------------------------------
// createAndVerifyAdapter always creates managed (local) adapter
// ---------------------------------------------------------------------------

describe("adapter creates managed (local) adapter", () => {
	test("constructor sets server reference", () => {
		const client = createMockClient();
		const server = createMockServer();
		const adapter = new OpenCodeAdapter(
			client as unknown as ConstructorParameters<typeof OpenCodeAdapter>[0],
			server,
			"anthropic/claude-sonnet-4-6",
		);
		// Adapter was created with a server — it's managed
		expect(adapter).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Phase 1 (004): serverUrl exposure + port randomization
// ---------------------------------------------------------------------------

describe("serverUrl exposure (004 Phase 1)", () => {
	test("exposes serverUrl matching server.url", () => {
		const { adapter } = createTestAdapter();
		expect(adapter.serverUrl).toBe("http://127.0.0.1:51234");
	});

	test("serverUrl reflects the actual server URL", () => {
		const client = createMockClient();
		const server = createMockServer("http://127.0.0.1:9999");
		const adapter = new OpenCodeAdapter(
			client as unknown as ConstructorParameters<typeof OpenCodeAdapter>[0],
			server,
		);
		expect(adapter.serverUrl).toBe("http://127.0.0.1:9999");
	});

	test("serverUrl is not hardcoded to port 4096", () => {
		const { adapter } = createTestAdapter();
		const url = new URL(adapter.serverUrl);
		// The mock uses 51234 (simulating an ephemeral port), not 4096
		expect(url.port).not.toBe("4096");
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.protocol).toBe("http:");
	});

	test("serverUrl has expected hostname/port format", () => {
		const { adapter } = createTestAdapter();
		const url = new URL(adapter.serverUrl);
		expect(url.hostname).toBe("127.0.0.1");
		expect(Number(url.port)).toBeGreaterThan(0);
		expect(adapter.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});
});

// ---------------------------------------------------------------------------
// 007 P3.3: Adapter session continuation
// ---------------------------------------------------------------------------

describe("007 P3.3: adapter session continuation", () => {
	test("skips session.create() when opts.sessionId is provided", async () => {
		let createCalled = false;
		const { adapter } = createTestAdapter({
			sessionCreate: async () => {
				createCalled = true;
				return {
					data: {
						id: "sess-new",
						projectID: "proj-1",
						directory: "/tmp",
						title: "test",
						version: "1",
						time: { created: Date.now(), updated: Date.now() },
					},
					error: undefined,
				};
			},
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: { result: "complete", commit: "abc123" },
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.001,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		const result = await adapter.invokeForStatus(
			defaultInvokeOpts({ sessionId: "sess-existing-456" }),
		);

		expect(createCalled).toBe(false);
		expect(result.type).toBe("status");
		expect(result.status.result).toBe("complete");
	});

	test("calls session.create() when opts.sessionId is not provided", async () => {
		let createCalled = false;
		const { adapter } = createTestAdapter({
			sessionCreate: async () => {
				createCalled = true;
				return {
					data: {
						id: "sess-new",
						projectID: "proj-1",
						directory: "/tmp",
						title: "test",
						version: "1",
						time: { created: Date.now(), updated: Date.now() },
					},
					error: undefined,
				};
			},
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: { result: "complete", commit: "abc123" },
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.001,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		await adapter.invokeForStatus(defaultInvokeOpts());

		expect(createCalled).toBe(true);
	});

	test("fires onSessionCreated with existing sessionId on continuation", async () => {
		const receivedSessionIds: string[] = [];
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: { result: "complete", commit: "abc123" },
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.001,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		await adapter.invokeForStatus(
			defaultInvokeOpts({
				sessionId: "sess-existing-789",
				onSessionCreated: (id) => {
					receivedSessionIds.push(id);
				},
			}),
		);

		expect(receivedSessionIds).toEqual(["sess-existing-789"]);
	});

	test("prompts use the continued sessionId (not a new one)", async () => {
		const promptSessionIds: string[] = [];
		const { adapter } = createTestAdapter({
			sessionPrompt: async (...args: unknown[]) => {
				const params = args[0] as Record<string, unknown>;
				promptSessionIds.push(params.sessionID as string);
				return {
					data: {
						info: {
							structured: { result: "complete", commit: "abc123" },
							tokens: {
								input: 10,
								output: 5,
								reasoning: 0,
								cache: { read: 0, write: 0 },
							},
							cost: 0.001,
							time: { created: Date.now() },
						},
						parts: [],
					},
					error: undefined,
				};
			},
		});

		await adapter.invokeForStatus(
			defaultInvokeOpts({ sessionId: "sess-continued-abc" }),
		);

		// Both prompts (execution + summary) should use the continued session ID
		expect(promptSessionIds.length).toBe(2);
		expect(promptSessionIds[0]).toBe("sess-continued-abc");
		expect(promptSessionIds[1]).toBe("sess-continued-abc");
	});

	test("returns the continued sessionId in result", async () => {
		const { adapter } = createTestAdapter({
			sessionPrompt: async () => ({
				data: {
					info: {
						structured: { result: "complete", commit: "abc123" },
						tokens: {
							input: 10,
							output: 5,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
						cost: 0.001,
						time: { created: Date.now() },
					},
					parts: [],
				},
				error: undefined,
			}),
		});

		const result = await adapter.invokeForStatus(
			defaultInvokeOpts({ sessionId: "sess-continued-xyz" }),
		);

		expect(result.sessionId).toBe("sess-continued-xyz");
	});
});
