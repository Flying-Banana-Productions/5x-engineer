import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDefaultTemplateRaw,
	listTemplates,
	loadTemplate,
	parseTemplate,
	renderBody,
	renderTemplate,
	setTemplateOverrideDir,
} from "../../../src/templates/loader.js";

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

describe("author-fix-quality template", () => {
	const vars = {
		plan_path: "docs/development/001-impl-cli.md",
		phase_number: "2",
		user_notes: "Test failures in unit/commands",
	};

	test("renders with valid variables", () => {
		const result = renderTemplate("author-fix-quality", vars);
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("Phase 2");
		expect(result.prompt).toContain("Test failures in unit/commands");
	});

	test("includes completion section (no signal blocks)", () => {
		const result = renderTemplate("author-fix-quality", vars);
		expect(result.prompt).toContain("Completion");
		expect(result.prompt).not.toContain("5x:status");
	});

	test("is explicitly scoped to quality remediation (not code review)", () => {
		const result = renderTemplate("author-fix-quality", vars);
		expect(result.prompt).toContain("quality remediation");
		expect(result.prompt).toContain("quality gate failures");
		expect(result.prompt).not.toContain("review document");
	});

	test("instructs to fix tests, lint, and type errors", () => {
		const result = renderTemplate("author-fix-quality", vars);
		expect(result.prompt).toContain("Run all tests");
		expect(result.prompt).toContain("lint");
		expect(result.prompt).toContain("type");
	});

	test("does not require review_path variable", () => {
		// author-fix-quality should NOT require review_path
		const { metadata } = loadTemplate("author-fix-quality");
		expect(metadata.variables).not.toContain("review_path");
		expect(metadata.variables).toContain("plan_path");
		expect(metadata.variables).toContain("phase_number");
		expect(metadata.variables).toContain("user_notes");
	});

	test("has correct step_name for quality fixes", () => {
		const { metadata } = loadTemplate("author-fix-quality");
		expect(metadata.stepName).toBe("author:fix-quality");
	});

	test("errors on missing required variables", () => {
		expect(() =>
			renderTemplate("author-fix-quality", {
				plan_path: "docs/development/001-impl-cli.md",
				// missing phase_number and user_notes
			}),
		).toThrow(/missing required variables/);
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
	test("returns all 8 templates", () => {
		const templates = listTemplates();
		const names = templates.map((t) => t.name);
		expect(names).toContain("author-fix-quality");
		expect(names).toContain("author-generate-plan");
		expect(names).toContain("author-next-phase");
		expect(names).toContain("author-process-plan-review");
		expect(names).toContain("author-process-impl-review");
		expect(names).toContain("reviewer-plan");
		expect(names).toContain("reviewer-plan-continued");
		expect(names).toContain("reviewer-commit");
		expect(templates.length).toBe(8);
	});

	test("all templates have version 1", () => {
		const templates = listTemplates();
		for (const t of templates) {
			expect(t.version).toBe(1);
		}
	});
});

describe("template stepName", () => {
	const expectedStepNames: Record<string, string> = {
		"author-fix-quality": "author:fix-quality",
		"author-generate-plan": "author:generate-plan",
		"author-next-phase": "author:implement",
		"author-process-plan-review": "author:fix-review",
		"author-process-impl-review": "author:fix-review",
		"reviewer-plan": "reviewer:review",
		"reviewer-commit": "reviewer:review",
	};

	test("all bundled templates have correct stepName in parsed metadata", () => {
		for (const [name, expectedStep] of Object.entries(expectedStepNames)) {
			const { metadata } = loadTemplate(name);
			expect(metadata.stepName).toBe(expectedStep);
		}
	});

	test("renderTemplate includes stepName in result", () => {
		const result = renderTemplate("author-next-phase", {
			plan_path: "/path/to/plan.md",
			phase_number: "1",
			user_notes: "test notes",
		});
		expect(result.stepName).toBe("author:implement");
	});

	test("on-disk override missing step_name for known template uses fallback and warns", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "tmpl-step-"));
		try {
			// Write override WITHOUT step_name
			writeFileSync(
				join(tmpDir, "author-next-phase.md"),
				[
					"---",
					"name: author-next-phase",
					"version: 1",
					"variables:",
					"  - plan_path",
					"  - phase_number",
					"  - user_notes",
					"---",
					"CUSTOM BODY {{plan_path}} {{phase_number}} {{user_notes}}",
				].join("\n"),
			);

			// Capture stderr
			const origStderr = console.error;
			const stderrLines: string[] = [];
			console.error = (...args: unknown[]) => {
				stderrLines.push(args.map(String).join(" "));
			};

			try {
				setTemplateOverrideDir(tmpDir);
				const { metadata } = loadTemplate("author-next-phase");

				// Should use fallback
				expect(metadata.stepName).toBe("author:implement");
				// Should have warned
				expect(stderrLines.some((l) => l.includes('missing "step_name"'))).toBe(
					true,
				);
				expect(
					stderrLines.some((l) =>
						l.includes("5x init --install-templates --force"),
					),
				).toBe(true);
			} finally {
				console.error = origStderr;
				setTemplateOverrideDir(null);
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("unknown template name with no step_name has stepName null, no warning", () => {
		// parseTemplate is exported for testing — call it directly with an
		// unknown template name (not in STEP_NAME_FALLBACKS) and no step_name
		// in frontmatter. stepName should be null and no warning emitted.
		const raw = [
			"---",
			"name: custom-template",
			"version: 1",
			"variables:",
			"  - some_var",
			"---",
			"Custom body {{some_var}}",
		].join("\n");

		const origStderr = console.error;
		const stderrLines: string[] = [];
		console.error = (...args: unknown[]) => {
			stderrLines.push(args.map(String).join(" "));
		};
		try {
			const result = parseTemplate(raw, "custom-template");
			expect(result.metadata.stepName).toBeNull();
			// No warning should have been emitted for unknown template names
			expect(stderrLines.some((l) => l.includes('missing "step_name"'))).toBe(
				false,
			);
		} finally {
			console.error = origStderr;
		}
	});

	test("template with invalid step_name (empty string) throws", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "tmpl-step-"));
		try {
			writeFileSync(
				join(tmpDir, "author-next-phase.md"),
				[
					"---",
					"name: author-next-phase",
					"version: 1",
					"variables:",
					"  - plan_path",
					"  - phase_number",
					"  - user_notes",
					'step_name: ""',
					"---",
					"BODY {{plan_path}} {{phase_number}} {{user_notes}}",
				].join("\n"),
			);

			setTemplateOverrideDir(tmpDir);
			expect(() => loadTemplate("author-next-phase")).toThrow(
				/"step_name" must be a non-empty string/,
			);
		} finally {
			setTemplateOverrideDir(null);
			rmSync(tmpDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Override mechanism tests
// ---------------------------------------------------------------------------

describe("setTemplateOverrideDir — disk-first loading", () => {
	let tmpDir: string;

	afterEach(() => {
		setTemplateOverrideDir(null); // reset for other tests
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	test("loads template from override dir when file exists", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-override-"));
		// Write a valid override with modified body
		writeFileSync(
			join(tmpDir, "author-generate-plan.md"),
			[
				"---",
				"name: author-generate-plan",
				"version: 1",
				"variables:",
				"  - prd_path",
				"  - plan_path",
				"  - plan_template_path",
				"---",
				"CUSTOM OVERRIDE: {{prd_path}} {{plan_path}} {{plan_template_path}}",
			].join("\n"),
		);

		setTemplateOverrideDir(tmpDir);
		const { body } = loadTemplate("author-generate-plan");
		expect(body).toContain("CUSTOM OVERRIDE:");
	});

	test("falls back to bundled when override dir set but file missing", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-override-"));
		// Dir exists but no file for author-generate-plan

		setTemplateOverrideDir(tmpDir);
		const { body } = loadTemplate("author-generate-plan");
		// Should get the bundled default
		expect(body).toContain("Completion");
		expect(body).not.toContain("CUSTOM OVERRIDE");
	});

	test("clearing override dir restores bundled templates", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-override-"));
		writeFileSync(
			join(tmpDir, "author-generate-plan.md"),
			[
				"---",
				"name: author-generate-plan",
				"version: 1",
				"variables:",
				"  - prd_path",
				"  - plan_path",
				"  - plan_template_path",
				"---",
				"CUSTOM OVERRIDE: {{prd_path}} {{plan_path}} {{plan_template_path}}",
			].join("\n"),
		);

		setTemplateOverrideDir(tmpDir);
		expect(loadTemplate("author-generate-plan").body).toContain(
			"CUSTOM OVERRIDE",
		);

		setTemplateOverrideDir(null);
		expect(loadTemplate("author-generate-plan").body).not.toContain(
			"CUSTOM OVERRIDE",
		);
	});

	test("cache is cleared when override dir changes", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-override-"));
		const subDir = join(tmpDir, "v2");
		mkdirSync(subDir);

		writeFileSync(
			join(tmpDir, "author-generate-plan.md"),
			[
				"---",
				"name: author-generate-plan",
				"version: 1",
				"variables:",
				"  - prd_path",
				"  - plan_path",
				"  - plan_template_path",
				"---",
				"VERSION_A: {{prd_path}} {{plan_path}} {{plan_template_path}}",
			].join("\n"),
		);
		writeFileSync(
			join(subDir, "author-generate-plan.md"),
			[
				"---",
				"name: author-generate-plan",
				"version: 1",
				"variables:",
				"  - prd_path",
				"  - plan_path",
				"  - plan_template_path",
				"---",
				"VERSION_B: {{prd_path}} {{plan_path}} {{plan_template_path}}",
			].join("\n"),
		);

		setTemplateOverrideDir(tmpDir);
		expect(loadTemplate("author-generate-plan").body).toContain("VERSION_A");

		setTemplateOverrideDir(subDir);
		expect(loadTemplate("author-generate-plan").body).toContain("VERSION_B");
	});

	test("override with mismatched frontmatter name throws", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-override-"));
		writeFileSync(
			join(tmpDir, "author-generate-plan.md"),
			[
				"---",
				"name: wrong-name",
				"version: 1",
				"variables:",
				"  - prd_path",
				"  - plan_path",
				"  - plan_template_path",
				"---",
				"Bad template",
			].join("\n"),
		);

		setTemplateOverrideDir(tmpDir);
		expect(() => loadTemplate("author-generate-plan")).toThrow(
			/does not match registry key/,
		);
	});

	test("unknown template still throws even with override dir set", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tmpl-override-"));
		setTemplateOverrideDir(tmpDir);
		expect(() => loadTemplate("nonexistent-template")).toThrow(
			/Unknown template/,
		);
	});
});

describe("variable_defaults", () => {
	test("parseTemplate parses variable_defaults and populates metadata.variableDefaults", () => {
		const raw = [
			"---",
			"name: test-defaults",
			"version: 1",
			"variables:",
			"  - required_var",
			"  - optional_var",
			"variable_defaults:",
			'  optional_var: "fallback"',
			"---",
			"Body {{required_var}} {{optional_var}}",
		].join("\n");

		const result = parseTemplate(raw, "test-defaults");
		expect(result.metadata.variableDefaults).toEqual({
			optional_var: "fallback",
		});
		expect(result.metadata.variables).toContain("optional_var");
		expect(result.metadata.variables).toContain("required_var");
	});

	test("renderTemplate for author-next-phase renders without providing user_notes (uses default empty string)", () => {
		// Clear cache to pick up updated template
		setTemplateOverrideDir(null);
		const result = renderTemplate("author-next-phase", {
			plan_path: "docs/development/001-impl-cli.md",
			phase_number: "3",
			// user_notes NOT provided — should use default ""
		});
		expect(result.prompt).toContain("phase 3");
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.name).toBe("author-next-phase");
	});

	test("explicit user_notes overrides the default", () => {
		setTemplateOverrideDir(null);
		const result = renderTemplate("author-next-phase", {
			plan_path: "docs/development/001-impl-cli.md",
			phase_number: "3",
			user_notes: "custom notes",
		});
		expect(result.prompt).toContain("custom notes");
	});

	test("variable_defaults key referencing a variable not in variables list throws", () => {
		const raw = [
			"---",
			"name: test-bad-default",
			"version: 1",
			"variables:",
			"  - some_var",
			"variable_defaults:",
			'  unknown_var: "oops"',
			"---",
			"Body {{some_var}}",
		].join("\n");

		expect(() => parseTemplate(raw, "test-bad-default")).toThrow(
			/key "unknown_var" is not declared in "variables" list/,
		);
	});

	test("variable_defaults with non-string value throws", () => {
		const raw = [
			"---",
			"name: test-nonstring",
			"version: 1",
			"variables:",
			"  - some_var",
			"variable_defaults:",
			"  some_var: 42",
			"---",
			"Body {{some_var}}",
		].join("\n");

		expect(() => parseTemplate(raw, "test-nonstring")).toThrow(
			/value for "some_var" must be a string, got number/,
		);
	});

	test("templates without variable_defaults still work (backward compatible)", () => {
		const raw = [
			"---",
			"name: test-no-defaults",
			"version: 1",
			"variables:",
			"  - my_var",
			"---",
			"Body {{my_var}}",
		].join("\n");

		const result = parseTemplate(raw, "test-no-defaults");
		expect(result.metadata.variableDefaults).toEqual({});
	});

	test("all bundled templates have valid variableDefaults metadata", () => {
		const templates = listTemplates();
		for (const t of templates) {
			expect(t.variableDefaults).toBeDefined();
			expect(typeof t.variableDefaults).toBe("object");
		}
	});

	test("author-fix-quality renders without providing user_notes", () => {
		setTemplateOverrideDir(null);
		const result = renderTemplate("author-fix-quality", {
			plan_path: "docs/development/001-impl-cli.md",
			phase_number: "2",
		});
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("Phase 2");
	});

	test("author-process-plan-review renders without providing user_notes", () => {
		setTemplateOverrideDir(null);
		const result = renderTemplate("author-process-plan-review", {
			review_path: "docs/reviews/review.md",
			plan_path: "docs/development/001-impl-cli.md",
		});
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("review.md");
	});

	test("author-process-impl-review renders without providing user_notes", () => {
		setTemplateOverrideDir(null);
		const result = renderTemplate("author-process-impl-review", {
			review_path: "docs/reviews/review.md",
			plan_path: "docs/development/001-impl-cli.md",
		});
		expect(result.prompt).toContain("001-impl-cli.md");
		expect(result.prompt).toContain("review.md");
	});

	test("missing non-defaulted variables still throw", () => {
		setTemplateOverrideDir(null);
		// author-next-phase has variable_defaults for user_notes only;
		// plan_path and phase_number are still required
		expect(() =>
			renderTemplate("author-next-phase", {
				plan_path: "docs/plan.md",
				// missing phase_number (no default)
			}),
		).toThrow(/missing required variables.*phase_number/);
	});

	test("variable_defaults must be a plain object, not an array", () => {
		const raw = [
			"---",
			"name: test-array-defaults",
			"version: 1",
			"variables:",
			"  - some_var",
			"variable_defaults:",
			"  - some_var",
			"---",
			"Body {{some_var}}",
		].join("\n");

		expect(() => parseTemplate(raw, "test-array-defaults")).toThrow(
			/"variable_defaults" must be a plain object/,
		);
	});
});

describe("getDefaultTemplateRaw", () => {
	test("returns raw content including frontmatter", () => {
		const raw = getDefaultTemplateRaw("author-generate-plan");
		expect(raw).toMatch(/^---\n/);
		expect(raw).toContain("name: author-generate-plan");
		expect(raw).toContain("variables:");
	});

	test("returns content for all registered templates", () => {
		const templates = listTemplates();
		for (const t of templates) {
			const raw = getDefaultTemplateRaw(t.name);
			expect(raw).toContain(`name: ${t.name}`);
		}
	});

	test("throws for unknown template name", () => {
		expect(() => getDefaultTemplateRaw("does-not-exist")).toThrow(
			/Unknown template "does-not-exist"/,
		);
	});
});
