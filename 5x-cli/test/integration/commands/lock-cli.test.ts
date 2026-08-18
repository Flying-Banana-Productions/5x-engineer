/**
 * Integration tests for `5x lock list` and `5x unlock` via CLI spawn.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizePlanPath } from "../../../src/paths.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");
const DEAD_PID = 99999999;

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-lock-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function canonicalLockPath(projectRoot: string, planPath: string): string {
	const canonical = canonicalizePlanPath(planPath);
	const hash = createHash("sha256")
		.update(canonical)
		.digest("hex")
		.slice(0, 16);
	return join(projectRoot, ".5x", "locks", `${hash}.lock`);
}

function writeLock(
	projectRoot: string,
	planPath: string,
	body: string | Record<string, unknown>,
	fileName?: string,
): string {
	const dir = join(projectRoot, ".5x", "locks");
	mkdirSync(dir, { recursive: true });
	const path = fileName
		? join(dir, fileName)
		: canonicalLockPath(projectRoot, planPath);
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
}

describe("5x lock list / unlock (integration)", () => {
	test(
		"empty list returns { locks: [] }",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const result = run5x(dir, ["lock", "list"]);
				expect(result.exitCode).toBe(0);
				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);
				expect(envelope.data).toEqual({ locks: [] });
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"classifies live, stale, and corrupt; corrupt exposes lock_path",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const livePlan = join(dir, "docs", "live.md");
				const stalePlan = join(dir, "docs", "stale.md");
				writeLock(dir, livePlan, {
					pid: process.pid,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(livePlan),
				});
				writeLock(dir, stalePlan, {
					pid: DEAD_PID,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(stalePlan),
				});
				const corrupt = writeLock(dir, "ignored", "{not-json", "leftover.lock");

				const result = run5x(dir, ["lock", "list"]);
				expect(result.exitCode).toBe(0);
				const envelope = parseJson(result.stdout);
				const locks = (
					envelope.data as {
						locks: Array<Record<string, unknown>>;
					}
				).locks;
				expect(locks.some((l) => l.liveness === "live")).toBe(true);
				expect(locks.some((l) => l.liveness === "stale")).toBe(true);
				const corruptRow = locks.find((l) => l.liveness === "corrupt");
				expect(corruptRow?.lock_path).toBe(corrupt);
				expect(corruptRow?.plan_path).toBeNull();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"unlock without --force refuses a live holder (exit 4)",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const plan = join(dir, "docs", "development", "foo.md");
				mkdirSync(join(dir, "docs", "development"), { recursive: true });
				writeFileSync(plan, "# plan\n");
				writeLock(dir, plan, {
					pid: process.pid,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(plan),
				});

				const result = run5x(dir, ["unlock", plan]);
				expect(result.exitCode).toBe(4);
				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(false);
				const error = envelope.error as Record<string, unknown>;
				expect(error.code).toBe("PLAN_LOCKED");
				const detail = error.detail as Record<string, unknown>;
				expect(detail.holder).toEqual(
					expect.objectContaining({ pid: process.pid }),
				);
				expect(String(detail.remediation)).toContain("--force");
				expect(existsSync(canonicalLockPath(dir, plan))).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"unlock --force prints previous_holder and removes the lock",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const plan = join(dir, "docs", "development", "foo.md");
				mkdirSync(join(dir, "docs", "development"), { recursive: true });
				writeFileSync(plan, "# plan\n");
				writeLock(dir, plan, {
					pid: process.pid,
					startedAt: "2026-01-01T00:00:00.000Z",
					planPath: canonicalizePlanPath(plan),
				});

				const result = run5x(dir, ["unlock", plan, "--force"]);
				expect(result.exitCode).toBe(0);
				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);
				const data = envelope.data as Record<string, unknown>;
				expect(data.released).toBe(true);
				expect(data.forced).toBe(true);
				expect(data.previous_holder).toEqual(
					expect.objectContaining({
						pid: process.pid,
						planPath: canonicalizePlanPath(plan),
					}),
				);
				expect(existsSync(canonicalLockPath(dir, plan))).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"text lock list for corrupt rows prints lock_path and doctor --fix",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const corrupt = writeLock(dir, "ignored", "{not-json", "leftover.lock");
				const result = run5x(dir, ["lock", "list", "--text"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("corrupt");
				expect(result.stdout).toContain(`lock_path=${corrupt}`);
				expect(result.stdout).toContain("→ 5x doctor --fix");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--help examples cover lock list and unlock",
		() => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const listHelp = run5x(dir, ["lock", "list", "--help"]);
				expect(listHelp.exitCode).toBe(0);
				expect(`${listHelp.stdout}\n${listHelp.stderr}`).toContain(
					"5x lock list",
				);
				const unlockHelp = run5x(dir, ["unlock", "--help"]);
				expect(unlockHelp.exitCode).toBe(0);
				expect(`${unlockHelp.stdout}\n${unlockHelp.stderr}`).toContain(
					"5x unlock",
				);
				expect(`${unlockHelp.stdout}\n${unlockHelp.stderr}`).toContain(
					"--force",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
