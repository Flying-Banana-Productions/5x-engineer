import { describe, expect, test } from "bun:test";
import {
	listBaseSkillNames,
	renderAllSkillTemplates,
	renderSkillByName,
} from "../../../src/skills/loader.js";

describe("shared skill template loader", () => {
	test("all shared templates load and parse frontmatter", () => {
		const names = listBaseSkillNames();
		expect(names).toEqual([
			"5x",
			"5x-windows",
			"5x-plan",
			"5x-plan-review",
			"5x-phase-execution",
		]);

		for (const name of names) {
			const nativeSkill = renderSkillByName(name, { native: true });
			expect(nativeSkill.name).toBe(name);
			expect(nativeSkill.description.length).toBeGreaterThan(10);
			expect(nativeSkill.content.startsWith("---\nname:")).toBe(true);
		}
	});

	test("renderAllSkillTemplates(native=true) returns valid SkillMetadata[]", () => {
		const skills = renderAllSkillTemplates({ native: true });
		expect(skills.length).toBe(5);
		for (const skill of skills) {
			expect(skill.name.length).toBeGreaterThan(0);
			expect(skill.description.length).toBeGreaterThan(0);
			expect(skill.content.length).toBeGreaterThan(0);
		}
	});

	test("renderAllSkillTemplates(native=false) returns valid SkillMetadata[]", () => {
		const skills = renderAllSkillTemplates({ native: false });
		expect(skills.length).toBe(5);
		for (const skill of skills) {
			expect(skill.name.length).toBeGreaterThan(0);
			expect(skill.description.length).toBeGreaterThan(0);
			expect(skill.content.length).toBeGreaterThan(0);
		}
	});

	test("native output contains Task tool/subagent_type references", () => {
		const native = renderAllSkillTemplates({ native: true })
			.map((s) => s.content)
			.join("\n\n");
		expect(native).toContain("Task tool");
		expect(native).toContain("subagent_type");
	});

	test("native output prefers native UI for human gates over 5x prompt in Tools sections", () => {
		const foundation = renderSkillByName("5x", { native: true }).content;
		expect(foundation).toContain("native UI");
		expect(foundation).toContain("AskQuestion");
		const planReview = renderSkillByName("5x-plan-review", {
			native: true,
		}).content;
		expect(planReview).toContain("Human gates");
	});

	test("invoke output omits Task tool/subagent_type references", () => {
		const invoke = renderAllSkillTemplates({ native: false })
			.map((s) => s.content)
			.join("\n\n");
		expect(invoke).not.toContain("Task tool");
		expect(invoke).not.toContain("subagent_type");
	});

	test("frontmatter is identical in native/invoke contexts", () => {
		for (const name of listBaseSkillNames()) {
			const native = renderSkillByName(name, { native: true });
			const invoke = renderSkillByName(name, { native: false });
			expect(invoke.name).toBe(native.name);
			expect(invoke.description).toBe(native.description);
		}
	});

	test("invoke-only placeholders render from else branches", () => {
		const plan = renderSkillByName("5x-plan", { native: false }).content;
		expect(plan).toContain("5x invoke author author-generate-plan");

		const foundation = renderSkillByName("5x", { native: false }).content;
		expect(foundation).toContain("session_id");
	});

	test("foundation skill points Windows users at the optional supplemental skill", () => {
		const foundation = renderSkillByName("5x", { native: true }).content;
		const windows = renderSkillByName("5x-windows", { native: true }).content;

		expect(foundation).toContain("also load `5x-windows`");
		expect(windows).toContain("PowerShell");
		expect(windows).toContain("ConvertFrom-Json");
	});
});
