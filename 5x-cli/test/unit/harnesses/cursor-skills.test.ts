import { describe, expect, test } from "bun:test";
import {
	listSkillNames,
	listSkills,
} from "../../../src/harnesses/cursor/skills/loader.js";
import { parseSkillFrontmatter } from "../../../src/skills/frontmatter.js";
import { listBaseSkillNames } from "../../../src/skills/loader.js";
import { createRenderContext } from "../../../src/skills/renderer.js";

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

	test("renders review-budget guidance in shared plan skills", () => {
		const skills = listSkills();
		const plan = skills.find((skill) => skill.name === "5x-plan")?.content;
		const review = skills.find(
			(skill) => skill.name === "5x-plan-review",
		)?.content;

		expect(plan).toContain("## Delivery Budget");
		expect(plan).toContain("minimal-compliant effort/architecture deltas");
		expect(review).toContain("BUDGET_SECTION_MISSING");
		expect(review).toContain("baselineAssessment");
		expect(review).toContain("new or changed");
		expect(review).toContain("--opt-in-budget-baseline");
		expect(review).toContain(
			"Ignore `result.budget.requiresHuman` for routing",
		);
	});

	test("renders the opt-in command for the reviewer delegation mode", () => {
		const native = listSkills(createRenderContext(true)).find(
			(skill) => skill.name === "5x-plan-review",
		)?.content;
		const invoke = listSkills(createRenderContext(false)).find(
			(skill) => skill.name === "5x-plan-review",
		)?.content;
		const nativeOptIn =
			"5x protocol validate reviewer --opt-in-budget-baseline";
		const invokeOptIn =
			"5x invoke reviewer reviewer-plan --opt-in-budget-baseline";

		expect(native).toContain(nativeOptIn);
		expect(native).not.toContain(invokeOptIn);
		expect(invoke).toContain(invokeOptIn);
		expect(invoke).not.toContain(nativeOptIn);
	});
});
