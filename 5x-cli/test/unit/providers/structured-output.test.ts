import { describe, expect, test } from "bun:test";
import {
	buildCorrectivePrompt,
	buildStructuredOutputPrompt,
	extractStructuredJson,
} from "../../../src/providers/structured-output.js";

describe("extractStructuredJson", () => {
	test("exact JSON", () => {
		expect(extractStructuredJson('{"result":"complete"}')).toEqual({
			ok: true,
			value: { result: "complete" },
		});
	});

	test("fenced block", () => {
		expect(
			extractStructuredJson(
				'Here you go:\n```json\n{"result":"complete","commit":"abc"}\n```\nDone.',
			),
		).toEqual({ ok: true, value: { result: "complete", commit: "abc" } });
	});

	test("prose then trailing object", () => {
		expect(
			extractStructuredJson('I finished the work.\n{"result":"complete"}'),
		).toEqual({ ok: true, value: { result: "complete" } });
	});

	test("prose-prefixed object with a nested object returns the outer object", () => {
		expect(
			extractStructuredJson(
				'Here is the result:\n{"result":"complete","metadata":{"commit":"abc"}}',
			),
		).toEqual({
			ok: true,
			value: { result: "complete", metadata: { commit: "abc" } },
		});
	});

	test("braces inside a string value", () => {
		expect(
			extractStructuredJson(
				'Result: {"result":"complete","reason":"a } brace"}',
			),
		).toEqual({ ok: true, value: { result: "complete", reason: "a } brace" } });
		expect(
			extractStructuredJson(
				'Result: {"result":"complete","reason":"a { brace"}',
			),
		).toEqual({ ok: true, value: { result: "complete", reason: "a { brace" } });
	});

	test("an escaped quote followed by a brace inside a string", () => {
		const text =
			'Result: {"result":"failed","reason":"said \\"}\\" then left"}';
		expect(extractStructuredJson(text)).toEqual({
			ok: true,
			value: { result: "failed", reason: 'said "}" then left' },
		});
	});

	test("a stray double quote in prose before the object", () => {
		expect(
			extractStructuredJson('He said "done.\n{"result":"complete"}'),
		).toEqual({ ok: true, value: { result: "complete" } });
	});

	test("several top-level objects: the last parseable one wins", () => {
		expect(
			extractStructuredJson(
				'First {"result":"failed"} then {not json} and {"result":"complete"} end {broken',
			),
		).toEqual({ ok: true, value: { result: "complete" } });
	});

	test("a top-level array containing an object is rejected", () => {
		expect(extractStructuredJson('[{"result":"complete"}]')).toEqual({
			ok: false,
		});
		expect(extractStructuredJson('Here: [{"result":"complete"}]')).toEqual({
			ok: false,
		});
	});

	test("a scalar is rejected", () => {
		expect(extractStructuredJson("42")).toEqual({ ok: false });
		expect(extractStructuredJson('"complete"')).toEqual({ ok: false });
		expect(extractStructuredJson("null")).toEqual({ ok: false });
	});

	test("empty input", () => {
		expect(extractStructuredJson("")).toEqual({ ok: false });
		expect(extractStructuredJson("   \n ")).toEqual({ ok: false });
	});
});

describe("structured prompts", () => {
	const schema = {
		type: "object",
		properties: { result: { type: "string" } },
	};

	test("summary prompt carries the base, the schema, and the JSON-only rule", () => {
		const prompt = buildStructuredOutputPrompt("BASE TEXT", schema);
		expect(prompt.startsWith("BASE TEXT")).toBe(true);
		expect(prompt).toContain(JSON.stringify(schema, null, 2));
		expect(prompt).toContain(
			"Your final message must be exactly one JSON object and nothing else.",
		);
	});

	test("corrective prompt restates the requirement", () => {
		const prompt = buildCorrectivePrompt(schema);
		expect(prompt).toContain(JSON.stringify(schema, null, 2));
		expect(prompt).toContain("exactly one JSON object");
	});
});
