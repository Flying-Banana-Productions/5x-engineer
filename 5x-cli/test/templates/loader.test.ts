import { describe, expect, test } from "bun:test";
import {
	listTemplates,
	loadTemplate,
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
		expect(body).toContain("5x:status");
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
		expect(result.prompt).toContain("5x:status");
		expect(result.prompt).toContain("protocolVersion: 1");
		expect(result.prompt).toContain("planPath:");
	});

	test("includes protocol output section for completed, needs_human, and failed", () => {
		const result = renderTemplate("author-generate-plan", vars);
		expect(result.prompt).toContain("result: completed");
		expect(result.prompt).toContain("result: needs_human");
		expect(result.prompt).toContain("result: failed");
	});

	test("includes YAML safety reminder", () => {
		const result = renderTemplate("author-generate-plan", vars);
		expect(result.prompt).toContain("safe scalars");
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
		expect(result.prompt).toContain("5x:status");
		expect(result.prompt).toContain("commit:");
		expect(result.prompt).toContain("phase:");
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

describe("author-process-review template", () => {
	const vars = {
		review_path: "docs/development/reviews/2026-02-15-cli-review.md",
		plan_path: "docs/development/001-impl-cli.md",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("author-process-review", vars);
		expect(result.prompt).toContain("2026-02-15-cli-review.md");
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("5x:status");
	});

	test("instructs to focus on latest addendum", () => {
		const result = renderTemplate("author-process-review", vars);
		expect(result.prompt).toContain("latest addendum");
	});

	test("includes guidance about plan-only vs code changes", () => {
		const result = renderTemplate("author-process-review", vars);
		expect(result.prompt).toContain("plan document only");
	});
});

describe("reviewer-plan template", () => {
	const vars = {
		plan_path: "docs/development/001-impl-cli.md",
		review_path: "docs/development/reviews/2026-02-15-cli-review.md",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("reviewer-plan", vars);
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("2026-02-15-cli-review.md");
		expect(result.prompt).toContain("5x:verdict");
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

	test("instructs to echo reviewPath", () => {
		const result = renderTemplate("reviewer-plan", vars);
		expect(result.prompt).toContain("reviewPath:");
	});

	test("includes YAML safety reminder", () => {
		const result = renderTemplate("reviewer-plan", vars);
		expect(result.prompt).toContain("safe scalars");
	});
});

describe("reviewer-commit template", () => {
	const vars = {
		commit_hash: "abc123def",
		review_path: "docs/development/reviews/2026-02-15-cli-review.md",
		plan_path: "docs/development/001-impl-cli.md",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("reviewer-commit", vars);
		expect(result.prompt).toContain("abc123def");
		expect(result.prompt).toContain("2026-02-15-cli-review.md");
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("5x:verdict");
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
	test("returns all 5 templates", () => {
		const templates = listTemplates();
		const names = templates.map((t) => t.name);
		expect(names).toContain("author-generate-plan");
		expect(names).toContain("author-next-phase");
		expect(names).toContain("author-process-review");
		expect(names).toContain("reviewer-plan");
		expect(names).toContain("reviewer-commit");
		expect(templates.length).toBe(5);
	});

	test("all templates have version 1", () => {
		const templates = listTemplates();
		for (const t of templates) {
			expect(t.version).toBe(1);
		}
	});
});
