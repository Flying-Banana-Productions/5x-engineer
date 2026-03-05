/**
 * Event Mapper Tests
 *
 * Validates SSE → AgentEvent mapping for OpenCode events.
 */

import { describe, expect, test } from "bun:test";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2";
import {
	createEventMapperState,
	createSessionResolveContext,
	getEventSessionId,
	mapSseToAgentEvent,
	resolveSessionIdWithContext,
	summarizeToolInput,
} from "../../src/providers/event-mapper.js";

// ---------------------------------------------------------------------------
// Tool Input Summary Tests
// ---------------------------------------------------------------------------

describe("summarizeToolInput", () => {
	test("bash tool extracts command", () => {
		const input = { command: "ls -la" };
		expect(summarizeToolInput("bash", input)).toBe("ls -la");
	});

	test("shell tool extracts command", () => {
		const input = { command: "pwd" };
		expect(summarizeToolInput("shell", input)).toBe("pwd");
	});

	test("edit tool extracts filePath", () => {
		const input = { filePath: "/path/to/file.ts" };
		expect(summarizeToolInput("edit", input)).toBe("/path/to/file.ts");
	});

	test("edit tool falls back to path", () => {
		const input = { path: "/path/to/file.ts" };
		expect(summarizeToolInput("edit", input)).toBe("/path/to/file.ts");
	});

	test("write tool extracts filePath", () => {
		const input = { filePath: "/path/to/output.txt" };
		expect(summarizeToolInput("write", input)).toBe("/path/to/output.txt");
	});

	test("read tool extracts filePath", () => {
		const input = { filePath: "/path/to/read.txt" };
		expect(summarizeToolInput("read", input)).toBe("/path/to/read.txt");
	});

	test("glob tool extracts pattern", () => {
		const input = { pattern: "**/*.ts" };
		expect(summarizeToolInput("glob", input)).toBe("**/*.ts");
	});

	test("grep tool extracts pattern", () => {
		const input = { pattern: "TODO" };
		expect(summarizeToolInput("grep", input)).toBe("TODO");
	});

	test("unknown tool shows keys", () => {
		const input = { foo: "bar", baz: 123 };
		const summary = summarizeToolInput("unknown", input);
		expect(summary).toBe("{foo, baz}");
	});

	test("empty object returns empty string", () => {
		expect(summarizeToolInput("any", {})).toBe("");
	});

	test("null/undefined input returns empty string", () => {
		expect(summarizeToolInput("bash", null)).toBe("");
		expect(summarizeToolInput("bash", undefined)).toBe("");
	});

	test("non-object input returns empty string", () => {
		expect(summarizeToolInput("bash", "string")).toBe("");
		expect(summarizeToolInput("bash", 123)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Session ID Resolution Tests
// ---------------------------------------------------------------------------

describe("getEventSessionId", () => {
	test("extracts sessionID from properties", () => {
		const event = {
			type: "message.part.updated",
			properties: { sessionID: "sess_123" },
		} as unknown as OpenCodeEvent;
		expect(getEventSessionId(event)).toBe("sess_123");
	});

	test("extracts sessionId from properties", () => {
		const event = {
			type: "message.part.updated",
			properties: { sessionId: "sess_456" },
		} as unknown as OpenCodeEvent;
		expect(getEventSessionId(event)).toBe("sess_456");
	});

	test("extracts sessionID from info", () => {
		const event = {
			type: "message.part.updated",
			properties: { info: { sessionID: "sess_789" } },
		} as unknown as OpenCodeEvent;
		expect(getEventSessionId(event)).toBe("sess_789");
	});

	test("extracts id from session event", () => {
		const event = {
			type: "session.created",
			properties: { info: { id: "sess_abc" } },
		} as unknown as OpenCodeEvent;
		expect(getEventSessionId(event)).toBe("sess_abc");
	});

	test("extracts sessionID from part", () => {
		const event = {
			type: "message.part.updated",
			properties: { part: { sessionID: "sess_def" } },
		} as unknown as OpenCodeEvent;
		expect(getEventSessionId(event)).toBe("sess_def");
	});

	test("returns undefined for events without session info", () => {
		const event = {
			type: "unknown",
			properties: { foo: "bar" },
		} as unknown as OpenCodeEvent;
		expect(getEventSessionId(event)).toBeUndefined();
	});

	test("returns undefined for events without properties", () => {
		const event = { type: "test" } as unknown as OpenCodeEvent;
		expect(getEventSessionId(event)).toBeUndefined();
	});
});

describe("resolveSessionIdWithContext", () => {
	test("stores session ID in context when found directly", () => {
		const ctx = createSessionResolveContext();
		const event = {
			type: "message.part.updated",
			properties: {
				sessionID: "sess_123",
				part: { id: "part_1" },
				info: { id: "msg_1" },
			},
		} as unknown as OpenCodeEvent;

		const result = resolveSessionIdWithContext(event, ctx);

		expect(result).toBe("sess_123");
		expect(ctx.partToSession.get("part_1")).toBe("sess_123");
		expect(ctx.messageToSession.get("msg_1")).toBe("sess_123");
	});

	test("resolves from part ID when direct ID not available", () => {
		const ctx = createSessionResolveContext();
		ctx.partToSession.set("part_1", "sess_123");

		const event = {
			type: "message.part.delta",
			properties: { partID: "part_1" },
		} as unknown as OpenCodeEvent;

		const result = resolveSessionIdWithContext(event, ctx);

		expect(result).toBe("sess_123");
	});

	test("resolves from message ID when part ID not in context", () => {
		const ctx = createSessionResolveContext();
		ctx.messageToSession.set("msg_1", "sess_456");

		const event = {
			type: "message.part.delta",
			properties: { messageID: "msg_1" },
		} as unknown as OpenCodeEvent;

		const result = resolveSessionIdWithContext(event, ctx);

		expect(result).toBe("sess_456");
	});

	test("stores part mapping from message context", () => {
		const ctx = createSessionResolveContext();
		ctx.messageToSession.set("msg_1", "sess_789");

		const event = {
			type: "message.part.updated",
			properties: {
				part: { id: "part_2", messageID: "msg_1" },
			},
		} as unknown as OpenCodeEvent;

		resolveSessionIdWithContext(event, ctx);

		expect(ctx.partToSession.get("part_2")).toBe("sess_789");
	});
});

// ---------------------------------------------------------------------------
// Event Mapping Tests
// ---------------------------------------------------------------------------

describe("mapSseToAgentEvent", () => {
	test("maps text delta from message.part.updated", () => {
		const state = createEventMapperState();
		const event = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", id: "part_1" },
				delta: "Hello world",
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toEqual({ type: "text", delta: "Hello world" });
		expect(state.textPartIds.has("part_1")).toBe(true);
	});

	test("maps text from full part.text when no delta", () => {
		const state = createEventMapperState();
		const event = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", id: "part_1", text: "Hello" },
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toEqual({ type: "text", delta: "Hello" });
	});

	test("maps reasoning delta from message.part.updated", () => {
		const state = createEventMapperState();
		const event = {
			type: "message.part.updated",
			properties: {
				part: { type: "reasoning", id: "part_1" },
				delta: "Thinking...",
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toEqual({ type: "reasoning", delta: "Thinking..." });
		expect(state.reasoningPartIds.has("part_1")).toBe(true);
	});

	test("maps tool_start for running tool", () => {
		const state = createEventMapperState();
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "bash",
					state: { status: "running", input: { command: "ls -la" } },
				},
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toEqual({
			type: "tool_start",
			tool: "bash",
			input_summary: "ls -la",
		});
	});

	test("maps tool_end for completed tool", () => {
		const state = createEventMapperState();
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "bash",
					state: { status: "completed", output: "Success" },
				},
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toEqual({
			type: "tool_end",
			tool: "bash",
			output: "Success",
			error: false,
		});
	});

	test("maps tool_end for error tool", () => {
		const state = createEventMapperState();
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "bash",
					state: { status: "error", output: "Command failed" },
				},
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toEqual({
			type: "tool_end",
			tool: "bash",
			output: "Command failed",
			error: true,
		});
	});

	test("deduplicates running tool events", () => {
		const state = createEventMapperState();
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					id: "tool_1",
					tool: "bash",
					state: { status: "running", input: { command: "ls" } },
				},
			},
		} as unknown as OpenCodeEvent;

		const result1 = mapSseToAgentEvent(event, state);
		expect(result1).toBeDefined();

		const result2 = mapSseToAgentEvent(event, state);
		expect(result2).toBeUndefined(); // Duplicate suppressed
	});

	test("maps legacy message.part.delta to text", () => {
		const state = createEventMapperState();
		state.textPartIds.add("part_1"); // Simulate prior registration

		const event = {
			type: "message.part.delta",
			properties: {
				partID: "part_1",
				delta: " more text",
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toEqual({ type: "text", delta: " more text" });
	});

	test("suppresses delta if part was already handled via updated", () => {
		const state = createEventMapperState();
		state.textPartIds.add("part_1");
		state.updatedDeltaPartIds.add("part_1"); // Already handled

		const event = {
			type: "message.part.delta",
			properties: {
				partID: "part_1",
				delta: "text",
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toBeUndefined();
	});

	test("maps session.error to error event", () => {
		const state = createEventMapperState();
		const event = {
			type: "session.error",
			properties: {
				error: "Something went wrong",
			},
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toEqual({
			type: "error",
			message: "Something went wrong",
		});
	});

	test("returns undefined for unknown event types", () => {
		const state = createEventMapperState();
		const event = {
			type: "unknown.event",
			properties: { foo: "bar" },
		} as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toBeUndefined();
	});

	test("returns undefined for events without properties", () => {
		const state = createEventMapperState();
		const event = { type: "message.part.updated" } as unknown as OpenCodeEvent;

		const result = mapSseToAgentEvent(event, state);

		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// State Management Tests
// ---------------------------------------------------------------------------

describe("createEventMapperState", () => {
	test("creates empty state", () => {
		const state = createEventMapperState();

		expect(state.textPartIds.size).toBe(0);
		expect(state.reasoningPartIds.size).toBe(0);
		expect(state.partTextById.size).toBe(0);
		expect(state.updatedDeltaPartIds.size).toBe(0);
		expect(state.runningToolSignatureById.size).toBe(0);
	});
});

describe("createSessionResolveContext", () => {
	test("creates empty context", () => {
		const ctx = createSessionResolveContext();

		expect(ctx.partToSession.size).toBe(0);
		expect(ctx.messageToSession.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Incremental Text Update Tests
// ---------------------------------------------------------------------------

describe("incremental text updates", () => {
	test("emits only new text from full-text updates", () => {
		const state = createEventMapperState();

		// First update: "Hello"
		const event1 = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", id: "part_1", text: "Hello" },
			},
		} as unknown as OpenCodeEvent;

		const result1 = mapSseToAgentEvent(event1, state);
		expect(result1).toEqual({ type: "text", delta: "Hello" });

		// Second update: "Hello world" - should only emit " world"
		const event2 = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", id: "part_1", text: "Hello world" },
			},
		} as unknown as OpenCodeEvent;

		const result2 = mapSseToAgentEvent(event2, state);
		expect(result2).toEqual({ type: "text", delta: " world" });
	});

	test("handles non-incremental updates gracefully", () => {
		const state = createEventMapperState();

		// First update
		const event1 = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", id: "part_1", text: "Hello" },
			},
		} as unknown as OpenCodeEvent;

		mapSseToAgentEvent(event1, state);

		// Second update is completely different (not incremental)
		const event2 = {
			type: "message.part.updated",
			properties: {
				part: { type: "text", id: "part_1", text: "Goodbye" },
			},
		} as unknown as OpenCodeEvent;

		const result2 = mapSseToAgentEvent(event2, state);
		// No delta emitted because it's not incremental
		expect(result2).toBeUndefined();
	});
});
