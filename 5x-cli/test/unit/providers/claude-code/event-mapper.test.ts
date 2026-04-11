import { describe, expect, test } from "bun:test";
import {
	createMapperState,
	mapNdjsonLine,
	summarizeToolInput,
} from "../../../../packages/provider-claude-code/src/event-mapper.js";

describe("summarizeToolInput", () => {
	test("Read uses file path", () => {
		expect(summarizeToolInput("Read", { file_path: "/a/b.ts" })).toBe(
			"/a/b.ts",
		);
	});

	test("Bash truncates long command", () => {
		const long = "x".repeat(200);
		const s = summarizeToolInput("Bash", { command: long });
		expect(s.length).toBe(120);
		expect(s.endsWith("...")).toBe(true);
	});

	test("Glob and Grep use pattern", () => {
		expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
		expect(summarizeToolInput("Grep", { pattern: "foo" })).toBe("foo");
	});
});

describe("mapNdjsonLine", () => {
	test("system → undefined", () => {
		const st = createMapperState();
		expect(mapNdjsonLine({ type: "system" }, st)).toBeUndefined();
	});

	test("rate_limit_event → undefined", () => {
		const st = createMapperState();
		expect(mapNdjsonLine({ type: "rate_limit_event" }, st)).toBeUndefined();
	});

	test("stream_event text_delta → text and accumulatedText", () => {
		const st = createMapperState();
		const ev = mapNdjsonLine(
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "hi" },
				},
			},
			st,
		);
		expect(ev).toEqual({ type: "text", delta: "hi" });
		expect(st.accumulatedText).toBe("hi");
	});

	test("stream_event text deltas append to accumulatedText", () => {
		const st = createMapperState();
		const line = {
			type: "stream_event",
			event: {
				type: "content_block_delta",
				delta: { type: "text_delta", text: "a" },
			},
		};
		mapNdjsonLine(line, st);
		mapNdjsonLine(
			{
				...line,
				event: { ...line.event, delta: { type: "text_delta", text: "b" } },
			},
			st,
		);
		expect(st.accumulatedText).toBe("ab");
	});

	test("stream_event thinking_delta → reasoning (does not append accumulatedText)", () => {
		const st = createMapperState();
		const ev = mapNdjsonLine(
			{
				type: "stream_event",
				event: {
					delta: { type: "thinking_delta", text: "think" },
				},
			},
			st,
		);
		expect(ev).toEqual({ type: "reasoning", delta: "think" });
		expect(st.accumulatedText).toBe("");
	});

	test("assistant tool_use → tool_start and pending map", () => {
		const st = createMapperState();
		const ev = mapNdjsonLine(
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "tu1",
							name: "Read",
							input: { file_path: "/f" },
						},
					],
				},
			},
			st,
		);
		expect(ev).toEqual({
			type: "tool_start",
			tool: "Read",
			input_summary: "/f",
		});
		expect(st.pendingTools.get("tu1")).toBe("Read");
	});

	test("multiple tool_use blocks → array of tool_start", () => {
		const st = createMapperState();
		const ev = mapNdjsonLine(
			{
				type: "assistant",
				content: [
					{
						type: "tool_use",
						id: "a",
						name: "Read",
						input: { file_path: "/1" },
					},
					{
						type: "tool_use",
						id: "b",
						name: "Write",
						input: { file_path: "/2" },
					},
				],
			},
			st,
		);
		expect(Array.isArray(ev)).toBe(true);
		expect(ev).toEqual([
			{
				type: "tool_start",
				tool: "Read",
				input_summary: "/1",
			},
			{
				type: "tool_start",
				tool: "Write",
				input_summary: "/2",
			},
		]);
	});

	test("user tool_result → tool_end with correlation", () => {
		const st = createMapperState();
		mapNdjsonLine(
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "tid",
							name: "Read",
							input: {},
						},
					],
				},
			},
			st,
		);
		const ev = mapNdjsonLine(
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "tid",
							content: "file contents",
							is_error: false,
						},
					],
				},
			},
			st,
		);
		expect(ev).toEqual({
			type: "tool_end",
			tool: "Read",
			output: "file contents",
		});
		expect(st.pendingTools.has("tid")).toBe(false);
	});

	test("tool_result with is_error → tool_end.error", () => {
		const st = createMapperState();
		mapNdjsonLine(
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "e1",
							name: "Bash",
							input: { command: "false" },
						},
					],
				},
			},
			st,
		);
		const ev = mapNdjsonLine(
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "e1",
							content: "failed",
							is_error: true,
						},
					],
				},
			},
			st,
		);
		expect(ev).toEqual({
			type: "tool_end",
			tool: "Bash",
			output: "failed",
			error: true,
		});
	});

	test("result success → done with RunResult fields", () => {
		const st = createMapperState();
		const ev = mapNdjsonLine(
			{
				type: "result",
				is_error: false,
				result: "final",
				session_id: "sess-1",
				usage: { input_tokens: 10, output_tokens: 20 },
				total_cost_usd: 0.42,
				duration_ms: 1500,
				structured_output: { ok: true },
			},
			st,
			{ sessionIdFallback: "fallback" },
		);
		expect(Array.isArray(ev)).toBe(false);
		if (!ev || Array.isArray(ev)) throw new Error("expected single event");
		expect(ev.type).toBe("done");
		if (ev.type === "done") {
			expect(ev.result.text).toBe("final");
			expect(ev.result.sessionId).toBe("sess-1");
			expect(ev.result.tokens).toEqual({ in: 10, out: 20 });
			expect(ev.result.costUsd).toBe(0.42);
			expect(ev.result.durationMs).toBe(1500);
			expect(ev.result.structured).toEqual({ ok: true });
		}
	});

	test("result error → error event", () => {
		const st = createMapperState();
		const ev = mapNdjsonLine(
			{
				type: "result",
				is_error: true,
				error: "schema validation failed",
			},
			st,
		);
		expect(ev).toEqual({
			type: "error",
			message: "schema validation failed",
		});
	});

	test("unknown type → undefined", () => {
		const st = createMapperState();
		expect(mapNdjsonLine({ type: "weird_unknown" }, st)).toBeUndefined();
	});

	test("malformed empty object → undefined", () => {
		const st = createMapperState();
		expect(mapNdjsonLine({}, st)).toBeUndefined();
	});
});
