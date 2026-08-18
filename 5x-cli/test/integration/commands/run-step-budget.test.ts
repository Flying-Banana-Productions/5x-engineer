/**
 * Integration smoke tests for step-budget visibility and text remediation.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizePlanPath } from "../../../src/paths.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-step-budget-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function setupProject(dir: string): { planPath: string } {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(planPath, "# Test Plan\n\n## Phase 1\n\n- [ ] Do thing\n");
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(join(dir, "5x.toml"), "maxStepsPerRun = 5\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	return { planPath };
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run5x(cwd: string, args: string[]): CmdResult {
	const result = Bun.spawnSync(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
		exitCode: result.exitCode ?? 1,
	};
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

describe("5x run step budget (integration)", () => {
	test(
		"run state always includes budget fields; 80% record warns; max fails with remediation",
		() => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const init = run5x(dir, ["run", "init", "--plan", planPath]);
				expect(init.exitCode).toBe(0);
				const runId = (parseJson(init.stdout).data as { run_id: string })
					.run_id;

				const emptyState = run5x(dir, ["run", "state", "--run", runId]);
				expect(emptyState.exitCode).toBe(0);
				const emptyData = parseJson(emptyState.stdout).data as Record<
					string,
					unknown
				>;
				expect(emptyData.steps_used).toBe(0);
				expect(emptyData.max_steps).toBe(5);
				expect(emptyData.steps_remaining).toBe(5);

				const db = new Database(join(dir, ".5x", "5x.db"));
				for (let i = 0; i < 3; i++) {
					db.exec(
						`INSERT INTO steps (run_id, step_name, iteration, result_json)
						 VALUES ('${runId}', 'step-${i}', 1, '{}')`,
					);
				}
				db.close();

				const warn = run5x(dir, [
					"run",
					"record",
					"step-3",
					"--run",
					runId,
					"--result",
					"{}",
				]);
				expect(warn.exitCode).toBe(0);
				const warnData = parseJson(warn.stdout).data as Record<string, unknown>;
				expect(warnData.total_steps).toBe(4);
				expect(warnData.step_budget).toEqual({
					used: 4,
					max: 5,
					remaining: 1,
				});
				expect(warnData.warnings).toEqual([
					expect.stringContaining("Approaching maxStepsPerRun (4/5)"),
				]);

				const fifth = run5x(dir, [
					"run",
					"record",
					"step-4",
					"--run",
					runId,
					"--result",
					"{}",
				]);
				expect(fifth.exitCode).toBe(0);

				const overflow = run5x(dir, [
					"--text",
					"run",
					"record",
					"step-overflow",
					"--run",
					runId,
					"--result",
					"{}",
				]);
				expect(overflow.exitCode).toBe(6);
				expect(overflow.stderr).toContain("Error:");
				expect(overflow.stderr).toContain("  → Raise maxStepsPerRun");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"PLAN_LOCKED --text shows unlock --force remediation",
		() => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const canonical = canonicalizePlanPath(planPath);
				const hash = createHash("sha256")
					.update(canonical)
					.digest("hex")
					.slice(0, 16);
				mkdirSync(join(dir, ".5x", "locks"), { recursive: true });
				writeFileSync(
					join(dir, ".5x", "locks", `${hash}.lock`),
					JSON.stringify({
						pid: process.pid,
						startedAt: new Date().toISOString(),
						planPath: canonical,
					}),
				);

				const locked = run5x(dir, [
					"--text",
					"run",
					"init",
					"--plan",
					planPath,
				]);
				expect(locked.exitCode).toBe(4);
				expect(locked.stderr).toContain("Error:");
				expect(locked.stderr).toContain("  → ");
				expect(locked.stderr).toContain("unlock");
				expect(locked.stderr).toContain("--force");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
