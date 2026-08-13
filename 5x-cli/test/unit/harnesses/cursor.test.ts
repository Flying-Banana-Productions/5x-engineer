import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessListData } from "../../../src/commands/harness.handler.js";
import cursorPlugin from "../../../src/harnesses/cursor/plugin.js";
import {
	listBundledHarnesses,
	loadHarnessPlugin,
} from "../../../src/harnesses/factory.js";
import { cursorLocationResolver } from "../../../src/harnesses/locations.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-cursor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

describe("cursor harness factory", () => {
	test("lists cursor as bundled harness", () => {
		expect(listBundledHarnesses()).toContain("cursor");
	});

	test("loadHarnessPlugin resolves bundled cursor plugin", async () => {
		const { plugin, source } = await loadHarnessPlugin("cursor");
		expect(source).toBe("bundled");
		expect(plugin.name).toBe("cursor");
		expect(plugin.supportedScopes).toEqual(["project", "user"]);
	});
});

describe("cursor location resolver", () => {
	test("project scope resolves .cursor with skills/agents/rules", () => {
		const root = "/tmp/project";
		const locations = cursorLocationResolver.resolve("project", root);
		expect(locations.rootDir).toBe(join(root, ".cursor"));
		expect(locations.skillsDir).toBe(join(root, ".cursor", "skills"));
		expect(locations.agentsDir).toBe(join(root, ".cursor", "agents"));
		expect(locations.rulesDir).toBe(join(root, ".cursor", "rules"));
	});

	test("user scope resolves ~/.cursor with no rulesDir", () => {
		const fakeHome = "/tmp/fake-home";
		const locations = cursorLocationResolver.resolve(
			"user",
			"/ignored",
			fakeHome,
		);
		expect(locations.rootDir).toBe(join(fakeHome, ".cursor"));
		expect(locations.skillsDir).toBe(join(fakeHome, ".cursor", "skills"));
		expect(locations.agentsDir).toBe(join(fakeHome, ".cursor", "agents"));
		expect(locations.rulesDir).toBeUndefined();
	});
});

describe("cursor plugin describe()", () => {
	test("describe(project) reports rules supported", () => {
		const desc = cursorPlugin.describe("project");
		expect(desc.capabilities).toEqual({ rules: true });
		expect(desc.ruleNames).toContain("5x-orchestrator");
		expect(desc.skillNames.length).toBeGreaterThan(0);
		expect(desc.agentNames).toEqual([
			"5x-reviewer",
			"5x-plan-author",
			"5x-code-author",
		]);
	});

	test("describe(user) reports rules unsupported", () => {
		const desc = cursorPlugin.describe("user");
		expect(desc.capabilities).toEqual({ rules: false });
		expect(desc.ruleNames).toEqual([]);
		expect(desc.skillNames.length).toBeGreaterThan(0);
		expect(desc.agentNames.length).toBe(3);
	});

	test("describe() default includes project rule support", () => {
		const desc = cursorPlugin.describe();
		expect(desc.capabilities).toEqual({ rules: true });
		expect(desc.ruleNames).toEqual(["5x-orchestrator", "5x-permissions"]);
	});
});

describe("cursor plugin install/uninstall", () => {
	test("project install writes skills, agents, and rule", async () => {
		const tmp = makeTmpDir();
		try {
			const result = await cursorPlugin.install({
				scope: "project",
				projectRoot: tmp,
				force: false,
				config: {},
			});

			expect(result.skills.created.length).toBeGreaterThan(0);
			expect(result.agents.created.length).toBe(3);
			expect(result.rules?.created).toContain("5x-orchestrator.mdc");
			expect(result.rules?.created).toContain("5x-permissions.mdc");
			expect(result.unsupported).toBeUndefined();

			expect(
				existsSync(join(tmp, ".cursor", "rules", "5x-orchestrator.mdc")),
			).toBe(true);
			expect(
				existsSync(join(tmp, ".cursor", "rules", "5x-permissions.mdc")),
			).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("user install reports rules unsupported", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			const result = await cursorPlugin.install({
				scope: "user",
				projectRoot: tmp,
				homeDir: fakeHome,
				force: false,
				config: {},
			});

			expect(result.unsupported).toEqual({ rules: true });
			expect(result.warnings?.[0]).toContain("Cursor user rules");
			expect(result.rules).toBeUndefined();
			expect(
				existsSync(join(fakeHome, ".cursor", "skills", "5x", "SKILL.md")),
			).toBe(true);
			expect(
				existsSync(join(fakeHome, ".cursor", "agents", "5x-reviewer.md")),
			).toBe(true);
			expect(existsSync(join(fakeHome, ".cursor", "rules"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("user uninstall reports rules unsupported", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			await cursorPlugin.install({
				scope: "user",
				projectRoot: tmp,
				homeDir: fakeHome,
				force: false,
				config: {},
			});

			const result = await cursorPlugin.uninstall({
				scope: "user",
				projectRoot: tmp,
				homeDir: fakeHome,
			});

			expect(result.unsupported).toEqual({ rules: true });
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("buildHarnessListData with cursor", () => {
	test("includes capabilities and unsupported fields by scope", async () => {
		const tmp = makeTmpDir();
		const fakeHome = join(tmp, "home");
		mkdirSync(fakeHome, { recursive: true });
		try {
			await cursorPlugin.install({
				scope: "project",
				projectRoot: tmp,
				force: false,
				config: {},
			});
			await cursorPlugin.install({
				scope: "user",
				projectRoot: tmp,
				homeDir: fakeHome,
				force: false,
				config: {},
			});

			const output = await buildHarnessListData(tmp, fakeHome);
			const cursor = output.harnesses.find((h) => h.name === "cursor");
			expect(cursor).toBeDefined();
			if (!cursor?.scopes.project || !cursor.scopes.user) {
				throw new Error("Expected project and user scopes for cursor");
			}

			expect(cursor.scopes.project.capabilities).toEqual({ rules: true });
			expect(cursor.scopes.project.unsupported).toBeUndefined();
			expect(cursor.scopes.project.files).toContain(
				"rules/5x-orchestrator.mdc",
			);

			expect(cursor.scopes.user.capabilities).toEqual({ rules: false });
			expect(cursor.scopes.user.unsupported).toEqual({ rules: true });
			expect(cursor.scopes.user.files.some((f) => f.startsWith("rules/"))).toBe(
				false,
			);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// renderAssets() — one render path (201-harness-freshness Phase 2)
// ---------------------------------------------------------------------------

describe("cursor plugin renderAssets()", () => {
	const config = {
		authorModel: "anthropic/claude-opus-4-5",
		reviewerModel: "anthropic/claude-sonnet-4-5",
	};

	test("project-scope output is byte-identical to what install() writes", async () => {
		const tmp = makeTmpDir();
		try {
			const ctx = {
				scope: "project" as const,
				projectRoot: tmp,
				force: false,
				config,
			};

			const rendered = await cursorPlugin.renderAssets?.(ctx);
			expect(rendered).toBeDefined();
			await cursorPlugin.install(ctx);

			const locations = cursorLocationResolver.resolve("project", tmp);
			for (const asset of rendered ?? []) {
				const onDisk = join(locations.rootDir, asset.path);
				expect(existsSync(onDisk)).toBe(true);
				expect(readFileSync(onDisk, "utf-8")).toBe(asset.content);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("user-scope output is byte-identical to what install() writes", async () => {
		const tmp = makeTmpDir();
		try {
			const ctx = {
				scope: "user" as const,
				projectRoot: join(tmp, "project"),
				force: false,
				config,
				homeDir: tmp,
			};

			const rendered = await cursorPlugin.renderAssets?.(ctx);
			await cursorPlugin.install(ctx);

			const locations = cursorLocationResolver.resolve(
				"user",
				ctx.projectRoot,
				tmp,
			);
			for (const asset of rendered ?? []) {
				const onDisk = join(locations.rootDir, asset.path);
				expect(existsSync(onDisk)).toBe(true);
				expect(readFileSync(onDisk, "utf-8")).toBe(asset.content);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("project scope yields exactly two rule assets", async () => {
		const rendered =
			(await cursorPlugin.renderAssets?.({
				scope: "project",
				projectRoot: "/tmp/project",
				force: false,
				config,
			})) ?? [];

		const rules = rendered.filter((a) => a.kind === "rule");
		expect(rules.map((r) => r.path).sort()).toEqual([
			"rules/5x-orchestrator.mdc",
			"rules/5x-permissions.mdc",
		]);
	});

	test("user scope yields no rule assets", async () => {
		const rendered =
			(await cursorPlugin.renderAssets?.({
				scope: "user",
				projectRoot: "/tmp/project",
				force: false,
				config,
				homeDir: "/tmp/fake-home",
			})) ?? [];

		expect(rendered.some((a) => a.kind === "rule")).toBe(false);
		expect(rendered.some((a) => a.kind === "skill")).toBe(true);
		expect(rendered.some((a) => a.kind === "agent")).toBe(true);
	});

	test("user scope install still reports unsupported rules with the same warning", async () => {
		const tmp = makeTmpDir();
		try {
			const result = await cursorPlugin.install({
				scope: "user",
				projectRoot: join(tmp, "project"),
				force: false,
				config,
				homeDir: tmp,
			});

			expect(result.rules).toBeUndefined();
			expect(result.unsupported?.rules).toBe(true);
			expect(result.warnings).toEqual([
				"Cursor user rules are settings-managed and not file-backed. Install with --scope project to add the orchestrator rule to your project.",
			]);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("authorDelegationMode: invoke omits author agents", async () => {
		const rendered =
			(await cursorPlugin.renderAssets?.({
				scope: "project",
				projectRoot: "/tmp/project",
				force: false,
				config: { ...config, authorDelegationMode: "invoke" },
			})) ?? [];

		const agentNames = rendered
			.filter((a) => a.kind === "agent")
			.map((a) => a.name);

		expect(agentNames).not.toContain("5x-plan-author");
		expect(agentNames).not.toContain("5x-code-author");
		expect(agentNames).toContain("5x-reviewer");
	});

	test("declared paths are rootDir-relative and POSIX-separated", async () => {
		const rendered =
			(await cursorPlugin.renderAssets?.({
				scope: "project",
				projectRoot: "/tmp/project",
				force: false,
				config,
			})) ?? [];

		for (const asset of rendered) {
			expect(asset.path).not.toContain("\\");
			expect(asset.path.startsWith("/")).toBe(false);
			expect(asset.path.startsWith("..")).toBe(false);
		}
	});
});
