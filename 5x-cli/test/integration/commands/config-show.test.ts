/**
 * Integration tests for `5x config show` — CLI subprocess behavior.
 *
 * Tests spawn the CLI binary and validate JSON envelope output, text
 * table output (--text), single-key text output (--key --text), exit
 * codes, and layered config resolution via --context.
 *
 * Unit tests for handlers and resolution are in test/unit/commands/config.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(prefix = "5x-cfg-int"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

function git(args: string[], cwd: string): string {
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
	return result.stdout.toString().trim();
}

function initRepo(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	git(["add", "."], dir);
	git(["commit", "-m", "initial"], dir);
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(
	cwd: string,
	args: string[],
	timeoutMs = 15000,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill("SIGINT"), timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

interface ConfigShowData {
	files: string[];
	entries: Array<{ key: string; value: unknown; isLocal?: boolean }>;
}

function entry(data: ConfigShowData, key: string): unknown {
	return data.entries.find((e) => e.key === key)?.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("5x config show (integration)", () => {
	test(
		"returns envelope with custom config values",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(
					join(dir, "5x.toml"),
					[
						"maxReviewIterations = 8",
						"maxQualityRetries = 4",
						"",
						"[author]",
						'provider = "test-provider"',
						'model = "test-model"',
					].join("\n"),
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "add config"], dir);

				const result = await run5x(dir, ["config", "show"]);
				expect(result.exitCode).toBe(0);

				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);

				const data = envelope.data as ConfigShowData;
				expect(entry(data, "maxReviewIterations")).toBe(8);
				expect(entry(data, "maxQualityRetries")).toBe(4);
				expect(entry(data, "author.provider")).toBe("test-provider");
				expect(entry(data, "author.model")).toBe("test-model");
				expect(data.files.length).toBeGreaterThanOrEqual(1);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--context resolves layered config from sub-project",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(
					join(dir, "5x.toml"),
					[
						"maxReviewIterations = 5",
						"",
						"[author]",
						'provider = "root-provider"',
						'model = "root-model"',
					].join("\n"),
				);

				const subDir = join(dir, "packages", "api");
				mkdirSync(subDir, { recursive: true });
				writeFileSync(
					join(subDir, "5x.toml"),
					["[author]", 'model = "sub-model"'].join("\n"),
				);

				git(["add", "-A"], dir);
				git(["commit", "-m", "add configs"], dir);

				const result = await run5x(dir, [
					"config",
					"show",
					"--context",
					subDir,
				]);
				expect(result.exitCode).toBe(0);

				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);

				const data = envelope.data as ConfigShowData;
				expect(entry(data, "author.model")).toBe("sub-model");
				expect(entry(data, "author.provider")).toBe("root-provider");
				expect(entry(data, "maxReviewIterations")).toBe(5);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"returns default values when no config file exists",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);

				const result = await run5x(dir, ["config", "show"]);
				expect(result.exitCode).toBe(0);

				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);

				const data = envelope.data as ConfigShowData;
				expect(data.files).toEqual([]);
				expect(entry(data, "maxReviewIterations")).toBe(5);
				expect(entry(data, "maxQualityRetries")).toBe(3);
				expect(entry(data, "maxStepsPerRun")).toBe(250);
				expect(entry(data, "author.provider")).toBe("opencode");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"preserves passthrough/plugin config keys in entries",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(
					join(dir, "5x.toml"),
					[
						"[author]",
						'provider = "acme"',
						"",
						"[acme]",
						'apiKey = "sk-test-123"',
						'region = "us-east-1"',
					].join("\n"),
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "add config with plugin"], dir);

				const result = await run5x(dir, ["config", "show"]);
				expect(result.exitCode).toBe(0);

				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);

				const data = envelope.data as ConfigShowData;
				expect(entry(data, "acme.apiKey")).toBe("sk-test-123");
				expect(entry(data, "acme.region")).toBe("us-east-1");
				expect(entry(data, "author.provider")).toBe("acme");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"resolves root-anchored values from linked worktree",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(
					join(dir, "5x.toml"),
					[
						"[db]",
						'path = ".5x/5x.db"',
						"",
						"[author]",
						'provider = "wt-provider"',
					].join("\n"),
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "add config"], dir);

				const wtDir = join(dir, "..", `wt-${Date.now()}`);
				git(["worktree", "add", wtDir, "-b", "test-wt"], dir);

				try {
					const result = await run5x(wtDir, ["config", "show"]);
					expect(result.exitCode).toBe(0);

					const envelope = parseJson(result.stdout);
					expect(envelope.ok).toBe(true);

					const data = envelope.data as ConfigShowData;
					expect(entry(data, "db.path")).toBe(".5x/5x.db");
					expect(entry(data, "author.provider")).toBe("wt-provider");
				} finally {
					git(["worktree", "remove", "--force", wtDir], dir);
				}
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--key returns a single entry in JSON mode",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(join(dir, "5x.toml"), "maxStepsPerRun = 400\n");
				git(["add", "-A"], dir);
				git(["commit", "-m", "c"], dir);

				const result = await run5x(dir, [
					"config",
					"show",
					"--key",
					"maxStepsPerRun",
				]);
				expect(result.exitCode).toBe(0);
				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);
				const row = envelope.data as { key: string; value: unknown };
				expect(row.key).toBe("maxStepsPerRun");
				expect(row.value).toBe(400);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--key with unknown key errors",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				const result = await run5x(dir, [
					"config",
					"show",
					"--key",
					"not.a.real.key",
				]);
				expect(result.exitCode).not.toBe(0);
				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text prints file header and table header with resolved defaults",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				const result = await run5x(dir, ["config", "show", "--text"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Config files:");
				expect(result.stdout).toContain("(none)");
				expect(result.stdout).toContain("Key");
				expect(result.stdout).toContain("Value");
				expect(result.stdout).toContain("Default");
				expect(result.stdout).toContain("Local");
				expect(result.stdout).toContain("author.provider");
				expect(result.stdout).toContain("opencode");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--key --text prints value only",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(join(dir, "5x.toml"), "maxStepsPerRun = 400\n");
				git(["add", "-A"], dir);
				git(["commit", "-m", "c"], dir);

				const result = await run5x(dir, [
					"config",
					"show",
					"--key",
					"maxStepsPerRun",
					"--text",
				]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("400");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
