/**
 * Tests for the OpenCode 2.x event mapper.
 *
 * Foreign-session isolation is asserted at the provider level in
 * `opencode.test.ts`; this file covers the pure mapping rows.
 */

import { describe, expect, test } from "bun:test";
import type { OpenCodeEvent } from "@opencode/client";
import {
	createEventMapperState,
	eventSessionId,
	mapOpenCodeEvent,
	summarizeToolInput,
} from "../../../src/providers/event-mapper.js";

function ev(type: string, data: Record<string, unknown>): OpenCodeEvent {
	return {
		id: `evt_${type}`,
		created: 0,
		type,
		data,
	} as unknown as OpenCodeEvent;
}

const SID = "ses_a";

describe("mapOpenCodeEvent", () => {
	test("session.text.delta → text", () => {
		const state = createEventMapperState();
		expect(
			mapOpenCodeEvent(
				ev("session.text.delta", { sessionID: SID, delta: "hello" }),
				state,
			),
		).toEqual({ type: "text", delta: "hello" });
	});

	test("empty text delta yields nothing", () => {
		const state = createEventMapperState();
		expect(
			mapOpenCodeEvent(
				ev("session.text.delta", { sessionID: SID, delta: "" }),
				state,
			),
		).toBeUndefined();
	});

	test("session.reasoning.delta → reasoning", () => {
		const state = createEventMapperState();
		expect(
			mapOpenCodeEvent(
				ev("session.reasoning.delta", { sessionID: SID, delta: "think" }),
				state,
			),
		).toEqual({ type: "reasoning", delta: "think" });
	});

	test("tool.input.started records the name; tool.called → tool_start", () => {
		const state = createEventMapperState();
		expect(
			mapOpenCodeEvent(
				ev("session.tool.input.started", {
					sessionID: SID,
					id: "call_1",
					name: "shell",
				}),
				state,
			),
		).toBeUndefined();
		expect(state.toolNames.get("call_1")).toBe("shell");
		expect(
			mapOpenCodeEvent(
				ev("session.tool.called", {
					sessionID: SID,
					id: "call_1",
					input: { command: "cat hello.txt" },
				}),
				state,
			),
		).toEqual({
			type: "tool_start",
			tool: "shell",
			input_summary: "cat hello.txt",
		});
	});

	test("tool.called without a preceding input.started falls back to unknown", () => {
		const state = createEventMapperState();
		expect(
			mapOpenCodeEvent(
				ev("session.tool.called", {
					sessionID: SID,
					id: "call_x",
					input: { a: 1, b: 2 },
				}),
				state,
			),
		).toEqual({ type: "tool_start", tool: "unknown", input_summary: "{a, b}" });
	});

	test("tool.success → tool_end with the first text content", () => {
		const state = createEventMapperState();
		state.toolNames.set("call_1", "read");
		expect(
			mapOpenCodeEvent(
				ev("session.tool.success", {
					sessionID: SID,
					id: "call_1",
					content: [
						{ type: "file", uri: "file:///x" },
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
				}),
				state,
			),
		).toEqual({ type: "tool_end", tool: "read", output: "first" });
	});

	test("tool_end output is truncated to 500 chars", () => {
		const state = createEventMapperState();
		state.toolNames.set("call_1", "shell");
		const mapped = mapOpenCodeEvent(
			ev("session.tool.success", {
				sessionID: SID,
				id: "call_1",
				content: [{ type: "text", text: "x".repeat(2000) }],
			}),
			state,
		);
		expect(mapped?.type).toBe("tool_end");
		if (mapped?.type === "tool_end") expect(mapped.output.length).toBe(500);
	});

	test("tool.failed → tool_end with error.message and error: true", () => {
		const state = createEventMapperState();
		state.toolNames.set("call_1", "shell");
		const mapped = mapOpenCodeEvent(
			ev("session.tool.failed", {
				sessionID: SID,
				id: "call_1",
				error: { type: "denied", message: "y".repeat(800) },
			}),
			state,
		);
		expect(mapped).toEqual({
			type: "tool_end",
			tool: "shell",
			output: "y".repeat(500),
			error: true,
		});
	});

	test("step.failed and execution.failed → error", () => {
		const state = createEventMapperState();
		expect(
			mapOpenCodeEvent(
				ev("session.step.failed", {
					sessionID: SID,
					error: { type: "x", message: "step broke" },
				}),
				state,
			),
		).toEqual({ type: "error", message: "step broke" });
		expect(
			mapOpenCodeEvent(
				ev("session.execution.failed", {
					sessionID: SID,
					error: { type: "x", message: "exec broke" },
				}),
				state,
			),
		).toEqual({ type: "error", message: "exec broke" });
	});

	test("inbox and non-failure execution events map to nothing", () => {
		const state = createEventMapperState();
		for (const type of [
			"session.inbox.enqueued",
			"session.inbox.delivered",
			"session.inbox.cancelled",
			"session.execution.started",
			"session.execution.succeeded",
			"session.execution.interrupted",
		]) {
			expect(
				mapOpenCodeEvent(ev(type, { sessionID: SID, inboxID: "msg_1" }), state),
			).toBeUndefined();
		}
	});
});

describe("eventSessionId", () => {
	test("reads data.sessionID", () => {
		expect(eventSessionId(ev("session.text.delta", { sessionID: SID }))).toBe(
			SID,
		);
	});

	test("reads data.form.sessionID for form.created", () => {
		expect(
			eventSessionId(
				ev("form.created", {
					form: { id: "frm_1", sessionID: "ses_form", title: "Q", fields: [] },
				}),
			),
		).toBe("ses_form");
	});

	test("undefined for events with no session", () => {
		expect(eventSessionId(ev("config.updated", {}))).toBeUndefined();
		expect(
			eventSessionId({ type: "server.connected" } as unknown as OpenCodeEvent),
		).toBeUndefined();
	});
});

describe("summarizeToolInput", () => {
	test("shell uses command", () => {
		expect(summarizeToolInput("shell", { command: "ls -la" })).toBe("ls -la");
	});

	test("read prefers path over filePath", () => {
		expect(summarizeToolInput("read", { path: "/a", filePath: "/b" })).toBe(
			"/a",
		);
		expect(summarizeToolInput("read", { filePath: "/b" })).toBe("/b");
	});

	test("edit uses path", () => {
		expect(summarizeToolInput("edit", { path: "src/x.ts" })).toBe("src/x.ts");
	});

	test("glob and grep use pattern", () => {
		expect(summarizeToolInput("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
		expect(summarizeToolInput("grep", { pattern: "foo" })).toBe("foo");
	});

	test("subagent uses agent", () => {
		expect(
			summarizeToolInput("subagent", { agent: "5x-reviewer", prompt: "x" }),
		).toBe("5x-reviewer");
	});

	test("unknown tools list their keys", () => {
		expect(summarizeToolInput("mystery", { a: 1, b: 2 })).toBe("{a, b}");
		expect(summarizeToolInput("mystery", {})).toBe("");
		expect(summarizeToolInput("mystery", null)).toBe("");
	});
});
