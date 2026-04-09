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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listAgentTemplates as listCursorAgentTemplates } from "../../../src/harnesses/cursor/loader.js";
import { listSkillNames as listCursorSkillNames } from "../../../src/harnesses/cursor/skills/loader.js";
import { listAgentTemplates } from "../../../src/harnesses/opencode/loader.js";
import { listSkillNames } from "../../../src/harnesses/opencode/skills/loader.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-harness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
		"lists bundled harnesses with JSON envelope",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runCmd(tmp, ["harness", "list"]);
				expect(exitCode).toBe(0);

				// stdout has JSON envelope
				const envelope = JSON.parse(stdout);
				expect(envelope.ok).toBe(true);
				expect(envelope.data).toBeDefined();
				expect(Array.isArray(envelope.data.harnesses)).toBe(true);
				expect(envelope.data.harnesses.length).toBeGreaterThanOrEqual(1);

				const opencode = envelope.data.harnesses.find(
					(h: { name: string }) => h.name === "opencode",
				);
				expect(opencode).toBeDefined();
				expect(opencode.source).toBe("bundled");
				expect(opencode.description).toBeTruthy();
				expect(opencode.scopes.project).toBeDefined();
				expect(typeof opencode.scopes.project.installed).toBe("boolean");
				expect(typeof opencode.scopes.project.root).toBe("string");
				expect(Array.isArray(opencode.scopes.project.files)).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"shows installed state after install",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);
				await runHarnessInstall(tmp, "opencode", ["--scope", "project"]);

				const { stdout, exitCode } = await runCmd(tmp, ["harness", "list"]);
				expect(exitCode).toBe(0);

				const envelope = JSON.parse(stdout);
				const opencode = envelope.data.harnesses.find(
					(h: { name: string }) => h.name === "opencode",
				);
				expect(opencode.scopes.project.installed).toBe(true);
				expect(opencode.scopes.project.root).toContain(".opencode");
				expect(opencode.scopes.project.files.length).toBeGreaterThan(0);
				expect(opencode.scopes.project.files).toContain(
					"skills/5x-plan/SKILL.md",
				);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"uses fake HOME for user-scope list state",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });
			try {
				const install = await runHarnessInstall(
					tmp,
					"opencode",
					["--scope", "user"],
					{ HOME: fakeHome },
				);
				expect(install.exitCode).toBe(0);

				const { stdout, exitCode } = await runCmd(tmp, ["harness", "list"], {
					HOME: fakeHome,
				});
				expect(exitCode).toBe(0);

				const envelope = JSON.parse(stdout);
				const opencode = envelope.data.harnesses.find(
					(h: { name: string }) => h.name === "opencode",
				);
				expect(opencode.scopes.user.installed).toBe(true);
				expect(opencode.scopes.user.files).toContain("skills/5x-plan/SKILL.md");
				expect(
					existsSync(
						join(
							fakeHome,
							".config",
							"opencode",
							"skills",
							"5x-plan",
							"SKILL.md",
						),
					),
				).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"shows not-installed state after uninstall",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);
				await runHarnessInstall(tmp, "opencode", ["--scope", "project"]);
				await runHarnessUninstall(tmp, "opencode", ["--scope", "project"]);

				const { stdout, exitCode } = await runCmd(tmp, ["harness", "list"]);
				expect(exitCode).toBe(0);

				const envelope = JSON.parse(stdout);
				const opencode = envelope.data.harnesses.find(
					(h: { name: string }) => h.name === "opencode",
				);
				expect(opencode.scopes.project.installed).toBe(false);
				expect(opencode.scopes.project.files).toHaveLength(0);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
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
// Cursor harness integration flows
// ---------------------------------------------------------------------------

describe("5x harness install cursor", () => {
	test(
		"project scope installs skills, agents, and rules under .cursor/",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);
				const { exitCode } = await runHarnessInstall(tmp, "cursor", [
					"--scope",
					"project",
				]);
				expect(exitCode).toBe(0);

				for (const name of listCursorSkillNames()) {
					expect(
						existsSync(join(tmp, ".cursor", "skills", name, "SKILL.md")),
					).toBe(true);
				}

				for (const name of listCursorAgentTemplates().map((a) => a.name)) {
					expect(existsSync(join(tmp, ".cursor", "agents", `${name}.md`))).toBe(
						true,
					);
				}

				expect(
					existsSync(join(tmp, ".cursor", "rules", "5x-orchestrator.mdc")),
				).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"user scope installs ~/.cursor skills+agents and reports rules unsupported",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				const install = await runHarnessInstall(
					tmp,
					"cursor",
					["--scope", "user"],
					{ HOME: fakeHome },
				);
				expect(install.exitCode).toBe(0);
				expect(install.stdout).toContain(
					"Note: Cursor user rules are settings-managed. Install with --scope project to add the orchestrator rule.",
				);

				for (const name of listCursorSkillNames()) {
					expect(
						existsSync(join(fakeHome, ".cursor", "skills", name, "SKILL.md")),
					).toBe(true);
				}

				for (const name of listCursorAgentTemplates().map((a) => a.name)) {
					expect(
						existsSync(join(fakeHome, ".cursor", "agents", `${name}.md`)),
					).toBe(true);
				}

				expect(existsSync(join(fakeHome, ".cursor", "rules"))).toBe(false);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"harness list reports cursor installed state for project and user scopes",
		async () => {
			const tmp = makeTmpDir();
			const fakeHome = join(tmp, "fake-home");
			mkdirSync(fakeHome, { recursive: true });

			try {
				await bootstrapProject(tmp);
				await runHarnessInstall(tmp, "cursor", ["--scope", "project"]);
				await runHarnessInstall(tmp, "cursor", ["--scope", "user"], {
					HOME: fakeHome,
				});

				const { stdout, exitCode } = await runCmd(tmp, ["harness", "list"], {
					HOME: fakeHome,
				});
				expect(exitCode).toBe(0);

				const envelope = JSON.parse(stdout);
				const cursor = envelope.data.harnesses.find(
					(h: { name: string }) => h.name === "cursor",
				);
				expect(cursor.scopes.project.installed).toBe(true);
				expect(cursor.scopes.project.files).toContain(
					"rules/5x-orchestrator.mdc",
				);
				expect(cursor.scopes.user.installed).toBe(true);
				expect(cursor.scopes.user.unsupported).toEqual({ rules: true });
				expect(cursor.scopes.user.files).not.toContain(
					"rules/5x-orchestrator.mdc",
				);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"project scope uninstall removes .cursor skills, agents, and rules",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);
				await runHarnessInstall(tmp, "cursor", ["--scope", "project"]);

				const uninstall = await runHarnessUninstall(tmp, "cursor", [
					"--scope",
					"project",
				]);
				expect(uninstall.exitCode).toBe(0);

				for (const name of listCursorSkillNames()) {
					expect(
						existsSync(join(tmp, ".cursor", "skills", name, "SKILL.md")),
					).toBe(false);
				}

				for (const name of listCursorAgentTemplates().map((a) => a.name)) {
					expect(existsSync(join(tmp, ".cursor", "agents", `${name}.md`))).toBe(
						false,
					);
				}

				expect(
					existsSync(join(tmp, ".cursor", "rules", "5x-orchestrator.mdc")),
				).toBe(false);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
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
				expect(stdout).toContain("Allowed choices are user, project");
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
// Mixed-mode delegation: lifecycle transitions and stale-asset handling
// ---------------------------------------------------------------------------

describe("5x harness install — mixed-mode delegation lifecycle", () => {
	test(
		"install with invoke/native config skips author agents but installs reviewer + orchestrator",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Write 5x.toml with author in invoke mode, reviewer in native mode
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
provider = "codex"
model = "o3"
delegationMode = "invoke"

[reviewer]
provider = "opencode"
model = "anthropic/claude-opus-4-6"
`,
					"utf-8",
				);

				const { exitCode } = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(exitCode).toBe(0);

				// Author agents should NOT be installed (invoke mode)
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-plan-author.md")),
				).toBe(false);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-code-author.md")),
				).toBe(false);

				// Reviewer and orchestrator should be installed (native mode)
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-reviewer.md")),
				).toBe(true);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-orchestrator.md")),
				).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"install with native/invoke config installs author agents but skips reviewer",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Write 5x.toml with author in native mode, reviewer in invoke mode
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
provider = "opencode"
model = "anthropic/claude-opus-4-6"
delegationMode = "native"

[reviewer]
provider = "codex"
model = "o3"
delegationMode = "invoke"
`,
					"utf-8",
				);

				const { exitCode } = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(exitCode).toBe(0);

				// Author agents should be installed (native mode)
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-plan-author.md")),
				).toBe(true);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-code-author.md")),
				).toBe(true);

				// Reviewer should NOT be installed (invoke mode), but orchestrator should
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-reviewer.md")),
				).toBe(false);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-orchestrator.md")),
				).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"install with invoke/invoke config only installs orchestrator",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Write 5x.toml with both roles in invoke mode
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "invoke"

[reviewer]
delegationMode = "invoke"
`,
					"utf-8",
				);

				const { exitCode } = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(exitCode).toBe(0);

				// Only orchestrator should be installed
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-orchestrator.md")),
				).toBe(true);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-plan-author.md")),
				).toBe(false);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-code-author.md")),
				).toBe(false);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-reviewer.md")),
				).toBe(false);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"config change from native/native to invoke/native removes author agents on reinstall",
		async () => {
			const tmp = makeTmpDir();
			try {
				// First install: native/native (default)
				await bootstrapProject(tmp);
				const first = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(first.exitCode).toBe(0);

				// Verify all agents are present
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-plan-author.md")),
				).toBe(true);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-code-author.md")),
				).toBe(true);

				// Change config to invoke/native
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "invoke"

[reviewer]
delegationMode = "native"
`,
					"utf-8",
				);

				// Reinstall with force
				const second = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
					"--force",
				]);
				expect(second.exitCode).toBe(0);

				// Author agents should be removed, reviewer and orchestrator remain
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-plan-author.md")),
				).toBe(false);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-code-author.md")),
				).toBe(false);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-reviewer.md")),
				).toBe(true);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-orchestrator.md")),
				).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"harness list accurately reports installed agents after mixed-mode install",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Install with invoke/native (author invoke, reviewer native)
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "invoke"

[reviewer]
delegationMode = "native"
`,
					"utf-8",
				);

				await runHarnessInstall(tmp, "opencode", ["--scope", "project"]);

				// List and verify
				const { stdout, exitCode } = await runCmd(tmp, ["harness", "list"]);
				expect(exitCode).toBe(0);

				const envelope = JSON.parse(stdout);
				const opencode = envelope.data.harnesses.find(
					(h: { name: string }) => h.name === "opencode",
				);
				expect(opencode.scopes.project.installed).toBe(true);

				// Should list only installed files (reviewer + orchestrator, not author)
				const agentFiles = opencode.scopes.project.files.filter((f: string) =>
					f.startsWith("agents/"),
				);
				expect(agentFiles).toContain("agents/5x-reviewer.md");
				expect(agentFiles).toContain("agents/5x-orchestrator.md");
				expect(agentFiles).not.toContain("agents/5x-plan-author.md");
				expect(agentFiles).not.toContain("agents/5x-code-author.md");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"uninstall removes all managed agents regardless of current config",
		async () => {
			const tmp = makeTmpDir();
			try {
				// Install with mixed mode
				await bootstrapProject(tmp);
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "invoke"

[reviewer]
delegationMode = "native"
`,
					"utf-8",
				);
				await runHarnessInstall(tmp, "opencode", ["--scope", "project"]);

				// Change config to native/native before uninstall
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "native"

[reviewer]
delegationMode = "native"
`,
					"utf-8",
				);

				// Uninstall should still remove all files
				const result = await runHarnessUninstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(result.exitCode).toBe(0);

				// All agents should be removed
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-orchestrator.md")),
				).toBe(false);
				expect(
					existsSync(join(tmp, ".opencode", "agents", "5x-reviewer.md")),
				).toBe(false);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"config change preserves user-authored agent files while removing stale 5x-managed files",
		async () => {
			const tmp = makeTmpDir();
			try {
				// First install: native/native (default)
				await bootstrapProject(tmp);
				const first = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(first.exitCode).toBe(0);

				// Add user-authored agent files
				const agentsDir = join(tmp, ".opencode", "agents");
				writeFileSync(
					join(agentsDir, "my-custom-agent.md"),
					"# My Custom Agent\n\nCustom instructions here",
					"utf-8",
				);
				writeFileSync(
					join(agentsDir, "third-party-helper.md"),
					"# Third Party Helper\n\nThird party instructions",
					"utf-8",
				);

				// Verify all files exist
				expect(existsSync(join(agentsDir, "5x-plan-author.md"))).toBe(true);
				expect(existsSync(join(agentsDir, "5x-code-author.md"))).toBe(true);
				expect(existsSync(join(agentsDir, "my-custom-agent.md"))).toBe(true);
				expect(existsSync(join(agentsDir, "third-party-helper.md"))).toBe(true);

				// Change config to invoke/native (author invoke, reviewer native)
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "invoke"

[reviewer]
delegationMode = "native"
`,
					"utf-8",
				);

				// Reinstall with force to trigger stale cleanup
				const second = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
					"--force",
				]);
				expect(second.exitCode).toBe(0);

				// Stale 5x-managed author agents should be removed
				expect(existsSync(join(agentsDir, "5x-plan-author.md"))).toBe(false);
				expect(existsSync(join(agentsDir, "5x-code-author.md"))).toBe(false);

				// User-authored and third-party agents should be preserved
				expect(existsSync(join(agentsDir, "my-custom-agent.md"))).toBe(true);
				expect(existsSync(join(agentsDir, "third-party-helper.md"))).toBe(true);

				// Native-mode agents should remain
				expect(existsSync(join(agentsDir, "5x-reviewer.md"))).toBe(true);
				expect(existsSync(join(agentsDir, "5x-orchestrator.md"))).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);
});

// ---------------------------------------------------------------------------
// Phase 5: Harness Skill Loader Integration — Mixed-mode skill rendering
// ---------------------------------------------------------------------------

describe("5x harness install — mixed-mode skill rendering", () => {
	test(
		"install with author invoke mode renders skills with 5x invoke for author steps",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Write 5x.toml with author in invoke mode, reviewer in native mode
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
provider = "codex"
model = "o3"
delegationMode = "invoke"

[reviewer]
provider = "opencode"
model = "anthropic/claude-opus-4-6"
`,
					"utf-8",
				);

				const { exitCode } = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(exitCode).toBe(0);

				// Read the installed 5x-phase-execution skill
				const skillPath = join(
					tmp,
					".opencode",
					"skills",
					"5x-phase-execution",
					"SKILL.md",
				);
				const skillContent = readFileSync(skillPath, "utf-8");

				// In mixed mode (author invoke, reviewer native):
				// - Author steps should reference `5x invoke` (not Task tool)
				// - Reviewer steps should reference Task tool
				// Since we can't easily distinguish which sections are author vs reviewer,
				// we verify that BOTH patterns can be present (skill contains invoke path
				// for author and native path for reviewer)

				// The skill should contain `5x invoke` (for author steps)
				expect(skillContent).toContain("5x invoke");

				// The skill should also contain Task tool references (for reviewer steps)
				expect(skillContent).toContain("Task tool");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"install with default native/native config renders skills with Task tool only",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Default config (no delegationMode specified = native for both)
				const { exitCode } = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(exitCode).toBe(0);

				// Read the installed 5x-phase-execution skill
				const skillPath = join(
					tmp,
					".opencode",
					"skills",
					"5x-phase-execution",
					"SKILL.md",
				);
				const skillContent = readFileSync(skillPath, "utf-8");

				// In native/native mode, skills should ONLY reference Task tool
				expect(skillContent).toContain("Task tool");
				// Should NOT contain `5x invoke` for delegation (only in invoke paths)
				expect(skillContent).not.toContain("5x invoke");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"config change from native/native to invoke/native updates skill files on reinstall",
		async () => {
			const tmp = makeTmpDir();
			try {
				// First install: native/native (default)
				await bootstrapProject(tmp);
				const first = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
				]);
				expect(first.exitCode).toBe(0);

				// Verify initial state: only Task tool references
				const skillPath = join(
					tmp,
					".opencode",
					"skills",
					"5x-phase-execution",
					"SKILL.md",
				);
				const initialContent = readFileSync(skillPath, "utf-8");
				expect(initialContent).toContain("Task tool");
				expect(initialContent).not.toContain("5x invoke");

				// Change config to invoke/native
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "invoke"

[reviewer]
delegationMode = "native"
`,
					"utf-8",
				);

				// Reinstall with force to update skill files
				const second = await runHarnessInstall(tmp, "opencode", [
					"--scope",
					"project",
					"--force",
				]);
				expect(second.exitCode).toBe(0);

				// Verify updated state: contains both patterns (mixed mode)
				const updatedContent = readFileSync(skillPath, "utf-8");
				expect(updatedContent).toContain("5x invoke");
				expect(updatedContent).toContain("Task tool");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"cursor harness renders skills with correct delegation patterns in mixed mode",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Write 5x.toml with mixed mode for cursor
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "invoke"

[reviewer]
delegationMode = "native"
`,
					"utf-8",
				);

				const { exitCode } = await runHarnessInstall(tmp, "cursor", [
					"--scope",
					"project",
				]);
				expect(exitCode).toBe(0);

				// Read the installed 5x-phase-execution skill
				const skillPath = join(
					tmp,
					".cursor",
					"skills",
					"5x-phase-execution",
					"SKILL.md",
				);
				const skillContent = readFileSync(skillPath, "utf-8");

				// In mixed mode: should contain both patterns
				expect(skillContent).toContain("5x invoke");
				expect(skillContent).toContain("Cursor subagent invocation");

				// Should NOT contain "Task tool" (cursor terminology adapts this)
				expect(skillContent).not.toContain("Task tool");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"harness list shows correct files after mixed-mode install",
		async () => {
			const tmp = makeTmpDir();
			try {
				await bootstrapProject(tmp);

				// Install with mixed mode
				writeFileSync(
					join(tmp, "5x.toml"),
					`
[author]
delegationMode = "invoke"

[reviewer]
delegationMode = "native"
`,
					"utf-8",
				);

				await runHarnessInstall(tmp, "opencode", ["--scope", "project"]);

				// List and verify
				const { stdout, exitCode } = await runCmd(tmp, ["harness", "list"]);
				expect(exitCode).toBe(0);

				const envelope = JSON.parse(stdout);
				const opencode = envelope.data.harnesses.find(
					(h: { name: string }) => h.name === "opencode",
				);
				expect(opencode.scopes.project.installed).toBe(true);

				// Should list all skill files (skills are always installed regardless of mode)
				expect(opencode.scopes.project.files).toContain(
					"skills/5x-phase-execution/SKILL.md",
				);
				expect(opencode.scopes.project.files).toContain(
					"skills/5x-plan/SKILL.md",
				);
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
