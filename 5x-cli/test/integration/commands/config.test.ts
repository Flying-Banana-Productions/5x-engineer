/**
 * Integration tests for `5x config set` / `config unset` — CLI round-trips.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(prefix = "5x-cfg-set-int"): string {
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

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed`);
	}
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

function entryValue(
	data: { entries: Array<{ key: string; value: unknown }> },
	key: string,
): unknown {
	return data.entries.find((e) => e.key === key)?.value;
}

describe("5x config set / unset (integration)", () => {
	test(
		"set then show reflects change",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(join(dir, "5x.toml"), '[author]\nprovider = "x"\n');
				git(["add", "-A"], dir);
				git(["commit", "-m", "cfg"], dir);

				const set = await run5x(dir, [
					"config",
					"set",
					"author.provider",
					"claude-code",
				]);
				expect(set.exitCode).toBe(0);

				const show = await run5x(dir, ["config", "show"]);
				expect(show.exitCode).toBe(0);
				const env = parseJson(show.stdout);
				expect(env.ok).toBe(true);
				const data = env.data as {
					entries: Array<{ key: string; value: unknown }>;
				};
				expect(entryValue(data, "author.provider")).toBe("claude-code");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--local writes 5x.toml.local",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(join(dir, "5x.toml"), '[author]\nprovider = "x"\n');
				git(["add", "-A"], dir);
				git(["commit", "-m", "cfg"], dir);

				const set = await run5x(dir, [
					"config",
					"set",
					"author.model",
					"m1",
					"--local",
				]);
				expect(set.exitCode).toBe(0);
				expect(readFileSync(join(dir, "5x.toml.local"), "utf-8")).toContain(
					"m1",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--context targets sub-project 5x.toml",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(join(dir, "5x.toml"), '[author]\nprovider = "root"\n');
				const sub = join(dir, "packages", "api");
				mkdirSync(sub, { recursive: true });
				writeFileSync(join(sub, "5x.toml"), '[paths]\nplans = "p"\n');
				git(["add", "-A"], dir);
				git(["commit", "-m", "cfg"], dir);

				const set = await run5x(dir, [
					"config",
					"set",
					"author.provider",
					"sub-only",
					"--context",
					sub,
				]);
				expect(set.exitCode).toBe(0);
				expect(readFileSync(join(sub, "5x.toml"), "utf-8")).toContain(
					"sub-only",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"JS active config rejects set with migration hint",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(
					join(dir, "5x.config.mjs"),
					'export default { author: { provider: "opencode" } }\n',
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "cfg"], dir);

				const r = await run5x(dir, ["config", "set", "maxStepsPerRun", "10"]);
				expect(r.exitCode).not.toBe(0);
				const env = parseJson(r.stdout);
				expect(env.ok).toBe(false);
				const err = env.error as { message: string };
				expect(err.message).toContain("5x upgrade");
				expect(err.message).toMatch(/5x\.config\.(js|mjs)/);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"P2.1: JS active config rejects unset with migration hint",
		async () => {
			for (const filename of ["5x.config.js", "5x.config.mjs"] as const) {
				const dir = makeTmpDir();
				try {
					initRepo(dir);
					const body =
						filename === "5x.config.mjs"
							? 'export default { author: { provider: "opencode" } }\n'
							: 'module.exports = { author: { provider: "opencode" } }\n';
					writeFileSync(join(dir, filename), body);
					git(["add", "-A"], dir);
					git(["commit", "-m", "cfg"], dir);

					const r = await run5x(dir, ["config", "unset", "maxStepsPerRun"]);
					expect(r.exitCode).not.toBe(0);
					const env = parseJson(r.stdout);
					expect(env.ok).toBe(false);
					const err = env.error as { message: string };
					expect(err.message).toContain("5x upgrade");
					expect(err.message).toMatch(/5x\.config\.(js|mjs)/);
					expect(err.message).toContain(filename);
				} finally {
					cleanupDir(dir);
				}
			}
		},
		{ timeout: 30000 },
	);

	test(
		"unset reverts layered value toward default (remove override)",
		async () => {
			const dir = makeTmpDir();
			try {
				initRepo(dir);
				writeFileSync(
					join(dir, "5x.toml"),
					["maxStepsPerRun = 99", "", "[author]", 'provider = "z"'].join("\n"),
				);
				git(["add", "-A"], dir);
				git(["commit", "-m", "cfg"], dir);

				const unset = await run5x(dir, ["config", "unset", "maxStepsPerRun"]);
				expect(unset.exitCode).toBe(0);

				const show = await run5x(dir, ["config", "show"]);
				const env = parseJson(show.stdout);
				expect(env.ok).toBe(true);
				const data = env.data as {
					entries: Array<{ key: string; value: unknown }>;
				};
				expect(entryValue(data, "maxStepsPerRun")).toBe(250);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
