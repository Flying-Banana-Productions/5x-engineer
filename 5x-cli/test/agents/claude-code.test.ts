import { describe, expect, test } from "bun:test";
import type { SpawnHandle } from "../../src/agents/claude-code.js";
import {
	buildArgs,
	ClaudeCodeAdapter,
	MAX_PROMPT_LENGTH,
	parseJsonOutput,
} from "../../src/agents/claude-code.js";
import type { InvokeOptions } from "../../src/agents/types.js";

// ---------------------------------------------------------------------------
// buildArgs
// ---------------------------------------------------------------------------

describe("buildArgs", () => {
	test("builds minimal args", () => {
		const opts: InvokeOptions = {
			prompt: "say hello",
			workdir: "/tmp",
		};
		const args = buildArgs(opts, 50);
		expect(args).toEqual([
			"-p",
			"say hello",
			"--output-format",
			"json",
			"--max-turns",
			"50",
		]);
	});

	test("includes model when specified", () => {
		const opts: InvokeOptions = {
			prompt: "test",
			workdir: "/tmp",
			model: "claude-opus-4-6",
		};
		const args = buildArgs(opts, 50);
		expect(args).toContain("--model");
		expect(args).toContain("claude-opus-4-6");
	});

	test("includes allowedTools when specified", () => {
		const opts: InvokeOptions = {
			prompt: "test",
			workdir: "/tmp",
			allowedTools: ["Bash(git:*)", "Edit"],
		};
		const args = buildArgs(opts, 30);
		expect(args).toContain("--allowedTools");
		expect(args).toContain("Bash(git:*)");
		expect(args).toContain("Edit");
	});

	test("respects custom maxTurns", () => {
		const opts: InvokeOptions = {
			prompt: "test",
			workdir: "/tmp",
		};
		const args = buildArgs(opts, 10);
		expect(args).toContain("--max-turns");
		expect(args).toContain("10");
	});
});

// ---------------------------------------------------------------------------
// parseJsonOutput
// ---------------------------------------------------------------------------

describe("parseJsonOutput", () => {
	test("parses valid Claude Code JSON output", () => {
		const json = JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "Hello world!",
			duration_ms: 1500,
			total_cost_usd: 0.025,
			session_id: "abc-123",
			usage: {
				input_tokens: 100,
				output_tokens: 50,
			},
		});
		const parsed = parseJsonOutput(json);
		expect(parsed).not.toBeNull();
		expect(parsed?.result).toBe("Hello world!");
		expect(parsed?.duration_ms).toBe(1500);
		expect(parsed?.total_cost_usd).toBe(0.025);
		expect(parsed?.session_id).toBe("abc-123");
		expect(parsed?.usage?.input_tokens).toBe(100);
		expect(parsed?.usage?.output_tokens).toBe(50);
	});

	test("handles output with extra unknown fields", () => {
		const json = JSON.stringify({
			type: "result",
			result: "Hello",
			duration_ms: 1000,
			some_new_field: "unknown",
			nested: { deep: true },
		});
		const parsed = parseJsonOutput(json);
		expect(parsed).not.toBeNull();
		expect(parsed?.result).toBe("Hello");
	});

	test("returns null for non-JSON output", () => {
		expect(parseJsonOutput("just some text")).toBeNull();
		expect(parseJsonOutput("")).toBeNull();
		expect(parseJsonOutput("   ")).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		expect(parseJsonOutput("{invalid json")).toBeNull();
	});

	test("warns but still returns when result field is missing", () => {
		// Capture console.warn
		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		try {
			const json = JSON.stringify({
				type: "result",
				duration_ms: 500,
			});
			const parsed = parseJsonOutput(json);
			expect(parsed).not.toBeNull();
			expect(parsed?.duration_ms).toBe(500);
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain("missing expected fields");
			expect(warnings[0]).toContain("result");
		} finally {
			console.warn = origWarn;
		}
	});

	test("parses output with is_error=true", () => {
		const json = JSON.stringify({
			type: "result",
			subtype: "error_max_turns",
			is_error: true,
			result: "Ran out of turns",
			duration_ms: 60000,
		});
		const parsed = parseJsonOutput(json);
		expect(parsed).not.toBeNull();
		expect(parsed?.is_error).toBe(true);
		expect(parsed?.subtype).toBe("error_max_turns");
		expect(parsed?.result).toBe("Ran out of turns");
	});

	test("handles result with 5x signal blocks", () => {
		const resultText = `I've completed the implementation.

<!-- 5x:status
protocolVersion: 1
result: completed
commit: abc123
phase: 1
summary: Implemented the feature
-->`;
		const json = JSON.stringify({
			type: "result",
			result: resultText,
			duration_ms: 5000,
		});
		const parsed = parseJsonOutput(json);
		expect(parsed?.result).toBe(resultText);
		expect(parsed?.result).toContain("5x:status");
	});
});

// ---------------------------------------------------------------------------
// ClaudeCodeAdapter — unit tests (mocked subprocess)
// ---------------------------------------------------------------------------

describe("ClaudeCodeAdapter", () => {
	test("has correct name", () => {
		const adapter = new ClaudeCodeAdapter();
		expect(adapter.name).toBe("claude-code");
	});

	test("invoke returns structured result from valid JSON output", async () => {
		const adapter = createMock(
			JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				result: "Test output",
				duration_ms: 1234,
				total_cost_usd: 0.01,
				session_id: "sess-abc",
				usage: {
					input_tokens: 200,
					output_tokens: 30,
				},
			}),
			0,
		);

		const result = await adapter.invoke({
			prompt: "test prompt",
			workdir: "/tmp",
		});

		expect(result.output).toBe("Test output");
		expect(result.exitCode).toBe(0);
		expect(result.duration).toBeGreaterThan(0);
		expect(result.tokens).toEqual({ input: 200, output: 30 });
		expect(result.cost).toBe(0.01);
		expect(result.sessionId).toBe("sess-abc");
	});

	test("invoke handles non-JSON output gracefully", async () => {
		const adapter = createMock("plain text output", 0);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.output).toBe("plain text output");
		expect(result.exitCode).toBe(0);
	});

	test("invoke captures non-zero exit code with is_error", async () => {
		const adapter = createMock(
			JSON.stringify({
				type: "result",
				subtype: "error",
				is_error: true,
				result: "Something went wrong",
				duration_ms: 500,
			}),
			1,
			"error on stderr",
		);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(1);
		expect(result.output).toBe("Something went wrong");
		expect(result.error).toContain("error on stderr");
	});

	test("invoke maps is_error=true to non-zero exitCode even when process exits 0", async () => {
		const adapter = createMock(
			JSON.stringify({
				type: "result",
				subtype: "error_max_turns",
				is_error: true,
				result: "Ran out of turns",
				duration_ms: 60000,
			}),
			0, // process exits 0
		);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		// is_error=true should override the 0 exit code
		expect(result.exitCode).toBe(1);
		expect(result.output).toBe("Ran out of turns");
		expect(result.error).toContain("error_max_turns");
	});

	test("invoke handles timeout", async () => {
		const adapter = createMock("", 0, "", { hang: true });

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			timeout: 100, // 100ms timeout
		});

		expect(result.exitCode).toBe(124); // timeout exit code
		expect(result.error).toContain("timed out");
	});

	test("invoke handles spawn failure gracefully", async () => {
		const adapter = createMock("", 0, "", { spawnError: true });

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Failed to spawn");
	});

	test("invoke with empty result field", async () => {
		const adapter = createMock(
			JSON.stringify({
				type: "result",
				result: "",
				duration_ms: 100,
			}),
			0,
		);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.output).toBe("");
		expect(result.exitCode).toBe(0);
	});

	test("invoke passes model and maxTurns to args", async () => {
		let capturedArgs: string[] = [];
		const adapter = createMock(
			JSON.stringify({ type: "result", result: "ok", duration_ms: 100 }),
			0,
			"",
			{
				captureArgs: (args: string[]) => {
					capturedArgs = args;
				},
			},
		);

		await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			model: "claude-sonnet-4-20250514",
			maxTurns: 25,
		});

		expect(capturedArgs).toContain("--model");
		expect(capturedArgs).toContain("claude-sonnet-4-20250514");
		expect(capturedArgs).toContain("--max-turns");
		expect(capturedArgs).toContain("25");
	});

	test("invoke rejects prompts exceeding MAX_PROMPT_LENGTH", async () => {
		const adapter = createMock(
			JSON.stringify({ type: "result", result: "ok" }),
			0,
		);

		const result = await adapter.invoke({
			prompt: "x".repeat(MAX_PROMPT_LENGTH + 1),
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("MAX_PROMPT_LENGTH");
	});
});

// ---------------------------------------------------------------------------
// Mockable adapter for testing — injects at the spawn boundary
// ---------------------------------------------------------------------------

interface MockOpts {
	hang?: boolean;
	spawnError?: boolean;
	captureArgs?: (args: string[]) => void;
}

/**
 * Helper to create a ReadableStream from a string.
 */
function stringStream(s: string): ReadableStream<Uint8Array> {
	const encoded = new TextEncoder().encode(s);
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoded);
			controller.close();
		},
	});
}

/**
 * Create a test adapter that overrides only `spawnProcess` so that the real
 * `invoke()` logic (JSON parsing, is_error handling, timeout, etc.) is
 * exercised. This avoids duplicating parsing/arg-building in the mock.
 */
function createMock(
	mockStdout: string,
	mockExitCode: number,
	mockStderr = "",
	mockOpts: MockOpts = {},
): ClaudeCodeAdapter {
	return new (class extends ClaudeCodeAdapter {
		protected override spawnProcess(
			args: string[],
			_opts: { cwd: string },
		): SpawnHandle {
			mockOpts.captureArgs?.(args);

			if (mockOpts.spawnError) {
				throw new Error("spawn error");
			}

			if (mockOpts.hang) {
				// Never-resolving exited promise simulates a hung process
				return {
					exited: new Promise<number>(() => {}),
					stdout: stringStream(""),
					stderr: stringStream(""),
					kill: () => {},
				};
			}

			return {
				exited: Promise.resolve(mockExitCode),
				stdout: stringStream(mockStdout),
				stderr: stringStream(mockStderr),
				kill: () => {},
			};
		}
	})();
}
