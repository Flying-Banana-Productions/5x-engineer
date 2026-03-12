/**
 * Type contract tests for v1 provider interfaces.
 *
 * These are compile-time checks verifying that the interfaces are correctly
 * defined and can be implemented. If this file compiles, the contracts hold.
 */

import { describe, expect, test } from "bun:test";
import type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	JSONSchema,
	ProviderPlugin,
	ResumeOptions,
	RunOptions,
	RunResult,
	SessionOptions,
} from "../../../src/providers/types.js";

// ---------------------------------------------------------------------------
// Compile-time assignability checks
// ---------------------------------------------------------------------------

describe("AgentProvider interface", () => {
	test("can be implemented", () => {
		// Compile-time check: a class implementing AgentProvider should type-check
		class TestProvider implements AgentProvider {
			async startSession(_opts: SessionOptions): Promise<AgentSession> {
				return null as unknown as AgentSession;
			}
			async resumeSession(
				_sessionId: string,
				_opts?: ResumeOptions,
			): Promise<AgentSession> {
				return null as unknown as AgentSession;
			}
			async close(): Promise<void> {}
		}

		const provider: AgentProvider = new TestProvider();
		expect(typeof provider.startSession).toBe("function");
		expect(typeof provider.resumeSession).toBe("function");
		expect(typeof provider.close).toBe("function");
	});
});

describe("AgentSession interface", () => {
	test("can be implemented", () => {
		class TestSession implements AgentSession {
			readonly id = "test-session";

			async run(_prompt: string, _opts?: RunOptions): Promise<RunResult> {
				return {
					text: "hello",
					sessionId: this.id,
					tokens: { in: 10, out: 20 },
					durationMs: 100,
				};
			}

			async *runStreamed(
				_prompt: string,
				_opts?: RunOptions,
			): AsyncIterable<AgentEvent> {
				yield { type: "text", delta: "hello" };
				yield {
					type: "done",
					result: {
						text: "hello",
						sessionId: this.id,
						tokens: { in: 10, out: 20 },
						durationMs: 100,
					},
				};
			}
		}

		const session: AgentSession = new TestSession();
		expect(session.id).toBe("test-session");
		expect(typeof session.run).toBe("function");
		expect(typeof session.runStreamed).toBe("function");
	});
});

describe("SessionOptions", () => {
	test("required fields", () => {
		const opts: SessionOptions = {
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp/work",
		};
		expect(opts.model).toBe("anthropic/claude-sonnet-4-6");
		expect(opts.workingDirectory).toBe("/tmp/work");
	});
});

describe("RunOptions", () => {
	test("all fields are optional", () => {
		const empty: RunOptions = {};
		expect(empty.outputSchema).toBeUndefined();
		expect(empty.signal).toBeUndefined();
		expect(empty.timeout).toBeUndefined();
	});

	test("accepts outputSchema as JSONSchema", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				result: { type: "string" },
			},
			required: ["result"],
		};
		const opts: RunOptions = {
			outputSchema: schema,
			timeout: 60,
		};
		expect(opts.outputSchema).toEqual(schema);
	});
});

describe("RunResult", () => {
	test("required and optional fields", () => {
		// Minimal
		const minimal: RunResult = {
			text: "completed",
			sessionId: "sess-1",
			tokens: { in: 100, out: 50 },
			durationMs: 5000,
		};
		expect(minimal.structured).toBeUndefined();
		expect(minimal.costUsd).toBeUndefined();

		// Full
		const full: RunResult = {
			text: "completed",
			structured: { result: "complete", commit: "abc123" },
			sessionId: "sess-1",
			tokens: { in: 100, out: 50 },
			costUsd: 0.005,
			durationMs: 5000,
		};
		expect(full.structured).toEqual({ result: "complete", commit: "abc123" });
		expect(full.costUsd).toBe(0.005);
	});
});

describe("AgentEvent discriminated union", () => {
	test("covers all event types", () => {
		const events: AgentEvent[] = [
			{ type: "text", delta: "hello" },
			{ type: "reasoning", delta: "thinking..." },
			{ type: "tool_start", tool: "bash", input_summary: "ls -la" },
			{
				type: "tool_end",
				tool: "bash",
				output: "file.txt",
				error: false,
			},
			{ type: "error", message: "something went wrong" },
			{ type: "usage", tokens: { in: 100, out: 50 }, costUsd: 0.01 },
			{
				type: "done",
				result: {
					text: "done",
					sessionId: "s1",
					tokens: { in: 100, out: 50 },
					durationMs: 1000,
				},
			},
		];
		expect(events).toHaveLength(7);

		// Verify discriminated union narrowing
		for (const event of events) {
			switch (event.type) {
				case "text":
					expect(typeof event.delta).toBe("string");
					break;
				case "reasoning":
					expect(typeof event.delta).toBe("string");
					break;
				case "tool_start":
					expect(typeof event.tool).toBe("string");
					expect(typeof event.input_summary).toBe("string");
					break;
				case "tool_end":
					expect(typeof event.tool).toBe("string");
					expect(typeof event.output).toBe("string");
					break;
				case "error":
					expect(typeof event.message).toBe("string");
					break;
				case "usage":
					expect(typeof event.tokens.in).toBe("number");
					expect(typeof event.tokens.out).toBe("number");
					break;
				case "done":
					expect(event.result).toBeDefined();
					break;
			}
		}
	});
});

describe("ProviderPlugin interface", () => {
	test("can be implemented", () => {
		const plugin: ProviderPlugin = {
			name: "test-provider",
			async create(_config?: Record<string, unknown>): Promise<AgentProvider> {
				return null as unknown as AgentProvider;
			},
		};

		expect(plugin.name).toBe("test-provider");
		expect(typeof plugin.create).toBe("function");
	});

	test("create accepts optional config", async () => {
		const plugin: ProviderPlugin = {
			name: "test",
			async create(config?: Record<string, unknown>) {
				// Config should be passthrough — any keys allowed
				expect(config?.apiKey).toBe("secret");
				return null as unknown as AgentProvider;
			},
		};

		await plugin.create({ apiKey: "secret", custom: true });
	});
});
