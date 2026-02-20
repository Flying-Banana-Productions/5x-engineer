/**
 * Adapter-level rendering integration test.
 *
 * Feeds synthetic SSE events through the rendering code path (formatSseEvent +
 * StreamWriter) and asserts on captured output. Tests the observable behavior
 * of the combined pipeline without touching real stdout or the SDK.
 *
 * Landed early (per review P1.2) to lock rendering behavior before Phase 3
 * wires StreamWriter into the adapter loop.
 */

import { describe, expect, test } from "bun:test";
import type { AnsiConfig } from "../../src/utils/ansi.js";
import {
	createEventRouterState,
	routeEventToWriter,
} from "../../src/utils/event-router.js";
import { StreamWriter } from "../../src/utils/stream-writer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_ANSI: AnsiConfig = { dim: "", reset: "", colorEnabled: false };
const DIM_ANSI: AnsiConfig = {
	dim: "\x1b[2m",
	reset: "\x1b[0m",
	colorEnabled: true,
};

/** Simulate the rendering pipeline using the shared event router. */
function renderEvents(
	events: unknown[],
	opts: {
		width?: number;
		ansi?: AnsiConfig;
		showReasoning?: boolean;
	} = {},
) {
	const chunks: string[] = [];
	const width = opts.width ?? 60;
	const ansi = opts.ansi ?? NO_ANSI;
	const writer = new StreamWriter({
		width,
		writer: (s: string) => chunks.push(s),
		ansi,
	});

	const state = createEventRouterState();

	for (const event of events) {
		routeEventToWriter(event, writer, state, {
			showReasoning: opts.showReasoning,
		});
	}

	writer.destroy();
	return chunks.join("");
}

// Helper to build common events
function textPartUpdated(id: string) {
	return {
		type: "message.part.updated",
		properties: { part: { type: "text", id } },
	};
}

function reasoningPartUpdated(id: string) {
	return {
		type: "message.part.updated",
		properties: { part: { type: "reasoning", id } },
	};
}

function delta(partID: string, text: string) {
	return {
		type: "message.part.delta",
		properties: { partID, delta: text },
	};
}

function toolRunning(tool: string, input: unknown) {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				type: "tool",
				tool,
				state: { status: "running", input },
			},
		},
	};
}

function toolCompleted(tool: string, output: string) {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				type: "tool",
				tool,
				state: { status: "completed", output },
			},
		},
	};
}

function toolError(tool: string, error: string) {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				type: "tool",
				tool,
				state: { status: "error", error },
			},
		},
	};
}

function stepFinish() {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				type: "step-finish",
				reason: "endTurn",
				cost: 0.05,
				tokens: { input: 1000, output: 500 },
			},
		},
	};
}

// ===========================================================================
// Tests
// ===========================================================================

describe("opencode rendering pipeline", () => {
	test("step-finish events are suppressed", () => {
		const out = renderEvents([stepFinish()]);
		expect(out).toBe("");
	});

	test("tool running events produce single-line output", () => {
		const out = renderEvents([toolRunning("bash", { command: "npm install" })]);
		expect(out).toBe("bash: npm install\n");
	});

	test("tool completed events produce single-line output with newlines collapsed", () => {
		const out = renderEvents([
			toolCompleted("bash", "file1.ts\nfile2.ts\nfile3.ts"),
		]);
		expect(out).toBe("file1.ts file2.ts file3.ts\n");
	});

	test("tool error events produce non-dim output with ! prefix", () => {
		const out = renderEvents([toolError("bash", "command not found")], {
			ansi: DIM_ANSI,
		});
		// Error lines should NOT be wrapped in dim
		expect(out).toBe("! bash: command not found\n");
		expect(out).not.toContain("\x1b[2m");
	});

	test("tool running events are dim when ANSI enabled", () => {
		const out = renderEvents([toolRunning("bash", { command: "ls" })], {
			ansi: DIM_ANSI,
		});
		expect(out).toContain("\x1b[2m");
		expect(out).toContain("bash: ls");
		expect(out).toContain("\x1b[0m");
	});

	test("text deltas are word-wrapped at configured width", () => {
		const out = renderEvents(
			[
				textPartUpdated("t1"),
				delta("t1", "one two three four five six seven eight nine ten"),
			],
			{ width: 20 },
		);
		const lines = out.split("\n");
		// Every non-empty line should be ≤ 20 chars
		for (const line of lines) {
			if (line.length > 0) {
				expect(line.length).toBeLessThanOrEqual(20);
			}
		}
	});

	test("text deltas preserve leading whitespace and newlines", () => {
		const out = renderEvents([
			textPartUpdated("t1"),
			delta("t1", "line one\n    indented\n  also indented"),
		]);
		expect(out).toContain("line one\n");
		expect(out).toContain("    indented\n");
		expect(out).toContain("  also indented\n");
	});

	test("fenced code blocks in text deltas are not word-wrapped", () => {
		const longCode =
			"const x = someVeryLongFunctionName(parameterOne, parameterTwo, parameterThree);";
		const out = renderEvents(
			[textPartUpdated("t1"), delta("t1", `\`\`\`\n${longCode}\n\`\`\`\n`)],
			{ width: 30 },
		);
		expect(out).toContain(longCode);
	});

	test("reasoning deltas are suppressed when showReasoning is false", () => {
		const out = renderEvents(
			[reasoningPartUpdated("r1"), delta("r1", "thinking hard about this")],
			{ showReasoning: false },
		);
		expect(out).toBe("");
	});

	test("reasoning deltas produce dim output when showReasoning is true", () => {
		const out = renderEvents(
			[reasoningPartUpdated("r1"), delta("r1", "thinking hard")],
			{ showReasoning: true, ansi: DIM_ANSI },
		);
		expect(out).toContain("\x1b[2m");
		expect(out).toContain("thinking hard");
		expect(out).toContain("\x1b[0m");
	});

	test("interleaved text deltas and tool events render correctly", () => {
		const out = renderEvents([
			textPartUpdated("t1"),
			delta("t1", "Let me check the files."),
			toolRunning("bash", { command: "ls src/" }),
			toolCompleted("bash", "index.ts\nutils.ts"),
			delta("t1", "Found two files."),
		]);
		// Text should be flushed before tool events, then resume after
		expect(out).toContain("Let me check the files.\n");
		expect(out).toContain("bash: ls src/\n");
		expect(out).toContain("index.ts utils.ts\n");
		expect(out).toContain("Found two files.\n");
	});

	test("tool output truncated to width by writeLine", () => {
		const longOutput = "x".repeat(200);
		const out = renderEvents([toolCompleted("bash", longOutput)], {
			width: 40,
		});
		const line = out.trimEnd();
		expect(line.length).toBeLessThanOrEqual(40);
		expect(line).toContain("...");
	});
});
