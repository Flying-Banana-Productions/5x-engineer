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
		sessionCreate?: () => Promise<unknown>;
		sessionPrompt?: () => Promise<unknown>;
		sessionAbort?: () => Promise<unknown>;
		sessionList?: () => Promise<unknown>;
		eventSubscribe?: () => Promise<unknown>;
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

function createMockServer() {
	return {
		url: "http://127.0.0.1:4096",
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
		timeout: 5_000,
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
			url: "http://127.0.0.1:4096",
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
		expect(result.verdict.items[0]!.id).toBe("P0.1");
		expect(result.verdict.items[0]!.action).toBe("auto_fix");
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
			sessionPrompt: () =>
				new Promise((resolve) => {
					// Never resolves — simulates a hung agent
					setTimeout(resolve, 60_000);
				}),
		});

		await expect(
			adapter.invokeForStatus(defaultInvokeOpts({ timeout: 50 })),
		).rejects.toThrow(AgentTimeoutError);
	});

	test("aborts session on timeout", async () => {
		let abortCalled = false;
		const { adapter } = createTestAdapter({
			sessionPrompt: () =>
				new Promise((resolve) => {
					setTimeout(resolve, 60_000);
				}),
			sessionAbort: async () => {
				abortCalled = true;
				return { data: true, error: undefined };
			},
		});

		try {
			await adapter.invokeForStatus(defaultInvokeOpts({ timeout: 50 }));
		} catch {
			// Expected
		}

		// Give abort a tick to fire
		await new Promise((r) => setTimeout(r, 20));
		expect(abortCalled).toBe(true);
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
			// Small delay lets the event stream process before prompt resolves
			sessionPrompt: async () => {
				await new Promise((r) => setTimeout(r, 30));
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

		// Give log file a moment to flush
		await new Promise((r) => setTimeout(r, 100));

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
			// Small delay lets the event stream process before prompt resolves
			sessionPrompt: async () => {
				await new Promise((r) => setTimeout(r, 30));
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
		await new Promise((r) => setTimeout(r, 100));

		const logContent = fs.readFileSync(logPath, "utf8").trim();
		const lines = logContent.split("\n").filter((l) => l.trim());
		// Only the own-session event should be logged
		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.properties.delta).toBe("own");
	});
});

// ---------------------------------------------------------------------------
// Factory still throws (Phase 3 constraint)
// ---------------------------------------------------------------------------

describe("factory still throws in Phase 3", () => {
	test("createAndVerifyAdapter throws not-implemented", async () => {
		const { createAndVerifyAdapter } = await import(
			"../../src/agents/factory.js"
		);
		await expect(createAndVerifyAdapter({})).rejects.toThrow(
			"OpenCode adapter not yet implemented",
		);
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
