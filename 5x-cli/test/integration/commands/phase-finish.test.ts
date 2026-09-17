/**
 * Integration tests for `5x phase finish`.
 *
 * Spawns the CLI with `--input` so stdin is not the protocol payload.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-phase-finish-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(
	cwd: string,
	args: string[],
	extraEnv?: Record<string, string | undefined>,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: { ...cleanGitEnv(), ...extraEnv },
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

async function setupProject(
	dir: string,
	opts?: { gates?: string[]; checked?: boolean },
): Promise<{ runId: string; planPath: string }> {
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

	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	const mark = opts?.checked === false ? " " : "x";
	writeFileSync(
		planPath,
		`# Test Plan\n\n## Phase 1: Setup\n\n- [${mark}] Do thing\n`,
	);

	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	const gates = opts?.gates ?? ["echo ok"];
	writeFileSync(
		join(dir, "5x.toml"),
		`qualityGates = [${gates.map((g) => `"${g}"`).join(", ")}]\n`,
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

	const init = await run5x(dir, ["run", "init", "--plan", planPath]);
	const initJson = JSON.parse(init.stdout) as {
		ok: boolean;
		data: { run_id: string };
	};
	if (!initJson.ok) {
		throw new Error(`run init failed: ${init.stdout}`);
	}
	return { runId: initJson.data.run_id, planPath };
}

describe("5x phase finish (integration)", () => {
	test(
		"--input happy path: single JSON envelope, exit 0",
		async () => {
			const dir = makeTmpDir();
			try {
				const { runId } = await setupProject(dir);
				const input = join(dir, "author.json");
				writeFileSync(
					input,
					JSON.stringify({ result: "complete", commit: "abc123def" }),
				);

				const result = await run5x(dir, [
					"phase",
					"finish",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--step",
					"author:impl",
					"--run",
					runId,
					"--input",
					input,
				]);

				expect(result.exitCode).toBe(0);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
				const steps = data.steps as Array<Record<string, unknown>>;
				expect(steps.map((s) => [s.name, s.status])).toEqual([
					["quality", "completed"],
					["protocol", "completed"],
					["checklist", "completed"],
				]);
				// Exactly one JSON object on stdout
				expect(result.stdout.trim().startsWith("{")).toBe(true);
				JSON.parse(result.stdout);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"quality fail exits 1 with QUALITY_FAILED and a single envelope",
		async () => {
			const dir = makeTmpDir();
			try {
				const { runId } = await setupProject(dir, { gates: ["false"] });
				const input = join(dir, "author.json");
				writeFileSync(
					input,
					JSON.stringify({ result: "complete", commit: "abc123def" }),
				);

				const result = await run5x(dir, [
					"phase",
					"finish",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--step",
					"author:impl",
					"--run",
					runId,
					"--input",
					input,
				]);

				expect(result.exitCode).toBe(1);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("QUALITY_FAILED");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"incomplete checklist with complete author exits 8",
		async () => {
			const dir = makeTmpDir();
			try {
				const { runId } = await setupProject(dir, { checked: false });
				const input = join(dir, "author.json");
				writeFileSync(
					input,
					JSON.stringify({ result: "complete", commit: "abc123def" }),
				);

				const result = await run5x(dir, [
					"phase",
					"finish",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--step",
					"author:impl",
					"--run",
					runId,
					"--input",
					input,
				]);

				expect(result.exitCode).toBe(8);
				const json = JSON.parse(result.stdout) as Record<string, unknown>;
				expect(json.ok).toBe(false);
				expect((json.error as Record<string, unknown>).code).toBe(
					"PHASE_CHECKLIST_INCOMPLETE",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);

	test(
		"phase finish appends a steps.jsonl line with origin",
		async () => {
			const dir = makeTmpDir();
			try {
				const { runId } = await setupProject(dir);
				const input = join(dir, "author.json");
				writeFileSync(
					input,
					JSON.stringify({ result: "complete", commit: "abc123def" }),
				);
				const result = await run5x(dir, [
					"phase",
					"finish",
					"--phase",
					"1",
					"--iteration",
					"1",
					"--step",
					"author:impl",
					"--run",
					runId,
					"--input",
					input,
				]);
				expect(result.exitCode).toBe(0);
				const stepsPath = join(
					dir,
					"docs",
					"development",
					"runs",
					"test-plan",
					runId,
					"steps.jsonl",
				);
				expect(existsSync(stepsPath)).toBe(true);
				const lines = readFileSync(stepsPath, "utf-8")
					.trim()
					.split("\n")
					.filter(Boolean);
				expect(lines.length).toBeGreaterThan(0);
				const parsed = JSON.parse(lines[lines.length - 1] ?? "{}") as {
					origin?: { recorder?: { installation_id?: string } };
					provenance?: string;
				};
				expect(parsed.provenance).toBe("recorded");
				expect(parsed.origin?.recorder?.installation_id).toBeTruthy();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 30000 },
	);
});
