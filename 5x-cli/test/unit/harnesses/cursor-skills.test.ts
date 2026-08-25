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
		expect(combined).toContain("$NATIVE_SUBTASK_ID");
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

	test("combined skills contain FIVEX_RUN and phase finish", () => {
		const combined = listSkills()
			.map((skill) => skill.content)
			.join("\n\n");
		expect(combined).toContain("FIVEX_RUN");
		expect(combined).toContain("phase finish");
	});

	test("5x-phase-execution keeps granular quality and protocol fallbacks", () => {
		const phase = listSkills().find((s) => s.name === "5x-phase-execution");
		expect(phase).toBeDefined();
		expect(phase?.content).toContain("5x protocol validate");
		expect(phase?.content).toContain("5x quality run");
		expect(phase?.content).toContain("5x phase finish");
	});

	test("windows skill contains FIVEX_RUN", () => {
		const windows = listSkills().find((s) => s.name === "5x-windows");
		expect(windows).toBeDefined();
		expect(windows?.content).toContain("FIVEX_RUN");
	});
});
