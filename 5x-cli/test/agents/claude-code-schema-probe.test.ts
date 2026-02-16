/**
 * Schema probe test for Claude Code `--output-format json`.
 *
 * This test invokes the real `claude` CLI with a trivial prompt and validates
 * that the JSON output contains the fields the adapter depends on. If Claude
 * Code changes its JSON schema, this test fails loudly.
 *
 * **Env-gated:** only runs when `FIVE_X_TEST_LIVE_AGENTS=1` is set.
 */

import { describe, expect, test } from "bun:test";

const LIVE = process.env.FIVE_X_TEST_LIVE_AGENTS === "1";

describe.skipIf(!LIVE)("Claude Code JSON schema probe", () => {
	test(
		"--output-format json contains required fields",
		async () => {
			const proc = Bun.spawn(
				["claude", "-p", "Reply with exactly: probe-ok", "--output-format", "json", "--max-turns", "1"],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);

			const exitCode = await proc.exited;
			const stdout = await new Response(proc.stdout).text();

			expect(exitCode).toBe(0);

			const json = JSON.parse(stdout.trim());

			// Required fields the adapter depends on
			expect(json).toHaveProperty("type");
			expect(json.type).toBe("result");

			expect(json).toHaveProperty("result");
			expect(typeof json.result).toBe("string");

			// Fields we use for display/logging
			expect(json).toHaveProperty("duration_ms");
			expect(typeof json.duration_ms).toBe("number");

			expect(json).toHaveProperty("session_id");
			expect(typeof json.session_id).toBe("string");

			// Token usage
			expect(json).toHaveProperty("usage");
			expect(json.usage).toHaveProperty("input_tokens");
			expect(json.usage).toHaveProperty("output_tokens");
			expect(typeof json.usage.input_tokens).toBe("number");
			expect(typeof json.usage.output_tokens).toBe("number");

			// Cost
			expect(json).toHaveProperty("total_cost_usd");
			expect(typeof json.total_cost_usd).toBe("number");

			// Error indicator
			expect(json).toHaveProperty("is_error");
			expect(typeof json.is_error).toBe("boolean");

			// Subtype
			expect(json).toHaveProperty("subtype");
		},
		60_000,
	); // 60s timeout for real API call
});
