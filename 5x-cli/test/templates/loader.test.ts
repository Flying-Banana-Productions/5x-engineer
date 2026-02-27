import { describe, expect, test } from "bun:test";
import {
	listTemplates,
	loadTemplate,
	renderBody,
	renderTemplate,
} from "../../src/templates/loader.js";

describe("loadTemplate", () => {
	test("loads a known template with valid metadata", () => {
		const { metadata, body } = loadTemplate("author-generate-plan");
		expect(metadata.name).toBe("author-generate-plan");
		expect(metadata.version).toBe(1);
		expect(metadata.variables).toContain("prd_path");
		expect(metadata.variables).toContain("plan_path");
		expect(metadata.variables).toContain("plan_template_path");
		expect(body).toContain("Completion");
		expect(body).not.toContain("---\nname:");
	});

	test("throws on unknown template name", () => {
		expect(() => loadTemplate("nonexistent-template")).toThrow(
			/Unknown template "nonexistent-template"/,
		);
	});

	test("all templates have valid frontmatter", () => {
		const templates = listTemplates();
		expect(templates.length).toBeGreaterThanOrEqual(5);
		for (const meta of templates) {
			expect(meta.name).toBeTruthy();
			expect(Number.isInteger(meta.version)).toBe(true);
			expect(Array.isArray(meta.variables)).toBe(true);
		}
	});
});

describe("renderTemplate", () => {
	test("substitutes all variables", () => {
		const result = renderTemplate("author-generate-plan", {
			prd_path: "docs/requirements/feature.md",
			plan_path: "docs/development/001-impl-feature.md",
			plan_template_path: "docs/_implementation_plan_template.md",
		});
		expect(result.name).toBe("author-generate-plan");
		expect(result.prompt).toContain("docs/requirements/feature.md");
		expect(result.prompt).toContain("docs/development/001-impl-feature.md");
		expect(result.prompt).toContain("docs/_implementation_plan_template.md");
		expect(result.prompt).not.toContain("{{prd_path}}");
		expect(result.prompt).not.toContain("{{plan_path}}");
		expect(result.prompt).not.toContain("{{plan_template_path}}");
	});

	test("errors on missing required variables", () => {
		expect(() =>
			renderTemplate("author-generate-plan", {
				prd_path: "docs/requirements/feature.md",
				// missing plan_path and plan_template_path
			}),
		).toThrow(/missing required variables.*plan_path/);
	});

	test("extra variables are ignored (not an error)", () => {
		const result = renderTemplate("author-generate-plan", {
			prd_path: "docs/requirements/feature.md",
			plan_path: "docs/development/001-impl-feature.md",
			plan_template_path: "docs/_implementation_plan_template.md",
			extra_unused: "some value",
		});
		expect(result.prompt).toBeTruthy();
	});

	test("rendered prompt does not contain frontmatter", () => {
		const result = renderTemplate("author-generate-plan", {
			prd_path: "a.md",
			plan_path: "b.md",
			plan_template_path: "c.md",
		});
		expect(result.prompt).not.toMatch(/^---/);
		expect(result.prompt).not.toContain("variables:");
	});
});

describe("author-generate-plan template", () => {
	const vars = {
		prd_path: "docs/workflows/370-feature.md",
		plan_path: "docs/development/370-impl-feature.md",
		plan_template_path: "docs/_implementation_plan_template.md",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("author-generate-plan", vars);
		expect(result.prompt).toContain("370-feature.md");
		expect(result.prompt).toContain("370-impl-feature.md");
	});

	test("includes completion section (no signal blocks)", () => {
		const result = renderTemplate("author-generate-plan", vars);
		expect(result.prompt).toContain("Completion");
		expect(result.prompt).toContain("structured format");
		expect(result.prompt).not.toContain("5x:status");
		expect(result.prompt).not.toContain("5x:verdict");
	});
});

describe("author-next-phase template", () => {
	const vars = {
		plan_path: "docs/development/001-impl-cli.md",
		phase_number: "3",
		user_notes: "Focus on test coverage",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("author-next-phase", vars);
		expect(result.prompt).toContain("phase 3");
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("Focus on test coverage");
	});

	test("includes completion section (no signal blocks)", () => {
		const result = renderTemplate("author-next-phase", vars);
		expect(result.prompt).toContain("Completion");
		expect(result.prompt).toContain("structured output");
		expect(result.prompt).not.toContain("5x:status");
	});

	test("includes branch management guidance", () => {
		const result = renderTemplate("author-next-phase", vars);
		expect(result.prompt).toContain("branch");
	});

	test("user_notes can be empty string", () => {
		const result = renderTemplate("author-next-phase", {
			...vars,
			user_notes: "",
		});
		expect(result.prompt).toBeTruthy();
	});
});

describe("author-process-plan-review template", () => {
	const vars = {
		review_path: "docs/development/reviews/2026-02-15-cli-plan-review.md",
		plan_path: "docs/development/001-impl-cli.md",
		user_notes: "(No additional notes)",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("author-process-plan-review", vars);
		expect(result.prompt).toContain("2026-02-15-cli-plan-review.md");
		expect(result.prompt).toContain("001-impl-cli.md");
	});

	test("includes completion section (no signal blocks)", () => {
		const result = renderTemplate("author-process-plan-review", vars);
		expect(result.prompt).toContain("Completion");
		expect(result.prompt).toContain("structured output");
		expect(result.prompt).not.toContain("5x:status");
	});

	test("instructs to focus on latest addendum", () => {
		const result = renderTemplate("author-process-plan-review", vars);
		expect(result.prompt).toContain("latest addendum");
	});

	test("is explicitly scoped to document-only changes", () => {
		const result = renderTemplate("author-process-plan-review", vars);
		expect(result.prompt).toContain("document-only");
		expect(result.prompt).not.toContain("Run all tests");
	});
});

describe("author-process-impl-review template", () => {
	const vars = {
		review_path: "docs/development/reviews/2026-02-15-cli-phase-1-review.md",
		plan_path: "docs/development/001-impl-cli.md",
		user_notes: "(No additional notes)",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("author-process-impl-review", vars);
		expect(result.prompt).toContain("2026-02-15-cli-phase-1-review.md");
		expect(result.prompt).toContain("001-impl-cli.md");
	});

	test("includes completion section (no signal blocks)", () => {
		const result = renderTemplate("author-process-impl-review", vars);
		expect(result.prompt).toContain("Completion");
		expect(result.prompt).toContain("structured output");
		expect(result.prompt).not.toContain("5x:status");
	});

	test("instructs to focus on latest addendum", () => {
		const result = renderTemplate("author-process-impl-review", vars);
		expect(result.prompt).toContain("latest addendum");
	});

	test("is explicitly scoped to code implementation fixes", () => {
		const result = renderTemplate("author-process-impl-review", vars);
		expect(result.prompt).toContain("code implementation");
		expect(result.prompt).toContain("Run all tests");
		expect(result.prompt).not.toContain("document-only");
	});
});

describe("reviewer-plan template", () => {
	const vars = {
		plan_path: "docs/development/001-impl-cli.md",
		review_path: "docs/development/reviews/2026-02-15-cli-review.md",
		review_template_path: ".5x/templates/review-template.md",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("reviewer-plan", vars);
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("2026-02-15-cli-review.md");
		expect(result.prompt).toContain(".5x/templates/review-template.md");
	});

	test("includes completion section (no signal blocks)", () => {
		const result = renderTemplate("reviewer-plan", vars);
		expect(result.prompt).toContain("Completion");
		expect(result.prompt).toContain("structured output");
		expect(result.prompt).not.toContain("5x:verdict");
	});

	test("includes action classification guidance", () => {
		const result = renderTemplate("reviewer-plan", vars);
		expect(result.prompt).toContain("auto_fix");
		expect(result.prompt).toContain("human_required");
	});

	test("includes readiness assessment options", () => {
		const result = renderTemplate("reviewer-plan", vars);
		expect(result.prompt).toContain("ready");
		expect(result.prompt).toContain("ready_with_corrections");
		expect(result.prompt).toContain("not_ready");
	});

	test("describes structured response fields", () => {
		const result = renderTemplate("reviewer-plan", vars);
		expect(result.prompt).toContain("readiness");
		expect(result.prompt).toContain("items");
		expect(result.prompt).toContain("summary");
	});
});

describe("reviewer-commit template", () => {
	const vars = {
		commit_hash: "abc123def",
		review_path: "docs/development/reviews/2026-02-15-cli-review.md",
		plan_path: "docs/development/001-impl-cli.md",
		review_template_path: ".5x/templates/review-template.md",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("reviewer-commit", vars);
		expect(result.prompt).toContain("abc123def");
		expect(result.prompt).toContain("2026-02-15-cli-review.md");
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain(".5x/templates/review-template.md");
	});

	test("includes completion section (no signal blocks)", () => {
		const result = renderTemplate("reviewer-commit", vars);
		expect(result.prompt).toContain("Completion");
		expect(result.prompt).toContain("structured output");
		expect(result.prompt).not.toContain("5x:verdict");
	});

	test("includes review dimensions", () => {
		const result = renderTemplate("reviewer-commit", vars);
		expect(result.prompt).toContain("Correctness");
		expect(result.prompt).toContain("Security");
		expect(result.prompt).toContain("Performance");
		expect(result.prompt).toContain("Test strategy");
	});

	test("includes action classification guidance", () => {
		const result = renderTemplate("reviewer-commit", vars);
		expect(result.prompt).toContain("auto_fix");
		expect(result.prompt).toContain("human_required");
	});

	test("includes phase readiness assessment", () => {
		const result = renderTemplate("reviewer-commit", vars);
		expect(result.prompt).toContain("next phase");
	});
});

describe("listTemplates", () => {
	test("returns all 6 templates", () => {
		const templates = listTemplates();
		const names = templates.map((t) => t.name);
		expect(names).toContain("author-generate-plan");
		expect(names).toContain("author-next-phase");
		expect(names).toContain("author-process-plan-review");
		expect(names).toContain("author-process-impl-review");
		expect(names).toContain("reviewer-plan");
		expect(names).toContain("reviewer-commit");
		expect(templates.length).toBe(6);
	});

	test("all templates have version 1", () => {
		const templates = listTemplates();
		for (const t of templates) {
			expect(t.version).toBe(1);
		}
	});
});

describe("renderBody — escaped literal braces", () => {
	test("\\{{ renders to literal {{ without error (P0.1 regression)", () => {
		const body = "Use \\{{example}} to show a placeholder.";
		const result = renderBody(body, {}, [], "test");
		expect(result).toBe("Use {{example}} to show a placeholder.");
	});

	test("escaped braces do not trigger unresolved variable error", () => {
		const body = "Literal: \\{{foo}} and \\{{bar}}.";
		// Should NOT throw — these are escaped, not real variables
		const result = renderBody(body, {}, [], "test");
		expect(result).toBe("Literal: {{foo}} and {{bar}}.");
	});

	test("mixed real variables and escaped braces", () => {
		const body = "Path: {{my_var}} and escaped: \\{{not_a_var}} end.";
		const result = renderBody(
			body,
			{ my_var: "/some/path" },
			["my_var"],
			"test",
		);
		expect(result).toBe("Path: /some/path and escaped: {{not_a_var}} end.");
	});

	test("multiple escaped braces in same body", () => {
		const body = "A \\{{x}} B \\{{y}} C";
		const result = renderBody(body, {}, [], "test");
		expect(result).toBe("A {{x}} B {{y}} C");
	});

	test("escaped brace adjacent to real variable", () => {
		const body = "\\{{literal}} then {{real}}";
		const result = renderBody(body, { real: "value" }, ["real"], "test");
		expect(result).toBe("{{literal}} then value");
	});
});

describe("renderBody — signal-block safety (P2-1)", () => {
	test("rejects variable value containing -->", () => {
		expect(() =>
			renderBody("{{my_var}}", { my_var: "bad --> value" }, ["my_var"], "test"),
		).toThrow(/unsafe sequence "-->"/);
	});

	test("rejects variable value containing newline", () => {
		expect(() =>
			renderBody("{{my_var}}", { my_var: "line1\nline2" }, ["my_var"], "test"),
		).toThrow(/contains a newline/);
	});

	test("allows safe scalar values", () => {
		const result = renderBody(
			"{{my_var}}",
			{ my_var: "docs/development/001-impl-cli.md" },
			["my_var"],
			"test",
		);
		expect(result).toBe("docs/development/001-impl-cli.md");
	});

	test("only validates declared variables (extras ignored)", () => {
		// extra_var has a newline but is not in declaredVars, so no error
		const result = renderBody(
			"{{my_var}}",
			{ my_var: "safe", extra_var: "has\nnewline" },
			["my_var"],
			"test",
		);
		expect(result).toBe("safe");
	});
});

describe("template caching (P1.2)", () => {
	test("loadTemplate returns same object reference on repeated calls", () => {
		const first = loadTemplate("author-generate-plan");
		const second = loadTemplate("author-generate-plan");
		expect(first).toBe(second);
	});
});

describe("frontmatter name validation (P1.1)", () => {
	test("all bundled templates have frontmatter name matching registry key", () => {
		const templates = listTemplates();
		for (const t of templates) {
			// loadTemplate already validates name === key; this confirms
			// it doesn't throw for any bundled template
			const { metadata } = loadTemplate(t.name);
			expect(metadata.name).toBe(t.name);
		}
	});
});
