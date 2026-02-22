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

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

async function runInit(
	cwd: string,
	extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "init", ...extraArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("5x init", () => {
	test("creates config file, .5x/ directory, and .gitignore in empty project", async () => {
		const tmp = makeTmpDir();
		try {
			const { stdout, exitCode } = await runInit(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Created 5x.config.js");
			expect(stdout).toContain("Created .5x/ directory");
			expect(stdout).toContain(".gitignore");
			expect(stdout).toContain("--no-tui");

			// Config file exists and is valid JS
			const configPath = join(tmp, "5x.config.js");
			expect(existsSync(configPath)).toBe(true);
			const configContent = readFileSync(configPath, "utf-8");
			expect(configContent).not.toContain("adapter:");
			expect(configContent).toContain("model:");
			expect(configContent).toContain("qualityGates");
			expect(configContent).toContain("@type");

			// .5x/ directory exists
			expect(existsSync(join(tmp, ".5x"))).toBe(true);

			// .gitignore contains .5x/
			const gitignorePath = join(tmp, ".gitignore");
			expect(existsSync(gitignorePath)).toBe(true);
			const gitignoreContent = readFileSync(gitignorePath, "utf-8");
			expect(gitignoreContent).toContain(".5x/");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips config file if already exists (without --force)", async () => {
		const tmp = makeTmpDir();
		try {
			const configPath = join(tmp, "5x.config.js");
			writeFileSync(
				configPath,
				"// existing config\nexport default {};",
				"utf-8",
			);

			const { stdout, exitCode } = await runInit(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Skipped 5x.config.js");

			// Original config unchanged
			const content = readFileSync(configPath, "utf-8");
			expect(content).toContain("existing config");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites config file with --force", async () => {
		const tmp = makeTmpDir();
		try {
			const configPath = join(tmp, "5x.config.js");
			writeFileSync(configPath, "// old config\nexport default {};", "utf-8");

			const { stdout, exitCode } = await runInit(tmp, ["--force"]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Overwrote 5x.config.js");

			// Config was overwritten
			const content = readFileSync(configPath, "utf-8");
			expect(content).not.toContain("old config");
			expect(content).not.toContain("adapter:");
			expect(content).toContain("model:");
		} finally {
			cleanupDir(tmp);
		}
	});

	test(".gitignore append is idempotent", async () => {
		const tmp = makeTmpDir();
		try {
			const gitignorePath = join(tmp, ".gitignore");
			writeFileSync(gitignorePath, "node_modules/\n.5x/\n", "utf-8");

			const { stdout, exitCode } = await runInit(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Skipped .gitignore (.5x/ already present)");

			// .gitignore unchanged — only one .5x/ entry
			const content = readFileSync(gitignorePath, "utf-8");
			const matches = content.match(/\.5x\//g);
			expect(matches?.length).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("appends .5x/ to existing .gitignore without duplicate", async () => {
		const tmp = makeTmpDir();
		try {
			const gitignorePath = join(tmp, ".gitignore");
			writeFileSync(gitignorePath, "node_modules/\ndist/\n", "utf-8");

			const { stdout, exitCode } = await runInit(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Added .5x/ to .gitignore");

			const content = readFileSync(gitignorePath, "utf-8");
			expect(content).toContain("node_modules/");
			expect(content).toContain(".5x/");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("handles .gitignore without trailing newline", async () => {
		const tmp = makeTmpDir();
		try {
			const gitignorePath = join(tmp, ".gitignore");
			writeFileSync(gitignorePath, "node_modules/\ndist/", "utf-8"); // no trailing newline

			const { exitCode } = await runInit(tmp);

			expect(exitCode).toBe(0);
			const content = readFileSync(gitignorePath, "utf-8");
			expect(content).toContain("dist/\n.5x/\n");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips .5x/ directory if already exists", async () => {
		const tmp = makeTmpDir();
		try {
			mkdirSync(join(tmp, ".5x"), { recursive: true });

			const { stdout, exitCode } = await runInit(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Skipped .5x/ directory (already exists)");
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("ensureGitignore", () => {
	test("creates .gitignore if missing", async () => {
		const { ensureGitignore } = await import("../../src/commands/init.js");
		const tmp = makeTmpDir();
		try {
			const result = ensureGitignore(tmp);
			expect(result.created).toBe(true);
			expect(result.appended).toBe(false);
			expect(readFileSync(join(tmp, ".gitignore"), "utf-8")).toBe(".5x/\n");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("appends if .gitignore exists without entry", async () => {
		const { ensureGitignore } = await import("../../src/commands/init.js");
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, ".gitignore"), "node_modules/\n", "utf-8");
			const result = ensureGitignore(tmp);
			expect(result.created).toBe(false);
			expect(result.appended).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("no-ops if .gitignore already contains .5x/", async () => {
		const { ensureGitignore } = await import("../../src/commands/init.js");
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, ".gitignore"), "node_modules/\n.5x/\n", "utf-8");
			const result = ensureGitignore(tmp);
			expect(result.created).toBe(false);
			expect(result.appended).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("generateConfigContent", () => {
	test("generates valid JS config with model examples", async () => {
		const { generateConfigContent } = await import(
			"../../src/commands/init.js"
		);
		const content = generateConfigContent();
		expect(content).toContain("@type");
		expect(content).toContain("export default");
		expect(content).toContain("author:");
		expect(content).toContain("reviewer:");
		expect(content).toContain("model:");
		expect(content).not.toContain("adapter:");
		expect(content).toContain("Remote server support is a future feature");
	});
});
