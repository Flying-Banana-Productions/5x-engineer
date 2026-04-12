import { describe, expect, test } from "bun:test";
import { parseModelForClaudeCode } from "../../../../packages/provider-claude-code/src/model.js";

describe("parseModelForClaudeCode", () => {
	test("strips anthropic/ prefix", () => {
		expect(parseModelForClaudeCode("anthropic/claude-sonnet-4-6")).toBe(
			"claude-sonnet-4-6",
		);
	});

	test("passes through bare alias", () => {
		expect(parseModelForClaudeCode("sonnet")).toBe("sonnet");
	});

	test("passes through model id without prefix", () => {
		expect(parseModelForClaudeCode("claude-sonnet-4-6")).toBe(
			"claude-sonnet-4-6",
		);
	});

	test("empty string", () => {
		expect(parseModelForClaudeCode("")).toBe("");
	});

	test("only first anthropic/ segment is stripped once", () => {
		expect(parseModelForClaudeCode("anthropic/foo/bar")).toBe("foo/bar");
	});

	test("does not strip other vendor prefixes", () => {
		expect(parseModelForClaudeCode("openai/gpt-4")).toBe("openai/gpt-4");
	});
});
