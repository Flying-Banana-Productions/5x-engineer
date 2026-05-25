import { describe, expect, test } from "bun:test";
import {
	extractStructuredOutput,
	wrapPromptForStructuredOutput,
} from "../../../../packages/provider-cursor-agent/src/structured.js";

describe("wrapPromptForStructuredOutput", () => {
	test("preserves original prompt text", () => {
		const wrapped = wrapPromptForStructuredOutput("Do the work", {
			type: "object",
			properties: { ok: { type: "boolean" } },
		});
		expect(wrapped.startsWith("Do the work")).toBe(true);
		expect(wrapped).toContain("FINAL RESPONSE REQUIREMENTS");
		expect(wrapped).toContain('"type": "object"');
		expect(wrapped).toContain("exactly one JSON object");
	});
});

describe("extractStructuredOutput", () => {
	test("parses exact JSON from final assistant text", () => {
		const result = extractStructuredOutput(
			'{"result":"pass","summary":"ok"}',
			"ignored terminal",
		);
		expect(result).toEqual({
			ok: true,
			value: { result: "pass", summary: "ok" },
		});
	});

	test("parses fenced JSON from final assistant text", () => {
		const result = extractStructuredOutput(
			'Here is the answer:\n```json\n{"result":"pass"}\n```',
			"",
		);
		expect(result).toEqual({ ok: true, value: { result: "pass" } });
	});

	test("falls back to terminal result text", () => {
		const result = extractStructuredOutput("", '{"result":"pass"}');
		expect(result).toEqual({ ok: true, value: { result: "pass" } });
	});

	test("prefers final assistant text over terminal result", () => {
		const result = extractStructuredOutput(
			'{"source":"assistant"}',
			'{"source":"terminal"}',
		);
		expect(result).toEqual({ ok: true, value: { source: "assistant" } });
	});

	test("returns ok false for malformed JSON without throwing", () => {
		const result = extractStructuredOutput("not json", "also not json");
		expect(result).toEqual({ ok: false });
	});

	test("falls back to fenced JSON in terminal result text", () => {
		const result = extractStructuredOutput(
			"",
			'```json\n{"result":"from-terminal"}\n```',
		);
		expect(result).toEqual({ ok: true, value: { result: "from-terminal" } });
	});

	test("extracts trailing JSON object from prose assistant text", () => {
		const result = extractStructuredOutput(
			'Plan updated successfully.\n\n{"result":"complete","commit":"deadbeef","notes":"done"}',
			"",
		);
		expect(result).toEqual({
			ok: true,
			value: { result: "complete", commit: "deadbeef", notes: "done" },
		});
	});
});
