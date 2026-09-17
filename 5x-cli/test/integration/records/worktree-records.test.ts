/**
 * Linked-worktree record writes: run.json + steps live in the worktree,
 * and `5x commit --files` from that run includes them.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
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
		`5x-wt-records-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
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

async function run5x(
	cwd: string,
	args: string[],
	extraEnv?: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

function setupProject(dir: string): { planPath: string } {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(
		planPath,
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
	return { planPath };
}

function listFiles(dir: string, acc: string[] = []): string[] {
	if (!existsSync(dir)) return acc;
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, name.name);
		if (name.isDirectory()) listFiles(full, acc);
		else acc.push(full);
	}
	return acc;
}

describe("worktree records", () => {
	test(
		"run init --worktree writes run.json in the linked worktree; commit includes it",
		async () => {
			const dir = makeTmpDir();
			const configHome = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const extraEnv = { FIVEX_CONFIG_HOME: configHome };

				const init = await run5x(
					dir,
					["run", "init", "--plan", planPath, "--worktree"],
					extraEnv,
				);
				expect(init.exitCode).toBe(0);
				const payload = parseJson(init.stdout).data as {
					run_id: string;
					worktree_path: string;
				};
				const runId = payload.run_id;
				const wtPath = payload.worktree_path;
				const slug = "test-plan";
				const wtRunJson = join(
					wtPath,
					"docs",
					"development",
					"runs",
					slug,
					runId,
					"run.json",
				);
				const mainRunJson = join(
					dir,
					"docs",
					"development",
					"runs",
					slug,
					runId,
					"run.json",
				);
				expect(existsSync(wtRunJson)).toBe(true);
				expect(existsSync(mainRunJson)).toBe(false);

				const runDoc = JSON.parse(await Bun.file(wtRunJson).text()) as Record<
					string,
					unknown
				>;
				expect(runDoc.format_version).toBe(1);
				const creator = runDoc.creator as { installation_id: string };
				expect(creator.installation_id).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
				);

				const record = await run5x(
					dir,
					[
						"run",
						"record",
						"author:impl:status",
						"--run",
						runId,
						"--result",
						'{"ok":true}',
						"--phase",
						"1",
					],
					extraEnv,
				);
				expect(record.exitCode).toBe(0);
				const stepsPath = join(
					wtPath,
					"docs",
					"development",
					"runs",
					slug,
					runId,
					"steps.jsonl",
				);
				expect(existsSync(stepsPath)).toBe(true);
				const stepLine = JSON.parse(
					(await Bun.file(stepsPath).text()).trim().split("\n")[0] ?? "{}",
				) as {
					schema_version?: number;
					provenance?: string;
					origin?: { recorder?: { installation_id?: string } };
				};
				expect(stepLine.origin?.recorder?.installation_id).toBe(
					creator.installation_id,
				);
				expect(stepLine.schema_version).toBe(1);
				expect(stepLine.provenance).toBe("recorded");

				writeFileSync(join(wtPath, "src-foo.ts"), "export const x = 1;\n");
				const commit = await run5x(
					dir,
					[
						"commit",
						"--run",
						runId,
						"-m",
						"code plus records",
						"--files",
						"src-foo.ts",
						"--phase",
						"1",
					],
					extraEnv,
				);
				expect(commit.exitCode).toBe(0);
				const files = git(
					["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
					wtPath,
				);
				expect(files).toContain("src-foo.ts");
				expect(files).toContain(
					`docs/development/runs/${slug}/${runId}/run.json`,
				);
				expect(files).toContain(
					`docs/development/runs/${slug}/${runId}/steps.jsonl`,
				);
				expect(files).not.toContain(".txn.");
				const identityFiles = listFiles(configHome);
				for (const f of identityFiles) {
					expect(files).not.toContain(f);
				}
				expect(
					existsSync(join(wtPath, "docs/development/runs", "identity.json")),
				).toBe(false);
			} finally {
				cleanupDir(dir);
				cleanupDir(configHome);
			}
		},
		{ timeout: 30000 },
	);
});
