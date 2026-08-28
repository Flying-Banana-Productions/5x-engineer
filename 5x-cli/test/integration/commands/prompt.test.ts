/**
 * Integration tests for `5x prompt` — CLI envelopes, temp-project persistence,
 * `--run` / `--timeout`, pipe races, and kind-aware EOF.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqlitePromptStore } from "../../../src/control-plane/index.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { generateRunId } from "../../../src/run-id.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface PromptRow {
	id: string;
	run_id: string | null;
	kind: string;
	answer: string | null;
	answered_by: string | null;
	answered_at: string | null;
	abandoned_at: string | null;
	abandon_reason: string | null;
}

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-prompt-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

function setupProject(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	const db = new Database(join(dir, ".5x", "5x.db"));
	runMigrations(db);
	db.close();
}

function dbPath(dir: string): string {
	return join(dir, ".5x", "5x.db");
}

function loadPrompts(dir: string): PromptRow[] {
	const db = new Database(dbPath(dir));
	const rows = db.query("SELECT * FROM prompts").all() as PromptRow[];
	db.close();
	return rows;
}

async function run5x(
	dir: string,
	args: string[],
	stdin?: string,
	env?: Record<string, string>,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		stdin:
			stdin !== undefined
				? (new Response(stdin).body as ReadableStream)
				: "ignore",
		env: { ...cleanGitEnv(), ...env },
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function run5xInteractive(
	dir: string,
	args: string[],
	stdin: string,
): Promise<CmdResult> {
	return run5x(dir, args, stdin, { "5X_FORCE_TTY": "1" });
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

async function withProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = makeTmpDir();
	try {
		setupProject(dir);
		return await fn(dir);
	} finally {
		cleanupDir(dir);
	}
}

// ---------------------------------------------------------------------------
// prompt choose
// ---------------------------------------------------------------------------

describe("5x prompt choose", () => {
	test(
		"returns default when non-interactive with --default",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
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
		},
		{ timeout: 15000 },
	);

	test(
		"after --default success, SQLite has one answered row answered_by = default",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"choose",
					"Pick a color",
					"--options",
					"red,green,blue",
					"--default",
					"green",
				]);
				expect(result.exitCode).toBe(0);
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.answered_by).toBe("default");
				expect(rows[0]?.answer).toBe("green");
				expect(rows[0]?.abandoned_at).toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"returns NON_INTERACTIVE when no default in non-TTY mode",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
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
		},
		{ timeout: 15000 },
	);

	test(
		"after NON_INTERACTIVE, row is abandoned not open",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"choose",
					"Pick a color",
					"--options",
					"red,green,blue",
				]);
				expect(result.exitCode).toBe(3);
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.abandon_reason).toBe("non-interactive");
				expect(rows[0]?.answered_at).toBeNull();
				expect(rows[0]?.abandoned_at).not.toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"returns INVALID_DEFAULT when default not in options",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
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
				expect(loadPrompts(dir)).toHaveLength(0);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"returns INVALID_OPTIONS when options list is empty",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"choose",
					"Pick",
					"--options",
					"",
				]);
				expect(result.exitCode).not.toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string };
				expect(error.code).toBe("INVALID_OPTIONS");
				expect(loadPrompts(dir)).toHaveLength(0);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"handles options with spaces after commas",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
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
		},
		{ timeout: 15000 },
	);

	test(
		"--run + real createRunV1 sets run_id",
		async () => {
			await withProject(async (dir) => {
				const runId = generateRunId();
				const db = new Database(dbPath(dir));
				createRunV1(db, { id: runId, planPath: "plan.md" });
				db.close();
				const result = await run5x(dir, [
					"prompt",
					"choose",
					"Pick",
					"--options",
					"a,b",
					"--default",
					"a",
					"--run",
					runId,
				]);
				expect(result.exitCode).toBe(0);
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.run_id).toBe(runId);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"--run unknown: RUN_NOT_FOUND, no prompt row",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"choose",
					"Pick",
					"--options",
					"a,b",
					"--run",
					"run_doesnotexist",
				]);
				expect(result.exitCode).not.toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				expect((data.error as { code: string }).code).toBe("RUN_NOT_FOUND");
				expect(loadPrompts(dir)).toHaveLength(0);
			});
		},
		{ timeout: 15000 },
	);

	test(
		'empty --run "": RUN_NOT_FOUND, no prompt row',
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"choose",
					"Pick",
					"--options",
					"a,b",
					"--run",
					"",
				]);
				expect(result.exitCode).not.toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				expect((data.error as { code: string }).code).toBe("RUN_NOT_FOUND");
				expect(loadPrompts(dir)).toHaveLength(0);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"--timeout abc and --timeout -1 exit non-zero with INVALID_ARGS and insert no prompt row",
		async () => {
			await withProject(async (dir) => {
				for (const bad of ["abc", "-1"]) {
					const result = await run5x(dir, [
						"prompt",
						"choose",
						"Pick",
						"--options",
						"a,b",
						"--timeout",
						bad,
					]);
					expect(result.exitCode).not.toBe(0);
					const data = parseJson(result.stdout);
					expect(data.ok).toBe(false);
					expect((data.error as { code: string }).code).toBe("INVALID_ARGS");
					expect(loadPrompts(dir)).toHaveLength(0);
				}
			});
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// prompt confirm
// ---------------------------------------------------------------------------

describe("5x prompt confirm", () => {
	test(
		"returns default=yes when non-interactive",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
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
		},
		{ timeout: 15000 },
	);

	test(
		"returns default=no when non-interactive",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
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
		},
		{ timeout: 15000 },
	);

	test(
		"returns NON_INTERACTIVE when no default in non-TTY mode",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, ["prompt", "confirm", "Continue?"]);
				expect(result.exitCode).toBe(3);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string };
				expect(error.code).toBe("NON_INTERACTIVE");
			});
		},
		{ timeout: 15000 },
	);

	test(
		"returns INVALID_DEFAULT for bad default value",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
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
		},
		{ timeout: 15000 },
	);

	test(
		"accepts 'y' as default",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"confirm",
					"OK?",
					"--default",
					"y",
				]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { confirmed: boolean };
				expect(payload.confirmed).toBe(true);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"accepts 'n' as default",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"confirm",
					"OK?",
					"--default",
					"n",
				]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { confirmed: boolean };
				expect(payload.confirmed).toBe(false);
			});
		},
		{ timeout: 15000 },
	);

	test(
		'empty --run "": RUN_NOT_FOUND, no prompt row',
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"confirm",
					"OK?",
					"--run",
					"",
				]);
				expect(result.exitCode).not.toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				expect((data.error as { code: string }).code).toBe("RUN_NOT_FOUND");
				expect(loadPrompts(dir)).toHaveLength(0);
			});
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// prompt input
// ---------------------------------------------------------------------------

describe("5x prompt input", () => {
	test(
		"reads single line from stdin pipe",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(
					dir,
					["prompt", "input", "Enter text"],
					"hello world\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { input: string };
				expect(payload.input).toBe("hello world\n");
			});
		},
		{ timeout: 15000 },
	);

	test(
		"reads multiline from stdin pipe",
		async () => {
			await withProject(async (dir) => {
				const input = "line one\nline two\nline three\n";
				const result = await run5x(
					dir,
					["prompt", "input", "Enter text", "--multiline"],
					input,
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { input: string };
				expect(payload.input).toBe(input);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"reads empty stdin pipe",
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, ["prompt", "input", "Enter text"], "");
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { input: string };
				expect(payload.input).toBe("");
			});
		},
		{ timeout: 15000 },
	);

	test(
		"preserves whitespace from stdin pipe",
		async () => {
			await withProject(async (dir) => {
				const input = "  indented\n\ttabbed\n";
				const result = await run5x(
					dir,
					["prompt", "input", "Enter text"],
					input,
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { input: string };
				expect(payload.input).toBe(input);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"no-TTY input hanging pipe + --timeout 50: PROMPT_TIMEOUT, row abandoned timeout",
		async () => {
			await withProject(async (dir) => {
				const proc = Bun.spawn(
					[
						"bun",
						"run",
						BIN,
						"prompt",
						"input",
						"Enter text",
						"--timeout",
						"50",
					],
					{
						cwd: dir,
						stdout: "pipe",
						stderr: "pipe",
						stdin: "pipe",
						env: cleanGitEnv(),
					},
				);
				const [stdout, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					proc.exited,
				]);
				expect(exitCode).toBe(3);
				const data = parseJson(stdout.trim());
				expect(data.ok).toBe(false);
				expect((data.error as { code: string }).code).toBe("PROMPT_TIMEOUT");
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.abandon_reason).toBe("timeout");
				expect(rows[0]?.abandoned_at).not.toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"no-TTY input hanging pipe: second process answerPrompt wins with stored { input }",
		async () => {
			await withProject(async (dir) => {
				const proc = Bun.spawn(
					["bun", "run", BIN, "prompt", "input", "Enter text"],
					{
						cwd: dir,
						stdout: "pipe",
						stderr: "pipe",
						stdin: "pipe",
						env: cleanGitEnv(),
					},
				);
				let promptId: string | undefined;
				const start = Date.now();
				while (Date.now() - start < 8000) {
					try {
						const rows = loadPrompts(dir);
						if (rows[0]?.id && rows[0].answered_at === null) {
							promptId = rows[0].id;
							break;
						}
					} catch {
						// DB may not be visible yet
					}
					await Bun.sleep(20);
				}
				expect(promptId).toBeDefined();
				if (promptId === undefined) {
					proc.kill();
					throw new Error("prompt row did not appear");
				}
				const db = new Database(dbPath(dir));
				db.exec("PRAGMA busy_timeout=5000");
				createSqlitePromptStore(db).answerPrompt(
					promptId,
					"from-control-plane",
					"control-plane",
				);
				db.close();
				const [stdout, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					proc.exited,
				]);
				expect(exitCode).toBe(0);
				const data = parseJson(stdout.trim());
				expect(data.ok).toBe(true);
				expect((data.data as { input: string }).input).toBe(
					"from-control-plane",
				);
			});
		},
		{ timeout: 15000 },
	);

	test(
		'empty --run "": RUN_NOT_FOUND, no prompt row',
		async () => {
			await withProject(async (dir) => {
				const result = await run5x(dir, [
					"prompt",
					"input",
					"Enter text",
					"--run",
					"",
				]);
				expect(result.exitCode).not.toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				expect((data.error as { code: string }).code).toBe("RUN_NOT_FOUND");
				expect(loadPrompts(dir)).toHaveLength(0);
			});
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Interactive choose (5X_FORCE_TTY=1)
// ---------------------------------------------------------------------------

describe("5x prompt choose (interactive)", () => {
	test(
		"accepts numeric selection",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "choose", "Pick", "--options", "red,green,blue"],
					"2\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { choice: string }).choice).toBe("green");
			});
		},
		{ timeout: 15000 },
	);

	test(
		"accepts text selection (case-insensitive)",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "choose", "Pick", "--options", "red,green,blue"],
					"GREEN\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { choice: string }).choice).toBe("green");
			});
		},
		{ timeout: 15000 },
	);

	test(
		"empty input with default returns default",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
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
		},
		{ timeout: 15000 },
	);

	test(
		"invalid then valid input succeeds (reprompt)",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "choose", "Pick", "--options", "red,green,blue"],
					"xyz\n1\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { choice: string }).choice).toBe("red");
				expect(result.stderr).toContain("Invalid selection");
			});
		},
		{ timeout: 15000 },
	);

	test(
		"EOF with default returns default",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
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
		},
		{ timeout: 15000 },
	);

	test(
		"EOF without default returns EOF error; row abandoned eof",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "choose", "Pick", "--options", "red,green,blue"],
					"",
				);
				expect(result.exitCode).toBe(3);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				expect((data.error as { code: string }).code).toBe("EOF");
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.abandon_reason).toBe("eof");
			});
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Interactive confirm (5X_FORCE_TTY=1)
// ---------------------------------------------------------------------------

describe("5x prompt confirm (interactive)", () => {
	test(
		"accepts 'y' input",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "confirm", "Continue?"],
					"y\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { confirmed: boolean }).confirmed).toBe(true);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"accepts 'n' input",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "confirm", "Continue?"],
					"n\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { confirmed: boolean }).confirmed).toBe(false);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"accepts 'yes' input (case-insensitive)",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "confirm", "Continue?"],
					"YES\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { confirmed: boolean }).confirmed).toBe(true);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"empty input with default returns default",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "confirm", "Continue?", "--default", "yes"],
					"\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { confirmed: boolean }).confirmed).toBe(true);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"invalid then valid input succeeds (reprompt)",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "confirm", "Continue?"],
					"maybe\ny\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { confirmed: boolean }).confirmed).toBe(true);
				expect(result.stderr).toContain("Invalid input");
			});
		},
		{ timeout: 15000 },
	);

	test(
		"EOF with default returns default",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "confirm", "Continue?", "--default", "no"],
					"",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { confirmed: boolean }).confirmed).toBe(false);
			});
		},
		{ timeout: 15000 },
	);

	test(
		"EOF without default returns EOF error; row abandoned eof",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "confirm", "Continue?"],
					"",
				);
				expect(result.exitCode).toBe(3);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				expect((data.error as { code: string }).code).toBe("EOF");
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.abandon_reason).toBe("eof");
			});
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Interactive input (5X_FORCE_TTY=1)
// ---------------------------------------------------------------------------

describe("5x prompt input (interactive)", () => {
	test(
		"reads single line interactively",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "input", "Enter text"],
					"hello\n",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { input: string }).input).toBe("hello");
			});
		},
		{ timeout: 15000 },
	);

	test(
		"EOF on single-line input returns empty string; row answered terminal",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "input", "Enter text"],
					"",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { input: string }).input).toBe("");
				expect((data.error as { code: string } | undefined)?.code).not.toBe(
					"EOF",
				);
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.answered_by).toBe("terminal");
				expect(rows[0]?.answer).toBe("");
				expect(rows[0]?.abandoned_at).toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"reads multiline interactively (Ctrl+D / EOF terminates); row answered terminal",
		async () => {
			await withProject(async (dir) => {
				const collected = "line one\nline two\n";
				const result = await run5xInteractive(
					dir,
					["prompt", "input", "Enter text", "--multiline"],
					collected,
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { input: string }).input).toBe(collected);
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.answered_by).toBe("terminal");
				expect(rows[0]?.answer).toBe(collected);
				expect(rows[0]?.abandoned_at).toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"interactive multiline immediate EOF: { input: '' }, answered terminal, not abandoned",
		async () => {
			await withProject(async (dir) => {
				const result = await run5xInteractive(
					dir,
					["prompt", "input", "Enter text", "--multiline"],
					"",
				);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { input: string }).input).toBe("");
				expect((data.error as { code: string } | undefined)?.code).not.toBe(
					"EOF",
				);
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.answered_by).toBe("terminal");
				expect(rows[0]?.abandoned_at).toBeNull();
			});
		},
		{ timeout: 15000 },
	);
});
