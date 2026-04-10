/**
 * Integration tests for `5x init` — CLI stdout and exit codes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const env = cleanGitEnv();
const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-init-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function runInit(
	cwd: string,
	extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "init", ...extraArgs], {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill("SIGINT"), 15000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout, stderr, exitCode };
}

let tmp: string;

beforeEach(() => {
	tmp = makeTmpDir();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("5x init (integration)", () => {
	test(
		"prints config hints and does not create 5x.toml",
		async () => {
			const result = await runInit(tmp);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("5x config show");
			expect(result.stdout).toContain("5x config set");
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
			expect(existsSync(join(tmp, ".5x"))).toBe(true);
		},
		{ timeout: 15000 },
	);

	test(
		"init --force does not create 5x.toml",
		async () => {
			const result = await runInit(tmp, ["--force"]);
			expect(result.exitCode).toBe(0);
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		},
		{ timeout: 15000 },
	);

	test(
		"sub-project init without root fails",
		async () => {
			const result = await runInit(tmp, ["--sub-project-path", "packages/api"]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain("Root project must be initialized");
		},
		{ timeout: 15000 },
	);

	test(
		"sub-project path creates paths-only 5x.toml",
		async () => {
			let r = await runInit(tmp);
			expect(r.exitCode).toBe(0);

			r = await runInit(tmp, ["--sub-project-path", "packages/api"]);
			expect(r.exitCode).toBe(0);

			const p = join(tmp, "packages", "api", "5x.toml");
			expect(existsSync(p)).toBe(true);
			const text = await Bun.file(p).text();
			expect(text).toContain("[paths]");
			expect(text).not.toContain("[author]");
		},
		{ timeout: 30000 },
	);
});
