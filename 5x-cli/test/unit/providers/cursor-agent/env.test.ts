import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildSubprocessEnv } from "../../../../packages/provider-cursor-agent/src/env.js";

describe("buildSubprocessEnv", () => {
	const originalApiKey = process.env.CURSOR_API_KEY;
	const originalAuthToken = process.env.CURSOR_AUTH_TOKEN;

	beforeEach(() => {
		process.env.CURSOR_API_KEY = "ambient-key";
		process.env.CURSOR_AUTH_TOKEN = "ambient-token";
	});

	afterEach(() => {
		if (originalApiKey === undefined) {
			delete process.env.CURSOR_API_KEY;
		} else {
			process.env.CURSOR_API_KEY = originalApiKey;
		}
		if (originalAuthToken === undefined) {
			delete process.env.CURSOR_AUTH_TOKEN;
		} else {
			process.env.CURSOR_AUTH_TOKEN = originalAuthToken;
		}
	});

	test("preserves ambient env vars", () => {
		const env = buildSubprocessEnv();
		expect(env.CURSOR_API_KEY).toBe("ambient-key");
		expect(env.CURSOR_AUTH_TOKEN).toBe("ambient-token");
		expect(env.PATH).toBe(process.env.PATH);
	});

	test("injects configured apiKey as CURSOR_API_KEY", () => {
		const env = buildSubprocessEnv({ apiKey: "cfg-key" });
		expect(env.CURSOR_API_KEY).toBe("cfg-key");
	});

	test("injects configured authToken as CURSOR_AUTH_TOKEN", () => {
		const env = buildSubprocessEnv({ authToken: "cfg-token" });
		expect(env.CURSOR_AUTH_TOKEN).toBe("cfg-token");
	});

	test("empty secret strings are treated as unset", () => {
		const env = buildSubprocessEnv({ apiKey: "", authToken: "" });
		expect(env.CURSOR_API_KEY).toBe("ambient-key");
		expect(env.CURSOR_AUTH_TOKEN).toBe("ambient-token");
	});

	test("does not mutate process.env", () => {
		const beforeKey = process.env.CURSOR_API_KEY;
		const beforeToken = process.env.CURSOR_AUTH_TOKEN;
		buildSubprocessEnv({ apiKey: "new-key", authToken: "new-token" });
		expect(process.env.CURSOR_API_KEY).toBe(beforeKey);
		expect(process.env.CURSOR_AUTH_TOKEN).toBe(beforeToken);
	});
});
