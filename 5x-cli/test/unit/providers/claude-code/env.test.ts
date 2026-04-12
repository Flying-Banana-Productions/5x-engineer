import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildSubprocessEnv } from "../../../../packages/provider-claude-code/src/env.js";

describe("buildSubprocessEnv", () => {
	const originalApiKey = process.env.ANTHROPIC_API_KEY;
	const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;

	beforeEach(() => {
		process.env.ANTHROPIC_API_KEY = "sk-ambient-key";
		process.env.ANTHROPIC_AUTH_TOKEN = "ambient-bearer-token";
	});

	afterEach(() => {
		if (originalApiKey === undefined) {
			delete process.env.ANTHROPIC_API_KEY;
		} else {
			process.env.ANTHROPIC_API_KEY = originalApiKey;
		}
		if (originalAuthToken === undefined) {
			delete process.env.ANTHROPIC_AUTH_TOKEN;
		} else {
			process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
		}
	});

	test("strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN by default", () => {
		const env = buildSubprocessEnv();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	test("preserves other env vars (e.g. PATH, HOME)", () => {
		const env = buildSubprocessEnv();
		expect(env.PATH).toBe(process.env.PATH);
		if (process.env.HOME !== undefined) {
			expect(env.HOME).toBe(process.env.HOME);
		}
	});

	test("forwards apiKey as ANTHROPIC_API_KEY when provided", () => {
		const env = buildSubprocessEnv("sk-opt-in-key");
		expect(env.ANTHROPIC_API_KEY).toBe("sk-opt-in-key");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	test("overrides ambient ANTHROPIC_API_KEY when apiKey provided", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ambient-key";
		const env = buildSubprocessEnv("sk-config-key");
		expect(env.ANTHROPIC_API_KEY).toBe("sk-config-key");
	});

	test("empty apiKey string is treated as unset", () => {
		const env = buildSubprocessEnv("");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	test("does not mutate process.env", () => {
		const before = process.env.ANTHROPIC_API_KEY;
		buildSubprocessEnv("sk-foo");
		expect(process.env.ANTHROPIC_API_KEY).toBe(before);
	});
});
