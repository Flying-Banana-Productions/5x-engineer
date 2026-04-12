import { describe, expect, test } from "bun:test";
import {
	buildCliArgs,
	type CliArgContext,
} from "../../../../packages/provider-claude-code/src/cli-args.js";

function base(over: Partial<CliArgContext> = {}): CliArgContext {
	return {
		prompt: "hello",
		sessionId: "550e8400-e29b-41d4-a716-446655440000",
		isResume: false,
		streaming: true,
		...over,
	};
}

describe("buildCliArgs", () => {
	test("always includes -p with prompt first", () => {
		const args = buildCliArgs(base({ prompt: "x y" }));
		expect(args[0]).toBe("-p");
		expect(args[1]).toBe("x y");
	});

	test("new session uses --session-id", () => {
		const args = buildCliArgs(base({ isResume: false }));
		expect(args).toContain("--session-id");
		expect(args).toContain("550e8400-e29b-41d4-a716-446655440000");
		expect(args).not.toContain("--resume");
	});

	test("resume uses --resume", () => {
		const args = buildCliArgs(base({ isResume: true }));
		expect(args).toContain("--resume");
		expect(args).toContain("550e8400-e29b-41d4-a716-446655440000");
		expect(args).not.toContain("--session-id");
	});

	test("includes --model when set", () => {
		const args = buildCliArgs(base({ model: "claude-sonnet-4-6" }));
		const i = args.indexOf("--model");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("claude-sonnet-4-6");
	});

	test("omits --model when empty string", () => {
		const args = buildCliArgs(base({ model: "" }));
		expect(args).not.toContain("--model");
	});

	test("streaming: stream-json + verbose + partial messages", () => {
		const args = buildCliArgs(base({ streaming: true }));
		expect(args).toEqual(
			expect.arrayContaining([
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
			]),
		);
	});

	test("non-streaming: json only", () => {
		const args = buildCliArgs(base({ streaming: false }));
		expect(args).toContain("--output-format");
		expect(args).toContain("json");
		expect(args).not.toContain("stream-json");
		expect(args).not.toContain("--include-partial-messages");
	});

	test("includes --json-schema when set", () => {
		const schema = JSON.stringify({ type: "object" });
		const args = buildCliArgs(base({ jsonSchema: schema }));
		const i = args.indexOf("--json-schema");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe(schema);
	});

	test("default permission adds --dangerously-skip-permissions", () => {
		const args = buildCliArgs(base({}));
		expect(args).toContain("--dangerously-skip-permissions");
	});

	test("permissionMode default explicitly skips", () => {
		const args = buildCliArgs(base({ permissionMode: "dangerously-skip" }));
		expect(args).toContain("--dangerously-skip-permissions");
	});

	test("permissionMode default does not add skip flag", () => {
		const args = buildCliArgs(base({ permissionMode: "default" }));
		expect(args).not.toContain("--dangerously-skip-permissions");
	});

	test("bare, tools, budget, system prompts", () => {
		const args = buildCliArgs(
			base({
				bare: true,
				tools: ["Read", "Write"],
				maxBudgetUsd: 3.5,
				systemPrompt: "SYS",
				appendSystemPrompt: "EXTRA",
			}),
		);
		expect(args).toContain("--bare");
		const ti = args.indexOf("--tools");
		expect(args[ti + 1]).toBe("Read,Write");
		const bi = args.indexOf("--max-budget-usd");
		expect(args[bi + 1]).toBe("3.5");
		const si = args.indexOf("--system-prompt");
		expect(args[si + 1]).toBe("SYS");
		const ai = args.indexOf("--append-system-prompt");
		expect(args[ai + 1]).toBe("EXTRA");
	});

	test("empty tools array omits --tools", () => {
		const args = buildCliArgs(base({ tools: [] }));
		expect(args).not.toContain("--tools");
	});

	test("includes --effort when set", () => {
		const args = buildCliArgs(base({ effort: "high" }));
		const i = args.indexOf("--effort");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("high");
	});

	test("omits --effort when undefined", () => {
		const args = buildCliArgs(base({}));
		expect(args).not.toContain("--effort");
	});

	test("includes --add-dir with variadic directories", () => {
		const args = buildCliArgs(base({ addDir: ["../sibling", "/abs/path"] }));
		const i = args.indexOf("--add-dir");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("../sibling");
		expect(args[i + 2]).toBe("/abs/path");
	});

	test("empty addDir array omits --add-dir", () => {
		const args = buildCliArgs(base({ addDir: [] }));
		expect(args).not.toContain("--add-dir");
	});

	test("includes --fallback-model when set", () => {
		const args = buildCliArgs(base({ fallbackModel: "sonnet" }));
		const i = args.indexOf("--fallback-model");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("sonnet");
	});

	test("omits --fallback-model when empty string", () => {
		const args = buildCliArgs(base({ fallbackModel: "" }));
		expect(args).not.toContain("--fallback-model");
	});

	test("includes --disallowed-tools joined with commas", () => {
		const args = buildCliArgs(
			base({ disallowedTools: ["Bash(rm:*)", "Edit"] }),
		);
		const i = args.indexOf("--disallowed-tools");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("Bash(rm:*),Edit");
	});

	test("empty disallowedTools array omits --disallowed-tools", () => {
		const args = buildCliArgs(base({ disallowedTools: [] }));
		expect(args).not.toContain("--disallowed-tools");
	});
});
