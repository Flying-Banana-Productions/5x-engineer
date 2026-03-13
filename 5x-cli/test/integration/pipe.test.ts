/**
 * Tests for src/pipe.ts — shared pipe infrastructure for reading
 * upstream 5x JSON envelopes from stdin.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { extractInvokeMetadata, extractPipeContext } from "../../src/pipe.js";
import { cleanGitEnv } from "../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// extractPipeContext
// ---------------------------------------------------------------------------

describe("extractPipeContext", () => {
	test(
		"extracts run_id, step_name, phase from data",
		() => {
			const ctx = extractPipeContext({
				run_id: "run_abc123",
				step_name: "author:implement",
				phase: "2",
			});
			expect(ctx.runId).toBe("run_abc123");
			expect(ctx.stepName).toBe("author:implement");
			expect(ctx.phase).toBe("2");
		},
		{ timeout: 15000 },
	);

	test(
		"builds templateVars from string fields only",
		() => {
			const ctx = extractPipeContext({
				plan_path: "docs/plan.md",
				phase_number: "3",
				result: { some: "object" },
				tokens: { in: 100, out: 50 },
				count: 42,
				passed: true,
				items: ["a", "b"],
			});
			// String fields become template vars
			expect(ctx.templateVars.plan_path).toBe("docs/plan.md");
			expect(ctx.templateVars.phase_number).toBe("3");
			// Non-string fields are excluded
			expect(ctx.templateVars).not.toHaveProperty("result");
			expect(ctx.templateVars).not.toHaveProperty("tokens");
			expect(ctx.templateVars).not.toHaveProperty("count");
			expect(ctx.templateVars).not.toHaveProperty("passed");
			expect(ctx.templateVars).not.toHaveProperty("items");
		},
		{ timeout: 15000 },
	);

	test(
		"skips excluded metadata keys",
		() => {
			const ctx = extractPipeContext({
				run_id: "run_abc",
				session_id: "sess_xyz",
				log_path: ".5x/logs/run_abc/agent-001.ndjson",
				cost_usd: "0.12",
				duration_ms: "45000",
				model: "anthropic/claude-sonnet-4-6",
				step_name: "author:implement",
				ok: "true",
				// This one should NOT be excluded
				plan_path: "docs/plan.md",
			});
			// Excluded keys should not appear in templateVars
			expect(ctx.templateVars).not.toHaveProperty("run_id");
			expect(ctx.templateVars).not.toHaveProperty("session_id");
			expect(ctx.templateVars).not.toHaveProperty("log_path");
			expect(ctx.templateVars).not.toHaveProperty("cost_usd");
			expect(ctx.templateVars).not.toHaveProperty("duration_ms");
			expect(ctx.templateVars).not.toHaveProperty("model");
			expect(ctx.templateVars).not.toHaveProperty("step_name");
			expect(ctx.templateVars).not.toHaveProperty("ok");
			// Non-excluded should be present
			expect(ctx.templateVars.plan_path).toBe("docs/plan.md");
		},
		{ timeout: 15000 },
	);

	test(
		"skips values with newlines",
		() => {
			const ctx = extractPipeContext({
				safe_val: "single line",
				multi_line: "line1\nline2",
			});
			expect(ctx.templateVars.safe_val).toBe("single line");
			expect(ctx.templateVars).not.toHaveProperty("multi_line");
		},
		{ timeout: 15000 },
	);

	test(
		"skips values containing -->",
		() => {
			const ctx = extractPipeContext({
				safe_val: "hello",
				arrow_val: "some --> content",
			});
			expect(ctx.templateVars.safe_val).toBe("hello");
			expect(ctx.templateVars).not.toHaveProperty("arrow_val");
		},
		{ timeout: 15000 },
	);

	test(
		"skips non-string values (objects, arrays, numbers, booleans)",
		() => {
			const ctx = extractPipeContext({
				obj: { nested: true },
				arr: [1, 2, 3],
				num: 42,
				bool: false,
				nul: null,
				str: "valid",
			});
			expect(Object.keys(ctx.templateVars)).toEqual(["str"]);
		},
		{ timeout: 15000 },
	);

	test(
		"returns empty context for empty data",
		() => {
			const ctx = extractPipeContext({});
			expect(ctx.runId).toBeUndefined();
			expect(ctx.stepName).toBeUndefined();
			expect(ctx.phase).toBeUndefined();
			expect(ctx.templateVars).toEqual({});
		},
		{ timeout: 15000 },
	);

	test(
		"ignores non-string run_id, step_name, phase",
		() => {
			const ctx = extractPipeContext({
				run_id: 123,
				step_name: true,
				phase: null,
			});
			expect(ctx.runId).toBeUndefined();
			expect(ctx.stepName).toBeUndefined();
			expect(ctx.phase).toBeUndefined();
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// extractInvokeMetadata
// ---------------------------------------------------------------------------

describe("extractInvokeMetadata", () => {
	test(
		"detects invoke shape and extracts all fields",
		() => {
			const data = {
				run_id: "run_abc123",
				step_name: "author:implement",
				phase: "1",
				model: "anthropic/claude-sonnet-4-6",
				result: { result: "complete", commit: "abc123" },
				session_id: "sess_xyz",
				duration_ms: 45000,
				tokens: { in: 8500, out: 3200 },
				cost_usd: 0.12,
				log_path: ".5x/logs/run_abc123/agent-001.ndjson",
			};

			const meta = extractInvokeMetadata(data);
			expect(meta).not.toBeNull();
			expect(meta?.result).toEqual({ result: "complete", commit: "abc123" });
			expect(meta?.sessionId).toBe("sess_xyz");
			expect(meta?.model).toBe("anthropic/claude-sonnet-4-6");
			expect(meta?.durationMs).toBe(45000);
			expect(meta?.tokensIn).toBe(8500);
			expect(meta?.tokensOut).toBe(3200);
			expect(meta?.costUsd).toBe(0.12);
			expect(meta?.logPath).toBe(".5x/logs/run_abc123/agent-001.ndjson");
		},
		{ timeout: 15000 },
	);

	test(
		"returns null for non-invoke data (quality output)",
		() => {
			const data = {
				passed: true,
				results: [
					{ command: "npm test", passed: true, duration_ms: 3000, output: "" },
				],
			};
			expect(extractInvokeMetadata(data)).toBeNull();
		},
		{ timeout: 15000 },
	);

	test(
		"returns null when result is missing",
		() => {
			const data = {
				session_id: "sess_xyz",
				duration_ms: 1000,
			};
			expect(extractInvokeMetadata(data)).toBeNull();
		},
		{ timeout: 15000 },
	);

	test(
		"returns null when result is a string (not an object)",
		() => {
			const data = {
				result: "some string",
				session_id: "sess_xyz",
			};
			expect(extractInvokeMetadata(data)).toBeNull();
		},
		{ timeout: 15000 },
	);

	test(
		"returns null when session_id is missing",
		() => {
			const data = {
				result: { result: "complete" },
				duration_ms: 1000,
			};
			expect(extractInvokeMetadata(data)).toBeNull();
		},
		{ timeout: 15000 },
	);

	test(
		"returns null when result is an array",
		() => {
			const data = {
				result: [1, 2, 3],
				session_id: "sess_xyz",
			};
			expect(extractInvokeMetadata(data)).toBeNull();
		},
		{ timeout: 15000 },
	);

	test(
		"handles missing optional fields gracefully",
		() => {
			const data = {
				result: { result: "complete" },
				session_id: "sess_xyz",
			};

			const meta = extractInvokeMetadata(data);
			expect(meta).not.toBeNull();
			expect(meta?.result).toEqual({ result: "complete" });
			expect(meta?.sessionId).toBe("sess_xyz");
			expect(meta?.model).toBeUndefined();
			expect(meta?.durationMs).toBeUndefined();
			expect(meta?.tokensIn).toBeUndefined();
			expect(meta?.tokensOut).toBeUndefined();
			expect(meta?.costUsd).toBeUndefined();
			expect(meta?.logPath).toBeUndefined();
		},
		{ timeout: 15000 },
	);

	test(
		"handles cost_usd: null (not a number)",
		() => {
			const data = {
				result: { result: "complete" },
				session_id: "sess_xyz",
				cost_usd: null,
			};
			const meta = extractInvokeMetadata(data);
			expect(meta).not.toBeNull();
			expect(meta?.costUsd).toBeUndefined();
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// readUpstreamEnvelope — integration tests via subprocess
// ---------------------------------------------------------------------------

describe("readUpstreamEnvelope", () => {
	// Note: readUpstreamEnvelope reads from stdin which requires subprocess testing.
	// We test it via Bun.spawn piping JSON into a helper script file.

	const HELPER_PATH = join(
		import.meta.dir,
		"../helpers",
		"pipe-read-helper.ts",
	);

	async function runWithStdin(
		input: string,
	): Promise<{ ok: boolean; result?: unknown; error?: string }> {
		const proc = Bun.spawn(["bun", "run", HELPER_PATH], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: cleanGitEnv(),
		});
		proc.stdin.write(input);
		proc.stdin.end();
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return JSON.parse(stdout.trim());
	}

	test(
		"parses valid invoke envelope",
		async () => {
			const envelope = JSON.stringify({
				ok: true,
				data: {
					run_id: "run_abc",
					step_name: "author:implement",
					result: { result: "complete" },
					session_id: "sess_1",
				},
			});
			const out = await runWithStdin(envelope);
			expect(out.ok).toBe(true);
			expect(out.result).not.toBeNull();
			const r = out.result as { data: Record<string, unknown> };
			expect(r.data.run_id).toBe("run_abc");
		},
		{ timeout: 15000 },
	);

	test(
		"parses valid non-invoke envelope (quality)",
		async () => {
			const envelope = JSON.stringify({
				ok: true,
				data: {
					passed: true,
					results: [],
				},
			});
			const out = await runWithStdin(envelope);
			expect(out.ok).toBe(true);
			const r = out.result as { data: Record<string, unknown> };
			expect(r.data.passed).toBe(true);
		},
		{ timeout: 15000 },
	);

	test(
		"throws on invalid JSON",
		async () => {
			const out = await runWithStdin("not json at all");
			expect(out.ok).toBe(false);
			expect(out.error).toContain("invalid JSON");
		},
		{ timeout: 15000 },
	);

	test(
		"throws on error envelope (ok: false)",
		async () => {
			const envelope = JSON.stringify({
				ok: false,
				error: { code: "SOME_ERROR", message: "Something went wrong" },
			});
			const out = await runWithStdin(envelope);
			expect(out.ok).toBe(false);
			expect(out.error).toContain("SOME_ERROR");
			expect(out.error).toContain("Something went wrong");
		},
		{ timeout: 15000 },
	);

	test(
		"returns null when stdin is TTY (no pipe)",
		async () => {
			// Validate the non-piped branch of readUpstreamEnvelope() by
			// temporarily setting process.stdin.isTTY = true and calling
			// readUpstreamEnvelope directly. This is a unit seam test.
			const { readUpstreamEnvelope } = await import("../../src/pipe.js");
			const origIsTTY = process.stdin.isTTY;
			try {
				Object.defineProperty(process.stdin, "isTTY", {
					value: true,
					configurable: true,
				});
				const result = await readUpstreamEnvelope();
				expect(result).toBeNull();
			} finally {
				Object.defineProperty(process.stdin, "isTTY", {
					value: origIsTTY,
					configurable: true,
				});
			}
		},
		{ timeout: 15000 },
	);

	test(
		"returns null on empty stdin",
		async () => {
			const out = await runWithStdin("");
			expect(out.ok).toBe(true);
			expect(out.result).toBeNull();
		},
		{ timeout: 15000 },
	);

	test(
		"throws when envelope missing ok field",
		async () => {
			const out = await runWithStdin(JSON.stringify({ data: { foo: "bar" } }));
			expect(out.ok).toBe(false);
			expect(out.error).toContain('missing "ok" field');
		},
		{ timeout: 15000 },
	);
});
