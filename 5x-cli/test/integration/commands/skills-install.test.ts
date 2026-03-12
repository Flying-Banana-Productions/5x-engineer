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
import { listSkillNames } from "../../../src/skills/loader.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-skills-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

async function runSkillsInstall(
	cwd: string,
	scope: string,
	extraArgs: string[] = [],
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(
		["bun", "run", BIN, "skills", "install", scope, ...extraArgs],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: { ...cleanGitEnv(), ...env },
		},
	);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("5x skills install project", () => {
	test(
		"installs all bundled skills to .agents/skills/",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stderr, exitCode } = await runSkillsInstall(tmp, "project");
				expect(exitCode).toBe(0);

				const names = listSkillNames();
				for (const name of names) {
					const skillPath = join(tmp, ".agents", "skills", name, "SKILL.md");
					expect(existsSync(skillPath)).toBe(true);
					expect(stderr).toContain(`Created .agents/skills/${name}/SKILL.md`);

					// Verify content has valid frontmatter
					const content = readFileSync(skillPath, "utf-8");
					expect(content).toContain("---");
					expect(content).toContain(`name: ${name}`);
					expect(content).toContain("description:");
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"skips existing skills without --force",
		async () => {
			const tmp = makeTmpDir();
			try {
				// Pre-create a skill
				const skillDir = join(tmp, ".agents", "skills", "5x-plan");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(join(skillDir, "SKILL.md"), "CUSTOM CONTENT", "utf-8");

				const { stderr, exitCode } = await runSkillsInstall(tmp, "project");
				expect(exitCode).toBe(0);
				expect(stderr).toContain(
					"Skipped .agents/skills/5x-plan/SKILL.md (already exists)",
				);
				// Other skills should still be created
				expect(stderr).toContain(
					"Created .agents/skills/5x-plan-review/SKILL.md",
				);

				// Verify custom skill was preserved
				expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(
					"CUSTOM CONTENT",
				);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"overwrites existing skills with --force",
		async () => {
			const tmp = makeTmpDir();
			try {
				// Pre-create a skill
				const skillDir = join(tmp, ".agents", "skills", "5x-plan");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(join(skillDir, "SKILL.md"), "CUSTOM CONTENT", "utf-8");

				const { stderr, exitCode } = await runSkillsInstall(tmp, "project", [
					"--force",
				]);
				expect(exitCode).toBe(0);
				expect(stderr).toContain("Overwrote .agents/skills/5x-plan/SKILL.md");

				// Verify skill was overwritten with bundled content
				const content = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
				expect(content).not.toBe("CUSTOM CONTENT");
				expect(content).toContain("name: 5x-plan");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"is idempotent — second install skips all",
		async () => {
			const tmp = makeTmpDir();
			try {
				// First install
				const first = await runSkillsInstall(tmp, "project");
				expect(first.exitCode).toBe(0);

				// Second install — all should be skipped
				const second = await runSkillsInstall(tmp, "project");
				expect(second.exitCode).toBe(0);

				const names = listSkillNames();
				for (const name of names) {
					expect(second.stderr).toContain(
						`Skipped .agents/skills/${name}/SKILL.md (already exists)`,
					);
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

describe("5x skills install user", () => {
	test(
		"installs skills to ~/.agents/skills/ (using HOME override)",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = makeTmpDir();
			try {
				const { stderr, exitCode } = await runSkillsInstall(tmp, "user", [], {
					HOME: fakeHome,
				});
				expect(exitCode).toBe(0);

				const names = listSkillNames();
				for (const name of names) {
					const skillPath = join(
						fakeHome,
						".agents",
						"skills",
						name,
						"SKILL.md",
					);
					expect(existsSync(skillPath)).toBe(true);
					expect(stderr).toContain(`Created ~/.agents/skills/${name}/SKILL.md`);
				}
			} finally {
				cleanupDir(tmp);
				cleanupDir(fakeHome);
			}
		},
		{ timeout: 15000 },
	);
});

describe("5x skills install --install-root", () => {
	test(
		"installs to custom root directory for project scope",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stderr, exitCode } = await runSkillsInstall(tmp, "project", [
					"--install-root",
					".claude",
				]);
				expect(exitCode).toBe(0);

				const names = listSkillNames();
				for (const name of names) {
					const skillPath = join(tmp, ".claude", "skills", name, "SKILL.md");
					expect(existsSync(skillPath)).toBe(true);
					expect(stderr).toContain(`Created .claude/skills/${name}/SKILL.md`);
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"installs to custom root directory for user scope",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = makeTmpDir();
			try {
				const { stderr, exitCode } = await runSkillsInstall(
					tmp,
					"user",
					["--install-root", ".opencode"],
					{ HOME: fakeHome },
				);
				expect(exitCode).toBe(0);

				const names = listSkillNames();
				for (const name of names) {
					const skillPath = join(
						fakeHome,
						".opencode",
						"skills",
						name,
						"SKILL.md",
					);
					expect(existsSync(skillPath)).toBe(true);
					expect(stderr).toContain(
						`Created ~/.opencode/skills/${name}/SKILL.md`,
					);
				}
			} finally {
				cleanupDir(tmp);
				cleanupDir(fakeHome);
			}
		},
		{ timeout: 15000 },
	);
});

describe("5x skills install output", () => {
	test(
		"returns clean JSON success envelope on stdout (no progress noise)",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, stderr, exitCode } = await runSkillsInstall(
					tmp,
					"project",
				);
				expect(exitCode).toBe(0);

				// stdout is a clean JSON envelope (compact since subprocess pipes)
				const envelope = JSON.parse(stdout.trim());
				expect(envelope.ok).toBe(true);
				expect(envelope.data.scope).toBe("project");
				expect(envelope.data.installRoot).toBe(".agents");
				expect(envelope.data.created.length).toBe(listSkillNames().length);
				expect(envelope.data.skipped).toHaveLength(0);
				expect(envelope.data.overwritten).toHaveLength(0);

				// Progress messages go to stderr, not stdout
				expect(stderr).toContain("Created");
				expect(stdout).not.toContain("Created .agents");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"returns pretty JSON envelope when --pretty is passed",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runSkillsInstall(tmp, "project", [
					"--pretty",
				]);
				expect(exitCode).toBe(0);

				// With --pretty, JSON envelope is indented
				expect(stdout.trim()).toMatch(/^\{\n/);
				const envelope = JSON.parse(stdout.trim());
				expect(envelope.ok).toBe(true);
				expect(envelope.data.scope).toBe("project");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});
