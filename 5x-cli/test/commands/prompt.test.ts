import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(args: string[], stdin?: string): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin:
			stdin !== undefined
				? (new Response(stdin).body as ReadableStream)
				: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// prompt choose
// ---------------------------------------------------------------------------

describe("5x prompt choose", () => {
	test("returns default when non-interactive with --default", async () => {
		const result = await run5x([
			"prompt",
			"choose",
			"Pick a color",
			"--options",
			"red,green,blue",
			"--default",
			"green",
		]);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { choice: string };
		expect(payload.choice).toBe("green");
	});

	test("returns NON_INTERACTIVE when no default in non-TTY mode", async () => {
		const result = await run5x([
			"prompt",
			"choose",
			"Pick a color",
			"--options",
			"red,green,blue",
		]);
		expect(result.exitCode).toBe(3);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(false);
		const error = data.error as { code: string };
		expect(error.code).toBe("NON_INTERACTIVE");
	});

	test("returns INVALID_DEFAULT when default not in options", async () => {
		const result = await run5x([
			"prompt",
			"choose",
			"Pick a color",
			"--options",
			"red,green,blue",
			"--default",
			"purple",
		]);
		expect(result.exitCode).not.toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(false);
		const error = data.error as { code: string };
		expect(error.code).toBe("INVALID_DEFAULT");
	});

	test("returns INVALID_OPTIONS when options list is empty", async () => {
		const result = await run5x(["prompt", "choose", "Pick", "--options", ""]);
		expect(result.exitCode).not.toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(false);
		const error = data.error as { code: string };
		expect(error.code).toBe("INVALID_OPTIONS");
	});

	test("handles options with spaces after commas", async () => {
		const result = await run5x([
			"prompt",
			"choose",
			"Pick a fruit",
			"--options",
			"apple, banana, cherry",
			"--default",
			"banana",
		]);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { choice: string };
		expect(payload.choice).toBe("banana");
	});
});

// ---------------------------------------------------------------------------
// prompt confirm
// ---------------------------------------------------------------------------

describe("5x prompt confirm", () => {
	test("returns default=yes when non-interactive", async () => {
		const result = await run5x([
			"prompt",
			"confirm",
			"Continue?",
			"--default",
			"yes",
		]);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { confirmed: boolean };
		expect(payload.confirmed).toBe(true);
	});

	test("returns default=no when non-interactive", async () => {
		const result = await run5x([
			"prompt",
			"confirm",
			"Continue?",
			"--default",
			"no",
		]);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { confirmed: boolean };
		expect(payload.confirmed).toBe(false);
	});

	test("returns NON_INTERACTIVE when no default in non-TTY mode", async () => {
		const result = await run5x(["prompt", "confirm", "Continue?"]);
		expect(result.exitCode).toBe(3);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(false);
		const error = data.error as { code: string };
		expect(error.code).toBe("NON_INTERACTIVE");
	});

	test("returns INVALID_DEFAULT for bad default value", async () => {
		const result = await run5x([
			"prompt",
			"confirm",
			"Continue?",
			"--default",
			"maybe",
		]);
		expect(result.exitCode).not.toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(false);
		const error = data.error as { code: string };
		expect(error.code).toBe("INVALID_DEFAULT");
	});

	test("accepts 'y' as default", async () => {
		const result = await run5x(["prompt", "confirm", "OK?", "--default", "y"]);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { confirmed: boolean };
		expect(payload.confirmed).toBe(true);
	});

	test("accepts 'n' as default", async () => {
		const result = await run5x(["prompt", "confirm", "OK?", "--default", "n"]);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { confirmed: boolean };
		expect(payload.confirmed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// prompt input
// ---------------------------------------------------------------------------

describe("5x prompt input", () => {
	test("reads single line from stdin pipe", async () => {
		const result = await run5x(
			["prompt", "input", "Enter text"],
			"hello world\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { input: string };
		expect(payload.input).toBe("hello world\n");
	});

	test("reads multiline from stdin pipe", async () => {
		const input = "line one\nline two\nline three\n";
		const result = await run5x(
			["prompt", "input", "Enter text", "--multiline"],
			input,
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { input: string };
		expect(payload.input).toBe(input);
	});

	test("reads empty stdin pipe", async () => {
		const result = await run5x(["prompt", "input", "Enter text"], "");
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { input: string };
		expect(payload.input).toBe("");
	});

	test("preserves whitespace from stdin pipe", async () => {
		const input = "  indented\n\ttabbed\n";
		const result = await run5x(["prompt", "input", "Enter text"], input);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		const payload = data.data as { input: string };
		expect(payload.input).toBe(input);
	});
});
