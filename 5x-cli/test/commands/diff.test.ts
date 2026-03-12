import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-diff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

function setupProject(dir: string): void {
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});

	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(join(dir, "file.txt"), "original content\n");

	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
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

describe("5x diff", () => {
	test(
		"returns empty diff when no changes",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, ["diff"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					ref: string;
					diff: string;
					files: string[];
				};
				expect(payload.ref).toBe("HEAD");
				expect(payload.diff).toBe("");
				expect(payload.files).toEqual([]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"returns diff of working tree changes against HEAD",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				// Modify a file
				writeFileSync(join(dir, "file.txt"), "modified content\n");

				const result = await run5x(dir, ["diff"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					ref: string;
					diff: string;
					files: string[];
				};
				expect(payload.ref).toBe("HEAD");
				expect(payload.diff).toContain("file.txt");
				expect(payload.diff).toContain("-original content");
				expect(payload.diff).toContain("+modified content");
				expect(payload.files).toContain("file.txt");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"returns diff since a specific ref",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				// Get initial commit hash
				const hashResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				const baseRef = hashResult.stdout.toString().trim();

				// Create a new commit
				writeFileSync(join(dir, "new-file.txt"), "new content\n");
				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add new file"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				const result = await run5x(dir, ["diff", "--since", baseRef]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					ref: string;
					diff: string;
					files: string[];
				};
				expect(payload.ref).toBe(baseRef);
				expect(payload.diff).toContain("new-file.txt");
				expect(payload.files).toContain("new-file.txt");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"includes stat when --stat is specified",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				// Modify file
				writeFileSync(join(dir, "file.txt"), "modified content\n");

				const result = await run5x(dir, ["diff", "--stat"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					ref: string;
					diff: string;
					files: string[];
					stat: {
						files_changed: number;
						insertions: number;
						deletions: number;
					};
				};
				expect(payload.stat).toBeDefined();
				expect(payload.stat.files_changed).toBe(1);
				expect(payload.stat.insertions).toBeGreaterThan(0);
				expect(payload.stat.deletions).toBeGreaterThan(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"stat not included by default",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				writeFileSync(join(dir, "file.txt"), "modified\n");

				const result = await run5x(dir, ["diff"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as Record<string, unknown>;
				expect(payload.stat).toBeUndefined();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"returns INVALID_REF for nonexistent ref",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, [
					"diff",
					"--since",
					"nonexistent-ref-abc123",
				]);
				expect(result.exitCode).toBe(1); // default exit code for unknown error codes
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string };
				expect(error.code).toBe("INVALID_REF");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"handles --since with --stat combined",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const hashResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				const baseRef = hashResult.stdout.toString().trim();

				writeFileSync(join(dir, "file.txt"), "updated content\n");
				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "update file"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				const result = await run5x(dir, ["diff", "--since", baseRef, "--stat"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					ref: string;
					stat: {
						files_changed: number;
						insertions: number;
						deletions: number;
					};
					files: string[];
				};
				expect(payload.ref).toBe(baseRef);
				expect(payload.stat.files_changed).toBe(1);
				expect(payload.files).toContain("file.txt");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
