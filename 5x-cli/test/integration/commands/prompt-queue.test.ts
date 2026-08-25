/**
 * Phase 7 prompt-queue gates: real-process SIGINT/SIGTERM, poll-only
 * interrupt, TTY timeout, pipe vs store, doctor orphan --fix, and
 * `5x run watch` SIGINT still exits 0.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqlitePromptStore } from "../../../src/control-plane/index.js";
import { completeRun, createRunV1 } from "../../../src/db/operations-v1.js";
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

function makeTmpDir(prefix: string): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
	mkdirSync(join(dir, "docs", "development"), { recursive: true });
	writeFileSync(
		join(dir, "docs", "development", "test-plan.md"),
		"# Plan\n\n## Phase 1\n\n- [ ] Task\n",
	);
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
	db.exec("PRAGMA busy_timeout=5000");
	const rows = db.query("SELECT * FROM prompts").all() as PromptRow[];
	db.close();
	return rows;
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function errorCode(stdout: string): string | undefined {
	const data = parseJson(stdout);
	return (data.error as { code?: string } | undefined)?.code;
}

async function waitForOpenPrompt(dir: string, ms = 8000): Promise<PromptRow> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		try {
			const open = loadPrompts(dir).find(
				(row) => row.answered_at === null && row.abandoned_at === null,
			);
			if (open) return open;
		} catch {
			// DB may not be visible yet
		}
		await Bun.sleep(20);
	}
	throw new Error("open prompt row did not appear");
}

async function withProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = makeTmpDir("5x-prompt-queue");
	try {
		setupProject(dir);
		return await fn(dir);
	} finally {
		cleanupDir(dir);
	}
}

function spawnPrompt(
	dir: string,
	args: string[],
	opts?: { forceTty?: boolean; stdin?: "pipe" | "ignore" },
): ReturnType<typeof Bun.spawn> {
	return Bun.spawn(["bun", "run", BIN, ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		stdin: opts?.stdin ?? "pipe",
		env: {
			...cleanGitEnv(),
			...(opts?.forceTty ? { "5X_FORCE_TTY": "1" } : {}),
		},
	});
}

async function collect(proc: ReturnType<typeof Bun.spawn>): Promise<CmdResult> {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function killLater(proc: ReturnType<typeof Bun.spawn>, ms: number): void {
	setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// already exited
		}
	}, ms);
}

describe("prompt-queue CAS / timeout CLI", () => {
	test(
		"--timeout 50 TTY with no input: PROMPT_TIMEOUT, row abandoned timeout",
		async () => {
			await withProject(async (dir) => {
				const proc = spawnPrompt(
					dir,
					["prompt", "choose", "Pick", "--options", "a,b", "--timeout", "50"],
					{ forceTty: true, stdin: "pipe" },
				);
				killLater(proc, 12000);
				const result = await collect(proc);
				expect(result.exitCode).toBe(3);
				expect(errorCode(result.stdout)).toBe("PROMPT_TIMEOUT");
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.abandon_reason).toBe("timeout");
				expect(rows[0]?.abandoned_at).not.toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"no-TTY input hanging pipe + --timeout: PROMPT_TIMEOUT, row abandoned timeout",
		async () => {
			await withProject(async (dir) => {
				const proc = spawnPrompt(
					dir,
					["prompt", "input", "Enter text", "--timeout", "50"],
					{ stdin: "pipe" },
				);
				killLater(proc, 12000);
				const result = await collect(proc);
				expect(result.exitCode).toBe(3);
				expect(errorCode(result.stdout)).toBe("PROMPT_TIMEOUT");
				const rows = loadPrompts(dir);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.abandon_reason).toBe("timeout");
				expect(rows[0]?.abandoned_at).not.toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"no-TTY input hanging pipe + control-plane answerPrompt: stored { input }",
		async () => {
			await withProject(async (dir) => {
				const proc = spawnPrompt(dir, ["prompt", "input", "Enter text"], {
					stdin: "pipe",
				});
				killLater(proc, 12000);
				const open = await waitForOpenPrompt(dir);
				const db = new Database(dbPath(dir));
				db.exec("PRAGMA busy_timeout=5000");
				createSqlitePromptStore(db).answerPrompt(
					open.id,
					"from-control-plane",
					"control-plane",
				);
				db.close();
				const result = await collect(proc);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				expect((data.data as { input: string }).input).toBe(
					"from-control-plane",
				);
			});
		},
		{ timeout: 15000 },
	);
});

describe("prompt-queue real-process lifecycle", () => {
	test(
		"SIGINT on waiting TTY prompt: exit 130, INTERRUPTED, abandoned interrupted",
		async () => {
			await withProject(async (dir) => {
				const proc = spawnPrompt(
					dir,
					["prompt", "choose", "Pick", "--options", "a,b"],
					{ forceTty: true, stdin: "pipe" },
				);
				killLater(proc, 12000);
				const open = await waitForOpenPrompt(dir);
				proc.kill("SIGINT");
				const result = await collect(proc);
				expect(result.exitCode).toBe(130);
				expect(errorCode(result.stdout)).toBe("INTERRUPTED");
				const row = loadPrompts(dir).find((r) => r.id === open.id);
				expect(row?.abandon_reason).toBe("interrupted");
				expect(row?.abandoned_at).not.toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"SIGTERM on waiting TTY prompt: exit 143, TERMINATED, abandoned interrupted",
		async () => {
			await withProject(async (dir) => {
				const proc = spawnPrompt(
					dir,
					["prompt", "choose", "Pick", "--options", "a,b"],
					{ forceTty: true, stdin: "pipe" },
				);
				killLater(proc, 12000);
				const open = await waitForOpenPrompt(dir);
				proc.kill("SIGTERM");
				const result = await collect(proc);
				expect(result.exitCode).toBe(143);
				expect(errorCode(result.stdout)).toBe("TERMINATED");
				const row = loadPrompts(dir).find((r) => r.id === open.id);
				expect(row?.abandon_reason).toBe("interrupted");
				expect(row?.abandoned_at).not.toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"poll-only SIGINT (no-TTY choose + timeout, no default): exit 130, INTERRUPTED",
		async () => {
			await withProject(async (dir) => {
				const proc = spawnPrompt(
					dir,
					[
						"prompt",
						"choose",
						"Pick",
						"--options",
						"a,b",
						"--timeout",
						"30000",
					],
					{ stdin: "ignore" },
				);
				killLater(proc, 12000);
				const open = await waitForOpenPrompt(dir);
				proc.kill("SIGINT");
				const result = await collect(proc);
				expect(result.exitCode).toBe(130);
				expect(errorCode(result.stdout)).toBe("INTERRUPTED");
				const row = loadPrompts(dir).find((r) => r.id === open.id);
				expect(row?.abandon_reason).toBe("interrupted");
				expect(row?.abandoned_at).not.toBeNull();
			});
		},
		{ timeout: 15000 },
	);

	test(
		"second SIGINT while abandoning still exits 130 without hanging",
		async () => {
			await withProject(async (dir) => {
				const proc = spawnPrompt(
					dir,
					["prompt", "choose", "Pick", "--options", "a,b"],
					{ forceTty: true, stdin: "pipe" },
				);
				killLater(proc, 12000);
				await waitForOpenPrompt(dir);
				proc.kill("SIGINT");
				try {
					proc.kill("SIGINT");
				} catch {
					// process may already have begun exiting
				}
				const result = await collect(proc);
				expect(result.exitCode).toBe(130);
			});
		},
		{ timeout: 15000 },
	);
});

describe("prompt-queue doctor orphan --fix", () => {
	test(
		"5x doctor reports PROMPT_ORPHANED; --fix lists it under fixed; re-run is clean",
		async () => {
			await withProject(async (dir) => {
				const runId = generateRunId();
				const db = new Database(dbPath(dir));
				createRunV1(db, { id: runId, planPath: "plan.md" });
				const prompt = createSqlitePromptStore(db).createPrompt({
					runId,
					kind: "choose",
					message: "Pick",
					options: ["a", "b"],
				});
				completeRun(db, runId, "completed");
				db.close();

				const detected = Bun.spawnSync(["bun", "run", BIN, "doctor"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(detected.exitCode).toBe(1);
				const report = parseJson(detected.stdout.toString()).data as {
					ok: boolean;
					checks: Array<Record<string, unknown>>;
					fixed: Array<Record<string, unknown>>;
				};
				expect(report.ok).toBe(false);
				expect(
					report.checks.some(
						(c) =>
							c.code === "PROMPT_ORPHANED" &&
							(c.detail as { promptId?: string } | undefined)?.promptId ===
								prompt.id,
					),
				).toBe(true);

				const fixed = Bun.spawnSync(["bun", "run", BIN, "doctor", "--fix"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(fixed.exitCode).toBe(0);
				const fixedReport = parseJson(fixed.stdout.toString()).data as {
					ok: boolean;
					checks: Array<Record<string, unknown>>;
					fixed: Array<Record<string, unknown>>;
				};
				expect(fixedReport.ok).toBe(true);
				expect(
					fixedReport.fixed.some((f) => f.code === "PROMPT_ORPHANED"),
				).toBe(true);

				const again = Bun.spawnSync(["bun", "run", BIN, "doctor"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(again.exitCode).toBe(0);
				const clean = parseJson(again.stdout.toString()).data as {
					ok: boolean;
					checks: Array<Record<string, unknown>>;
				};
				expect(clean.ok).toBe(true);
				expect(clean.checks.some((c) => c.code === "PROMPT_ORPHANED")).toBe(
					false,
				);
				expect(clean.checks.some((c) => c.code === "PROMPTS_OK")).toBe(true);

				const row = loadPrompts(dir).find((r) => r.id === prompt.id);
				expect(row?.abandon_reason).toBe("run-terminal");
				expect(row?.abandoned_at).not.toBeNull();
			});
		},
		{ timeout: 15000 },
	);
});

describe("prompt-queue run watch SIGINT compatibility", () => {
	test(
		"5x run watch SIGINT still exits 0 (does not force 130)",
		async () => {
			await withProject(async (dir) => {
				const init = Bun.spawnSync(
					[
						"bun",
						"run",
						BIN,
						"run",
						"init",
						"--plan",
						"docs/development/test-plan.md",
					],
					{
						cwd: dir,
						env: cleanGitEnv(),
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(init.exitCode).toBe(0);
				const initJson = parseJson(init.stdout.toString());
				const runId = (initJson.data as { run_id: string }).run_id;

				const logDir = join(dir, ".5x", "logs", runId);
				mkdirSync(logDir, { recursive: true });
				writeFileSync(
					join(logDir, "agent-001.ndjson"),
					`${JSON.stringify({ ts: "2026-01-01T00:00:00Z", type: "text", delta: "hello" })}\n`,
				);

				const proc = Bun.spawn(
					[
						"bun",
						"run",
						BIN,
						"run",
						"watch",
						"--run",
						runId,
						"--poll-interval",
						"10",
					],
					{
						cwd: dir,
						env: cleanGitEnv(),
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				killLater(proc, 12000);

				let stdout = "";
				let killed = false;
				const decoder = new TextDecoder();
				const readStdout = async () => {
					for await (const chunk of proc.stdout) {
						stdout += decoder.decode(chunk, { stream: true });
						if (stdout.includes("hello") && !killed) {
							killed = true;
							proc.kill("SIGINT");
						}
					}
				};
				const drainStderr = new Response(proc.stderr).text();
				const started = Date.now();
				const watchdog = setInterval(() => {
					if (!killed && Date.now() - started > 8000) {
						killed = true;
						proc.kill("SIGINT");
					}
				}, 50);
				const [, , exitCode] = await Promise.all([
					readStdout(),
					drainStderr,
					proc.exited,
				]);
				clearInterval(watchdog);
				expect(exitCode).toBe(0);
				expect(exitCode).not.toBe(130);
			});
		},
		{ timeout: 15000 },
	);
});
