import { describe, expect, test } from "bun:test";
import {
	createMapperState,
	mapCursorAgentLine,
	summarizeCursorToolArgs,
} from "../../../../packages/provider-cursor-agent/src/event-mapper.js";

const SESSION = "c6b62c6f-7ead-4fd6-9922-e952131177ff";

describe("summarizeCursorToolArgs", () => {
	test("read tool uses path", () => {
		expect(summarizeCursorToolArgs("read", { path: "README.md" })).toBe(
			"README.md",
		);
	});

	test("shell-like tools truncate long command", () => {
		const long = "x".repeat(200);
		const s = summarizeCursorToolArgs("bash", { command: long });
		expect(s.length).toBe(120);
		expect(s.endsWith("...")).toBe(true);
	});
});

describe("mapCursorAgentLine", () => {
	test("system init stores session id and emits nothing", () => {
		const st = createMapperState();
		expect(
			mapCursorAgentLine(
				{
					type: "system",
					subtype: "init",
					session_id: SESSION,
					model: "Claude 4 Sonnet",
				},
				st,
			),
		).toBeUndefined();
		expect(st.sessionId).toBe(SESSION);
	});

	test("user message emits nothing", () => {
		const st = createMapperState();
		expect(
			mapCursorAgentLine(
				{
					type: "user",
					message: {
						role: "user",
						content: [{ type: "text", text: "Read README.md" }],
					},
					session_id: SESSION,
				},
				st,
			),
		).toBeUndefined();
	});

	test("assistant partial delta emits text and tracks finalAssistantText", () => {
		const st = createMapperState();
		const ev = mapCursorAgentLine(
			{
				type: "assistant",
				timestamp_ms: 1,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I'll read" }],
				},
				session_id: SESSION,
			},
			st,
		);
		expect(ev).toEqual({ type: "text", delta: "I'll read" });
		expect(st.accumulatedText).toBe("I'll read");
		expect(st.finalAssistantText).toBe("I'll read");
	});

	test("assistant pre-tool duplicate flush is skipped", () => {
		const st = createMapperState();
		expect(
			mapCursorAgentLine(
				{
					type: "assistant",
					timestamp_ms: 2,
					model_call_id: "call-1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "I'll read" }],
					},
					session_id: SESSION,
				},
				st,
			),
		).toBeUndefined();
		expect(st.accumulatedText).toBe("");
	});

	test("assistant final flush is skipped in partial mode but accumulates text", () => {
		const st = createMapperState();
		expect(
			mapCursorAgentLine(
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done!" }],
					},
					session_id: SESSION,
				},
				st,
				{ partialMode: true },
			),
		).toBeUndefined();
		expect(st.finalAssistantText).toBe("Done!");
	});

	test("assistant final flush with JSON accumulates for structured extraction", () => {
		const st = createMapperState();
		const payload = '{"result":"complete","commit":"abc123"}';
		mapCursorAgentLine(
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: payload }],
				},
				session_id: SESSION,
			},
			st,
			{ partialMode: true },
		);
		expect(st.finalAssistantText).toBe(payload);
	});

	test("assistant full message emits text when partial mode disabled", () => {
		const st = createMapperState();
		const ev = mapCursorAgentLine(
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Complete answer" }],
				},
				session_id: SESSION,
			},
			st,
			{ partialMode: false },
		);
		expect(ev).toEqual({ type: "text", delta: "Complete answer" });
		expect(st.finalAssistantText).toBe("Complete answer");
	});

	test("readToolCall started and completed correlate by call_id", () => {
		const st = createMapperState();
		const started = mapCursorAgentLine(
			{
				type: "tool_call",
				subtype: "started",
				call_id: "toolu_read",
				tool_call: {
					readToolCall: { args: { path: "README.md" } },
				},
				session_id: SESSION,
			},
			st,
		);
		expect(started).toEqual({
			type: "tool_start",
			tool: "read",
			input_summary: "README.md",
		});

		const completed = mapCursorAgentLine(
			{
				type: "tool_call",
				subtype: "completed",
				call_id: "toolu_read",
				tool_call: {
					readToolCall: {
						args: { path: "README.md" },
						result: {
							success: {
								content: "# Project",
								isEmpty: false,
							},
						},
					},
				},
				session_id: SESSION,
			},
			st,
		);
		expect(completed).toEqual({
			type: "tool_end",
			tool: "read",
			output: "# Project",
		});
		expect(st.toolNamesByCallId.has("toolu_read")).toBe(false);
	});

	test("writeToolCall maps normalized tool name", () => {
		const st = createMapperState();
		const ev = mapCursorAgentLine(
			{
				type: "tool_call",
				subtype: "started",
				call_id: "toolu_write",
				tool_call: {
					writeToolCall: {
						args: { path: "summary.txt", fileText: "hello" },
					},
				},
				session_id: SESSION,
			},
			st,
		);
		expect(ev).toEqual({
			type: "tool_start",
			tool: "write",
			input_summary: "summary.txt",
		});
	});

	test("generic function tool call uses function.name", () => {
		const st = createMapperState();
		const ev = mapCursorAgentLine(
			{
				type: "tool_call",
				subtype: "started",
				call_id: "fn1",
				tool_call: {
					function: {
						name: "grep",
						arguments: '{"pattern":"foo"}',
					},
				},
				session_id: SESSION,
			},
			st,
		);
		expect(ev).toEqual({
			type: "tool_start",
			tool: "grep",
			input_summary: '{"pattern":"foo"}',
		});
	});

	test("tool_end marks error results", () => {
		const st = createMapperState();
		mapCursorAgentLine(
			{
				type: "tool_call",
				subtype: "started",
				call_id: "err1",
				tool_call: {
					readToolCall: { args: { path: "missing.txt" } },
				},
				session_id: SESSION,
			},
			st,
		);
		const ev = mapCursorAgentLine(
			{
				type: "tool_call",
				subtype: "completed",
				call_id: "err1",
				tool_call: {
					readToolCall: {
						args: { path: "missing.txt" },
						result: { error: { message: "file not found" } },
					},
				},
				session_id: SESSION,
			},
			st,
		);
		expect(ev).toEqual({
			type: "tool_end",
			tool: "read",
			output: "file not found",
			error: true,
		});
	});

	test("terminal result success emits usage then done with zero tokens", () => {
		const st = createMapperState();
		st.finalAssistantText = "Done!";
		const ev = mapCursorAgentLine(
			{
				type: "result",
				subtype: "success",
				duration_ms: 5234,
				duration_api_ms: 5234,
				is_error: false,
				result: "Done!",
				session_id: SESSION,
			},
			st,
		);
		expect(Array.isArray(ev)).toBe(true);
		if (!Array.isArray(ev)) throw new Error("expected array");
		expect(ev[0]).toEqual({ type: "usage", tokens: { in: 0, out: 0 } });
		expect(ev[1]?.type).toBe("done");
		if (ev[1]?.type === "done") {
			expect(ev[1].result.text).toBe("Done!");
			expect(ev[1].result.sessionId).toBe(SESSION);
			expect(ev[1].result.tokens).toEqual({ in: 0, out: 0 });
			expect(ev[1].result.durationMs).toBe(5234);
			expect(ev[1].result.costUsd).toBeUndefined();
		}
	});

	test("terminal result error emits error event", () => {
		const st = createMapperState();
		const ev = mapCursorAgentLine(
			{
				type: "result",
				subtype: "error",
				is_error: true,
				error: "run failed",
			},
			st,
		);
		expect(ev).toEqual({ type: "error", message: "run failed" });
	});

	test("malformed line returns undefined", () => {
		const st = createMapperState();
		expect(mapCursorAgentLine({}, st)).toBeUndefined();
		expect(mapCursorAgentLine({ type: "unknown" }, st)).toBeUndefined();
	});

	test("documented sequence partial deltas accumulate final assistant text", () => {
		const st = createMapperState();
		mapCursorAgentLine(
			{
				type: "assistant",
				timestamp_ms: 1,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I'll read the README.md file" }],
				},
				session_id: SESSION,
			},
			st,
		);
		mapCursorAgentLine(
			{
				type: "assistant",
				timestamp_ms: 2,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done!" }],
				},
				session_id: SESSION,
			},
			st,
		);
		expect(st.finalAssistantText).toBe("I'll read the README.md fileDone!");
	});
});
