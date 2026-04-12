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
