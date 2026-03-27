/**
 * Unit tests for harness handler — direct function calls, filesystem assertions only.
 *
 * Converted from test/integration/commands/harness.test.ts (Phase 4).
 * Tests that assert on CLI stdout/stderr/exit codes or require HOME env
 * mutation remain in test/integration/commands/harness.test.ts.
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
import { join } from "node:path";
import {
	buildHarnessListData,
	harnessInstall,
	harnessList,
	harnessUninstall,
} from "../../../src/commands/harness.handler.js";
import { initScaffold } from "../../../src/commands/init.handler.js";
import { isValidPlugin } from "../../../src/harnesses/factory.js";
import { listAgentTemplates } from "../../../src/harnesses/opencode/loader.js";
import { listSkillNames } from "../../../src/harnesses/opencode/skills/loader.js";
import { setOutputFormat } from "../../../src/output.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-harness-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/**
 * Bootstrap a minimal 5x project in a temp dir via direct handler call.
 */
async function bootstrapProject(dir: string): Promise<void> {
	await initScaffold({ startDir: dir });
}

// ---------------------------------------------------------------------------
// `harnessInstall` — project scope, filesystem side-effect tests
// ---------------------------------------------------------------------------

describe("harnessInstall --scope project", () => {
	test("injects per-harness model strings from harnessModels", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			writeFileSync(
				join(tmp, "5x.toml"),
				`[author]
model = "fallback-author"
[author.harnessModels]
opencode = "anthropic/sonnet-for-opencode"
cursor = "claude-sonnet-for-cursor"

[reviewer]
model = "fallback-reviewer"
[reviewer.harnessModels]
opencode = "openai/gpt-for-opencode"
cursor = "gpt-for-cursor"
`,
				"utf-8",
			);

			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const planAuthor = readFileSync(
				join(tmp, ".opencode", "agents", "5x-plan-author.md"),
				"utf-8",
			);
			expect(planAuthor).toContain("anthropic/sonnet-for-opencode");
			const reviewer = readFileSync(
				join(tmp, ".opencode", "agents", "5x-reviewer.md"),
				"utf-8",
			);
			expect(reviewer).toContain("openai/gpt-for-opencode");

			await harnessInstall({
				name: "cursor",
				scope: "project",
				startDir: tmp,
			});

			const cursorPlan = readFileSync(
				join(tmp, ".cursor", "agents", "5x-plan-author.md"),
				"utf-8",
			);
			expect(cursorPlan).toContain("claude-sonnet-for-cursor");
			const cursorRev = readFileSync(
				join(tmp, ".cursor", "agents", "5x-reviewer.md"),
				"utf-8",
			);
			expect(cursorRev).toContain("gpt-for-cursor");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("installs all bundled skills under .opencode/skills/", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const skillNames = listSkillNames();
			for (const name of skillNames) {
				const skillPath = join(tmp, ".opencode", "skills", name, "SKILL.md");
				expect(existsSync(skillPath)).toBe(true);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("installs all bundled agent profiles under .opencode/agents/", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const agentNames = listAgentTemplates().map((a) => a.name);
			for (const name of agentNames) {
				const agentPath = join(tmp, ".opencode", "agents", `${name}.md`);
				expect(existsSync(agentPath)).toBe(true);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("installs 5 skills and 4 agents (3 subagents + 1 orchestrator)", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const skillsDir = join(tmp, ".opencode", "skills");
			const agentsDir = join(tmp, ".opencode", "agents");

			const skillNames = listSkillNames();
			expect(skillNames).toHaveLength(5);

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

	test("fails when control plane state DB is absent", async () => {
		const tmp = makeTmpDir();
		try {
			expect(
				async () =>
					await harnessInstall({
						name: "opencode",
						scope: "project",
						startDir: tmp,
					}),
			).toThrow("5x init");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("idempotent: second run without --force skips all files", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);

			// First run
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Capture file contents after first install
			const skillNames = listSkillNames();
			const firstContents = new Map<string, string>();
			for (const name of skillNames) {
				const skillPath = join(tmp, ".opencode", "skills", name, "SKILL.md");
				firstContents.set(skillPath, readFileSync(skillPath, "utf-8"));
			}

			// Second run (no --force)
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Files unchanged after second run
			for (const [path, content] of firstContents) {
				expect(readFileSync(path, "utf-8")).toBe(content);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("--force overwrites existing skill and agent files", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);

			// First install
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Overwrite existing content in one skill file
			const skillPath = join(tmp, ".opencode", "skills", "5x-plan", "SKILL.md");
			writeFileSync(skillPath, "# custom content", "utf-8");

			// Second run with --force
			await harnessInstall({
				name: "opencode",
				scope: "project",
				force: true,
				startDir: tmp,
			});

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
// isValidPlugin — duck-type validation
// ---------------------------------------------------------------------------

describe("isValidPlugin", () => {
	const validPlugin = {
		name: "test",
		description: "A test plugin",
		supportedScopes: ["project"],
		locations: { resolve: () => ({ agentsDir: "", skillsDir: "" }) },
		describe: () => ({ skillNames: [], agentNames: [] }),
		install: async () => ({
			skills: { created: [], overwritten: [], skipped: [] },
			agents: { created: [], overwritten: [], skipped: [] },
		}),
		uninstall: async () => ({
			skills: { removed: [], notFound: [] },
			agents: { removed: [], notFound: [] },
		}),
	};

	test("accepts a fully valid plugin", () => {
		expect(isValidPlugin(validPlugin)).toBe(true);
	});

	test("rejects plugin missing locations", () => {
		const { locations, ...incomplete } = validPlugin;
		expect(isValidPlugin(incomplete)).toBe(false);
	});

	test("rejects plugin missing describe", () => {
		const { describe: _d, ...incomplete } = validPlugin;
		expect(isValidPlugin(incomplete)).toBe(false);
	});

	test("rejects plugin missing uninstall", () => {
		const { uninstall, ...incomplete } = validPlugin;
		expect(isValidPlugin(incomplete)).toBe(false);
	});

	test("rejects plugin missing install", () => {
		const { install, ...incomplete } = validPlugin;
		expect(isValidPlugin(incomplete)).toBe(false);
	});

	test("rejects plugin with locations missing resolve()", () => {
		const badLocations = { ...validPlugin, locations: {} };
		expect(isValidPlugin(badLocations)).toBe(false);
	});

	test("rejects null", () => {
		expect(isValidPlugin(null)).toBe(false);
	});

	test("rejects undefined", () => {
		expect(isValidPlugin(undefined)).toBe(false);
	});

	test("rejects non-object", () => {
		expect(isValidPlugin("string")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// `harnessUninstall` — project scope
// ---------------------------------------------------------------------------

describe("harnessUninstall --scope project", () => {
	test("removes all installed skill and agent files", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Verify files exist first
			const skillNames = listSkillNames();
			const agentNames = listAgentTemplates().map((a) => a.name);
			for (const name of skillNames) {
				expect(
					existsSync(join(tmp, ".opencode", "skills", name, "SKILL.md")),
				).toBe(true);
			}
			for (const name of agentNames) {
				expect(existsSync(join(tmp, ".opencode", "agents", `${name}.md`))).toBe(
					true,
				);
			}

			// Uninstall
			const output = await harnessUninstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Verify files removed
			for (const name of skillNames) {
				expect(
					existsSync(join(tmp, ".opencode", "skills", name, "SKILL.md")),
				).toBe(false);
			}
			for (const name of agentNames) {
				expect(existsSync(join(tmp, ".opencode", "agents", `${name}.md`))).toBe(
					false,
				);
			}

			// Verify output shape
			expect(output.harnessName).toBe("opencode");
			expect(output.scopes.project).toBeDefined();
			expect(output.scopes.user).toBeUndefined();
			expect(output.scopes.project?.skills.removed.length).toBe(
				skillNames.length,
			);
			expect(output.scopes.project?.agents.removed.length).toBe(
				agentNames.length,
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports not-found gracefully when files are missing", async () => {
		const tmp = makeTmpDir();
		try {
			// No install — just uninstall directly
			const output = await harnessUninstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const skillNames = listSkillNames();
			const agentNames = listAgentTemplates().map((a) => a.name);

			expect(output.scopes.project).toBeDefined();
			expect(output.scopes.project?.skills.removed).toHaveLength(0);
			expect(output.scopes.project?.skills.notFound.length).toBe(
				skillNames.length,
			);
			expect(output.scopes.project?.agents.removed).toHaveLength(0);
			expect(output.scopes.project?.agents.notFound.length).toBe(
				agentNames.length,
			);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// `harnessUninstall` — user scope
// ---------------------------------------------------------------------------

describe("harnessUninstall --scope user", () => {
	test("removes installed files from user scope", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		try {
			await harnessInstall({
				name: "opencode",
				scope: "user",
				startDir: tmp,
				homeDir: fakeHome,
			});

			const userSkillPath = join(
				fakeHome,
				".config",
				"opencode",
				"skills",
				"5x-plan",
				"SKILL.md",
			);
			expect(existsSync(userSkillPath)).toBe(true);

			const output = await harnessUninstall({
				name: "opencode",
				scope: "user",
				startDir: tmp,
				homeDir: fakeHome,
			});

			expect(output.harnessName).toBe("opencode");
			expect(output.scopes.user).toBeDefined();
			expect(output.scopes.project).toBeUndefined();
			expect(output.scopes.user?.skills.removed).toContain("5x-plan/SKILL.md");
			expect(existsSync(userSkillPath)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// `harnessUninstall` — --all flag
// ---------------------------------------------------------------------------

describe("harnessUninstall --all", () => {
	test("processes both supported scopes", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});
			await harnessInstall({
				name: "opencode",
				scope: "user",
				startDir: tmp,
				homeDir: fakeHome,
			});

			const output = await harnessUninstall({
				name: "opencode",
				all: true,
				startDir: tmp,
				homeDir: fakeHome,
			});

			expect(output.harnessName).toBe("opencode");
			expect(output.scopes.project).toBeDefined();
			expect(output.scopes.user).toBeDefined();
			expect(output.scopes.project?.skills.removed).toContain(
				"5x-plan/SKILL.md",
			);
			expect(output.scopes.user?.skills.removed).toContain("5x-plan/SKILL.md");
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
			).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("outside a git repo uses cwd as project root", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Verify files are installed
			const skillNames = listSkillNames();
			for (const name of skillNames) {
				expect(
					existsSync(join(tmp, ".opencode", "skills", name, "SKILL.md")),
				).toBe(true);
			}

			// Uninstall with --all from a non-git dir
			// startDir is a temp dir that has the files — falls back to cwd
			const output = await harnessUninstall({
				name: "opencode",
				all: true,
				startDir: tmp,
				homeDir: fakeHome,
			});

			expect(output.scopes.project).toBeDefined();
			expect(output.scopes.project?.skills.removed.length).toBe(
				skillNames.length,
			);

			// Verify files removed
			for (const name of skillNames) {
				expect(
					existsSync(join(tmp, ".opencode", "skills", name, "SKILL.md")),
				).toBe(false);
			}
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// `harnessUninstall` — validation
// ---------------------------------------------------------------------------

describe("harnessUninstall validation", () => {
	test("errors when neither --scope nor --all provided", async () => {
		const tmp = makeTmpDir();
		try {
			await expect(
				harnessUninstall({
					name: "opencode",
					startDir: tmp,
				}),
			).rejects.toThrow("Must specify either --scope or --all");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("errors when both --scope and --all provided", async () => {
		const tmp = makeTmpDir();
		try {
			await expect(
				harnessUninstall({
					name: "opencode",
					scope: "project",
					all: true,
					startDir: tmp,
				}),
			).rejects.toThrow("Cannot specify both --scope and --all");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("errors on invalid scope value", async () => {
		const tmp = makeTmpDir();
		try {
			await expect(
				harnessUninstall({
					name: "opencode",
					scope: "global",
					startDir: tmp,
				}),
			).rejects.toThrow("Invalid scope");
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// `buildHarnessListData` — enhanced harness list
// ---------------------------------------------------------------------------

describe("buildHarnessListData", () => {
	test("lists bundled harness with correct source label", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			const output = await buildHarnessListData(tmp, fakeHome);

			expect(output.harnesses.length).toBeGreaterThanOrEqual(1);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode) {
				throw new Error("Expected opencode harness in list output");
			}
			expect(opencode.source).toBe("bundled");
			expect(opencode.description).toBeTruthy();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("includes scope-aware capabilities metadata in JSON output", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			const output = await buildHarnessListData(tmp, fakeHome);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode?.scopes.project || !opencode.scopes.user) {
				throw new Error("Expected both scopes for opencode");
			}

			expect(opencode.scopes.project.capabilities).toEqual({ rules: false });
			expect(opencode.scopes.user.capabilities).toEqual({ rules: false });
		} finally {
			cleanupDir(tmp);
		}
	});

	test("marks rules unsupported when scope does not support rule assets", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			const output = await buildHarnessListData(tmp, fakeHome);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode?.scopes.project || !opencode.scopes.user) {
				throw new Error("Expected both scopes for opencode");
			}

			expect(opencode.scopes.project.unsupported).toEqual({ rules: true });
			expect(opencode.scopes.user.unsupported).toEqual({ rules: true });
		} finally {
			cleanupDir(tmp);
		}
	});

	test("preserves existing file-list schema with added metadata fields", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const output = await buildHarnessListData(tmp, fakeHome);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode?.scopes.project) {
				throw new Error("Expected project scope for opencode");
			}

			expect(opencode.scopes.project.files).toContain(
				"skills/5x-plan/SKILL.md",
			);
			expect(opencode.scopes.project.files).toContain("agents/5x-reviewer.md");
			expect(
				opencode.scopes.project.files.some((f) => f.startsWith("rules/")),
			).toBe(false);
			expect(opencode.scopes.project.installed).toBe(true);
			expect(opencode.scopes.project.capabilities).toEqual({ rules: false });
			expect(opencode.scopes.project.unsupported).toEqual({ rules: true });
		} finally {
			cleanupDir(tmp);
		}
	});

	test("shows installed state when files exist on disk", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const output = await buildHarnessListData(tmp, fakeHome);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode?.scopes.project) {
				throw new Error("Expected project scope for opencode");
			}
			expect(opencode.scopes.project).toBeDefined();
			expect(opencode.scopes.project.installed).toBe(true);
			expect(opencode.scopes.project.root).toBe(join(tmp, ".opencode"));
			expect(opencode.scopes.project.files.length).toBeGreaterThan(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("shows not-installed state when files are absent", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			const output = await buildHarnessListData(tmp, fakeHome);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode?.scopes.project) {
				throw new Error("Expected project scope for opencode");
			}
			expect(opencode.scopes.project).toBeDefined();
			expect(opencode.scopes.project.installed).toBe(false);
			expect(opencode.scopes.project.files).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports not-installed for project scope in plain directory", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			// No git repo, no harness files — project root falls back to cwd
			const output = await buildHarnessListData(tmp, fakeHome);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode?.scopes.project) {
				throw new Error("Expected project scope for opencode");
			}
			expect(opencode.scopes.project).toBeDefined();
			expect(opencode.scopes.project.installed).toBe(false);
			expect(opencode.scopes.project.files).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("file list matches expected managed files", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const output = await buildHarnessListData(tmp, fakeHome);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode?.scopes.project) {
				throw new Error("Expected project scope for opencode");
			}

			const projectFiles = opencode.scopes.project.files;

			// Check skill files
			const skillNames = listSkillNames();
			for (const name of skillNames) {
				expect(projectFiles).toContain(`skills/${name}/SKILL.md`);
			}

			// Check agent files
			const agentNames = listAgentTemplates().map((a) => a.name);
			for (const name of agentNames) {
				expect(projectFiles).toContain(`agents/${name}.md`);
			}

			// Total count should match skills + agents
			expect(projectFiles).toHaveLength(skillNames.length + agentNames.length);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("checks user scope against provided fake home only", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			await harnessInstall({
				name: "opencode",
				scope: "user",
				startDir: tmp,
				homeDir: fakeHome,
			});

			const output = await buildHarnessListData(tmp, fakeHome);
			const opencode = output.harnesses.find((h) => h.name === "opencode");
			expect(opencode).toBeDefined();
			if (!opencode?.scopes.user) {
				throw new Error("Expected user scope for opencode");
			}
			expect(opencode.scopes.user).toBeDefined();
			expect(opencode.scopes.user.installed).toBe(true);
			expect(opencode.scopes.user.root).toBe(
				join(fakeHome, ".config", "opencode"),
			);
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
	});
});

// ---------------------------------------------------------------------------
// `harnessList` --text readable output
// ---------------------------------------------------------------------------

describe("harnessList readable output", () => {
	test("lists rules files when present in scope files", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		const originalLog = console.log;
		const logs: string[] = [];

		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "cursor",
				scope: "project",
				startDir: tmp,
				homeDir: fakeHome,
			});

			setOutputFormat("text");
			console.log = (...args: unknown[]) => {
				logs.push(args.join(" "));
			};

			await harnessList({ startDir: tmp, homeDir: fakeHome });

			expect(logs.join("\n")).toContain("rules/5x-orchestrator.mdc");
		} finally {
			console.log = originalLog;
			setOutputFormat("json");
			cleanupDir(tmp);
		}
	});

	test("shows unsupported rules note for cursor user scope", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "fake-home");
		mkdirSync(fakeHome, { recursive: true });

		const originalLog = console.log;
		const logs: string[] = [];

		try {
			await harnessInstall({
				name: "cursor",
				scope: "user",
				startDir: tmp,
				homeDir: fakeHome,
			});

			setOutputFormat("text");
			console.log = (...args: unknown[]) => {
				logs.push(args.join(" "));
			};

			await harnessList({ startDir: tmp, homeDir: fakeHome });

			const output = logs.join("\n");
			expect(output).toContain("rules: unsupported");
			expect(output).toContain(
				"Note: Cursor user rules are settings-managed and not file-backed. Install with --scope project to add the orchestrator rule.",
			);
		} finally {
			console.log = originalLog;
			setOutputFormat("json");
			cleanupDir(tmp);
		}
	});
});
