import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type {
	NdjsonResult,
	RaceResult,
	SpawnHandle,
} from "../../src/agents/claude-code.js";
import {
	BOUNDED_FALLBACK_LIMIT,
	buildArgs,
	ClaudeCodeAdapter,
	MAX_LINE_BUFFER_SIZE,
	MAX_PROMPT_LENGTH,
	MAX_STDERR_SIZE,
	parseJsonOutput,
} from "../../src/agents/claude-code.js";
import type { InvokeOptions } from "../../src/agents/types.js";

// ---------------------------------------------------------------------------
// NDJSON test helpers
// ---------------------------------------------------------------------------

/** Serialize an array of event objects into a newline-delimited JSON string. */
function makeNdjson(...events: object[]): string {
	return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** Build a standard `type: "result"` event, with sensible defaults. */
function makeResultEvent(
	result: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result,
		duration_ms: 1234,
		total_cost_usd: 0.01,
		session_id: "sess-abc",
		usage: { input_tokens: 200, output_tokens: 30 },
		...overrides,
	};
}

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
			"stream-json",
			"--verbose",
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
		const warnings: string[] = [];
		const json = JSON.stringify({
			type: "result",
			duration_ms: 500,
		});
		const parsed = parseJsonOutput(json, (msg) => warnings.push(msg));
		expect(parsed).not.toBeNull();
		expect(parsed?.duration_ms).toBe(500);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("missing expected fields");
		expect(warnings[0]).toContain("result");
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

	test("invoke returns structured result from NDJSON stream", async () => {
		const adapter = createMock(
			makeNdjson(
				{ type: "system", subtype: "init", model: "claude-opus-4-6" },
				makeResultEvent("Test output"),
			),
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

		// No result event found — falls back to bounded content
		expect(result.output).toBe("plain text output");
		expect(result.exitCode).toBe(0);
	});

	test("invoke captures non-zero exit code with is_error", async () => {
		const adapter = createMock(
			makeNdjson(
				makeResultEvent("Something went wrong", {
					subtype: "error",
					is_error: true,
				}),
			),
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
			makeNdjson(
				makeResultEvent("Ran out of turns", {
					subtype: "error_max_turns",
					is_error: true,
					duration_ms: 60000,
				}),
			),
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
		const adapter = createMock("", 0, "", { timeout: true });

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
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
			makeNdjson(makeResultEvent("", { duration_ms: 100 })),
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
			makeNdjson(makeResultEvent("ok", { duration_ms: 100 })),
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

	test("invoke rejects prompts exceeding MAX_PROMPT_LENGTH (byte-based)", async () => {
		const adapter = createMock(makeNdjson(makeResultEvent("ok")), 0);

		// ASCII: 1 byte per char
		const result = await adapter.invoke({
			prompt: "x".repeat(MAX_PROMPT_LENGTH + 1),
			workdir: "/tmp",
		});
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("MAX_PROMPT_LENGTH");
		expect(result.error).toContain("bytes");

		// Multi-byte: emoji is 4 bytes, so fewer chars needed to exceed limit
		const emoji = "\u{1F600}"; // 4 bytes in UTF-8
		const count = Math.ceil(MAX_PROMPT_LENGTH / 4) + 1;
		const result2 = await adapter.invoke({
			prompt: emoji.repeat(count),
			workdir: "/tmp",
		});
		expect(result2.exitCode).toBe(1);
		expect(result2.error).toContain("MAX_PROMPT_LENGTH");
	});

	test("invoke always populates error on non-zero exitCode (NDJSON path)", async () => {
		// exitCode=2, no stderr, no is_error/subtype — should still get error
		const adapter = createMock(
			makeNdjson(
				makeResultEvent("partial output", {
					duration_ms: 100,
					subtype: undefined,
					is_error: undefined,
				}),
			),
			2,
		);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(2);
		expect(result.error).toBeDefined();
		expect(result.error).toContain("exit code 2");
	});

	test("invoke always populates error on non-zero exitCode (non-JSON path)", async () => {
		const adapter = createMock("raw output", 3);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(3);
		expect(result.error).toBeDefined();
		expect(result.error).toContain("exit code 3");
	});

	test("invoke includes subtype in error even without is_error flag", async () => {
		const adapter = createMock(
			makeNdjson(
				makeResultEvent("tool failed", {
					subtype: "error_tool_use",
					is_error: false,
					duration_ms: 100,
				}),
			),
			1,
		);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("error_tool_use");
	});

	test("timeout path with hanging streams: boundedDrain aborts reader and returns", async () => {
		// Streams never close — simulates a hung process whose streams remain
		// open after SIGTERM/SIGKILL. The mocked boundedDrain aborts immediately
		// so there are no real timers.
		const adapter = createMock("", 0, "", {
			timeout: true,
			hangingStreams: true,
		});

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(124);
		expect(result.error).toContain("timed out");
	});

	// -------------------------------------------------------------------------
	// logStream
	// -------------------------------------------------------------------------

	test("logStream receives each NDJSON line written during streaming", async () => {
		const events = [
			{ type: "system", subtype: "init", model: "claude-opus-4-6" },
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Working..." }] },
			},
			makeResultEvent("Done"),
		];
		const ndjson = makeNdjson(...events);

		const logStream = new PassThrough();
		const chunks: string[] = [];
		logStream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

		const adapter = createMock(ndjson, 0);
		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			logStream,
		});

		expect(result.output).toBe("Done");
		const fullLog = chunks.join("");
		// Each original event line should appear in the log
		expect(fullLog).toContain(JSON.stringify(events[0]));
		expect(fullLog).toContain(JSON.stringify(events[1]));
		expect(fullLog).toContain(JSON.stringify(events[2]));
	});

	test("logStream write error is non-fatal — adapter continues and returns result", async () => {
		const ndjson = makeNdjson(makeResultEvent("Done"));

		// A logStream that always throws on write
		const badLogStream = {
			write() {
				throw new Error("disk full");
			},
		} as unknown as NodeJS.WritableStream;

		const warnings: string[] = [];
		const adapter = createMock(ndjson, 0, "", {
			captureWarnings: (msg) => warnings.push(msg),
		});
		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			logStream: badLogStream,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("Done");
		expect(warnings.some((w) => w.includes("logStream write failed"))).toBe(
			true,
		);
	});

	// -------------------------------------------------------------------------
	// onEvent
	// -------------------------------------------------------------------------

	test("onEvent is called per line with parsed event object and raw line", async () => {
		const events = [
			{ type: "system", subtype: "init", model: "claude-opus-4-6" },
			makeResultEvent("Done"),
		];
		const ndjson = makeNdjson(...events);

		const received: { event: unknown; rawLine: string }[] = [];
		const adapter = createMock(ndjson, 0);

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			onEvent: (event, rawLine) => {
				received.push({ event, rawLine });
			},
		});

		expect(result.output).toBe("Done");
		expect(received).toHaveLength(2);
		expect((received[0]?.event as Record<string, unknown>).type).toBe("system");
		expect(received[0]?.rawLine).toBe(JSON.stringify(events[0]));
		expect((received[1]?.event as Record<string, unknown>).type).toBe("result");
	});

	test("onEvent is not called for non-JSON lines", async () => {
		// Mix of valid JSON and non-JSON
		const ndjson = `not json at all\n${JSON.stringify(makeResultEvent("Done"))}\n`;

		let callCount = 0;
		const adapter = createMock(ndjson, 0);

		await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			onEvent: () => {
				callCount++;
			},
		});

		// Only the valid JSON line triggers onEvent
		expect(callCount).toBe(1);
	});

	test("onEvent exception is non-fatal — adapter continues and returns result", async () => {
		const events = [
			{ type: "system", subtype: "init", model: "claude-opus-4-6" },
			makeResultEvent("Done"),
		];
		const ndjson = makeNdjson(...events);

		let callCount = 0;
		const warnings: string[] = [];
		const adapter = createMock(ndjson, 0, "", {
			captureWarnings: (msg) => warnings.push(msg),
		});
		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			onEvent: () => {
				callCount++;
				throw new Error("formatter crash");
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("Done");
		// Called once, then disabled after the first throw
		expect(callCount).toBe(1);
		expect(warnings.some((w) => w.includes("onEvent callback threw"))).toBe(
			true,
		);
	});

	// -------------------------------------------------------------------------
	// Bounded memory
	// -------------------------------------------------------------------------

	test("bounded fallback does not accumulate more than BOUNDED_FALLBACK_LIMIT bytes", async () => {
		// Large stdout with many lines but no result event — process exits non-zero
		const manyLines = `${Array.from(
			{ length: 5_000 },
			(_, i) => `{"type":"data","line":${i}}`,
		).join("\n")}\n`;

		const adapter = createMock(manyLines, 1);
		const result = await adapter.invoke({ prompt: "test", workdir: "/tmp" });

		// No result event → output is boundedFallback
		expect(result.exitCode).toBe(1);
		// Output must not exceed the fallback limit (with a small tolerance for
		// chunk alignment at the boundary)
		expect(result.output.length).toBeLessThanOrEqual(
			BOUNDED_FALLBACK_LIMIT + 200,
		);
	});

	// -------------------------------------------------------------------------
	// Timeout with AbortController cancellation
	// -------------------------------------------------------------------------

	test("timeout with partial NDJSON: reader is cancelled and partial data returned", async () => {
		// Stream emits one NDJSON line then hangs — no result event.
		// The mocked raceWithTimeout/killWithEscalation/boundedDrain ensure
		// the timeout path executes without real timers.
		const partialNdjson = `${JSON.stringify({ type: "system", subtype: "init" })}\n`;

		const adapter = createMock(partialNdjson, 0, "", {
			timeout: true,
			partialStream: true,
		});

		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
		});

		expect(result.exitCode).toBe(124);
		expect(result.error).toContain("timed out");
		// Partial NDJSON line should appear in bounded fallback
		expect(result.output).toContain('"type":"system"');
	});

	// -------------------------------------------------------------------------
	// P0.1: Line-buffer bounding (degraded mode)
	// -------------------------------------------------------------------------

	test("huge single NDJSON line triggers degraded mode then recovers for result event", async () => {
		// Degraded mode triggers when a PARTIAL line (no terminating newline)
		// exceeds MAX_LINE_BUFFER_SIZE. We simulate this with a multi-chunk
		// stream: chunk 1 has a normal init line + the start of a huge line
		// (no trailing newline), chunk 2 has the rest of the huge line + newline
		// + a result event. The adapter should degrade on the huge partial line
		// but recover and parse the result event.
		const initEvent = JSON.stringify({
			type: "system",
			subtype: "init",
			model: "test",
		});
		const hugePayload = "x".repeat(MAX_LINE_BUFFER_SIZE + 100);
		const resultEvent = JSON.stringify(makeResultEvent("Recovered"));

		// Chunk 1: complete init line + start of huge line (no trailing \n)
		const chunk1 = `${initEvent}\n${hugePayload}`;
		// Chunk 2: trailing newline for huge line + result event
		const chunk2 = `\n${resultEvent}\n`;

		const warnings: string[] = [];
		const adapter = createMockWithChunkedStdout([chunk1, chunk2], 0, "", {
			captureWarnings: (msg) => warnings.push(msg),
		});
		const result = await adapter.invoke({ prompt: "test", workdir: "/tmp" });

		// Should have recovered and parsed the result event
		expect(result.output).toBe("Recovered");
		expect(result.exitCode).toBe(0);
		// Should have emitted a degraded-mode warning
		expect(warnings.some((w) => w.includes("entering degraded mode"))).toBe(
			true,
		);
	});

	test("logStream still receives bytes during degraded mode", async () => {
		const initEvent = JSON.stringify({ type: "system", subtype: "init" });
		const hugePayload = "y".repeat(MAX_LINE_BUFFER_SIZE + 50);
		const resultEvent = JSON.stringify(makeResultEvent("Done"));

		// Chunk 1: complete init + start of huge line (partial — no \n)
		const chunk1 = `${initEvent}\n${hugePayload}`;
		// Chunk 2: end of huge line + result
		const chunk2 = `\n${resultEvent}\n`;

		const logStream = new PassThrough();
		const chunks: string[] = [];
		logStream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

		const adapter = createMockWithChunkedStdout([chunk1, chunk2], 0, "", {
			captureWarnings: () => {},
		});
		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			logStream,
		});

		expect(result.output).toBe("Done");
		const fullLog = chunks.join("");
		// The init event should have been logged normally
		expect(fullLog).toContain(initEvent);
		// The huge line's raw bytes should also be teed during degraded mode
		expect(fullLog.length).toBeGreaterThan(MAX_LINE_BUFFER_SIZE);
	});

	// -------------------------------------------------------------------------
	// P0.2: Async logStream error handling
	// -------------------------------------------------------------------------

	test("logStream async error event is non-fatal — adapter continues and returns result", async () => {
		const ndjson = makeNdjson(
			{ type: "system", subtype: "init" },
			makeResultEvent("Done"),
		);

		// A logStream backed by a real EventEmitter so the defensive 'error'
		// handler can be attached by readNdjson.
		const logStream = new PassThrough();

		const warnings: string[] = [];
		const adapter = createMock(ndjson, 0, "", {
			captureWarnings: (msg) => warnings.push(msg),
		});
		const result = await adapter.invoke({
			prompt: "test",
			workdir: "/tmp",
			logStream,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("Done");

		// The defensive 'error' handler was attached during readNdjson.
		// Emit an error now — simulates an async disk error that arrives
		// after processing completes. Without the handler, this would crash.
		logStream.emit("error", new Error("disk full async"));

		expect(warnings.some((w) => w.includes("logStream error event"))).toBe(
			true,
		);
	});

	// -------------------------------------------------------------------------
	// P1.2: Bounded stderr
	// -------------------------------------------------------------------------

	test("large stderr output is bounded by MAX_STDERR_SIZE", async () => {
		const ndjson = makeNdjson(makeResultEvent("ok"));
		// Generate stderr larger than MAX_STDERR_SIZE
		const largeStderr = "E".repeat(MAX_STDERR_SIZE * 2);

		const adapter = createMock(ndjson, 1, largeStderr);
		const result = await adapter.invoke({ prompt: "test", workdir: "/tmp" });

		expect(result.exitCode).toBe(1);
		// error field includes stderr, which should be bounded
		expect(result.error).toBeDefined();
		// The stderr content in the error should not exceed MAX_STDERR_SIZE
		// (error may have prefix text, so just check it's reasonably bounded)
		expect(result.error?.length).toBeLessThanOrEqual(MAX_STDERR_SIZE + 200);
	});

	// -------------------------------------------------------------------------
	// Result extraction
	// -------------------------------------------------------------------------

	test("result event extracted from type:result NDJSON line", async () => {
		// Verify that intermediate events don't interfere with result extraction
		const ndjson = makeNdjson(
			{
				type: "system",
				subtype: "init",
				model: "test-model",
				session_id: "s1",
			},
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Thinking..." }] },
			},
			{
				type: "user",
				message: { content: [{ type: "tool_result", content: "ok" }] },
			},
			makeResultEvent("Final answer", { session_id: "s1", duration_ms: 5000 }),
		);

		const adapter = createMock(ndjson, 0);
		const result = await adapter.invoke({ prompt: "test", workdir: "/tmp" });

		expect(result.output).toBe("Final answer");
		expect(result.exitCode).toBe(0);
		expect(result.sessionId).toBe("s1");
		expect(result.duration).toBe(5000);
	});
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockOpts {
	/**
	 * Simulate a timeout: raceWithTimeout returns { timedOut: true },
	 * killWithEscalation is a no-op, boundedDrain aborts the reader
	 * immediately. No real timers are used.
	 */
	timeout?: boolean;
	/**
	 * When combined with `timeout`, uses hanging streams instead of
	 * normal streams. Tests that boundedDrain's abort path works when
	 * streams never close.
	 */
	hangingStreams?: boolean;
	/**
	 * When combined with `timeout`, the stdout stream emits mockStdout
	 * data then hangs (never closes). Tests partial-read + abort.
	 */
	partialStream?: boolean;
	/** spawnProcess throws instead of returning a handle. */
	spawnError?: boolean;
	/** Capture the args passed to spawnProcess. */
	captureArgs?: (args: string[]) => void;
	/**
	 * Capture warnings via the DI warn() method instead of mutating
	 * the global console.warn. Concurrent-test safe.
	 */
	captureWarnings?: (msg: string) => void;
}

/** Build a ReadableStream from a string — emits all data then closes. */
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
 * Build a ReadableStream that emits `initial` then hangs indefinitely.
 * Simulates a process that has partially written output but stalls.
 */
function partialThenHangingStream(initial: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let emitted = false;
	return new ReadableStream({
		pull(controller) {
			if (!emitted) {
				emitted = true;
				controller.enqueue(encoder.encode(initial));
				return;
			}
			// Never enqueue more — stalls the reader until cancelled
			return new Promise<void>(() => {});
		},
	});
}

/**
 * Create a ReadableStream that never closes and never emits data.
 */
function hangingStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		pull() {
			return new Promise(() => {});
		},
	});
}

/**
 * Create a test adapter that overrides spawnProcess and, when `timeout`
 * is set, also overrides raceWithTimeout/killWithEscalation/boundedDrain
 * to exercise the timeout handling path without any real timers.
 */
function createMock(
	mockStdout: string,
	mockExitCode: number,
	mockStderr = "",
	mockOpts: MockOpts = {},
): ClaudeCodeAdapter {
	return new (class extends ClaudeCodeAdapter {
		protected override warn(msg: string): void {
			if (mockOpts.captureWarnings) {
				mockOpts.captureWarnings(msg);
			}
			// When no captureWarnings provided, swallow warnings (test/setup.ts
			// already suppresses console.warn globally).
		}

		protected override spawnProcess(
			args: string[],
			_opts: { cwd: string },
		): SpawnHandle {
			mockOpts.captureArgs?.(args);

			if (mockOpts.spawnError) {
				throw new Error("spawn error");
			}

			// For timeout mocks, exited never resolves (the mock
			// raceWithTimeout returns timedOut immediately instead).
			if (mockOpts.timeout) {
				let stdout: ReadableStream<Uint8Array>;
				if (mockOpts.hangingStreams) {
					stdout = hangingStream();
				} else if (mockOpts.partialStream) {
					stdout = partialThenHangingStream(mockStdout);
				} else {
					stdout = stringStream(mockStdout);
				}
				return {
					exited: new Promise<number>(() => {}),
					stdout,
					stderr: stringStream(mockStderr),
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

		// -- Timeout path overrides: no real timers --

		protected override async raceWithTimeout(
			exited: Promise<number>,
			_timeoutMs: number,
		): Promise<RaceResult> {
			if (mockOpts.timeout) {
				return { timedOut: true };
			}
			// Normal path: process resolves immediately in non-timeout mocks
			const exitCode = await exited;
			return { timedOut: false, exitCode };
		}

		protected override async killWithEscalation(
			_proc: SpawnHandle,
		): Promise<void> {
			// No-op in tests — no real signals or grace timers.
		}

		protected override async boundedDrain(
			stdoutDone: Promise<NdjsonResult>,
			stderrDone: Promise<string>,
			ac: AbortController,
		): Promise<[NdjsonResult, string]> {
			if (mockOpts.timeout) {
				// Immediately abort the NDJSON reader — simulates
				// DRAIN_TIMEOUT_MS expiring without a real timer.
				ac.abort();
				const [ndjson, stderr] = await Promise.all([
					stdoutDone,
					stderrDone.catch(() => ""),
				]);
				return [ndjson, stderr];
			}
			// Normal path (non-timeout mocks) — streams close immediately
			return Promise.all([stdoutDone, stderrDone]) satisfies Promise<
				[NdjsonResult, string]
			>;
		}
	})();
}

/**
 * Build a ReadableStream that emits multiple string chunks sequentially.
 * Each chunk is enqueued in order; the stream closes after the last chunk.
 */
function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let idx = 0;
	return new ReadableStream({
		pull(controller) {
			if (idx < chunks.length) {
				// biome-ignore lint/style/noNonNullAssertion: idx is bounds-checked
				controller.enqueue(encoder.encode(chunks[idx]!));
				idx++;
			} else {
				controller.close();
			}
		},
	});
}

/**
 * Create a test adapter with multi-chunk stdout (for testing degraded mode
 * where partial lines exceed MAX_LINE_BUFFER_SIZE across chunk boundaries).
 */
function createMockWithChunkedStdout(
	stdoutChunks: string[],
	mockExitCode: number,
	mockStderr = "",
	mockOpts: MockOpts = {},
): ClaudeCodeAdapter {
	return new (class extends ClaudeCodeAdapter {
		protected override warn(msg: string): void {
			if (mockOpts.captureWarnings) {
				mockOpts.captureWarnings(msg);
			}
		}

		protected override spawnProcess(
			_args: string[],
			_opts: { cwd: string },
		): SpawnHandle {
			return {
				exited: Promise.resolve(mockExitCode),
				stdout: chunkedStream(stdoutChunks),
				stderr: stringStream(mockStderr),
				kill: () => {},
			};
		}

		protected override async raceWithTimeout(
			exited: Promise<number>,
			_timeoutMs: number,
		): Promise<RaceResult> {
			const exitCode = await exited;
			return { timedOut: false, exitCode };
		}
	})();
}
