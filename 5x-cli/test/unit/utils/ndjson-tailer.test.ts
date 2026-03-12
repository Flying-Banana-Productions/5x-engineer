/**
 * Tests for NdjsonTailer — deterministic (no timer/watcher dependency).
 *
 * All tests use pollInterval: 0 and call poll() directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NdjsonTailer } from "../../../src/utils/ndjson-tailer.js";

let dir: string;
let controller: AbortController;

beforeEach(() => {
	dir = join(
		tmpdir(),
		`ndjson-tailer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	controller = new AbortController();
});

afterEach(() => {
	controller.abort();
});

function makeTailer(): NdjsonTailer {
	return new NdjsonTailer({ dir, pollInterval: 0, signal: controller.signal });
}

function writeLine(file: string, obj: Record<string, unknown>): void {
	appendFileSync(join(dir, file), `${JSON.stringify(obj)}\n`);
}

describe("NdjsonTailer", () => {
	test("single file tailing", () => {
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "hello" });
		const tailer = makeTailer();

		const lines = tailer.poll();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.file).toBe("agent-001.ndjson");
		expect(lines[0]?.entry).toEqual({ ts: "t1", type: "text", delta: "hello" });

		// No new data → empty
		expect(tailer.poll()).toHaveLength(0);

		// Append more
		writeLine("agent-001.ndjson", { ts: "t2", type: "text", delta: "world" });
		const lines2 = tailer.poll();
		expect(lines2).toHaveLength(1);
		expect(lines2[0]?.entry.delta).toBe("world");
	});

	test("multi-file tailing", () => {
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "a" });
		writeLine("agent-002.ndjson", { ts: "t2", type: "text", delta: "b" });
		const tailer = makeTailer();

		const lines = tailer.poll();
		expect(lines).toHaveLength(2);
		// Sorted by filename
		expect(lines[0]?.file).toBe("agent-001.ndjson");
		expect(lines[1]?.file).toBe("agent-002.ndjson");
	});

	test("new file detection mid-watch", () => {
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "first" });
		const tailer = makeTailer();

		tailer.poll(); // consume existing

		// Add a new file
		writeLine("agent-002.ndjson", { ts: "t2", type: "text", delta: "second" });
		const lines = tailer.poll();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.file).toBe("agent-002.ndjson");
		expect(lines[0]?.entry.delta).toBe("second");
	});

	test("partial line buffering", () => {
		// Write half a line (no newline)
		const partial = '{"ts":"t1","type":"text"';
		writeFileSync(join(dir, "agent-001.ndjson"), partial);

		const tailer = makeTailer();
		expect(tailer.poll()).toHaveLength(0); // no complete line yet

		// Complete the line
		appendFileSync(join(dir, "agent-001.ndjson"), ',"delta":"hi"}\n');
		const lines = tailer.poll();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.entry).toEqual({ ts: "t1", type: "text", delta: "hi" });
	});

	test("malformed JSON skipped without crash", () => {
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "ok" });
		appendFileSync(join(dir, "agent-001.ndjson"), "NOT VALID JSON\n");
		writeLine("agent-001.ndjson", { ts: "t3", type: "text", delta: "after" });

		const tailer = makeTailer();
		const lines = tailer.poll();
		// Should get 2 valid lines, skip the bad one
		expect(lines).toHaveLength(2);
		expect(lines[0]?.entry.delta).toBe("ok");
		expect(lines[1]?.entry.delta).toBe("after");
	});

	test("abort signal stops iteration", () => {
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "a" });
		const tailer = makeTailer();

		tailer.poll(); // consume
		controller.abort();

		// After abort, poll returns empty
		writeLine("agent-001.ndjson", { ts: "t2", type: "text", delta: "b" });
		expect(tailer.poll()).toHaveLength(0);
	});

	test("empty directory yields nothing until file appears", () => {
		const tailer = makeTailer();
		expect(tailer.poll()).toHaveLength(0);

		writeLine("agent-001.ndjson", {
			ts: "t1",
			type: "text",
			delta: "appeared",
		});
		const lines = tailer.poll();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.entry.delta).toBe("appeared");
	});

	test("file truncation resets offset", () => {
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "before" });
		const tailer = makeTailer();
		tailer.poll(); // consume

		// Truncate and write new content
		writeFileSync(
			join(dir, "agent-001.ndjson"),
			'{"ts":"t2","type":"text","delta":"after"}\n',
		);
		const lines = tailer.poll();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.entry.delta).toBe("after");
	});

	test("ignores non-matching filenames", () => {
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "yes" });
		appendFileSync(
			join(dir, "other.log"),
			'{"ts":"t2","type":"text","delta":"no"}\n',
		);
		appendFileSync(
			join(dir, "agent.ndjson"),
			'{"ts":"t3","type":"text","delta":"no2"}\n',
		);

		const tailer = makeTailer();
		const lines = tailer.poll();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.file).toBe("agent-001.ndjson");
	});

	test("skipToEnd skips existing content", () => {
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "old" });
		writeLine("agent-001.ndjson", { ts: "t2", type: "text", delta: "old2" });

		const tailer = makeTailer();
		tailer.skipToEnd();

		// Existing content is skipped
		expect(tailer.poll()).toHaveLength(0);

		// New content is picked up
		writeLine("agent-001.ndjson", { ts: "t3", type: "text", delta: "new" });
		const lines = tailer.poll();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.entry.delta).toBe("new");
	});

	test("multiple lines in single read", () => {
		const data = [
			{ ts: "t1", type: "text", delta: "a" },
			{ ts: "t2", type: "text", delta: "b" },
			{ ts: "t3", type: "text", delta: "c" },
		];
		for (const d of data) writeLine("agent-001.ndjson", d);

		const tailer = makeTailer();
		const lines = tailer.poll();
		expect(lines).toHaveLength(3);
		expect(lines.map((l) => l.entry.delta)).toEqual(["a", "b", "c"]);
	});

	test("session_start entries are parsed normally", () => {
		writeLine("agent-001.ndjson", {
			ts: "t0",
			type: "session_start",
			role: "author",
			template: "author-next-phase",
			run: "run_abc123",
			phase_number: "1",
		});
		writeLine("agent-001.ndjson", { ts: "t1", type: "text", delta: "hi" });

		const tailer = makeTailer();
		const lines = tailer.poll();
		expect(lines).toHaveLength(2);
		expect(lines[0]?.entry.type).toBe("session_start");
		expect(lines[0]?.entry.role).toBe("author");
		expect(lines[0]?.entry.phase_number).toBe("1");
		expect(lines[1]?.entry.type).toBe("text");
	});
});
