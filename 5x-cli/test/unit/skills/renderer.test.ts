import { describe, expect, test } from "bun:test";
import { renderSkillTemplate } from "../../../src/skills/renderer.js";

describe("renderSkillTemplate", () => {
	test("includes {{#if native}} block when native=true", () => {
		const rendered = renderSkillTemplate(
			["before", "{{#if native}}", "native only", "{{/if}}", "after"].join(
				"\n",
			),
			{ native: true },
		);

		expect(rendered).toBe(["before", "native only", "after"].join("\n"));
	});

	test("strips {{#if native}} block when native=false", () => {
		const rendered = renderSkillTemplate(
			["before", "{{#if native}}", "native only", "{{/if}}", "after"].join(
				"\n",
			),
			{ native: false },
		);

		expect(rendered).toBe(["before", "after"].join("\n"));
	});

	test("includes {{#if invoke}} block when native=false and strips when native=true", () => {
		const template = [
			"before",
			"{{#if invoke}}",
			"invoke only",
			"{{/if}}",
			"after",
		].join("\n");

		expect(renderSkillTemplate(template, { native: false })).toBe(
			["before", "invoke only", "after"].join("\n"),
		);
		expect(renderSkillTemplate(template, { native: true })).toBe(
			["before", "after"].join("\n"),
		);
	});

	test("selects correct branch for if/else", () => {
		const template = [
			"{{#if native}}",
			"native branch",
			"{{else}}",
			"invoke branch",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template, { native: true })).toBe(
			"native branch",
		);
		expect(renderSkillTemplate(template, { native: false })).toBe(
			"invoke branch",
		);
	});

	test("directive lines are not present in output", () => {
		const rendered = renderSkillTemplate(
			["{{#if native}}", "x", "{{else}}", "y", "{{/if}}"].join("\n"),
			{ native: true },
		);

		expect(rendered).toBe("x");
		expect(rendered).not.toContain("{{#if native}}");
		expect(rendered).not.toContain("{{else}}");
		expect(rendered).not.toContain("{{/if}}");
	});

	test("content outside conditional blocks is always included", () => {
		const template = [
			"outside top",
			"{{#if native}}",
			"inside",
			"{{/if}}",
			"outside bottom",
		].join("\n");

		expect(renderSkillTemplate(template, { native: true })).toBe(
			["outside top", "inside", "outside bottom"].join("\n"),
		);
		expect(renderSkillTemplate(template, { native: false })).toBe(
			["outside top", "outside bottom"].join("\n"),
		);
	});

	test("preserves markdown code blocks inside conditionals", () => {
		const template = [
			"{{#if native}}",
			"```bash",
			"5x template render reviewer-commit",
			"```",
			"{{else}}",
			"```bash",
			"5x invoke reviewer reviewer-commit",
			"```",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template, { native: true })).toBe(
			["```bash", "5x template render reviewer-commit", "```"].join("\n"),
		);
		expect(renderSkillTemplate(template, { native: false })).toBe(
			["```bash", "5x invoke reviewer reviewer-commit", "```"].join("\n"),
		);
	});

	test("throws on unclosed {{#if}}", () => {
		expect(() =>
			renderSkillTemplate(["{{#if native}}", "missing close"].join("\n"), {
				native: true,
			}),
		).toThrow("Unclosed {{#if}} block");
	});

	test("throws on unmatched {{else}}", () => {
		expect(() => renderSkillTemplate("{{else}}", { native: true })).toThrow(
			"Unmatched {{else}} directive",
		);
	});

	test("throws on unmatched {{/if}}", () => {
		expect(() => renderSkillTemplate("{{/if}}", { native: true })).toThrow(
			"Unmatched {{/if}} directive",
		);
	});

	test("empty conditional blocks produce no output for that section", () => {
		const template = [
			"start",
			"{{#if native}}",
			"{{/if}}",
			"middle",
			"{{#if invoke}}",
			"{{/if}}",
			"end",
		].join("\n");

		expect(renderSkillTemplate(template, { native: true })).toBe(
			["start", "middle", "end"].join("\n"),
		);
		expect(renderSkillTemplate(template, { native: false })).toBe(
			["start", "middle", "end"].join("\n"),
		);
	});

	test("supports multiple conditional blocks in one template", () => {
		const template = [
			"A",
			"{{#if native}}",
			"B-native",
			"{{else}}",
			"B-invoke",
			"{{/if}}",
			"C",
			"{{#if invoke}}",
			"D-invoke",
			"{{else}}",
			"D-native",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template, { native: true })).toBe(
			["A", "B-native", "C", "D-native"].join("\n"),
		);
		expect(renderSkillTemplate(template, { native: false })).toBe(
			["A", "B-invoke", "C", "D-invoke"].join("\n"),
		);
	});
});
