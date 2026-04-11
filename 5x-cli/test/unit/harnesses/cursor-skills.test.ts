import { describe, expect, test } from "bun:test";
import {
	listSkillNames,
	listSkills,
} from "../../../src/harnesses/cursor/skills/loader.js";
import { parseSkillFrontmatter } from "../../../src/skills/frontmatter.js";
import { listBaseSkillNames } from "../../../src/skills/loader.js";

describe("cursor skills loader", () => {
	test("loads all shared skills from shared base template names", () => {
		expect(listSkillNames()).toEqual(listBaseSkillNames());
		expect(listSkillNames()).toEqual([
			"5x",
			"5x-windows",
			"5x-plan",
			"5x-plan-review",
			"5x-phase-execution",
			"5x-config",
		]);

		const skills = listSkills();
		expect(skills).toHaveLength(6);
	});

	test("applies cursor-native subagent terminology", () => {
		const combined = listSkills()
			.map((skill) => skill.content)
			.join("\n\n");

		expect(combined).toContain("Cursor subagent invocation");
		expect(combined).toContain("resume=");
		expect(combined).toContain("$REVIEWER_AGENT_ID");
	});

	test("removes opencode-specific task tool wording", () => {
		const combined = listSkills()
			.map((skill) => skill.content)
			.join("\n\n");

		expect(combined).not.toContain("Task tool");
		expect(combined).not.toContain("subagent_type");
		expect(combined).not.toContain("task_id");
	});

	test("does not leak unresolved harness token placeholders", () => {
		for (const skill of listSkills()) {
			expect(skill.content).not.toContain("[[NATIVE_CONTINUE_PARAM]]");
		}
	});

	test("does not retain opencode wording in cursor-rendered skills", () => {
		const combined = listSkills()
			.map((skill) => skill.content)
			.join("\n\n");

		expect(combined).not.toMatch(/opencode/i);
	});

	test("keeps frontmatter valid after cursor terminology adaptation", () => {
		for (const skill of listSkills()) {
			const frontmatter = parseSkillFrontmatter(skill.content);
			expect(frontmatter.name).toBe(skill.name);
			expect(frontmatter.description.length).toBeGreaterThan(0);
		}
	});
});
