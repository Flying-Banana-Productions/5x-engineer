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

async function run5x(
	args: string[],
	stdin?: string,
	env?: Record<string, string>,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin:
			stdin !== undefined
				? (new Response(stdin).body as ReadableStream)
				: "pipe",
		env: { ...process.env, ...env },
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/**
 * Run with 5X_FORCE_TTY=1 to exercise interactive code paths.
 * stdin content is piped in and then the pipe closes (triggering EOF after data).
 */
async function run5xInteractive(
	args: string[],
	stdin: string,
): Promise<CmdResult> {
	return run5x(args, stdin, { "5X_FORCE_TTY": "1" });
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

// ---------------------------------------------------------------------------
// Interactive choose (5X_FORCE_TTY=1)
// ---------------------------------------------------------------------------

describe("5x prompt choose (interactive)", () => {
	test("accepts numeric selection", async () => {
		const result = await run5xInteractive(
			["prompt", "choose", "Pick", "--options", "red,green,blue"],
			"2\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { choice: string }).choice).toBe("green");
	});

	test("accepts text selection (case-insensitive)", async () => {
		const result = await run5xInteractive(
			["prompt", "choose", "Pick", "--options", "red,green,blue"],
			"GREEN\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { choice: string }).choice).toBe("green");
	});

	test("empty input with default returns default", async () => {
		const result = await run5xInteractive(
			[
				"prompt",
				"choose",
				"Pick",
				"--options",
				"red,green,blue",
				"--default",
				"green",
			],
			"\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { choice: string }).choice).toBe("green");
	});

	test("invalid then valid input succeeds (reprompt)", async () => {
		// Send invalid input "xyz" first, then valid "1" — should reprompt and accept "1"
		const result = await run5xInteractive(
			["prompt", "choose", "Pick", "--options", "red,green,blue"],
			"xyz\n1\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { choice: string }).choice).toBe("red");
		// Verify reprompt message appeared on stderr
		expect(result.stderr).toContain("Invalid selection");
	});

	test("EOF with default returns default", async () => {
		// Empty stdin (pipe closes immediately) = EOF
		const result = await run5xInteractive(
			[
				"prompt",
				"choose",
				"Pick",
				"--options",
				"red,green,blue",
				"--default",
				"blue",
			],
			"",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { choice: string }).choice).toBe("blue");
	});

	test("EOF without default returns EOF error", async () => {
		const result = await run5xInteractive(
			["prompt", "choose", "Pick", "--options", "red,green,blue"],
			"",
		);
		expect(result.exitCode).toBe(3);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(false);
		expect((data.error as { code: string }).code).toBe("EOF");
	});
});

// ---------------------------------------------------------------------------
// Interactive confirm (5X_FORCE_TTY=1)
// ---------------------------------------------------------------------------

describe("5x prompt confirm (interactive)", () => {
	test("accepts 'y' input", async () => {
		const result = await run5xInteractive(
			["prompt", "confirm", "Continue?"],
			"y\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { confirmed: boolean }).confirmed).toBe(true);
	});

	test("accepts 'n' input", async () => {
		const result = await run5xInteractive(
			["prompt", "confirm", "Continue?"],
			"n\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { confirmed: boolean }).confirmed).toBe(false);
	});

	test("accepts 'yes' input (case-insensitive)", async () => {
		const result = await run5xInteractive(
			["prompt", "confirm", "Continue?"],
			"YES\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { confirmed: boolean }).confirmed).toBe(true);
	});

	test("empty input with default returns default", async () => {
		const result = await run5xInteractive(
			["prompt", "confirm", "Continue?", "--default", "yes"],
			"\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { confirmed: boolean }).confirmed).toBe(true);
	});

	test("invalid then valid input succeeds (reprompt)", async () => {
		// Send invalid "maybe" first, then valid "y"
		const result = await run5xInteractive(
			["prompt", "confirm", "Continue?"],
			"maybe\ny\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { confirmed: boolean }).confirmed).toBe(true);
		// Verify reprompt message appeared on stderr
		expect(result.stderr).toContain("Invalid input");
	});

	test("EOF with default returns default", async () => {
		const result = await run5xInteractive(
			["prompt", "confirm", "Continue?", "--default", "no"],
			"",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { confirmed: boolean }).confirmed).toBe(false);
	});

	test("EOF without default returns EOF error", async () => {
		const result = await run5xInteractive(
			["prompt", "confirm", "Continue?"],
			"",
		);
		expect(result.exitCode).toBe(3);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(false);
		expect((data.error as { code: string }).code).toBe("EOF");
	});
});

// ---------------------------------------------------------------------------
// Interactive input (5X_FORCE_TTY=1)
// ---------------------------------------------------------------------------

describe("5x prompt input (interactive)", () => {
	test("reads single line interactively", async () => {
		const result = await run5xInteractive(
			["prompt", "input", "Enter text"],
			"hello\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { input: string }).input).toBe("hello");
	});

	test("EOF on single-line input returns empty string", async () => {
		const result = await run5xInteractive(
			["prompt", "input", "Enter text"],
			"",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { input: string }).input).toBe("");
	});

	test("reads multiline interactively (Ctrl+D / EOF terminates)", async () => {
		const result = await run5xInteractive(
			["prompt", "input", "Enter text", "--multiline"],
			"line one\nline two\n",
		);
		expect(result.exitCode).toBe(0);
		const data = parseJson(result.stdout);
		expect(data.ok).toBe(true);
		expect((data.data as { input: string }).input).toBe("line one\nline two\n");
	});
});
