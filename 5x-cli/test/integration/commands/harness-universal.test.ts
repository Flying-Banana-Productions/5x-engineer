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
import { listBaseSkillNames } from "../../../src/skills/loader.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-harness-universal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

async function runCmd(
	cwd: string,
	args: string[],
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...cleanGitEnv(), ...env },
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

async function runInit(cwd: string): Promise<void> {
	const result = await runCmd(cwd, ["init"]);
	expect(result.exitCode).toBe(0);
}

describe("universal harness lifecycle", () => {
	test(
		"install creates .agents/skills/<name>/SKILL.md",
		async () => {
			const tmp = makeTmpDir();
			try {
				await runInit(tmp);

				const install = await runCmd(tmp, [
					"harness",
					"install",
					"universal",
					"--scope",
					"project",
				]);
				expect(install.exitCode).toBe(0);

				for (const name of listBaseSkillNames()) {
					const skillPath = join(tmp, ".agents", "skills", name, "SKILL.md");
					expect(existsSync(skillPath)).toBe(true);
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"harness list reports universal as installed",
		async () => {
			const tmp = makeTmpDir();
			try {
				await runInit(tmp);
				const install = await runCmd(tmp, [
					"harness",
					"install",
					"universal",
					"--scope",
					"project",
				]);
				expect(install.exitCode).toBe(0);

				const listed = await runCmd(tmp, ["harness", "list"]);
				expect(listed.exitCode).toBe(0);

				const envelope = JSON.parse(listed.stdout);
				const universal = envelope.data.harnesses.find(
					(h: { name: string }) => h.name === "universal",
				);
				expect(universal).toBeDefined();
				expect(universal.scopes.project.installed).toBe(true);
				expect(universal.scopes.project.files).toContain("skills/5x/SKILL.md");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"uninstall removes all universal skill files",
		async () => {
			const tmp = makeTmpDir();
			try {
				await runInit(tmp);
				await runCmd(tmp, [
					"harness",
					"install",
					"universal",
					"--scope",
					"project",
				]);

				const uninstall = await runCmd(tmp, [
					"harness",
					"uninstall",
					"universal",
					"--scope",
					"project",
				]);
				expect(uninstall.exitCode).toBe(0);

				for (const name of listBaseSkillNames()) {
					const skillPath = join(tmp, ".agents", "skills", name, "SKILL.md");
					expect(existsSync(skillPath)).toBe(false);
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--force overwrites existing universal skill content",
		async () => {
			const tmp = makeTmpDir();
			try {
				await runInit(tmp);
				const first = await runCmd(tmp, [
					"harness",
					"install",
					"universal",
					"--scope",
					"project",
				]);
				expect(first.exitCode).toBe(0);

				const target = join(tmp, ".agents", "skills", "5x", "SKILL.md");
				writeFileSync(target, "# tampered", "utf-8");

				const forced = await runCmd(tmp, [
					"harness",
					"install",
					"universal",
					"--scope",
					"project",
					"--force",
				]);
				expect(forced.exitCode).toBe(0);

				const restored = readFileSync(target, "utf-8");
				expect(restored).not.toBe("# tampered");
				expect(restored).toContain("name: 5x");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"skill files follow <name>/SKILL.md structure",
		async () => {
			const tmp = makeTmpDir();
			try {
				await runInit(tmp);
				const install = await runCmd(tmp, [
					"harness",
					"install",
					"universal",
					"--scope",
					"project",
				]);
				expect(install.exitCode).toBe(0);

				for (const name of listBaseSkillNames()) {
					expect(
						existsSync(join(tmp, ".agents", "skills", name, "SKILL.md")),
					).toBe(true);
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);
});
