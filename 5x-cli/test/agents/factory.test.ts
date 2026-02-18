import { describe, expect, test } from "bun:test";
import {
	createAdapter,
	createAndVerifyAdapter,
} from "../../src/agents/factory.js";

describe("createAndVerifyAdapter", () => {
	test("Phase 1: throws with clear message — not yet implemented", async () => {
		await expect(
			createAndVerifyAdapter({
				author: { model: "anthropic/claude-sonnet-4-6" },
				reviewer: { model: "anthropic/claude-haiku" },
			}),
		).rejects.toThrow("OpenCode adapter not yet implemented");
	});

	test("Phase 1: accepts any config shape", async () => {
		// Factory should accept any config without throwing until actual implementation
		await expect(
			createAndVerifyAdapter({
				author: { model: "test-author" },
				reviewer: { model: "test-reviewer" },
			}),
		).rejects.toThrow("OpenCode adapter not yet implemented");
	});
});

describe("createAdapter (deprecated)", () => {
	test("throws with deprecation message", () => {
		expect(() => createAdapter()).toThrow("deprecated");
	});
});
