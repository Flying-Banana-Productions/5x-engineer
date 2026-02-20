import { describe, expect, test } from "bun:test";
import type { AnsiConfig } from "../../src/utils/ansi.js";
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

function capture(width = 40, ansi: AnsiConfig = NO_ANSI) {
	const chunks: string[] = [];
	const writer = new StreamWriter({
		width,
		writer: (s: string) => chunks.push(s),
		ansi,
	});
	return { writer, chunks, output: () => chunks.join("") };
}

// ---------------------------------------------------------------------------
// Word wrapping
// ---------------------------------------------------------------------------

describe("StreamWriter — word wrapping", () => {
	test("wraps at specified width", () => {
		const { writer, output } = capture(20);
		writer.writeText("one two three four five six");
		writer.destroy();
		// "one two three four " = 19 chars, "five" would push to 24 → wrap
		expect(output()).toBe("one two three four\nfive six\n");
	});

	test("handles multiple deltas building up a line", () => {
		const { writer, output } = capture(20);
		writer.writeText("hello ");
		writer.writeText("world ");
		writer.writeText("this is a test");
		writer.destroy();
		expect(output()).toBe("hello world this is\na test\n");
	});

	test("newlines in delta reset column position", () => {
		const { writer, output } = capture(40);
		writer.writeText("first line\nsecond line");
		writer.destroy();
		expect(output()).toBe("first line\nsecond line\n");
	});

	test("long word exceeding width is not broken", () => {
		const { writer, output } = capture(10);
		writer.writeText("abcdefghijklmnop short");
		writer.destroy();
		// Long word written as-is on its own line, then "short" wraps
		expect(output()).toBe("abcdefghijklmnop\nshort\n");
	});

	test("long word at start of line is written as-is", () => {
		const { writer, output } = capture(10);
		writer.writeText("abcdefghijklmnop");
		writer.destroy();
		expect(output()).toBe("abcdefghijklmnop\n");
	});
});

// ---------------------------------------------------------------------------
// Whitespace preservation
// ---------------------------------------------------------------------------

describe("StreamWriter — whitespace preservation", () => {
	test("preserves leading whitespace on input lines", () => {
		const { writer, output } = capture(40);
		writer.writeText("line one\n    indented line");
		writer.destroy();
		expect(output()).toBe("line one\n    indented line\n");
	});

	test("preserves multiple consecutive spaces within a line", () => {
		const { writer, output } = capture(40);
		writer.writeText("a  b   c");
		writer.destroy();
		expect(output()).toBe("a  b   c\n");
	});

	test("preserves tab characters", () => {
		const { writer, output } = capture(40);
		writer.writeText("a\tb\tc");
		writer.destroy();
		expect(output()).toBe("a\tb\tc\n");
	});

	test("preserves trailing whitespace before explicit newline", () => {
		const { writer, output } = capture(40);
		writer.writeText("two-spaces  \nnext line");
		writer.destroy();
		expect(output()).toBe("two-spaces  \nnext line\n");
	});

	test("preserves trailing tabs before explicit newline", () => {
		const { writer, output } = capture(40);
		writer.writeText("with-tab\t\nnext");
		writer.destroy();
		expect(output()).toBe("with-tab\t\nnext\n");
	});

	test("preserves markdown hard line break (two trailing spaces)", () => {
		const { writer, output } = capture(40);
		writer.writeText("line one  \nline two  \nline three");
		writer.destroy();
		expect(output()).toBe("line one  \nline two  \nline three\n");
	});
});

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

describe("StreamWriter — fenced code blocks", () => {
	test("content inside fences is not word-wrapped", () => {
		const { writer, output } = capture(20);
		writer.writeText(
			"```\nthis is a very long line that should not wrap inside a fence\n```\n",
		);
		writer.destroy();
		expect(output()).toBe(
			"```\nthis is a very long line that should not wrap inside a fence\n```\n",
		);
	});

	test("wrapping resumes after closing fence", () => {
		const { writer, output } = capture(20);
		writer.writeText("```\ncode line\n```\none two three four five six");
		writer.destroy();
		const out = output();
		// Code block passes through, then normal text wraps
		expect(out).toContain("```\ncode line\n```\n");
		expect(out).toContain("one two three four\nfive six\n");
	});

	test("nested/multiple fenced blocks tracked correctly", () => {
		const { writer, output } = capture(20);
		writer.writeText(
			"```\nblock one\n```\nwrap here yes wrap\n```\nblock two\n```\n",
		);
		writer.destroy();
		const out = output();
		// First block: no wrap
		expect(out).toContain("```\nblock one\n```\n");
		// Between blocks: wraps
		expect(out).toContain("wrap here yes wrap\n");
		// Second block: no wrap
		expect(out).toContain("```\nblock two\n```\n");
	});

	test("fenced block with language tag", () => {
		const { writer, output } = capture(20);
		writer.writeText("```typescript\nconst x = 1;\n```\n");
		writer.destroy();
		expect(output()).toBe("```typescript\nconst x = 1;\n```\n");
	});
});

// ---------------------------------------------------------------------------
// ANSI styling — writeThinking
// ---------------------------------------------------------------------------

describe("StreamWriter — writeThinking ANSI", () => {
	test("emits dim/reset codes when color enabled", () => {
		const { writer, output } = capture(40, DIM_ANSI);
		writer.writeThinking("thinking about it");
		writer.destroy();
		const out = output();
		expect(out).toContain("\x1b[2m");
		expect(out).toContain("thinking about it");
		expect(out).toContain("\x1b[0m");
	});

	test("emits no dim/reset codes when color disabled", () => {
		const { writer, output } = capture(40, NO_ANSI);
		writer.writeThinking("thinking about it");
		writer.destroy();
		const out = output();
		expect(out).not.toContain("\x1b[2m");
		expect(out).not.toContain("\x1b[0m");
		expect(out).toContain("thinking about it");
	});

	test("style transition text→thinking→text emits proper ANSI", () => {
		const { writer, chunks } = capture(80, DIM_ANSI);
		writer.writeText("hello ");
		writer.writeThinking("hmm ");
		writer.writeText("world");
		writer.destroy();

		const out = chunks.join("");
		// text "hello ", then reset+dim for thinking, then reset+text for world
		const dimIdx = out.indexOf("\x1b[2m");
		const helloIdx = out.indexOf("hello");
		const hmmIdx = out.indexOf("hmm");
		expect(dimIdx).toBeGreaterThan(helloIdx);
		expect(dimIdx).toBeLessThan(hmmIdx);

		// After "hmm", there should be a reset before "world"
		const resetAfterHmm = out.indexOf("\x1b[0m", hmmIdx);
		const worldIdx = out.indexOf("world");
		expect(resetAfterHmm).toBeLessThan(worldIdx);
	});
});

// ---------------------------------------------------------------------------
// writeLine
// ---------------------------------------------------------------------------

describe("StreamWriter — writeLine", () => {
	test("flushes in-progress streaming first", () => {
		const { writer, output } = capture(40);
		writer.writeText("partial");
		writer.writeLine("complete line");
		writer.destroy();
		const out = output();
		// "partial" should be flushed with a newline before "complete line"
		expect(out).toBe("partial\ncomplete line\n");
	});

	test("dim option wraps in dim/reset", () => {
		const { writer, output } = capture(40, DIM_ANSI);
		writer.writeLine("tool output", { dim: true });
		writer.destroy();
		expect(output()).toBe("\x1b[2mtool output\x1b[0m\n");
	});

	test("non-dim writeLine has no ANSI codes", () => {
		const { writer, output } = capture(40, DIM_ANSI);
		writer.writeLine("error message");
		writer.destroy();
		expect(output()).toBe("error message\n");
	});

	test("truncates long text to width with ...", () => {
		const { writer, output } = capture(20);
		writer.writeLine("this is a very long line that exceeds width");
		writer.destroy();
		const out = output();
		expect(out.length).toBeLessThanOrEqual(21); // 20 chars + \n
		expect(out).toContain("...");
		expect(out).toBe("this is a very lo...\n");
	});

	test("does not truncate text within width", () => {
		const { writer, output } = capture(40);
		writer.writeLine("short line");
		writer.destroy();
		expect(output()).toBe("short line\n");
	});
});

// ---------------------------------------------------------------------------
// endBlock / destroy
// ---------------------------------------------------------------------------

describe("StreamWriter — endBlock / destroy", () => {
	test("endBlock is idempotent", () => {
		const { writer, output } = capture(40);
		writer.writeText("hello");
		writer.endBlock();
		writer.endBlock();
		writer.endBlock();
		expect(output()).toBe("hello\n");
	});

	test("destroy flushes and terminates", () => {
		const { writer, output } = capture(40);
		writer.writeText("final text");
		writer.destroy();
		expect(output()).toBe("final text\n");
	});

	test("destroy resets thinking style", () => {
		const { writer, output } = capture(40, DIM_ANSI);
		writer.writeThinking("thinking");
		writer.destroy();
		const out = output();
		expect(out).toContain("\x1b[0m");
	});
});

// ---------------------------------------------------------------------------
// Injectable writer / ansi
// ---------------------------------------------------------------------------

describe("StreamWriter — injectable dependencies", () => {
	test("injectable writer captures all output", () => {
		const calls: string[] = [];
		const writer = new StreamWriter({
			width: 40,
			writer: (s) => calls.push(s),
			ansi: NO_ANSI,
		});
		writer.writeText("test");
		writer.destroy();
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.join("")).toBe("test\n");
	});

	test("injectable ansi config controls ANSI output", () => {
		const { writer, output } = capture(40, {
			dim: "[DIM]",
			reset: "[RST]",
			colorEnabled: true,
		});
		writer.writeLine("info", { dim: true });
		writer.destroy();
		expect(output()).toBe("[DIM]info[RST]\n");
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("StreamWriter — width clamping", () => {
	test("clamps width=0 to MIN_WIDTH", () => {
		const { writer, output } = capture(0);
		writer.writeLine("hello world");
		writer.destroy();
		// Should not throw; output truncated to MIN_WIDTH (4)
		expect(output()).toBe("h...\n");
	});

	test("clamps width=2 to MIN_WIDTH", () => {
		const { writer, output } = capture(2);
		writer.writeLine("hello");
		writer.destroy();
		expect(output()).toBe("h...\n");
	});

	test("clamps negative width to MIN_WIDTH", () => {
		const { writer, output } = capture(-10);
		writer.writeLine("hello");
		writer.destroy();
		expect(output()).toBe("h...\n");
	});

	test("floors fractional width", () => {
		const { writer, output } = capture(10.7);
		writer.writeLine("abcdefghijklmnop");
		writer.destroy();
		// width=10 after floor
		expect(output()).toBe("abcdefg...\n");
	});

	test("handles NaN width with default 80", () => {
		const chunks: string[] = [];
		const writer = new StreamWriter({
			width: Number.NaN,
			writer: (s: string) => chunks.push(s),
			ansi: NO_ANSI,
		});
		writer.writeLine("test");
		writer.destroy();
		expect(chunks.join("")).toBe("test\n");
	});

	test("handles Infinity width with default 80", () => {
		const chunks: string[] = [];
		const writer = new StreamWriter({
			width: Number.POSITIVE_INFINITY,
			writer: (s: string) => chunks.push(s),
			ansi: NO_ANSI,
		});
		writer.writeLine("test");
		writer.destroy();
		expect(chunks.join("")).toBe("test\n");
	});
});

// ---------------------------------------------------------------------------
// Thinking prefix (no-ANSI fallback)
// ---------------------------------------------------------------------------

describe("StreamWriter — thinking prefix (no-ANSI)", () => {
	test("emits > prefix on each reasoning line when color disabled", () => {
		const { writer, output } = capture(40, NO_ANSI);
		writer.writeThinking("line one\nline two");
		writer.destroy();
		expect(output()).toBe("> line one\n> line two\n");
	});

	test("no > prefix when color enabled (dim is sufficient)", () => {
		const { writer, output } = capture(40, DIM_ANSI);
		writer.writeThinking("thinking");
		writer.destroy();
		const out = output();
		expect(out).not.toContain("> ");
		expect(out).toContain("thinking");
	});

	test("> prefix emitted on wrap-inserted newlines", () => {
		const { writer, output } = capture(20, NO_ANSI);
		writer.writeThinking("one two three four five six");
		writer.destroy();
		const lines = output()
			.split("\n")
			.filter((l) => l.length > 0);
		for (const line of lines) {
			expect(line.startsWith("> ")).toBe(true);
		}
	});

	test("prefix stops after style transitions back to text", () => {
		const { writer, output } = capture(40, NO_ANSI);
		writer.writeThinking("reason");
		writer.writeText("\nnormal text");
		writer.destroy();
		const out = output();
		expect(out).toContain("> reason");
		expect(out).not.toContain("> normal text");
		expect(out).toContain("normal text");
	});
});

describe("StreamWriter — edge cases", () => {
	test("empty delta does not produce output", () => {
		const { writer, output } = capture(40);
		writer.writeText("");
		writer.destroy();
		// destroy on idle with col=0 should not emit a newline
		expect(output()).toBe("");
	});

	test("delta with only whitespace", () => {
		const { writer, output } = capture(40);
		writer.writeText("   ");
		writer.destroy();
		// Whitespace should be written as-is, then newline on destroy
		expect(output()).toBe("   \n");
	});

	test("delta with only newlines", () => {
		const { writer, output } = capture(40);
		writer.writeText("\n\n\n");
		writer.destroy();
		expect(output()).toBe("\n\n\n");
	});
});
