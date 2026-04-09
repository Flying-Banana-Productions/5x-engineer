import { describe, expect, test } from "bun:test";
import {
	renderSkillTemplate,
	type SkillRenderContext,
} from "../../../src/skills/renderer.js";

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
		const template = "before\n{{#if native}}\nnative only\n{{/if}}\nafter";
		const rendered = renderSkillTemplate(template, makeContext(true, true));
		expect(rendered).toBe("before\nnative only\nafter");
	});

	test("strips {{#if native}} block when not both roles are native", () => {
		const template = "before\n{{#if native}}\nnative only\n{{/if}}\nafter";
		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			"before\nafter",
		);
		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			"before\nafter",
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"before\nafter",
		);
	});

	test("includes {{#if invoke}} block when both roles are invoke", () => {
		const template = "before\n{{#if invoke}}\ninvoke only\n{{/if}}\nafter";
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"before\ninvoke only\nafter",
		);
	});

	test("strips {{#if invoke}} block when not both roles are invoke", () => {
		const template = "before\n{{#if invoke}}\ninvoke only\n{{/if}}\nafter";
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			"before\nafter",
		);
		expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
			"before\nafter",
		);
		expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
			"before\nafter",
		);
	});

	test("selects correct branch for if/else with native/native", () => {
		const template =
			"{{#if native}}\nnative branch\n{{else}}\ninvoke branch\n{{/if}}";
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			"native branch",
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"invoke branch",
		);
	});

	test("directive lines are not present in output", () => {
		const template = "{{#if native}}\nx\n{{else}}\ny\n{{/if}}";
		const rendered = renderSkillTemplate(template, makeContext(true, true));
		expect(rendered).toBe("x");
		expect(rendered).not.toContain("{{#if native}}");
		expect(rendered).not.toContain("{{else}}");
		expect(rendered).not.toContain("{{/if}}");
	});

	test("content outside conditional blocks is always included", () => {
		const template =
			"outside top\n{{#if native}}\ninside\n{{/if}}\noutside bottom";
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			"outside top\ninside\noutside bottom",
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"outside top\noutside bottom",
		);
	});

	test("preserves markdown code blocks inside conditionals", () => {
		const template =
			"{{#if native}}\n```bash\n5x template render\n```\n{{else}}\n```bash\n5x invoke\n```\n{{/if}}";
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			"```bash\n5x template render\n```",
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"```bash\n5x invoke\n```",
		);
	});

	test("throws on unclosed {{#if}}", () => {
		const template = "{{#if native}}\nmissing close";
		expect(() =>
			renderSkillTemplate(template, makeContext(true, true)),
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
		const template =
			"start\n{{#if native}}\n{{/if}}\nmiddle\n{{#if invoke}}\n{{/if}}\nend";
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			"start\nmiddle\nend",
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"start\nmiddle\nend",
		);
	});

	test("supports multiple conditional blocks in one template", () => {
		const template =
			"A\n{{#if native}}\nB-native\n{{else}}\nB-invoke\n{{/if}}\nC\n{{#if invoke}}\nD-invoke\n{{else}}\nD-native\n{{/if}}";
		expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
			"A\nB-native\nC\nD-native",
		);
		expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
			"A\nB-invoke\nC\nD-invoke",
		);
	});

	describe("legacy invoke fallback with omitted ctx.invoke", () => {
		test("{{#if invoke}} is false in mixed mode when ctx.invoke is omitted", () => {
			const template = "{{#if invoke}}\ninvoke content\n{{/if}}";
			// Mixed mode: author invoke, reviewer native - omit ctx.invoke
			const ctx1: SkillRenderContext = {
				native: false, // not both native
				authorNative: false,
				reviewerNative: true,
				anyNative: true,
				anyInvoke: true,
			};
			expect(renderSkillTemplate(template, ctx1)).toBe("");

			// Mixed mode: author native, reviewer invoke - omit ctx.invoke
			const ctx2: SkillRenderContext = {
				native: false, // not both native
				authorNative: true,
				reviewerNative: false,
				anyNative: true,
				anyInvoke: true,
			};
			expect(renderSkillTemplate(template, ctx2)).toBe("");
		});

		test("{{#if invoke}} is true only when both roles are invoke (omitted ctx.invoke)", () => {
			const template = "{{#if invoke}}\ninvoke content\n{{/if}}";
			// Both invoke - omit ctx.invoke
			const ctx: SkillRenderContext = {
				native: false,
				authorNative: false,
				reviewerNative: false,
				anyNative: false,
				anyInvoke: true,
			};
			expect(renderSkillTemplate(template, ctx)).toBe("invoke content");
		});

		test("{{#if invoke}} is false when both roles are native (omitted ctx.invoke)", () => {
			const template = "{{#if invoke}}\ninvoke content\n{{/if}}";
			// Both native - omit ctx.invoke
			const ctx: SkillRenderContext = {
				native: true,
				authorNative: true,
				reviewerNative: true,
				anyNative: true,
				anyInvoke: false,
			};
			expect(renderSkillTemplate(template, ctx)).toBe("");
		});

		test("{{#if invoke}} respects explicit ctx.invoke when provided", () => {
			const template = "{{#if invoke}}\ninvoke content\n{{/if}}";
			// Even in mixed mode, explicit invoke: true should include the block
			const ctx: SkillRenderContext = {
				native: false,
				invoke: true, // explicitly set
				authorNative: true,
				reviewerNative: false,
				anyNative: true,
				anyInvoke: true,
			};
			expect(renderSkillTemplate(template, ctx)).toBe("invoke content");
		});
	});

	describe("per-role conditionals", () => {
		test("{{#if author_native}} includes block when author is native", () => {
			const template = "{{#if author_native}}\nauthor native content\n{{/if}}";
			expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
				"author native content",
			);
			expect(renderSkillTemplate(template, makeContext(false, false))).toBe("");
		});

		test("{{#if author_invoke}} includes block when author is invoke", () => {
			const template = "{{#if author_invoke}}\nauthor invoke content\n{{/if}}";
			expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
				"author invoke content",
			);
			expect(renderSkillTemplate(template, makeContext(true, true))).toBe("");
		});

		test("{{#if reviewer_native}} includes block when reviewer is native", () => {
			const template =
				"{{#if reviewer_native}}\nreviewer native content\n{{/if}}";
			expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
				"reviewer native content",
			);
			expect(renderSkillTemplate(template, makeContext(true, false))).toBe("");
		});

		test("{{#if reviewer_invoke}} includes block when reviewer is invoke", () => {
			const template =
				"{{#if reviewer_invoke}}\nreviewer invoke content\n{{/if}}";
			expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
				"reviewer invoke content",
			);
			expect(renderSkillTemplate(template, makeContext(true, true))).toBe("");
		});

		test("{{#if any_native}} includes block when at least one role is native", () => {
			const template = "{{#if any_native}}\nany native content\n{{/if}}";
			expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
				"any native content",
			);
			expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
				"any native content",
			);
			expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
				"any native content",
			);
			expect(renderSkillTemplate(template, makeContext(false, false))).toBe("");
		});

		test("{{#if any_invoke}} includes block when at least one role is invoke", () => {
			const template = "{{#if any_invoke}}\nany invoke content\n{{/if}}";
			expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
				"any invoke content",
			);
			expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
				"any invoke content",
			);
			expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
				"any invoke content",
			);
			expect(renderSkillTemplate(template, makeContext(true, true))).toBe("");
		});

		test("mixed mode renders correct blocks for each role", () => {
			const template =
				"A\n{{#if author_native}}\nB-author-native\n{{/if}}\n{{#if author_invoke}}\nC-author-invoke\n{{/if}}\n{{#if reviewer_native}}\nD-reviewer-native\n{{/if}}\n{{#if reviewer_invoke}}\nE-reviewer-invoke\n{{/if}}\nF";
			expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
				"A\nB-author-native\nD-reviewer-native\nF",
			);
			expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
				"A\nC-author-invoke\nE-reviewer-invoke\nF",
			);
			expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
				"A\nC-author-invoke\nD-reviewer-native\nF",
			);
			expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
				"A\nB-author-native\nE-reviewer-invoke\nF",
			);
		});

		test("{{else}} flips correctly for all new directives", () => {
			const template1 =
				"{{#if author_native}}\nauthor native\n{{else}}\nauthor invoke\n{{/if}}";
			expect(renderSkillTemplate(template1, makeContext(true, false))).toBe(
				"author native",
			);
			expect(renderSkillTemplate(template1, makeContext(false, false))).toBe(
				"author invoke",
			);

			const template2 =
				"{{#if any_native}}\nhas native\n{{else}}\nno native\n{{/if}}";
			expect(renderSkillTemplate(template2, makeContext(true, false))).toBe(
				"has native",
			);
			expect(renderSkillTemplate(template2, makeContext(false, false))).toBe(
				"no native",
			);
		});

		test("throws on unknown directive", () => {
			const template = "{{#if foo}}\ncontent\n{{/if}}";
			expect(() =>
				renderSkillTemplate(template, makeContext(true, true)),
			).toThrow("Unknown directive: {{#if foo}}");
		});

		test("all four context combinations produce valid output", () => {
			const template =
				"start\n{{#if author_native}}\nauthor-native\n{{/if}}\n{{#if author_invoke}}\nauthor-invoke\n{{/if}}\n{{#if reviewer_native}}\nreviewer-native\n{{/if}}\n{{#if reviewer_invoke}}\nreviewer-invoke\n{{/if}}\n{{#if any_native}}\nany-native\n{{/if}}\n{{#if any_invoke}}\nany-invoke\n{{/if}}\nend";
			expect(renderSkillTemplate(template, makeContext(true, true))).toBe(
				"start\nauthor-native\nreviewer-native\nany-native\nend",
			);
			expect(renderSkillTemplate(template, makeContext(false, true))).toBe(
				"start\nauthor-invoke\nreviewer-native\nany-native\nany-invoke\nend",
			);
			expect(renderSkillTemplate(template, makeContext(true, false))).toBe(
				"start\nauthor-native\nreviewer-invoke\nany-native\nany-invoke\nend",
			);
			expect(renderSkillTemplate(template, makeContext(false, false))).toBe(
				"start\nauthor-invoke\nreviewer-invoke\nany-invoke\nend",
			);
		});
	});
});
