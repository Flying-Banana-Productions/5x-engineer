import { describe, expect, test } from "bun:test";
import { formatSseEvent } from "../../src/utils/sse-formatter.js";

// ===========================================================================
// OpenCode SSE event shapes (primary)
// ===========================================================================

describe("formatSseEvent — OpenCode SSE events", () => {
	// -----------------------------------------------------------------------
	// message.part.delta (text streaming)
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

	test("message.part.updated text → null (delta handled inline upstream)", () => {
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
	// message.part.updated — reasoning parts
	// -----------------------------------------------------------------------

	test("message.part.updated reasoning → null (handled as deltas upstream)", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "reasoning",
					sessionID: "sess-1",
					messageID: "msg-1",
					id: "part-1",
				},
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// message.part.updated — tool parts
	// -----------------------------------------------------------------------

	test("tool running → { text: 'bash: ls -la', dim: true }", () => {
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
		expect(result).toEqual({ text: "bash: ls -la", dim: true });
	});

	test("tool running with title → uses title as label", () => {
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
		expect(result).toEqual({ text: "Running command: echo hi", dim: true });
	});

	test("tool running file_edit → shows filePath", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "file_edit",
					state: {
						status: "running",
						input: { filePath: "/tmp/foo.ts", oldString: "a", newString: "b" },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({ text: "file_edit: /tmp/foo.ts", dim: true });
	});

	test("tool running read → shows filePath", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "read",
					state: {
						status: "running",
						input: { filePath: "/tmp/bar.ts" },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({ text: "read: /tmp/bar.ts", dim: true });
	});

	test("tool running grep → shows pattern", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "grep",
					state: {
						status: "running",
						input: { pattern: "TODO", path: "/src" },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({ text: "grep: TODO", dim: true });
	});

	test("tool running glob → shows pattern", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "glob",
					state: {
						status: "running",
						input: { pattern: "**/*.ts" },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({ text: "glob: **/*.ts", dim: true });
	});

	test("tool running unknown → shows key names", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "custom_tool",
					state: {
						status: "running",
						input: { foo: 1, bar: "hi" },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({ text: "custom_tool: {foo, bar}", dim: true });
	});

	test("tool running with no input → label only", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "bash",
					state: {
						status: "running",
						input: null,
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({ text: "bash", dim: true });
	});

	test("tool completed → { text: collapsed output, dim: true }", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "bash",
					state: {
						status: "completed",
						input: { command: "ls" },
						output: "file1.ts\nfile2.ts",
						time: { start: Date.now(), end: Date.now() },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({ text: "file1.ts file2.ts", dim: true });
	});

	test("tool completed with huge output → only slices first N chars", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "bash",
					state: {
						status: "completed",
						input: {},
						output: "x".repeat(10000),
						time: { start: Date.now(), end: Date.now() },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).not.toBeNull();
		// Bounded to 500-char slice max
		expect(result?.text.length).toBeLessThanOrEqual(500);
		expect(result?.dim).toBe(true);
	});

	test("tool completed empty → null", () => {
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
						time: { start: Date.now(), end: Date.now() },
					},
				},
			},
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("tool error → { text: '! bash: command not found', dim: false }", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
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
		expect(result).toEqual({
			text: "! bash: command not found",
			dim: false,
		});
	});

	test("tool pending → null", () => {
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

	test("tool with write + path field → shows path", () => {
		const event = {
			type: "message.part.updated",
			properties: {
				part: {
					type: "tool",
					tool: "write",
					state: {
						status: "running",
						input: { path: "/tmp/out.txt", content: "hello" },
					},
				},
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({ text: "write: /tmp/out.txt", dim: true });
	});

	// -----------------------------------------------------------------------
	// message.part.updated — step-finish (hidden)
	// -----------------------------------------------------------------------

	test("step-finish → null (hidden)", () => {
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
		expect(formatSseEvent(event)).toBeNull();
	});

	test("step-finish without cost → null", () => {
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
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// session.error
	// -----------------------------------------------------------------------

	test("session.error → { text: '! Provider connection lost', dim: false }", () => {
		const event = {
			type: "session.error",
			properties: {
				sessionID: "sess-1",
				error: "Provider connection lost",
			},
		};
		expect(formatSseEvent(event)).toEqual({
			text: "! Provider connection lost",
			dim: false,
		});
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

	test("session.status → null", () => {
		const event = {
			type: "session.status",
			properties: { sessionID: "sess-1", status: { type: "busy" } },
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("session.idle → null", () => {
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
	// system init → hidden
	// -----------------------------------------------------------------------

	test("system init → null (hidden)", () => {
		const event = {
			type: "system",
			subtype: "init",
			model: "claude-opus-4-6",
			session_id: "abc123",
			tools: [{ name: "Bash" }, { name: "Read" }],
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	test("system init with unknown model → null", () => {
		const event = { type: "system", subtype: "init" };
		expect(formatSseEvent(event)).toBeNull();
	});

	test("system with other subtype → null", () => {
		const event = { type: "system", subtype: "other" };
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// assistant messages — text
	// -----------------------------------------------------------------------

	test("assistant text → { text, dim: false }", () => {
		const event = {
			type: "assistant",
			message: {
				content: [{ type: "text", text: "Hello world" }],
			},
		};
		expect(formatSseEvent(event)).toEqual({
			text: "Hello world",
			dim: false,
		});
	});

	test("assistant text multi-line → joined text", () => {
		const event = {
			type: "assistant",
			message: {
				content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
			},
		};
		expect(formatSseEvent(event)).toEqual({
			text: "Line 1\nLine 2\nLine 3",
			dim: false,
		});
	});

	test("assistant text empty → null", () => {
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

	test("assistant tool_use → { text: 'Bash: ...', dim: false }", () => {
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
		expect(result).not.toBeNull();
		expect(result?.text).toContain("Bash:");
		expect(result?.text).toContain("ls -la");
		expect(result?.dim).toBe(false);
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
		// "Bash: " prefix (6 chars) + summary (max 120) ≤ 126
		expect(result?.text.length).toBeLessThanOrEqual(130);
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
		expect(result?.text).toContain("unknown:");
	});

	// -----------------------------------------------------------------------
	// assistant messages — multi-part content
	// -----------------------------------------------------------------------

	test("assistant multi-part → both text and tool_use rendered", () => {
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
		expect(result?.text).toContain("I'll run a command");
		expect(result?.text).toContain("Bash:");
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

	test("user tool_result with string content → collapsed, dim", () => {
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
		expect(result).toEqual({ text: "Command output here", dim: true });
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
		expect(result).toEqual({ text: "Array output", dim: true });
	});

	test("user tool_result multiline → whitespace collapsed", () => {
		const event = {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						content: "file1.ts\nfile2.ts\nfile3.ts",
					},
				],
			},
		};
		const result = formatSseEvent(event);
		expect(result).toEqual({
			text: "file1.ts file2.ts file3.ts",
			dim: true,
		});
	});

	test("user tool_result with huge content → bounded slice", () => {
		const longContent = "x".repeat(10000);
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
		expect(result?.text.length).toBeLessThanOrEqual(500);
		expect(result?.dim).toBe(true);
	});

	test("user tool_result with empty string → null", () => {
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
	// result event → hidden
	// -----------------------------------------------------------------------

	test("result event → null (hidden)", () => {
		const event = {
			type: "result",
			subtype: "success",
			total_cost_usd: 0.0312,
			duration_ms: 5432,
		};
		expect(formatSseEvent(event)).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Unknown / invalid event types
	// -----------------------------------------------------------------------

	test("unknown event type → null", () => {
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
	// safeInputSummary edge cases (via legacy tool_use path)
	// -----------------------------------------------------------------------

	test("tool_use with circular-reference input → fallback", () => {
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
		expect(result?.text).toContain("Test:");
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
		expect(result?.text).toContain('{"cmd":"ls"}');
	});
});
