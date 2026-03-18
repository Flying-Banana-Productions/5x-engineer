import { describe, expect, test } from "bun:test";
import {
	getDefaultSkillRaw,
	listSkillNames,
	listSkills,
	parseSkillFrontmatter,
} from "../../../src/skills/loader.js";

describe("Skill loader", () => {
	test("listSkillNames returns all bundled skills", () => {
		const names = listSkillNames();
		expect(names).toContain("5x");
		expect(names).toContain("5x-plan");
		expect(names).toContain("5x-plan-review");
		expect(names).toContain("5x-phase-execution");
		expect(names.length).toBe(4);
	});

	test("listSkills returns metadata with description and content", () => {
		const skills = listSkills();
		expect(skills.length).toBe(4);

		const planSkill = skills.find((s) => s.name === "5x-plan");
		expect(planSkill).toBeDefined();
		expect(planSkill?.description).toContain("implementation plan");
		expect(planSkill?.content).toContain("---");
		expect(planSkill?.content).toContain("name: 5x-plan");
		expect(planSkill?.content).toContain("## Workflow");
	});

	test("all bundled skills have valid frontmatter", () => {
		const skills = listSkills();
		for (const skill of skills) {
			expect(skill.name).toBeTruthy();
			expect(skill.description.length).toBeGreaterThan(10);
			// Description should be useful for agent discovery
			expect(skill.description).not.toBe("A skill.");
		}
	});

	test("getDefaultSkillRaw returns full SKILL.md content", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("---");
		expect(content).toContain("name: 5x-plan");
		expect(content).toContain("## Prerequisites");
		expect(content).toContain("## Tools");
		expect(content).toContain("## Workflow");
	});

	test("getDefaultSkillRaw throws for unknown skill", () => {
		expect(() => getDefaultSkillRaw("unknown-skill")).toThrow(
			'Unknown skill "unknown-skill"',
		);
	});
});

describe("parseSkillFrontmatter", () => {
	test("parses valid frontmatter with name and description", () => {
		const raw = [
			"---",
			"name: my-skill",
			"description: Does something useful.",
			"---",
			"# Body content",
		].join("\n");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.name).toBe("my-skill");
		expect(fm.description).toBe("Does something useful.");
		expect(fm.metadata).toBeUndefined();
	});

	test("parses metadata field", () => {
		const raw = [
			"---",
			"name: my-skill",
			"description: A skill.",
			"metadata:",
			'  author: "test-org"',
			'  version: "1.0"',
			"---",
			"# Body",
		].join("\n");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.metadata).toEqual({ author: "test-org", version: "1.0" });
	});

	test("parses multi-line description (YAML block scalar)", () => {
		const raw = [
			"---",
			"name: my-skill",
			"description: >-",
			"  A multi-line description that spans",
			"  multiple lines in YAML.",
			"---",
			"# Body",
		].join("\n");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.description).toBe(
			"A multi-line description that spans multiple lines in YAML.",
		);
	});

	test("throws on missing frontmatter delimiters", () => {
		expect(() => parseSkillFrontmatter("# Just markdown")).toThrow(
			"missing YAML frontmatter",
		);
	});

	test("throws on missing name field", () => {
		const raw = ["---", "description: A skill.", "---", "# Body"].join("\n");
		expect(() => parseSkillFrontmatter(raw)).toThrow('missing required "name"');
	});

	test("throws on missing description field", () => {
		const raw = ["---", "name: my-skill", "---", "# Body"].join("\n");
		expect(() => parseSkillFrontmatter(raw)).toThrow(
			'missing required "description"',
		);
	});

	test("throws on empty name", () => {
		const raw = [
			"---",
			'name: ""',
			"description: A skill.",
			"---",
			"# Body",
		].join("\n");
		expect(() => parseSkillFrontmatter(raw)).toThrow('missing required "name"');
	});

	test("throws on empty description", () => {
		const raw = [
			"---",
			"name: my-skill",
			'description: ""',
			"---",
			"# Body",
		].join("\n");
		expect(() => parseSkillFrontmatter(raw)).toThrow(
			'missing required "description"',
		);
	});

	test("ignores non-object metadata", () => {
		const raw = [
			"---",
			"name: my-skill",
			"description: A skill.",
			"metadata: not-an-object",
			"---",
			"# Body",
		].join("\n");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.metadata).toBeUndefined();
	});
});
