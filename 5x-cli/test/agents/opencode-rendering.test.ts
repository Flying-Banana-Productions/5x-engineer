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
	MAX_TRACKED_DELTA_PART_IDS,
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

function textPartUpdatedWithDelta(id: string, text: string) {
	return {
		type: "message.part.updated",
		properties: { part: { type: "text", id }, delta: text },
	};
}

function textPartUpdatedWithDeltaNoId(text: string) {
	return {
		type: "message.part.updated",
		properties: { part: { type: "text" }, delta: text },
	};
}

function textPartUpdatedWithFullText(id: string, text: string) {
	return {
		type: "message.part.updated",
		properties: { part: { type: "text", id, text } },
	};
}

function reasoningPartUpdated(id: string) {
	return {
		type: "message.part.updated",
		properties: { part: { type: "reasoning", id } },
	};
}

function reasoningPartUpdatedWithDelta(id: string, text: string) {
	return {
		type: "message.part.updated",
		properties: { part: { type: "reasoning", id }, delta: text },
	};
}

function reasoningPartUpdatedWithFullText(id: string, text: string) {
	return {
		type: "message.part.updated",
		properties: { part: { type: "reasoning", id, text } },
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

function toolRunningWithId(id: string, tool: string, input: unknown) {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				id,
				type: "tool",
				tool,
				state: { status: "running", input },
			},
		},
	};
}

function toolCompletedWithId(id: string, tool: string, output: string) {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				id,
				type: "tool",
				tool,
				state: { status: "completed", output },
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

	test("text deltas on message.part.updated are streamed", () => {
		const out = renderEvents([
			textPartUpdatedWithDelta("t1", "Hello from updated delta"),
		]);
		expect(out).toBe("Hello from updated delta\n");
	});

	test("text deltas on message.part.updated stream even without part id", () => {
		const out = renderEvents([
			textPartUpdatedWithDeltaNoId("Hello without id"),
		]);
		expect(out).toBe("Hello without id\n");
	});

	test("text full-text updates stream incremental append", () => {
		const out = renderEvents([
			textPartUpdatedWithFullText("t1", "Hello"),
			textPartUpdatedWithFullText("t1", "Hello world"),
		]);
		expect(out).toBe("Hello world\n");
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

	test("reasoning deltas on message.part.updated obey showReasoning", () => {
		const hidden = renderEvents(
			[reasoningPartUpdatedWithDelta("r1", "thinking inline")],
			{ showReasoning: false },
		);
		expect(hidden).toBe("");

		const shown = renderEvents(
			[reasoningPartUpdatedWithDelta("r1", "thinking inline")],
			{ showReasoning: true },
		);
		expect(shown).toBe("> thinking inline\n");
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

	test("reasoning full-text updates obey showReasoning", () => {
		const hidden = renderEvents([
			reasoningPartUpdatedWithFullText("r1", "think"),
			reasoningPartUpdatedWithFullText("r1", "thinking"),
		]);
		expect(hidden).toBe("");

		const shown = renderEvents(
			[
				reasoningPartUpdatedWithFullText("r1", "think"),
				reasoningPartUpdatedWithFullText("r1", "thinking"),
			],
			{ showReasoning: true },
		);
		expect(shown).toBe("> thinking\n");
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

	test("legacy message.part.delta is deduped after updated delta for same part", () => {
		const out = renderEvents([
			textPartUpdatedWithDelta("t1", "Hello once"),
			delta("t1", "Hello once"),
		]);
		expect(out).toBe("Hello once\n");
	});

	test("updatedDeltaPartIds stays bounded for large sessions", () => {
		const state = createEventRouterState();
		const writer = new StreamWriter({
			width: 80,
			writer: () => {},
			ansi: NO_ANSI,
		});

		for (let i = 0; i < MAX_TRACKED_DELTA_PART_IDS + 200; i++) {
			routeEventToWriter(
				textPartUpdatedWithDelta(`t${i}`, "x"),
				writer,
				state,
				{},
			);
		}

		writer.destroy();
		expect(state.updatedDeltaPartIds.size).toBeLessThanOrEqual(
			MAX_TRACKED_DELTA_PART_IDS,
		);
		expect(state.updatedDeltaPartIds.has("t0")).toBe(false);
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

	test("dedupes repeated identical running tool updates for same part", () => {
		const out = renderEvents([
			toolRunningWithId("tool-1", "bash", { command: "npm test 2>&1" }),
			toolRunningWithId("tool-1", "bash", { command: "npm test 2>&1" }),
			toolRunningWithId("tool-1", "bash", { command: "npm test 2>&1" }),
		]);
		expect(out).toBe("bash: npm test 2>&1\n");
	});

	test("allows new running output after tool completion", () => {
		const out = renderEvents([
			toolRunningWithId("tool-1", "bash", { command: "npm test" }),
			toolCompletedWithId("tool-1", "bash", "done"),
			toolRunningWithId("tool-1", "bash", { command: "npm test" }),
		]);
		expect(out).toContain("bash: npm test\n");
		expect(out).toContain("done\n");
		expect(out.endsWith("bash: npm test\n")).toBe(true);
	});
});
