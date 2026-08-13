import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { universalLocationResolver } from "../../../src/harnesses/locations.js";
import universalPlugin from "../../../src/harnesses/universal/plugin.js";
import { parseSkillFrontmatter } from "../../../src/skills/frontmatter.js";
import { listBaseSkillNames } from "../../../src/skills/loader.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-universal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

describe("universal location resolver", () => {
	test("project scope resolves to .agents/skills", () => {
		const projectRoot = "/tmp/project";
		const locations = universalLocationResolver.resolve("project", projectRoot);

		expect(locations.rootDir).toBe(join(projectRoot, ".agents"));
		expect(locations.skillsDir).toBe(join(projectRoot, ".agents", "skills"));
		expect(locations.agentsDir).toBe(join(projectRoot, ".agents", "agents"));
	});

	test("user scope resolves to ~/.agents/skills", () => {
		const fakeHome = "/tmp/fake-home";
		const locations = universalLocationResolver.resolve(
			"user",
			"/ignored/project",
			fakeHome,
		);

		expect(locations.rootDir).toBe(join(fakeHome, ".agents"));
		expect(locations.skillsDir).toBe(join(fakeHome, ".agents", "skills"));
		expect(locations.agentsDir).toBe(join(fakeHome, ".agents", "agents"));
	});
});

describe("universal plugin", () => {
	test("describe() returns base skill names and no agents", () => {
		const desc = universalPlugin.describe();
		expect(desc.skillNames).toEqual(listBaseSkillNames());
		expect(desc.agentNames).toEqual([]);
	});

	test("install writes invoke-based SKILL.md files and no agent files", async () => {
		const tmp = makeTmpDir();
		try {
			const result = await universalPlugin.install({
				scope: "project",
				projectRoot: tmp,
				force: false,
				config: {},
			});

			expect(result.agents.created).toHaveLength(0);
			expect(result.agents.overwritten).toHaveLength(0);
			expect(result.agents.skipped).toHaveLength(0);

			const skillsDir = join(tmp, ".agents", "skills");
			for (const name of listBaseSkillNames()) {
				const skillPath = join(skillsDir, name, "SKILL.md");
				expect(existsSync(skillPath)).toBe(true);

				const content = readFileSync(skillPath, "utf-8");
				if (name !== "5x-windows" && name !== "5x-config") {
					expect(content).toContain("5x invoke");
				}
				expect(content).not.toContain("Task tool");

				const fm = parseSkillFrontmatter(content);
				expect(fm.name).toBe(name);
				expect(fm.name).toMatch(/^[a-z0-9-]+$/);
				expect(fm.name.length).toBeLessThanOrEqual(64);
				expect(fm.description.length).toBeGreaterThan(0);
				expect(fm.description.length).toBeLessThanOrEqual(1024);
			}

			const agentsDir = join(tmp, ".agents", "agents");
			expect(existsSync(agentsDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("uninstall removes universal skill directories", async () => {
		const tmp = makeTmpDir();
		try {
			await universalPlugin.install({
				scope: "project",
				projectRoot: tmp,
				force: false,
				config: {},
			});

			const skillsDir = join(tmp, ".agents", "skills");
			expect(existsSync(skillsDir)).toBe(true);
			expect(readdirSync(skillsDir).length).toBeGreaterThan(0);

			const result = await universalPlugin.uninstall({
				scope: "project",
				projectRoot: tmp,
			});

			expect(result.skills.removed).toHaveLength(listBaseSkillNames().length);
			expect(result.agents.removed).toHaveLength(0);
			expect(result.agents.notFound).toHaveLength(0);
			expect(existsSync(skillsDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// renderAssets() — one render path (201-harness-freshness Phase 2)
// ---------------------------------------------------------------------------

describe("universal plugin renderAssets()", () => {
	test("output is byte-identical to what install() writes", async () => {
		const tmp = makeTmpDir();
		try {
			const ctx = {
				scope: "project" as const,
				projectRoot: tmp,
				force: false,
				config: {},
			};

			const rendered = await universalPlugin.renderAssets?.(ctx);
			expect(rendered).toBeDefined();
			await universalPlugin.install(ctx);

			const locations = universalLocationResolver.resolve("project", tmp);
			for (const asset of rendered ?? []) {
				const onDisk = join(locations.rootDir, asset.path);
				expect(existsSync(onDisk)).toBe(true);
				expect(readFileSync(onDisk, "utf-8")).toBe(asset.content);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("renders skills only — no agents, no rules", async () => {
		const rendered =
			(await universalPlugin.renderAssets?.({
				scope: "project",
				projectRoot: "/tmp/project",
				force: false,
				config: {},
			})) ?? [];

		expect(rendered.every((a) => a.kind === "skill")).toBe(true);
		expect(rendered.map((a) => a.name).sort()).toEqual(
			[...listBaseSkillNames()].sort(),
		);
	});

	test("output does not vary with baked models or delegation mode", async () => {
		const base = {
			scope: "project" as const,
			projectRoot: "/tmp/project",
			force: false,
		};

		const plain =
			(await universalPlugin.renderAssets?.({
				...base,
				config: {},
			})) ?? [];
		const configured =
			(await universalPlugin.renderAssets?.({
				...base,
				config: {
					authorModel: "anthropic/claude-opus-4-5",
					reviewerModel: "anthropic/claude-sonnet-4-5",
					authorDelegationMode: "invoke",
					reviewerDelegationMode: "invoke",
				},
			})) ?? [];

		// Universal delegates via `5x invoke` and bakes nothing per-role, so a
		// universal install can only ever go stale on a CLI upgrade.
		expect(configured).toEqual(plain);
	});

	test("declared paths are rootDir-relative and POSIX-separated", async () => {
		const rendered =
			(await universalPlugin.renderAssets?.({
				scope: "project",
				projectRoot: "/tmp/project",
				force: false,
				config: {},
			})) ?? [];

		for (const asset of rendered) {
			expect(asset.path).toBe(`skills/${asset.name}/SKILL.md`);
			expect(asset.path).not.toContain("\\");
		}
	});
});
