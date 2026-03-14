import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-quality-noop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

function setupProject(
	dir: string,
	opts: { skipQualityGates?: boolean } = {},
): void {
	// Init git repo
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

	// Create .5x directory
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	// Write TOML config — no qualityGates, optionally skipQualityGates
	const lines: string[] = [];
	if (opts.skipQualityGates !== undefined) {
		lines.push(`skipQualityGates = ${opts.skipQualityGates}`);
	}
	if (lines.length > 0) {
		writeFileSync(join(dir, "5x.toml"), `${lines.join("\n")}\n`);
	}

	// Initial commit
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

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(cwd: string, args: string[]): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
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
// Tests
// ---------------------------------------------------------------------------

describe("5x quality run — no-op ambiguity", () => {
	test(
		"empty gates + skipQualityGates: false → stderr warning, no skipped in output",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir, { skipQualityGates: false });
				const result = await run5x(dir, ["quality", "run"]);
				expect(result.exitCode).toBe(0);

				// stderr should contain the warning
				expect(result.stderr).toContain("no quality gates configured");
				expect(result.stderr).toContain("skipQualityGates");

				// stdout JSON should have passed: true, no skipped field
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as Record<string, unknown>;
				expect(payload.passed).toBe(true);
				expect(payload.results).toEqual([]);
				expect("skipped" in payload).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"empty gates + no config (default skipQualityGates: false) → stderr warning",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir); // no config, defaults apply
				const result = await run5x(dir, ["quality", "run"]);
				expect(result.exitCode).toBe(0);

				// stderr should contain the warning
				expect(result.stderr).toContain("no quality gates configured");

				// stdout JSON should have passed: true, no skipped field
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as Record<string, unknown>;
				expect(payload.passed).toBe(true);
				expect("skipped" in payload).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"empty gates + skipQualityGates: true → no stderr warning, skipped: true in output",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir, { skipQualityGates: true });
				const result = await run5x(dir, ["quality", "run"]);
				expect(result.exitCode).toBe(0);

				// stderr should NOT contain the warning
				expect(result.stderr).not.toContain("no quality gates configured");

				// stdout JSON should have passed: true and skipped: true
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as Record<string, unknown>;
				expect(payload.passed).toBe(true);
				expect(payload.skipped).toBe(true);
				expect(payload.results).toEqual([]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
