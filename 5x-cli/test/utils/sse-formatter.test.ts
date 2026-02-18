import { describe, expect, test } from "bun:test";
import { formatSseEvent } from "../../src/utils/sse-formatter.js";

describe("formatSseEvent", () => {
	// ---------------------------------------------------------------------------
	// system init
	// ---------------------------------------------------------------------------

	test("system init → [session] line with model, suppresses tools", () => {
		const event = {
			type: "system",
			subtype: "init",
			model: "claude-opus-4-6",
			session_id: "abc123",
			tools: [{ name: "Bash" }, { name: "Read" }], // should be suppressed
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

	// ---------------------------------------------------------------------------
	// assistant messages — text
	// ---------------------------------------------------------------------------

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

	// ---------------------------------------------------------------------------
	// assistant messages — tool_use
	// ---------------------------------------------------------------------------

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

	test("assistant tool_use with long input → bounded key summary (no large allocation)", () => {
		// Input whose JSON form exceeds TOOL_INPUT_LIMIT (120 chars).
		// safeInputSummary produces a key-only summary to avoid retaining huge strings.
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
		// Output must be bounded (well under the 120-char limit for the key summary).
		const inputPart = result.replace("  [tool] Bash: ", "");
		expect(inputPart.length).toBeLessThanOrEqual(124);
		// Key summary shows the object's keys and the serialized size.
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

	// ---------------------------------------------------------------------------
	// assistant messages — multi-part content
	// ---------------------------------------------------------------------------

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

	// ---------------------------------------------------------------------------
	// user messages — tool_result
	// ---------------------------------------------------------------------------

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

	// ---------------------------------------------------------------------------
	// result event
	// ---------------------------------------------------------------------------

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

	// ---------------------------------------------------------------------------
	// Unknown / invalid event types
	// ---------------------------------------------------------------------------

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

	// ---------------------------------------------------------------------------
	// safeInputSummary edge cases (via formatSseEvent tool_use path)
	// ---------------------------------------------------------------------------

	test("tool_use with circular-reference input → [unserializable] fallback", () => {
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular; // creates circular reference
		const event = {
			type: "assistant",
			message: {
				content: [{ type: "tool_use", name: "Test", input: circular }],
			},
		};
		const result = formatSseEvent(event);
		expect(result).not.toBeNull();
		// Should include the tool name and not throw
		expect(result).toContain("[tool] Test:");
		// Should contain unserializable marker or key names
		const inputPart = (result ?? "").replace("  [tool] Test: ", "");
		expect(inputPart.length).toBeLessThanOrEqual(124);
	});

	test("tool_use with small input → exact JSON output (no key-summary)", () => {
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
