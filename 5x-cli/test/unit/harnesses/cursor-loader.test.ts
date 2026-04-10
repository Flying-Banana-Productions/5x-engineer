import { describe, expect, test } from "bun:test";
import {
	listAgentTemplates,
	renderAgentTemplates,
} from "../../../src/harnesses/cursor/loader.js";

function getTemplateContent(
	templates: Array<{ name: string; content: string }>,
	name: string,
): string {
	const template = templates.find((entry) => entry.name === name);
	if (!template) {
		throw new Error(`Missing template: ${name}`);
	}
	return template.content;
}

describe("cursor loader model injection", () => {
	test("omits model frontmatter field when models are unset", () => {
		const templates = renderAgentTemplates({});

		for (const name of ["5x-plan-author", "5x-code-author", "5x-reviewer"]) {
			const content = getTemplateContent(templates, name);
			expect(content).not.toContain("\nmodel: ");
		}
	});

	test("injects and YAML-escapes configured model values", () => {
		const authorModel = 'author:model "alpha" \\ path\nline\rend';
		const reviewerModel = 'reviewer:model "beta" \\ check\nline\rend';
		const templates = renderAgentTemplates({ authorModel, reviewerModel });

		const planAuthor = getTemplateContent(templates, "5x-plan-author");
		const codeAuthor = getTemplateContent(templates, "5x-code-author");
		const reviewer = getTemplateContent(templates, "5x-reviewer");

		expect(planAuthor).toContain(
			'model: "author:model \\"alpha\\" \\\\ path\\nline\\rend"',
		);
		expect(codeAuthor).toContain(
			'model: "author:model \\"alpha\\" \\\\ path\\nline\\rend"',
		);
		expect(reviewer).toContain(
			'model: "reviewer:model \\"beta\\" \\\\ check\\nline\\rend"',
		);
	});

	test("injects author model into author subagents only", () => {
		const templates = renderAgentTemplates({
			authorModel: "author-model",
			reviewerModel: "reviewer-model",
		});

		expect(getTemplateContent(templates, "5x-plan-author")).toContain(
			'model: "author-model"',
		);
		expect(getTemplateContent(templates, "5x-code-author")).toContain(
			'model: "author-model"',
		);
		expect(getTemplateContent(templates, "5x-reviewer")).not.toContain(
			'model: "author-model"',
		);
	});

	test("injects reviewer model into reviewer subagent only", () => {
		const templates = renderAgentTemplates({
			authorModel: "author-model",
			reviewerModel: "reviewer-model",
		});

		expect(getTemplateContent(templates, "5x-reviewer")).toContain(
			'model: "reviewer-model"',
		);
		expect(getTemplateContent(templates, "5x-plan-author")).not.toContain(
			'model: "reviewer-model"',
		);
		expect(getTemplateContent(templates, "5x-code-author")).not.toContain(
			'model: "reviewer-model"',
		);
	});
});

describe("cursor loader — mixed-mode delegation filtering", () => {
	test("with authorInvoke: true returns only reviewer", () => {
		const templates = renderAgentTemplates({
			authorInvoke: true,
			reviewerInvoke: false,
		});

		const names = templates.map((t) => t.name);
		expect(names).toContain("5x-reviewer");
		expect(names).not.toContain("5x-plan-author");
		expect(names).not.toContain("5x-code-author");
		expect(templates).toHaveLength(1);
	});

	test("with reviewerInvoke: true returns only author agents", () => {
		const templates = renderAgentTemplates({
			authorInvoke: false,
			reviewerInvoke: true,
		});

		const names = templates.map((t) => t.name);
		expect(names).toContain("5x-plan-author");
		expect(names).toContain("5x-code-author");
		expect(names).not.toContain("5x-reviewer");
		expect(templates).toHaveLength(2);
	});

	test("with both invoke flags returns empty array", () => {
		const templates = renderAgentTemplates({
			authorInvoke: true,
			reviewerInvoke: true,
		});

		expect(templates).toHaveLength(0);
	});

	test("default behavior (no invoke flags) returns all templates", () => {
		const templates = renderAgentTemplates({});

		const names = templates.map((t) => t.name);
		expect(names).toContain("5x-plan-author");
		expect(names).toContain("5x-code-author");
		expect(names).toContain("5x-reviewer");
		expect(templates).toHaveLength(3);
	});

	test("listAgentTemplates returns all 3 templates regardless of mode", () => {
		// listAgentTemplates returns static bundled inventory
		const allTemplates = listAgentTemplates();
		expect(allTemplates).toHaveLength(3);
		const names = allTemplates.map((t) => t.name);
		expect(names).toContain("5x-plan-author");
		expect(names).toContain("5x-code-author");
		expect(names).toContain("5x-reviewer");
	});
});
