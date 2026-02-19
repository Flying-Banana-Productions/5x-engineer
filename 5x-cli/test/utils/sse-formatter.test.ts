import { describe, expect, test } from "bun:test";
import { formatSseEvent } from "../../src/utils/sse-formatter.js";

// ===========================================================================
// OpenCode SSE event shapes (primary — Phase 3+)
// ===========================================================================

describe("formatSseEvent — OpenCode SSE events", () => {
	// -----------------------------------------------------------------------
	// message.part.delta (text streaming)
	// Deltas are handled inline in writeEventsToLog — formatSseEvent always
	// returns null for them so the caller can own newline placement.
	// -----------------------------------------------------------------------

	test("message.part.delta → null (handled inline upstream)", () => {
		const event = {
			type: "message.part.delta",
			properties: {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-1",
				delta: "Hello world",
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("message.part.delta with empty delta → null", () => {
		const event = {
			type: "message.part.delta",
			properties: {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-1",
				delta: "",
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// message.part.updated — text parts
	// -----------------------------------------------------------------------

	test("message.part.updated text with delta → null (delta handled inline upstream)", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "text",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
					text: "Full text here",
				},
				delta: "here",
			},
		};
		// The delta field on part.updated is also suppressed — deltas are
		// streamed inline via the message.part.delta event path in writeEventsToLog.
		expect(formatSseEvent(event)).toBeNull();
	});

	test("message.part.updated text without delta → null", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "text",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
					text: "Full text",
				},
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// message.part.updated — tool parts
	// -----------------------------------------------------------------------

	test("tool part running → [tool] with name and input", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
					callID: "call-1",
					tool: "bash",
					state: {
						status: "running",
						input: { command: "ls -la" },
						time: { start: Date.now() },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toContain("[tool]");
		expect(result).toContain("bash:");
		expect(result).toContain("ls -la");
	});

	test("tool part running with title → uses title as label", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
					callID: "call-1",
					tool: "bash",
					state: {
						status: "running",
						input: { command: "echo hi" },
						title: "Running command",
						time: { start: Date.now() },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toContain("[tool] Running command:");
	});

	test("tool part completed → [result] with output", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
					callID: "call-1",
					tool: "bash",
					state: {
						status: "completed",
						input: { command: "ls" },
						output: "file1.ts\nfile2.ts",
						title: "bash",
						metadata: {},
						time: { start: Date.now(), end: Date.now() },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toBe("  [result] file1.ts\nfile2.ts");
	});

	test("tool part completed with long output → truncated", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
					callID: "call-1",
					tool: "bash",
					state: {
						status: "completed",
						input: {},
						output: "x".repeat(300),
						title: "bash",
						metadata: {},
						time: { start: Date.now(), end: Date.now() },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).not.toBeNull();
		const content = (result ?? "").replace("  [result] ", "");
		expect(content.length).toBe(200);
	});

	test("tool part completed with empty output → null", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "bash",
					state: {
						status: "completed",
						input: {},
						output: "",
						title: "bash",
						metadata: {},
						time: { start: Date.now(), end: Date.now() },
					},
				},
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("tool part error → [error] with message", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
					callID: "call-1",
					tool: "bash",
					state: {
						status: "error",
						input: { command: "bad-cmd" },
						error: "command not found",
						time: { start: Date.now(), end: Date.now() },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toContain("[error] bash:");
		expect(result).toContain("command not found");
	});

	test("tool part pending → null", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "bash",
					state: {
						status: "pending",
						input: {},
						raw: "{}",
					},
				},
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("tool part with large input → bounded key summary", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "write",
					state: {
						status: "running",
						input: { path: "/tmp/file.ts", content: "x".repeat(200) },
						time: { start: Date.now() },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).not.toBeNull();
		expect(result).toContain("[tool]");
		const inputPart = (result ?? "").replace(/.*: /, "");
		expect(inputPart.length).toBeLessThanOrEqual(124);
	});

	// -----------------------------------------------------------------------
	// message.part.updated — step-finish
	// -----------------------------------------------------------------------

	test("step-finish → [done] with cost and tokens", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "step-finish",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
					reason: "endTurn",
					cost: 0.0312,
					tokens: {
						input: 1000,
						output: 500,
						reasoning: 0,
						cache: { read: 0, write: 0 },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toContain("[done]");
		expect(result).toContain("endTurn");
		expect(result).toContain("$0.0312");
		expect(result).toContain("1000→500");
	});

	test("step-finish without cost → cost=unknown", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "step-finish",
					reason: "endTurn",
					tokens: {},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toContain("cost=unknown");
	});

	// -----------------------------------------------------------------------
	// session.error
	// -----------------------------------------------------------------------

	test("session.error → [error] with message", () => {
		const event = {
			type: "session.error",
			properties: {
				sessionID: "sess-1",
				error: "Provider connection lost",
			},
		};
		expect(formatSseEvent(event)).toBe("  [error] Provider connection lost");
	});

	test("session.error without error string → null", () => {
		const event = {
			type: "session.error",
			properties: { sessionID: "sess-1" },
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Other/unknown OpenCode events → null
	// -----------------------------------------------------------------------

	test("session.status → null (suppressed)", () => {
		const event = {
			type: "session.status",
			properties: { sessionID: "sess-1", status: { type: "busy" } },
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("session.idle → null (suppressed)", () => {
		const event = {
			type: "session.idle",
			properties: { sessionID: "sess-1" },
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("message.part.updated with no part → null", () => {
		const event = {
			type: "message.part.updated",
			properties: {},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("unknown event with properties → null", () => {
		const event = {
			type: "file.edited",
			properties: { file: "some-file.ts" },
		};
		expect(formatSseEvent(event)).toBeNull();
	});
});

// ===========================================================================
// Legacy NDJSON shapes (Claude Code format — backward compat)
// ===========================================================================

describe("formatSseEvent — Legacy NDJSON events", () => {
	// -----------------------------------------------------------------------
	// system init
	// -----------------------------------------------------------------------

	test("system init → [session] line with model, suppresses tools", () => {
		const event = {
			type: "system",
			subtype: "init",
			model: "claude-opus-4-6",
			session_id: "abc123",
			tools: [{ name: "Bash" }, { name: "Read" }],
		};
		expect(formatSseEvent(event)).toBe("  [session] model=claude-opus-4-6");
	});

	test("system init with unknown model", () => {
		const event = { type: "system", subtype: "init" };
		expect(formatSseEvent(event)).toBe("  [session] model=unknown");
	});

	test("system with other subtype → null (suppress)", () => {
		const event = { type: "system", subtype: "other" };
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// assistant messages — text
	// -----------------------------------------------------------------------

	test("assistant text → indented text", () => {
		const event = {
			type: "assistant",
			message: {
				content: [{ type: "text", text: "Hello world" }],
			},
		};
		expect(formatSseEvent(event)).toBe("  Hello world");
	});

	test("assistant text multi-line → each line indented", () => {
		const event = {
			type: "assistant",
			message: {
				content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
			},
		};
		expect(formatSseEvent(event)).toBe("  Line 1\n  Line 2\n  Line 3");
	});

	test("assistant text empty string → null", () => {
		const event = {
			type: "assistant",
			message: {
				content: [{ type: "text", text: "" }],
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// assistant messages — tool_use
	// -----------------------------------------------------------------------

	test("assistant tool_use → [tool] line with name and input summary", () => {
		const event = {
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Bash",
						input: { command: "ls -la" },
					},
				],
			},
		};
		const result = formatSseEvent(event);
		expect(result).toContain("[tool] Bash:");
		expect(result).toContain("ls -la");
	});

	test("assistant tool_use with long input → bounded key summary", () => {
		const longInput = { command: "x".repeat(200) };
		const event = {
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						name: "Bash",
						input: longInput,
					},
				],
			},
		};
		const result = formatSseEvent(event);
		expect(result).not.toBeNull();
		if (!result) throw new Error("Expected non-null result");
		const inputPart = result.replace("  [tool] Bash: ", "");
		expect(inputPart.length).toBeLessThanOrEqual(124);
		expect(inputPart).toContain("command");
		expect(inputPart).toContain("chars");
	});

	test("assistant tool_use unknown name → 'unknown'", () => {
		const event = {
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						input: { x: 1 },
					},
				],
			},
		};
		const result = formatSseEvent(event);
		expect(result).toContain("[tool] unknown:");
	});

	// -----------------------------------------------------------------------
	// assistant messages — multi-part content
	// -----------------------------------------------------------------------

	test("assistant multi-part content → both text and tool_use rendered", () => {
		const event = {
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "I'll run a command" },
					{ type: "tool_use", name: "Bash", input: { command: "echo hi" } },
				],
			},
		};
		const result = formatSseEvent(event);
		expect(result).not.toBeNull();
		expect(result).toContain("I'll run a command");
		expect(result).toContain("[tool] Bash:");
	});

	test("assistant with empty content array → null", () => {
		const event = {
			type: "assistant",
			message: { content: [] },
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("assistant without message → null", () => {
		const event = { type: "assistant" };
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// user messages — tool_result
	// -----------------------------------------------------------------------

	test("user tool_result with string content → [result] line", () => {
		const event = {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						content: "Command output here",
					},
				],
			},
		};
		const result = formatSseEvent(event);
		expect(result).toBe("  [result] Command output here");
	});

	test("user tool_result with array content → uses first element text", () => {
		const event = {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						content: [{ type: "text", text: "Array output" }],
					},
				],
			},
		};
		const result = formatSseEvent(event);
		expect(result).toBe("  [result] Array output");
	});

	test("user tool_result content truncated to 200 chars", () => {
		const longContent = "x".repeat(300);
		const event = {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						content: longContent,
					},
				],
			},
		};
		const result = formatSseEvent(event);
		expect(result).not.toBeNull();
		if (!result) throw new Error("Expected non-null result");
		const contentPart = result.replace("  [result] ", "");
		expect(contentPart.length).toBe(200);
	});

	test("user tool_result with empty string content → null", () => {
		const event = {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						content: "",
					},
				],
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("user message with no tool_result parts → null", () => {
		const event = {
			type: "user",
			message: {
				content: [{ type: "something_else", content: "x" }],
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// result event
	// -----------------------------------------------------------------------

	test("result event → [done] line with subtype, cost, duration", () => {
		const event = {
			type: "result",
			subtype: "success",
			total_cost_usd: 0.0312,
			duration_ms: 5432,
		};
		const result = formatSseEvent(event);
		expect(result).toBe("  [done] success | cost=$0.0312 | 5.4s");
	});

	test("result event with missing cost/duration → 'unknown'", () => {
		const event = { type: "result", subtype: "error" };
		const result = formatSseEvent(event);
		expect(result).toBe("  [done] error | cost=unknown | unknown");
	});

	test("result event without subtype → 'unknown'", () => {
		const event = { type: "result", total_cost_usd: 0.01, duration_ms: 1000 };
		const result = formatSseEvent(event);
		expect(result).toBe("  [done] unknown | cost=$0.0100 | 1.0s");
	});

	// -----------------------------------------------------------------------
	// Unknown / invalid event types
	// -----------------------------------------------------------------------

	test("unknown event type → null (forward-compatible)", () => {
		const event = { type: "future_event_type", data: "something" };
		expect(formatSseEvent(event)).toBeNull();
	});

	test("null event → null", () => {
		expect(formatSseEvent(null)).toBeNull();
	});

	test("non-object event → null", () => {
		expect(formatSseEvent("string")).toBeNull();
		expect(formatSseEvent(42)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// safeInputSummary edge cases (via tool_use path)
	// -----------------------------------------------------------------------

	test("tool_use with circular-reference input → [unserializable] fallback", () => {
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		const event = {
			type: "assistant",
			message: {
				content: [{ type: "tool_use", name: "Test", input: circular }],
			},
		};
		const result = formatSseEvent(event);
		expect(result).not.toBeNull();
		expect(result).toContain("[tool] Test:");
		const inputPart = (result ?? "").replace("  [tool] Test: ", "");
		expect(inputPart.length).toBeLessThanOrEqual(124);
	});

	test("tool_use with small input → exact JSON output", () => {
		const smallInput = { cmd: "ls" };
		const event = {
			type: "assistant",
			message: {
				content: [{ type: "tool_use", name: "Bash", input: smallInput }],
			},
		};
		const result = formatSseEvent(event);
		expect(result).toContain('{"cmd":"ls"}');
	});
});
