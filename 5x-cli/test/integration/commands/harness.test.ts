/**
 * Integration tests for `5x harness install` and `5x harness list`.
 *
 * Tests that assert on filesystem side effects via direct handler calls
 * have been moved to test/unit/commands/harness.test.ts (Phase 4).
 *
 * Remaining tests require the CLI layer (stdout/stderr/exit-code assertions)
 * or HOME-dependent behavior that requires process-wide env mutation.
 *
 * Covers:
 * - `5x harness list` output
 * - `5x harness install opencode --scope user` resolves correct global paths
 * - --scope validation (required when ambiguous, auto-inferred when single)
 * - Unknown harness name error
 * - Legacy `5x init` bare command
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
import { listAgentTemplates } from "../../../src/harnesses/opencode/loader.js";
import { listSkillNames } from "../../../src/skills/loader.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		homedir(),
		`.5x-harness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

async function runInit(
	cwd: string,
	extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return runCmd(cwd, ["init", ...extraArgs]);
}

async function runHarnessInstall(
	cwd: string,
	name: string,
	extraArgs: string[] = [],
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return runCmd(cwd, ["harness", "install", name, ...extraArgs], env);
}

/**
 * Bootstrap a minimal 5x project in a temp dir (writes 5x.toml, .5x/, 5x.db).
 */
async function bootstrapProject(dir: string): Promise<void> {
	await runInit(dir);
}

// ---------------------------------------------------------------------------
// `5x harness list`
// ---------------------------------------------------------------------------

describe("5x harness list", () => {
	test(
		"lists bundled harnesses",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runCmd(tmp, ["harness", "list"]);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("opencode");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// `5x harness install opencode --scope user`
// ---------------------------------------------------------------------------

describe("5x harness install opencode --scope user", () => {
	test(
		"installs skills under ~/.config/opencode/skills/",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				const { exitCode } = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);

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
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"installs agents under ~/.config/opencode/agents/",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				const { exitCode } = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);

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
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"user scope does NOT require control plane",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				// No 5x init done — no .5x/ or 5x.toml
				const { exitCode } = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);
				expect(exitCode).toBe(0);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"user scope installs to XDG path, not ~/.opencode/",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				const { exitCode } = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);
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
		},
		{ timeout: 15000 },
	);

	test(
		"user scope idempotent: second run skips all files",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				const first = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);
				expect(first.exitCode).toBe(0);

				const { stdout, exitCode } = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);
				expect(exitCode).toBe(0);
				expect(stdout).not.toContain("Created");
				expect(stdout).not.toContain("Overwrote");
				expect(stdout).toContain("Skipped");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"user scope --force overwrites existing files",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				const first = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);
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
				const { stdout, exitCode } = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user", "--force"],
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
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

describe("5x harness install — scope validation", () => {
	test(
		"fails when --scope is omitted for multi-scope harness",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);
				const { stdout, exitCode } = await runHarnessInstall(tmp, "opencode");

				expect(exitCode).not.toBe(0);
				expect(stdout).toContain("--scope");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"fails when --scope has invalid value",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);
				const { stdout, exitCode } = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"global",
				]);

				expect(exitCode).not.toBe(0);
				expect(stdout).toContain("Invalid scope");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Unknown harness
// ---------------------------------------------------------------------------

describe("5x harness install — unknown harness", () => {
	test(
		"fails with install instructions for unknown harness",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runHarnessInstall(
					tmp,
					"nonexistent-harness",
					["--scope", "project"],
				);

				expect(exitCode).not.toBe(0);
				expect(stdout).toContain("not found");
				expect(stdout).toContain("@5x-ai/harness-nonexistent-harness");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Legacy compatibility: bare `5x init --force` still works
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// `5x harness uninstall`
// ---------------------------------------------------------------------------

async function runHarnessUninstall(
	cwd: string,
	name: string,
	extraArgs: string[] = [],
	env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return runCmd(cwd, ["harness", "uninstall", name, ...extraArgs], env);
}

describe("5x harness uninstall — round-trip", () => {
	test(
		"install → verify → uninstall → verify removed (project scope)",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Install
				const installResult = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(installResult.exitCode).toBe(0);

				// Verify files exist
				const skillNames = listSkillNames();
				const agentNames = listAgentTemplates().map((a) => a.name);
				for (const name of skillNames) {
					expect(
						existsSync(join(tmp, ".opencode", "skills", name, "SKILL.md")),
					).toBe(true);
				}
				for (const name of agentNames) {
					expect(
						existsSync(join(tmp, ".opencode", "agents", `${name}.md`)),
					).toBe(true);
				}

				// Uninstall
				const uninstallResult = await runHarnessUninstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(uninstallResult.exitCode).toBe(0);
				expect(uninstallResult.stderr).toContain("Removed");
				expect(uninstallResult.stderr).toContain("uninstall complete");

				// Verify files removed
				for (const name of skillNames) {
					expect(
						existsSync(join(tmp, ".opencode", "skills", name, "SKILL.md")),
					).toBe(false);
				}
				for (const name of agentNames) {
					expect(
						existsSync(join(tmp, ".opencode", "agents", `${name}.md`)),
					).toBe(false);
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"uninstall emits JSON success envelope on stdout",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Install first
				const installResult = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(installResult.exitCode).toBe(0);

				// Uninstall and check JSON envelope
				const { stdout, exitCode } = await runHarnessUninstall(
					tmp,
					"opencode",
					["--scope", "project"],
				);
				expect(exitCode).toBe(0);

				const envelope = JSON.parse(stdout);
				expect(envelope.ok).toBe(true);
				expect(envelope.data).toBeDefined();
				expect(envelope.data.harnessName).toBe("opencode");
				expect(envelope.data.scopes).toBeDefined();
				expect(envelope.data.scopes.project).toBeDefined();
				expect(envelope.data.scopes.project.skills).toBeDefined();
				expect(Array.isArray(envelope.data.scopes.project.skills.removed)).toBe(
					true,
				);
				expect(
					Array.isArray(envelope.data.scopes.project.skills.notFound),
				).toBe(true);
				expect(envelope.data.scopes.project.agents).toBeDefined();
				expect(Array.isArray(envelope.data.scopes.project.agents.removed)).toBe(
					true,
				);
				expect(
					Array.isArray(envelope.data.scopes.project.agents.notFound),
				).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--all removes from both scopes",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				await bootstrapProject(tmp);

				// Install project scope
				const installProject = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(installProject.exitCode).toBe(0);

				// Install user scope
				const installUser = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);
				expect(installUser.exitCode).toBe(0);

				// Verify files exist in both scopes
				const skillNames = listSkillNames();
				for (const name of skillNames) {
					expect(
						existsSync(join(tmp, ".opencode", "skills", name, "SKILL.md")),
					).toBe(true);
					expect(
						existsSync(
							join(fakeHome, ".config", "opencode", "skills", name, "SKILL.md"),
						),
					).toBe(true);
				}

				// Uninstall --all
				const uninstallResult = await runHarnessUninstall(
					tmp,
					"opencode",
					["--all"],
					{ HOME: fakeHome },
				);
				expect(uninstallResult.exitCode).toBe(0);

				// Verify project-scope files removed
				for (const name of skillNames) {
					expect(
						existsSync(join(tmp, ".opencode", "skills", name, "SKILL.md")),
					).toBe(false);
				}

				// Verify user-scope files removed
				for (const name of skillNames) {
					expect(
						existsSync(
							join(fakeHome, ".config", "opencode", "skills", name, "SKILL.md"),
						),
					).toBe(false);
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);
});

// ---------------------------------------------------------------------------
// Legacy compatibility: bare `5x init --force` still works
// ---------------------------------------------------------------------------

describe("5x init (no subcommands)", () => {
	test(
		"bare 5x init --force works without arguments",
		async () => {
			const tmp = makeTmpDir();
			try {
				const first = await runInit(tmp);
				expect(first.exitCode).toBe(0);

				const { stdout, exitCode } = await runInit(tmp, ["--force"]);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("Overwrote 5x.toml");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"bare 5x init prints harness install hint",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runInit(tmp);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("5x harness install opencode");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});
