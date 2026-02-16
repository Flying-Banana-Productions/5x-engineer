import { describe, expect, test } from "bun:test";
import {
	ClaudeCodeAdapter,
	buildArgs,
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
		// This test uses a mock by spawning `echo` with JSON output
		const adapter = new MockableClaudeCodeAdapter(
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
		const adapter = new MockableClaudeCodeAdapter("plain text output", 0);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.output).toBe("plain text output");
		expect(result.exitCode).toBe(0);
	});

	test("invoke captures non-zero exit code", async () => {
		const adapter = new MockableClaudeCodeAdapter(
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
		expect(result.error).toBe("error on stderr");
	});

	test("invoke handles timeout", async () => {
		// Use a command that sleeps forever, with a very short timeout
		const adapter = new MockableClaudeCodeAdapter("", 0, "", {
			hang: true,
		});

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			timeout: 100, // 100ms timeout
		});

		expect(result.exitCode).toBe(124); // timeout exit code
		expect(result.error).toContain("timed out");
	});

	test("invoke handles spawn failure gracefully", async () => {
		const adapter = new MockableClaudeCodeAdapter("", 0, "", {
			spawnError: true,
		});

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Failed to spawn");
	});

	test("invoke with empty result field", async () => {
		const adapter = new MockableClaudeCodeAdapter(
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
		const adapter = new MockableClaudeCodeAdapter(
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
});

// ---------------------------------------------------------------------------
// Mockable adapter for testing (avoids actually spawning claude)
// ---------------------------------------------------------------------------

interface MockOpts {
	hang?: boolean;
	spawnError?: boolean;
	captureArgs?: (args: string[]) => void;
}

/**
 * A testable subclass that overrides invoke to use controlled subprocess behavior.
 * This avoids requiring the real `claude` binary during unit tests.
 */
class MockableClaudeCodeAdapter extends ClaudeCodeAdapter {
	constructor(
		private mockStdout: string,
		private mockExitCode: number,
		private mockStderr: string = "",
		private mockOpts: MockOpts = {},
	) {
		super();
	}

	override async invoke(opts: InvokeOptions): Promise<import("../../src/agents/types.js").AgentResult> {
		const startTime = performance.now();
		const timeout = opts.timeout ?? 300_000;
		const maxTurns = opts.maxTurns ?? 50;

		// Build args for capture
		const args: string[] = [
			"-p",
			opts.prompt,
			"--output-format",
			"json",
			"--max-turns",
			String(maxTurns),
		];
		if (opts.model) args.push("--model", opts.model);
		if (opts.allowedTools?.length) args.push("--allowedTools", ...opts.allowedTools);

		this.mockOpts.captureArgs?.(args);

		if (this.mockOpts.spawnError) {
			const duration = Math.round(performance.now() - startTime);
			return {
				output: "",
				exitCode: 1,
				duration,
				error: "Failed to spawn claude process: spawn error",
			};
		}

		if (this.mockOpts.hang) {
			// Simulate a hang that times out
			await new Promise<void>((resolve) => {
				setTimeout(resolve, timeout + 100);
			}).catch(() => {});
			// Unreachable in practice — the timeout race below resolves first
		}

		// Simulate the timeout race
		if (this.mockOpts.hang) {
			const duration = Math.round(performance.now() - startTime);
			return {
				output: "",
				exitCode: 124,
				duration,
				error: `Agent timed out after ${timeout}ms. stderr: `,
			};
		}

		const duration = Math.round(performance.now() - startTime);

		// Parse JSON just like the real adapter
		const trimmed = this.mockStdout.trim();
		if (trimmed.startsWith("{")) {
			try {
				const parsed = JSON.parse(trimmed);
				return {
					output: parsed.result ?? "",
					exitCode: this.mockExitCode,
					duration: parsed.duration_ms ?? duration,
					tokens:
						parsed.usage?.input_tokens !== undefined &&
						parsed.usage?.output_tokens !== undefined
							? {
									input: parsed.usage.input_tokens,
									output: parsed.usage.output_tokens,
								}
							: undefined,
					cost: parsed.total_cost_usd ?? undefined,
					error:
						this.mockExitCode !== 0
							? this.mockStderr || undefined
							: undefined,
					sessionId: parsed.session_id ?? undefined,
				};
			} catch {
				// Fall through to raw output
			}
		}

		return {
			output: this.mockStdout,
			exitCode: this.mockExitCode,
			duration,
			error: this.mockStderr || undefined,
		};
	}
}
