import { describe, expect, test } from "bun:test";
import {
	renderSkillTemplate,
	type SkillRenderContext,
} from "../../../src/skills/renderer.js";

/**
 * Helper to create a full SkillRenderContext from per-role flags.
 * Computes the derived legacy and cross-cutting fields.
 */
function makeContext(
	authorNative: boolean,
	reviewerNative: boolean,
): SkillRenderContext {
	const anyNative = authorNative || reviewerNative;
	const anyInvoke = !authorNative || !reviewerNative;
	return {
		native: authorNative && reviewerNative,
		invoke: !authorNative && !reviewerNative,
		authorNative,
		reviewerNative,
		anyNative,
		anyInvoke,
	};
}

describe("renderSkillTemplate", () => {
	test("includes {{#if native}} block when both roles are native", () => {
		const rendered = renderSkillTemplate(
			["before", "{{#if native}}", "native only", "{{/if}}", "after"].join(
				"\n",
			),
			makeContext(true, true),
		);

		expect(rendered).toBe(["before", "native only", "after"].join("\n"));
	});

	test("strips {{#if native}} block when not both roles are native", () => {
		// Mixed mode - only author native
		const rendered1 = renderSkillTemplate(
			["before", "{{#if native}}", "native only", "{{/if}}", "after"].join(
				"\n",
			),
			makeContext(true, false),
		);
		expect(rendered1).toBe(["before", "after"].join("\n"));

		// Mixed mode - only reviewer native
		const rendered2 = renderSkillTemplate(
			["before", "{{#if native}}", "native only", "{{/if}}", "after"].join(
				"\n",
			),
			makeContext(false, true),
		);
		expect(rendered2).toBe(["before", "after"].join("\n"));

		// Both invoke
		const rendered3 = renderSkillTemplate(
			["before", "{{#if native}}", "native only", "{{/if}}", "after"].join(
				"\n",
			),
			makeContext(false, false),
		);
		expect(rendered3).toBe(["before", "after"].join("\n"));
	});

	test("includes {{#if invoke}} block when both roles are invoke", () => {
		const template = [
			"before",
			"{{#if invoke}}",
			"invoke only",
			"{{/if}}",
			"after",
		].join("\n");

		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			["before", "invoke only", "after"].join("\n"),
		);
	});

	test("strips {{#if invoke}} block when not both roles are invoke", () => {
		const template = [
			"before",
			"{{#if invoke}}",
			"invoke only",
			"{{/if}}",
			"after",
		].join("\n");

		// Both native
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			["before", "after"].join("\n"),
		);

		// Mixed mode - only author invoke
		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			["before", "after"].join("\n"),
		);

		// Mixed mode - only reviewer invoke
		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			["before", "after"].join("\n"),
		);
	});

	test("selects correct branch for if/else with native/native", () => {
		const template = [
			"{{#if native}}",
			"native branch",
			"{{else}}",
			"invoke branch",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			"native branch",
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"invoke branch",
		);
	});

	test("directive lines are not present in output", () => {
		const rendered = renderSkillTemplate(
			["{{#if native}}", "x", "{{else}}", "y", "{{/if}}"].join("\n"),
			makeContext(true, true),
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

		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			["outside top", "inside", "outside bottom"].join("\n"),
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
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

		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			["```bash", "5x template render reviewer-commit", "```"].join("\n"),
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			["```bash", "5x invoke reviewer reviewer-commit", "```"].join("\n"),
		);
	});

	test("throws on unclosed {{#if}}", () => {
		expect(() =>
			renderSkillTemplate(
				["{{#if native}}", "missing close"].join("\n"),
				makeContext(true, true),
			),
		).toThrow("Unclosed {{#if}} block");
	});

	test("throws on unmatched {{else}}", () => {
		expect(() =>
			renderSkillTemplate("{{else}}", makeContext(true, true)),
		).toThrow("Unmatched {{else}} directive");
	});

	test("throws on unmatched {{/if}}", () => {
		expect(() =>
			renderSkillTemplate("{{/if}}", makeContext(true, true)),
		).toThrow("Unmatched {{/if}} directive");
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

		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			["start", "middle", "end"].join("\n"),
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
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

		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			["A", "B-native", "C", "D-native"].join("\n"),
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			["A", "B-invoke", "C", "D-invoke"].join("\n"),
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 1: Per-role and cross-cutting conditionals (019-mixed-mode-delegation)
// ---------------------------------------------------------------------------

describe("renderSkillTemplate per-role conditionals", () => {
	test("{{#if author_native}} includes block when author is native", () => {
		const template = [
			"{{#if author_native}}",
			"author native content",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			"author native content",
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe("");
	});

	test("{{#if author_invoke}} includes block when author is invoke", () => {
		const template = [
			"{{#if author_invoke}}",
			"author invoke content",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			"author invoke content",
		);
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe("");
	});

	test("{{#if reviewer_native}} includes block when reviewer is native", () => {
		const template = [
			"{{#if reviewer_native}}",
			"reviewer native content",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			"reviewer native content",
		);
		expect(renderSkillTemplate(template, makeContext(true, false))).toBe("");
	});

	test("{{#if reviewer_invoke}} includes block when reviewer is invoke", () => {
		const template = [
			"{{#if reviewer_invoke}}",
			"reviewer invoke content",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			"reviewer invoke content",
		);
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe("");
	});

	test("{{#if any_native}} includes block when at least one role is native", () => {
		const template = [
			"{{#if any_native}}",
			"any native content",
			"{{/if}}",
		].join("\n");

		// Both native
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			"any native content",
		);
		// Mixed - author only
		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			"any native content",
		);
		// Mixed - reviewer only
		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			"any native content",
		);
		// Both invoke
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe("");
	});

	test("{{#if any_invoke}} includes block when at least one role is invoke", () => {
		const template = [
			"{{#if any_invoke}}",
			"any invoke content",
			"{{/if}}",
		].join("\n");

		// Both invoke
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"any invoke content",
		);
		// Mixed - author only
		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			"any invoke content",
		);
		// Mixed - reviewer only
		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			"any invoke content",
		);
		// Both native
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe("");
	});

	test("mixed mode renders correct blocks for each role", () => {
		const template = [
			"A",
			"{{#if author_native}}",
			"B-author-native",
			"{{/if}}",
			"{{#if author_invoke}}",
			"C-author-invoke",
			"{{/if}}",
			"{{#if reviewer_native}}",
			"D-reviewer-native",
			"{{/if}}",
			"{{#if reviewer_invoke}}",
			"E-reviewer-invoke",
			"{{/if}}",
			"F",
		].join("\n");

		// Native/native - only native blocks show
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			["A", "B-author-native", "D-reviewer-native", "F"].join("\n"),
		);

		// Invoke/invoke - only invoke blocks show
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			["A", "C-author-invoke", "E-reviewer-invoke", "F"].join("\n"),
		);

		// Invoke author, native reviewer
		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			["A", "C-author-invoke", "D-reviewer-native", "F"].join("\n"),
		);

		// Native author, invoke reviewer
		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			["A", "B-author-native", "E-reviewer-invoke", "F"].join("\n"),
		);
	});

	test("{{else}} flips correctly for all new directives", () => {
		// Test author_native with else
		const template1 = [
			"{{#if author_native}}",
			"author native",
			"{{else}}",
			"author invoke",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template1, makeContext(true, false))).toBe(
			"author native",
		);
		expect(renderSkillTemplate(template1, makeContext(false, false))).toBe(
			"author invoke",
		);

		// Test any_native with else
		const template2 = [
			"{{#if any_native}}",
			"has native",
			"{{else}}",
			"no native",
			"{{/if}}",
		].join("\n");

		expect(renderSkillTemplate(template2, makeContext(true, false))).toBe(
			"has native",
		);
		expect(renderSkillTemplate(template2, makeContext(false, false))).toBe(
			"no native",
		);
	});

	test("throws on unknown directive", () => {
		expect(() =>
			renderSkillTemplate(
				["{{#if foo}}", "content", "{{/if}}"].join("\n"),
				makeContext(true, true),
			),
		).toThrow("Unknown directive: {{#if foo}}");
	});

	test("all four context combinations produce valid output", () => {
		const template = [
			"start",
			"{{#if author_native}}",
			"author-native",
			"{{/if}}",
			"{{#if author_invoke}}",
			"author-invoke",
			"{{/if}}",
			"{{#if reviewer_native}}",
			"reviewer-native",
			"{{/if}}",
			"{{#if reviewer_invoke}}",
			"reviewer-invoke",
			"{{/if}}",
			"{{#if any_native}}",
			"any-native",
			"{{/if}}",
			"{{#if any_invoke}}",
			"any-invoke",
			"{{/if}}",
			"end",
		].join("\n");

		// Native/native
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			["start", "author-native", "reviewer-native", "any-native", "end"].join(
				"\n",
			),
		);

		// Invoke/native
		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			[
				"start",
				"author-invoke",
				"reviewer-native",
				"any-native",
				"any-invoke",
				"end",
			].join("\n"),
		);

		// Native/invoke
		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			[
				"start",
				"author-native",
				"reviewer-invoke",
				"any-native",
				"any-invoke",
				"end",
			].join("\n"),
		);

		// Invoke/invoke
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			["start", "author-invoke", "reviewer-invoke", "any-invoke", "end"].join(
				"\n",
			),
		);
	});
});
