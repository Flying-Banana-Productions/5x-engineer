/**
 * Schema probe test for Claude Code `--output-format json`.
 *
 * This test invokes the real `claude` CLI with a trivial prompt and validates
 * that the JSON output contains the fields the adapter depends on. If Claude
 * Code changes its JSON schema, this test fails loudly.
 *
 * Only *required* fields (`type`, `result`) are hard-asserted. Optional fields
 * (`usage`, `total_cost_usd`, `session_id`, etc.) are validated for type
 * correctness only when present. This keeps the probe useful for detecting
 * drift without failing on legitimately optional upstream fields.
 *
 * **Env-gated:** only runs when `FIVE_X_TEST_LIVE_AGENTS=1` is set.
 */

import { describe, expect, test } from "bun:test";

const LIVE = process.env.FIVE_X_TEST_LIVE_AGENTS === "1";

describe.skipIf(!LIVE)("Claude Code JSON schema probe", () => {
	test("--output-format json contains required fields", async () => {
		const proc = Bun.spawn(
			[
				"claude",
				"-p",
				"Reply with exactly: probe-ok",
				"--output-format",
				"json",
				"--max-turns",
				"1",
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();

		expect(exitCode).toBe(0);

		const json = JSON.parse(stdout.trim());

		// --- Required fields (adapter correctness depends on these) ---
		expect(json).toHaveProperty("type");
		expect(json.type).toBe("result");

		expect(json).toHaveProperty("result");
		expect(typeof json.result).toBe("string");

		// --- Optional fields: validate type if present ---

		if ("duration_ms" in json) {
			expect(typeof json.duration_ms).toBe("number");
		}

		if ("session_id" in json) {
			expect(typeof json.session_id).toBe("string");
		}

		if ("usage" in json && json.usage != null) {
			if ("input_tokens" in json.usage) {
				expect(typeof json.usage.input_tokens).toBe("number");
			}
			if ("output_tokens" in json.usage) {
				expect(typeof json.usage.output_tokens).toBe("number");
			}
		}

		if ("total_cost_usd" in json) {
			expect(typeof json.total_cost_usd).toBe("number");
		}

		if ("is_error" in json) {
			expect(typeof json.is_error).toBe("boolean");
		}

		// subtype: just check type if present (string)
		if ("subtype" in json) {
			expect(typeof json.subtype).toBe("string");
		}
	}, 60_000); // 60s timeout for real API call
});
