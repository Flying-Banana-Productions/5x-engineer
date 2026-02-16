import { describe, expect, test } from "bun:test";
import { ClaudeCodeAdapter } from "../../src/agents/claude-code.js";
import { createAdapter } from "../../src/agents/factory.js";

describe("createAdapter", () => {
	test('returns ClaudeCodeAdapter for "claude-code"', () => {
		const adapter = createAdapter({ adapter: "claude-code" });
		expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
		expect(adapter.name).toBe("claude-code");
	});

	test('throws for "opencode" (not yet implemented)', () => {
		expect(() => createAdapter({ adapter: "opencode" })).toThrow(
			"not yet implemented",
		);
	});

	test("throws for unknown adapter", () => {
		expect(() =>
			createAdapter({ adapter: "gpt-4" as "claude-code" }),
		).toThrow("Unknown adapter");
	});

	test("adapter has isAvailable method", () => {
		const adapter = createAdapter({ adapter: "claude-code" });
		expect(typeof adapter.isAvailable).toBe("function");
	});

	test("adapter has invoke method", () => {
		const adapter = createAdapter({ adapter: "claude-code" });
		expect(typeof adapter.invoke).toBe("function");
	});
});
