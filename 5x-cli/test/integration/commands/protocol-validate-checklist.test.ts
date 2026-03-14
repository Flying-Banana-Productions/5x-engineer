/**
 * Integration test for `5x protocol validate author` checklist gate.
 *
 * Tests that the CLI subprocess correctly validates phase checklist
 * completion when --plan is provided, including fail-closed behavior
 * for explicit inputs and PHASE_CHECKLIST_INCOMPLETE errors.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../../../src/db/schema.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-pv-checklist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5xWithStdin(
	cwd: string,
	args: string[],
	stdinData: string,
	timeoutMs = 15000,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(stdinData);
	proc.stdin.end();
	const timer = setTimeout(() => proc.kill("SIGINT"), timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function setupProject(dir: string): void {
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	mkdirSync(join(dir, ".5x"), { recursive: true });
	const db = new Database(join(dir, ".5x", "5x.db"));
	runMigrations(db);
	db.close();

	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n',
	);

	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

function insertRun(dir: string, runId: string, planPath: string): void {
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.run(
		`INSERT INTO runs (id, plan_path, status, config_json, created_at, updated_at)
		 VALUES (?1, ?2, 'active', '{}', datetime('now'), datetime('now'))`,
		[runId, planPath],
	);
	db.close();
}

function writePlan(
	dir: string,
	filename: string,
	phases: Array<{
		number: string;
		title: string;
		items: Array<{ text: string; checked: boolean }>;
	}>,
): string {
	const lines = ["# Test Plan\n", "**Version:** 1.0\n", "**Status:** Draft\n"];
	for (const phase of phases) {
		lines.push(`\n## Phase ${phase.number}: ${phase.title}\n`);
		lines.push("**Completion gate:** All items checked.\n");
		for (const item of phase.items) {
			lines.push(`- [${item.checked ? "x" : " "}] ${item.text}`);
		}
		lines.push("");
	}
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, filename);
	writeFileSync(planPath, lines.join("\n"));
	return planPath;
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("5x protocol validate author — checklist gate (integration)", () => {
	test(
		"--plan with incomplete phase emits PHASE_CHECKLIST_INCOMPLETE",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = writePlan(dir, "test-plan.md", [
					{
						number: "1",
						title: "Setup",
						items: [
							{ text: "Create config", checked: true },
							{ text: "Add tests", checked: false },
						],
					},
				]);

				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--plan",
						planPath,
						"--phase",
						"Phase 1: Setup",
					],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("PHASE_CHECKLIST_INCOMPLETE");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--plan with complete phase succeeds",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = writePlan(dir, "test-plan.md", [
					{
						number: "1",
						title: "Setup",
						items: [
							{ text: "Create config", checked: true },
							{ text: "Add tests", checked: true },
						],
					},
				]);

				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--plan",
						planPath,
						"--phase",
						"Phase 1: Setup",
					],
					input,
				);

				expect(result.exitCode).toBe(0);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--no-phase-checklist-validate suppresses the check",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = writePlan(dir, "test-plan.md", [
					{
						number: "1",
						title: "Setup",
						items: [{ text: "Add tests", checked: false }],
					},
				]);

				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--plan",
						planPath,
						"--phase",
						"Phase 1: Setup",
						"--no-phase-checklist-validate",
					],
					input,
				);

				expect(result.exitCode).toBe(0);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--run with incomplete checklist emits PHASE_CHECKLIST_INCOMPLETE",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = writePlan(dir, "test-plan.md", [
					{
						number: "1",
						title: "Setup",
						items: [
							{ text: "Create config", checked: true },
							{ text: "Add tests", checked: false },
						],
					},
				]);
				const runId = "run_checklist_integ001";
				insertRun(dir, runId, planPath);

				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--run",
						runId,
						"--phase",
						"Phase 1: Setup",
					],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("PHASE_CHECKLIST_INCOMPLETE");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--run with auto-discovered plan + explicit --phase not found → PHASE_NOT_FOUND (fail-closed)",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = writePlan(dir, "test-plan.md", [
					{
						number: "1",
						title: "Setup",
						items: [{ text: "Create config", checked: true }],
					},
				]);
				const runId = "run_checklist_phase404";
				insertRun(dir, runId, planPath);

				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--run",
						runId,
						"--phase",
						"Phase 99: Nonexistent",
					],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("PHASE_NOT_FOUND");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--plan with non-existent file → PLAN_NOT_FOUND",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const input = JSON.stringify({
					result: "complete",
					commit: "abc123",
				});

				const result = await run5xWithStdin(
					dir,
					[
						"protocol",
						"validate",
						"author",
						"--plan",
						join(dir, "nonexistent.md"),
						"--phase",
						"Phase 1",
					],
					input,
				);

				expect(result.exitCode).not.toBe(0);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("PLAN_NOT_FOUND");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});
