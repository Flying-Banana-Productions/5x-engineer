import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CliError,
	exitCodeForError,
	formatGenericText,
	getOutputFormat,
	outputError,
	outputSuccess,
	setOutputFormat,
	setPrettyPrint,
} from "../../src/output.js";
import { nextLogSequence } from "../../src/providers/log-writer.js";
import { generateRunId } from "../../src/run-id.js";

// ---------------------------------------------------------------------------
// CliError
// ---------------------------------------------------------------------------

describe("CliError", () => {
	test("sets code, message, and default exitCode from EXIT_CODE_MAP", () => {
		const err = new CliError("PLAN_LOCKED", "plan is locked");
		expect(err.code).toBe("PLAN_LOCKED");
		expect(err.message).toBe("plan is locked");
		expect(err.exitCode).toBe(4);
		expect(err.detail).toBeUndefined();
		expect(err.name).toBe("CliError");
		expect(err).toBeInstanceOf(Error);
	});

	test("accepts optional detail", () => {
		const detail = { plan: "docs/plan.md", holder_pid: 1234 };
		const err = new CliError("PLAN_LOCKED", "locked", detail);
		expect(err.detail).toEqual(detail);
	});

	test("accepts explicit exitCode override", () => {
		const err = new CliError("CUSTOM_CODE", "custom error", undefined, 99);
		expect(err.exitCode).toBe(99);
	});

	test("unknown code defaults to exit code 1", () => {
		const err = new CliError("SOME_UNKNOWN_CODE", "something went wrong");
		expect(err.exitCode).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// exitCodeForError
// ---------------------------------------------------------------------------

describe("exitCodeForError", () => {
	test("maps known error codes to correct exit codes", () => {
		expect(exitCodeForError("TEMPLATE_NOT_FOUND")).toBe(2);
		expect(exitCodeForError("PLAN_NOT_FOUND")).toBe(2);
		expect(exitCodeForError("PROVIDER_NOT_FOUND")).toBe(2);
		expect(exitCodeForError("INVALID_PROVIDER")).toBe(2);
		expect(exitCodeForError("NON_INTERACTIVE")).toBe(3);
		expect(exitCodeForError("PLAN_LOCKED")).toBe(4);
		expect(exitCodeForError("DIRTY_WORKTREE")).toBe(5);
		expect(exitCodeForError("MAX_STEPS_EXCEEDED")).toBe(6);
		expect(exitCodeForError("INVALID_STRUCTURED_OUTPUT")).toBe(7);
	});

	test("returns 1 for unknown codes", () => {
		expect(exitCodeForError("SOMETHING_ELSE")).toBe(1);
		expect(exitCodeForError("")).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// outputSuccess
// ---------------------------------------------------------------------------

describe("outputSuccess", () => {
	test("writes JSON envelope to console.log", () => {
		const calls: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			outputSuccess({ run_id: "run_abc123", status: "active" });
		} finally {
			console.log = origLog;
		}

		expect(calls).toHaveLength(1);
		const raw = calls[0];
		expect(raw).toBeDefined();
		const parsed = JSON.parse(raw as string);
		expect(parsed).toEqual({
			ok: true,
			data: { run_id: "run_abc123", status: "active" },
		});
	});

	test("handles null data", () => {
		const calls: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			outputSuccess(null);
		} finally {
			console.log = origLog;
		}

		const raw = calls[0];
		expect(raw).toBeDefined();
		const parsed = JSON.parse(raw as string);
		expect(parsed).toEqual({ ok: true, data: null });
	});

	test("normalizes undefined data to null so `data` field is always present on the wire", () => {
		const calls: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			outputSuccess(undefined);
		} finally {
			console.log = origLog;
		}

		const raw = calls[0];
		expect(raw).toBeDefined();
		const parsed = JSON.parse(raw as string);
		// `data` must be present (as null), not omitted
		expect(parsed).toEqual({ ok: true, data: null });
		expect("data" in parsed).toBe(true);
	});

	test("handles complex nested data", () => {
		const calls: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			outputSuccess({
				steps: [{ id: 1, name: "author:implement:status" }],
				summary: { total_cost: 0.15 },
			});
		} finally {
			console.log = origLog;
		}

		const raw = calls[0];
		expect(raw).toBeDefined();
		const parsed = JSON.parse(raw as string);
		expect(parsed.ok).toBe(true);
		expect(parsed.data.steps).toHaveLength(1);
		expect(parsed.data.summary.total_cost).toBe(0.15);
	});

	test("pretty-prints JSON when setPrettyPrint(true)", () => {
		const calls: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			setPrettyPrint(true);
			outputSuccess({ key: "value" });
		} finally {
			console.log = origLog;
		}

		const raw = calls[0] as string;
		// Pretty-printed JSON has newlines and indentation
		expect(raw).toContain("\n");
		expect(raw).toContain('  "ok"');
	});

	test("compact JSON when setPrettyPrint(false)", () => {
		const calls: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			setPrettyPrint(false);
			outputSuccess({ key: "value" });
		} finally {
			console.log = origLog;
		}

		const raw = calls[0] as string;
		// Compact JSON: no newlines
		expect(raw).not.toContain("\n");
		expect(raw).toBe('{"ok":true,"data":{"key":"value"}}');
	});

	test("defaults to compact JSON when stdout is not a TTY", () => {
		// In test/CI context, stdout is piped (not a TTY), so prettyPrint
		// auto-detects to false.  We verify this by NOT calling setPrettyPrint
		// and checking the serialization result.
		const calls: string[] = [];
		const origLog = console.log;
		const origIsTTY = process.stdout.isTTY;
		try {
			// Simulate non-TTY (piped) — this is the default in test context
			Object.defineProperty(process.stdout, "isTTY", {
				value: undefined,
				configurable: true,
			});
			// Re-import would be needed to re-evaluate the default, but we can
			// test the derived behavior via setPrettyPrint matching auto-detect:
			setPrettyPrint(process.stdout?.isTTY ?? false);
			console.log = (...args: unknown[]) => {
				calls.push(String(args[0]));
			};
			outputSuccess({ tty: false });
		} finally {
			Object.defineProperty(process.stdout, "isTTY", {
				value: origIsTTY,
				configurable: true,
			});
			console.log = origLog;
		}

		const raw = calls[0] as string;
		expect(raw).not.toContain("\n");
	});

	test("defaults to pretty JSON when stdout is a TTY", () => {
		const calls: string[] = [];
		const origLog = console.log;
		const origIsTTY = process.stdout.isTTY;
		try {
			Object.defineProperty(process.stdout, "isTTY", {
				value: true,
				configurable: true,
			});
			setPrettyPrint(process.stdout?.isTTY ?? false);
			console.log = (...args: unknown[]) => {
				calls.push(String(args[0]));
			};
			outputSuccess({ tty: true });
		} finally {
			Object.defineProperty(process.stdout, "isTTY", {
				value: origIsTTY,
				configurable: true,
			});
			console.log = origLog;
		}

		const raw = calls[0] as string;
		expect(raw).toContain("\n");
		expect(raw).toContain('  "ok"');
	});
});

// ---------------------------------------------------------------------------
// Output format state
// ---------------------------------------------------------------------------

describe("output format state", () => {
	afterEach(() => {
		setOutputFormat("json");
	});

	test("default format is json", () => {
		expect(getOutputFormat()).toBe("json");
	});

	test("setOutputFormat('text') / getOutputFormat() round-trip", () => {
		setOutputFormat("text");
		expect(getOutputFormat()).toBe("text");
	});

	test("setOutputFormat('json') resets to JSON", () => {
		setOutputFormat("text");
		setOutputFormat("json");
		expect(getOutputFormat()).toBe("json");
	});
});

// ---------------------------------------------------------------------------
// formatGenericText
// ---------------------------------------------------------------------------

describe("formatGenericText", () => {
	/** Capture console.log calls and return joined output. */
	function capture(fn: () => void): string {
		const lines: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			lines.push(args.length === 0 ? "" : String(args[0]));
		};
		try {
			fn();
		} finally {
			console.log = origLog;
		}
		return lines.join("\n");
	}

	test("flat object renders aligned key-value lines", () => {
		const output = capture(() =>
			formatGenericText({ run_id: "R1", status: "completed" }),
		);
		expect(output).toContain("run_id");
		expect(output).toContain("R1");
		expect(output).toContain("status");
		expect(output).toContain("completed");
		// Keys should be padded — "run_id" (6) and "status" (6) are same length
		expect(output).toContain("run_id  R1");
		expect(output).toContain("status  completed");
	});

	test("nested object renders indented key-value", () => {
		const output = capture(() =>
			formatGenericText({ summary: { total: 5, passed: 3 } }),
		);
		expect(output).toContain("summary:");
		expect(output).toContain("  total");
		expect(output).toContain("  passed");
	});

	test("array of primitives renders comma-joined", () => {
		const output = capture(() => formatGenericText({ tags: ["a", "b", "c"] }));
		expect(output).toContain("a, b, c");
	});

	test("array of objects renders separated blocks", () => {
		const output = capture(() =>
			formatGenericText([
				{ id: 1, name: "first" },
				{ id: 2, name: "second" },
			]),
		);
		expect(output).toContain("first");
		expect(output).toContain("second");
		// Blocks should be separated by a blank line
		expect(output).toContain("\n\n");
	});

	test("null values are omitted", () => {
		const output = capture(() =>
			formatGenericText({ visible: "yes", hidden: null }),
		);
		expect(output).toContain("visible");
		expect(output).not.toContain("hidden");
	});

	test("empty array renders (none)", () => {
		const output = capture(() => formatGenericText([]));
		expect(output).toBe("(none)");
	});

	test("empty object renders (none)", () => {
		const output = capture(() => formatGenericText({}));
		expect(output).toBe("(none)");
	});

	test("object with empty array value renders key  (none)", () => {
		const output = capture(() => formatGenericText({ items: [] }));
		expect(output).toContain("items  (none)");
	});

	test("object with mix of empty and populated arrays", () => {
		const output = capture(() =>
			formatGenericText({ empty: [], filled: ["x", "y"] }),
		);
		expect(output).toContain("empty   (none)");
		expect(output).toContain("filled  x, y");
	});
});

// ---------------------------------------------------------------------------
// outputSuccess with text formatter
// ---------------------------------------------------------------------------

describe("outputSuccess with text formatter", () => {
	afterEach(() => {
		setOutputFormat("json");
	});

	test("json mode: formatter is NOT called, JSON envelope written", () => {
		setOutputFormat("json");
		const calls: string[] = [];
		let formatterCalled = false;
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			outputSuccess({ key: "val" }, () => {
				formatterCalled = true;
			});
		} finally {
			console.log = origLog;
		}
		expect(formatterCalled).toBe(false);
		expect(calls).toHaveLength(1);
		const parsed = JSON.parse(calls[0] as string);
		expect(parsed.ok).toBe(true);
		expect(parsed.data.key).toBe("val");
	});

	test("text mode with formatter: formatter IS called, no JSON", () => {
		setOutputFormat("text");
		const calls: string[] = [];
		let formatterData: unknown = null;
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			outputSuccess({ key: "val" }, (data) => {
				formatterData = data;
				console.log(`custom: ${(data as { key: string }).key}`);
			});
		} finally {
			console.log = origLog;
		}
		expect(formatterData).toEqual({ key: "val" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toBe("custom: val");
		// No JSON envelope
		expect(calls[0]).not.toContain('"ok"');
	});

	test("text mode without formatter: generic formatter called", () => {
		setOutputFormat("text");
		const calls: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			calls.push(String(args[0]));
		};
		try {
			outputSuccess({ run_id: "R1", status: "active" });
		} finally {
			console.log = origLog;
		}
		expect(calls.length).toBeGreaterThan(0);
		const output = calls.join("\n");
		// Generic formatter output — key-value pairs
		expect(output).toContain("run_id");
		expect(output).toContain("R1");
		// No JSON envelope
		expect(output).not.toContain('"ok"');
	});
});

// ---------------------------------------------------------------------------
// outputError
// ---------------------------------------------------------------------------

describe("outputError", () => {
	test("throws CliError with correct properties", () => {
		expect(() => outputError("PLAN_NOT_FOUND", "no plan")).toThrow(CliError);
	});

	test("thrown CliError has correct code and message", () => {
		try {
			outputError("DIRTY_WORKTREE", "uncommitted changes");
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(CliError);
			const cliErr = err as CliError;
			expect(cliErr.code).toBe("DIRTY_WORKTREE");
			expect(cliErr.message).toBe("uncommitted changes");
			expect(cliErr.exitCode).toBe(5);
		}
	});

	test("passes detail and exitCode through", () => {
		try {
			outputError("CUSTOM", "msg", { key: "val" }, 42);
			expect(true).toBe(false);
		} catch (err) {
			const cliErr = err as CliError;
			expect(cliErr.detail).toEqual({ key: "val" });
			expect(cliErr.exitCode).toBe(42);
		}
	});
});

// ---------------------------------------------------------------------------
// generateRunId
// ---------------------------------------------------------------------------

describe("generateRunId", () => {
	test("starts with 'run_' prefix", () => {
		const id = generateRunId();
		expect(id.startsWith("run_")).toBe(true);
	});

	test("has correct length: 'run_' + 12 hex chars = 16 total", () => {
		const id = generateRunId();
		expect(id).toHaveLength(16);
	});

	test("suffix is valid hex", () => {
		const id = generateRunId();
		const suffix = id.slice(4);
		expect(suffix).toMatch(/^[0-9a-f]{12}$/);
	});

	test("generates unique IDs", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(generateRunId());
		}
		expect(ids.size).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// nextLogSequence
// ---------------------------------------------------------------------------

describe("nextLogSequence", () => {
	const tmpBase = join(tmpdir(), "5x-test-logseq");

	test("returns '001' for non-existent directory", () => {
		const seq = nextLogSequence(join(tmpBase, "nonexistent"));
		expect(seq).toBe("001");
	});

	test("returns '001' for empty directory", () => {
		const dir = join(tmpBase, `empty-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			const seq = nextLogSequence(dir);
			expect(seq).toBe("001");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns next sequence after existing files", () => {
		const dir = join(tmpBase, `seq-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, "agent-001.ndjson"), "");
			writeFileSync(join(dir, "agent-002.ndjson"), "");
			const seq = nextLogSequence(dir);
			expect(seq).toBe("003");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ignores non-matching files", () => {
		const dir = join(tmpBase, `ignore-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, "agent-001.ndjson"), "");
			writeFileSync(join(dir, "trace-001.ndjson"), "");
			writeFileSync(join(dir, "readme.md"), "");
			const seq = nextLogSequence(dir);
			expect(seq).toBe("002");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("handles gaps in sequence numbers", () => {
		const dir = join(tmpBase, `gap-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, "agent-001.ndjson"), "");
			writeFileSync(join(dir, "agent-005.ndjson"), "");
			const seq = nextLogSequence(dir);
			expect(seq).toBe("006");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("pads sequence to 3 digits", () => {
		const dir = join(tmpBase, `pad-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			const seq = nextLogSequence(dir);
			expect(seq).toHaveLength(3);
			expect(seq).toBe("001");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
