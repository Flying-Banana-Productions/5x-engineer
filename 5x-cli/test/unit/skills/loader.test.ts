import { describe, expect, test } from "bun:test";
import {
	listBaseSkillNames,
	renderAllSkillTemplates,
	renderSkillByName,
} from "../../../src/skills/loader.js";
import { createRenderContext } from "../../../src/skills/renderer.js";

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
			const nativeSkill = renderSkillByName(name, createRenderContext(true));
			expect(nativeSkill.name).toBe(name);
			expect(nativeSkill.description.length).toBeGreaterThan(10);
			expect(nativeSkill.content.startsWith("---\nname:")).toBe(true);
		}
	});

	test("renderAllSkillTemplates(native=true) returns valid SkillMetadata[]", () => {
		const skills = renderAllSkillTemplates(createRenderContext(true));
		expect(skills.length).toBe(5);
		for (const skill of skills) {
			expect(skill.name.length).toBeGreaterThan(0);
			expect(skill.description.length).toBeGreaterThan(0);
			expect(skill.content.length).toBeGreaterThan(0);
		}
	});

	test("renderAllSkillTemplates(native=false) returns valid SkillMetadata[]", () => {
		const skills = renderAllSkillTemplates(createRenderContext(false));
		expect(skills.length).toBe(5);
		for (const skill of skills) {
			expect(skill.name.length).toBeGreaterThan(0);
			expect(skill.description.length).toBeGreaterThan(0);
			expect(skill.content.length).toBeGreaterThan(0);
		}
	});

	test("native output contains Task tool/subagent_type references", () => {
		const native = renderAllSkillTemplates(createRenderContext(true))
			.map((s) => s.content)
			.join("\n\n");
		expect(native).toContain("Task tool");
		expect(native).toContain("subagent_type");
	});

	test("native output prefers native UI for human gates over 5x prompt in Tools sections", () => {
		const foundation = renderSkillByName(
			"5x",
			createRenderContext(true),
		).content;
		expect(foundation).toContain("native UI");
		expect(foundation).toContain("AskQuestion");
		const planReview = renderSkillByName(
			"5x-plan-review",
			createRenderContext(true),
		).content;
		expect(planReview).toContain("Human gates");
	});

	test("invoke output omits Task tool/subagent_type references", () => {
		const invoke = renderAllSkillTemplates(createRenderContext(false))
			.map((s) => s.content)
			.join("\n\n");
		expect(invoke).not.toContain("Task tool");
		expect(invoke).not.toContain("subagent_type");
	});

	test("frontmatter is identical in native/invoke contexts", () => {
		for (const name of listBaseSkillNames()) {
			const native = renderSkillByName(name, createRenderContext(true));
			const invoke = renderSkillByName(name, createRenderContext(false));
			expect(invoke.name).toBe(native.name);
			expect(invoke.description).toBe(native.description);
		}
	});

	test("invoke-only placeholders render from else branches", () => {
		const plan = renderSkillByName(
			"5x-plan",
			createRenderContext(false),
		).content;
		expect(plan).toContain("5x invoke author author-generate-plan");

		const foundation = renderSkillByName(
			"5x",
			createRenderContext(false),
		).content;
		expect(foundation).toContain("session_id");
	});

	test("foundation skill points Windows users at the optional supplemental skill", () => {
		const foundation = renderSkillByName(
			"5x",
			createRenderContext(true),
		).content;
		const windows = renderSkillByName(
			"5x-windows",
			createRenderContext(true),
		).content;

		expect(foundation).toContain("also load `5x-windows`");
		expect(windows).toContain("PowerShell");
		expect(windows).toContain("ConvertFrom-Json");
	});
});
