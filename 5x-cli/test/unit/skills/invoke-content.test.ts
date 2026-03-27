import { describe, expect, test } from "bun:test";
import {
	renderAllSkillTemplates,
	renderSkillByName,
} from "../../../src/skills/loader.js";

describe("invoke-path skill content", () => {
	test("invoke-rendered skills include author/reviewer invoke commands", () => {
		const invoke = renderAllSkillTemplates({ native: false })
			.map((skill) => skill.content)
			.join("\n\n");

		expect(invoke).toContain("5x invoke author");
		expect(invoke).toContain("5x invoke reviewer");
	});

	test("invoke-rendered skills omit native-only Task tool references", () => {
		const invoke = renderAllSkillTemplates({ native: false })
			.map((skill) => skill.content)
			.join("\n\n");

		expect(invoke).not.toContain("Task tool");
		expect(invoke).not.toContain("subagent_type");
		expect(invoke).not.toContain("task_id");
	});

	test("invoke-rendered 5x foundation skill references session_id in gotchas", () => {
		const foundation = renderSkillByName("5x", { native: false }).content;
		expect(foundation).toContain("session_id");
		expect(foundation).toContain("5x invoke --record");
	});

	test("invoke-rendered 5x-phase-execution includes review_path extraction", () => {
		const phaseExecution = renderSkillByName("5x-phase-execution", {
			native: false,
		}).content;

		expect(phaseExecution).toContain("Extract review_path");
		expect(phaseExecution).toContain("5x template render reviewer-commit");
		expect(phaseExecution).toContain(".data.variables.review_path");
	});

	test("all invoke-rendered skills include --record and .data.result checks", () => {
		for (const skill of renderAllSkillTemplates({ native: false }).filter(
			(skill) => skill.name !== "5x-windows",
		)) {
			expect(skill.content).toContain("--record");
			expect(skill.content).toContain(".data.result");
		}
	});

	test("invoke-rendered output has no native-only protocol validation references", () => {
		const invoke = renderAllSkillTemplates({ native: false })
			.map((skill) => skill.content)
			.join("\n\n");

		expect(invoke).not.toContain("5x protocol validate");
		expect(invoke).not.toContain("Task tool");
	});
});
