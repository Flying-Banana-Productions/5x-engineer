/**
 * Integration tests for `5x init opencode <user|project>`.
 *
 * Phase 3 (014-harness-native-subagent-orchestration).
 *
 * Covers:
 * - `5x init opencode project` writes both skills and agents
 * - `5x init opencode project` fails with clear error when `.5x/` or `5x.toml` is absent
 * - `5x init opencode user` resolves the correct global config paths
 * - `--force` overwrite behavior
 * - Idempotent re-run behavior (skipped on second run)
 * - Legacy `5x init --force` still works without arguments (compatibility)
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listAgentTemplates } from "../../src/harnesses/opencode/loader.js";
import { listSkillNames } from "../../src/skills/loader.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		homedir(),
		`.5x-init-opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "init", ...extraArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

async function runInitOpencode(
	cwd: string,
	scope: string,
	extraArgs: string[] = [],
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(
		["bun", "run", BIN, "init", "opencode", scope, ...extraArgs],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		},
	);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/**
 * Bootstrap a minimal 5x project in a temp dir (writes 5x.toml and .5x/).
 * Used for project-scope tests that require the prerequisite check to pass.
 */
async function bootstrapProject(dir: string): Promise<void> {
	await runInit(dir);
}

// ---------------------------------------------------------------------------
// Legacy compatibility: bare `5x init --force` still works
// ---------------------------------------------------------------------------

describe("5x init --force (legacy compatibility)", () => {
	test("bare 5x init --force works without arguments", async () => {
		const tmp = makeTmpDir();
		try {
			// First init
			const first = await runInit(tmp);
			expect(first.exitCode).toBe(0);

			// Force re-init
			const { stdout, exitCode } = await runInit(tmp, ["--force"]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Overwrote 5x.toml");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("bare 5x init still prints opencode hint", async () => {
		const tmp = makeTmpDir();
		try {
			const { stdout, exitCode } = await runInit(tmp);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("5x init opencode project");
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// `5x init opencode project`
// ---------------------------------------------------------------------------

describe("5x init opencode project", () => {
	test("installs all bundled skills under .opencode/skills/", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			const { stdout, exitCode } = await runInitOpencode(tmp, "project");

			expect(exitCode).toBe(0);

			const skillNames = listSkillNames();
			for (const name of skillNames) {
				const skillPath = join(tmp, ".opencode", "skills", name, "SKILL.md");
				expect(existsSync(skillPath)).toBe(true);
				expect(stdout).toContain(`.opencode/skills/${name}/SKILL.md`);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("installs all bundled agent profiles under .opencode/agents/", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			const { stdout, exitCode } = await runInitOpencode(tmp, "project");

			expect(exitCode).toBe(0);

			const agentNames = listAgentTemplates().map((a) => a.name);
			for (const name of agentNames) {
				const agentPath = join(tmp, ".opencode", "agents", `${name}.md`);
				expect(existsSync(agentPath)).toBe(true);
				expect(stdout).toContain(`.opencode/agents/${name}.md`);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("installs 3 skills and 4 agents (3 subagents + 1 orchestrator)", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			const { exitCode } = await runInitOpencode(tmp, "project");
			expect(exitCode).toBe(0);

			const skillsDir = join(tmp, ".opencode", "skills");
			const agentsDir = join(tmp, ".opencode", "agents");

			const skillNames = listSkillNames();
			expect(skillNames).toHaveLength(3);

			const agentNames = listAgentTemplates().map((a) => a.name);
			expect(agentNames).toHaveLength(4);

			for (const name of skillNames) {
				expect(existsSync(join(skillsDir, name, "SKILL.md"))).toBe(true);
			}
			for (const name of agentNames) {
				expect(existsSync(join(agentsDir, `${name}.md`))).toBe(true);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("fails with clear error when .5x/ is absent", async () => {
		const tmp = makeTmpDir();
		try {
			// Write 5x.toml but NOT .5x/
			writeFileSync(join(tmp, "5x.toml"), "[author]\n", "utf-8");

			const { stdout, exitCode } = await runInitOpencode(tmp, "project");

			expect(exitCode).not.toBe(0);
			// The error is emitted via the JSON error envelope on stdout
			expect(stdout).toContain("5x init");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("fails with clear error when 5x.toml is absent", async () => {
		const tmp = makeTmpDir();
		try {
			// Create .5x/ but NOT 5x.toml
			mkdirSync(join(tmp, ".5x"), { recursive: true });

			const { stdout, exitCode } = await runInitOpencode(tmp, "project");

			expect(exitCode).not.toBe(0);
			expect(stdout).toContain("5x init");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("fails with clear error when neither .5x/ nor 5x.toml exists", async () => {
		const tmp = makeTmpDir();
		try {
			const { stdout, exitCode } = await runInitOpencode(tmp, "project");

			expect(exitCode).not.toBe(0);
			expect(stdout).toContain("5x init");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("idempotent: second run without --force skips all files", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);

			// First run
			const first = await runInitOpencode(tmp, "project");
			expect(first.exitCode).toBe(0);

			// Second run (no --force)
			const { stdout, exitCode } = await runInitOpencode(tmp, "project");
			expect(exitCode).toBe(0);
			expect(stdout).not.toContain("Created");
			expect(stdout).not.toContain("Overwrote");
			// All files should be reported as skipped
			expect(stdout).toContain("Skipped");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("--force overwrites existing skill and agent files", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);

			// First install
			const first = await runInitOpencode(tmp, "project");
			expect(first.exitCode).toBe(0);
			expect(first.stdout).toContain("Created");

			// Overwrite existing content in one skill file
			const skillPath = join(tmp, ".opencode", "skills", "5x-plan", "SKILL.md");
			writeFileSync(skillPath, "# custom content", "utf-8");

			// Second run with --force
			const { stdout, exitCode } = await runInitOpencode(tmp, "project", [
				"--force",
			]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Overwrote");

			// File should be restored to bundled content
			const restored = readFileSync(skillPath, "utf-8");
			expect(restored).not.toBe("# custom content");
			expect(restored).toContain("5x-plan");
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// `5x init opencode user`
// ---------------------------------------------------------------------------

describe("5x init opencode user", () => {
	test("installs skills under ~/.config/opencode/skills/", async () => {
		const tmp = makeTmpDir();
		// Use a custom HOME to avoid polluting the real user's opencode config
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		try {
			const { stdout, exitCode } = await runInitOpencode(tmp, "user", [], {
				HOME: fakeHome,
			});

			expect(exitCode).toBe(0);

			const skillNames = listSkillNames();
			for (const name of skillNames) {
				const skillPath = join(
					fakeHome,
					".config",
					"opencode",
					"skills",
					name,
					"SKILL.md",
				);
				expect(existsSync(skillPath)).toBe(true);
				expect(stdout).toContain(`~/.config/opencode/skills/${name}/SKILL.md`);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("installs agents under ~/.config/opencode/agents/", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		try {
			const { stdout, exitCode } = await runInitOpencode(tmp, "user", [], {
				HOME: fakeHome,
			});

			expect(exitCode).toBe(0);

			const agentNames = listAgentTemplates().map((a) => a.name);
			for (const name of agentNames) {
				const agentPath = join(
					fakeHome,
					".config",
					"opencode",
					"agents",
					`${name}.md`,
				);
				expect(existsSync(agentPath)).toBe(true);
				expect(stdout).toContain(`~/.config/opencode/agents/${name}.md`);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("user scope does NOT require .5x/ or 5x.toml to exist", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		try {
			// No 5x init done — no .5x/ or 5x.toml
			const { exitCode } = await runInitOpencode(tmp, "user", [], {
				HOME: fakeHome,
			});
			expect(exitCode).toBe(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("user scope installs to XDG path, not ~/.opencode/", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		try {
			const { exitCode } = await runInitOpencode(tmp, "user", [], {
				HOME: fakeHome,
			});
			expect(exitCode).toBe(0);

			// Must NOT install to ~/.opencode/
			const wrongPath = join(fakeHome, ".opencode");
			expect(existsSync(wrongPath)).toBe(false);

			// Must install to ~/.config/opencode/
			const correctPath = join(fakeHome, ".config", "opencode");
			expect(existsSync(correctPath)).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("user scope idempotent: second run skips all files", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		try {
			// First run
			const first = await runInitOpencode(tmp, "user", [], { HOME: fakeHome });
			expect(first.exitCode).toBe(0);

			// Second run
			const { stdout, exitCode } = await runInitOpencode(tmp, "user", [], {
				HOME: fakeHome,
			});
			expect(exitCode).toBe(0);
			expect(stdout).not.toContain("Created");
			expect(stdout).not.toContain("Overwrote");
			expect(stdout).toContain("Skipped");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("user scope --force overwrites existing files", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		try {
			// First run
			const first = await runInitOpencode(tmp, "user", [], { HOME: fakeHome });
			expect(first.exitCode).toBe(0);

			// Tamper with an agent file
			const agentPath = join(
				fakeHome,
				".config",
				"opencode",
				"agents",
				"5x-reviewer.md",
			);
			writeFileSync(agentPath, "# tampered", "utf-8");

			// Force overwrite
			const { stdout, exitCode } = await runInitOpencode(
				tmp,
				"user",
				["--force"],
				{ HOME: fakeHome },
			);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Overwrote");

			const restored = readFileSync(agentPath, "utf-8");
			expect(restored).not.toBe("# tampered");
			expect(restored).toContain("5x-reviewer");
		} finally {
			cleanupDir(tmp);
		}
	});
});
