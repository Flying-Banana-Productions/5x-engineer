/**
 * Tests for OpenCode harness skill content, loader, and frontmatter parsing.
 *
 * Consolidated from:
 * - test/unit/skills/skill-content.test.ts (skill content assertions)
 * - test/unit/commands/init-skills.test.ts (loader + frontmatter parser tests)
 *
 * All skill content and loader tests now live here, alongside the OpenCode
 * harness that owns the skill files.
 */

import { describe, expect, test } from "bun:test";
import {
	getDefaultSkillRaw,
	listSkillNames,
	listSkills,
	parseSkillFrontmatter,
} from "../../../src/harnesses/opencode/skills/loader.js";
import {
	listTemplates,
	renderTemplate,
} from "../../../src/templates/loader.js";

// ---------------------------------------------------------------------------
// Skill loader tests
// ---------------------------------------------------------------------------

describe("skill loader", () => {
	test("all skills load without error", () => {
		expect(() => getDefaultSkillRaw("5x")).not.toThrow();
		expect(() => getDefaultSkillRaw("5x-windows")).not.toThrow();
		expect(() => getDefaultSkillRaw("5x-plan")).not.toThrow();
		expect(() => getDefaultSkillRaw("5x-plan-review")).not.toThrow();
		expect(() => getDefaultSkillRaw("5x-phase-execution")).not.toThrow();
		expect(() => getDefaultSkillRaw("5x-config")).not.toThrow();
	});

	test("listSkillNames returns all bundled skills", () => {
		const names = listSkillNames();
		expect(names).toContain("5x");
		expect(names).toContain("5x-windows");
		expect(names).toContain("5x-plan");
		expect(names).toContain("5x-plan-review");
		expect(names).toContain("5x-phase-execution");
		expect(names).toContain("5x-config");
		expect(names.length).toBe(6);
	});

	test("listSkills returns metadata with description and content", () => {
		const skills = listSkills();
		expect(skills.length).toBe(6);

		const planSkill = skills.find((s) => s.name === "5x-plan");
		expect(planSkill).toBeDefined();
		expect(planSkill?.description).toContain("implementation plan");
		expect(planSkill?.content).toContain("---");
		expect(planSkill?.content).toContain("name: 5x-plan");
		expect(planSkill?.content).toContain("## Workflow");
	});

	test("all bundled skills have valid frontmatter", () => {
		const skills = listSkills();
		for (const skill of skills) {
			expect(skill.name).toBeTruthy();
			expect(skill.description.length).toBeGreaterThan(10);
			// Description should be useful for agent discovery
			expect(skill.description).not.toBe("A skill.");
		}
	});

	test("getDefaultSkillRaw returns full SKILL.md content", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("---");
		expect(content).toContain("name: 5x-plan");
		expect(content).toContain("## Prerequisites");
		expect(content).toContain("## Tools");
		expect(content).toContain("## Workflow");
	});

	test("getDefaultSkillRaw throws for unknown skill", () => {
		expect(() => getDefaultSkillRaw("unknown-skill")).toThrow(
			'Unknown skill "unknown-skill"',
		);
	});

	test("skill frontmatter parses correctly for all skills", () => {
		for (const name of [
			"5x",
			"5x-windows",
			"5x-plan",
			"5x-plan-review",
			"5x-phase-execution",
			"5x-config",
		]) {
			const raw = getDefaultSkillRaw(name);
			const fm = parseSkillFrontmatter(raw);
			expect(fm.name).toBe(name);
			expect(fm.description.length).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// parseSkillFrontmatter
// ---------------------------------------------------------------------------

describe("parseSkillFrontmatter", () => {
	test("parses valid frontmatter with name and description", () => {
		const raw = [
			"---",
			"name: my-skill",
			"description: Does something useful.",
			"---",
			"# Body content",
		].join("\n");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.name).toBe("my-skill");
		expect(fm.description).toBe("Does something useful.");
		expect(fm.metadata).toBeUndefined();
	});

	test("parses metadata field", () => {
		const raw = [
			"---",
			"name: my-skill",
			"description: A skill.",
			"metadata:",
			'  author: "test-org"',
			'  version: "1.0"',
			"---",
			"# Body",
		].join("\n");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.metadata).toEqual({ author: "test-org", version: "1.0" });
	});

	test("parses multi-line description (YAML block scalar)", () => {
		const raw = [
			"---",
			"name: my-skill",
			"description: >-",
			"  A multi-line description that spans",
			"  multiple lines in YAML.",
			"---",
			"# Body",
		].join("\n");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.description).toBe(
			"A multi-line description that spans multiple lines in YAML.",
		);
	});

	test("throws on missing frontmatter delimiters", () => {
		expect(() => parseSkillFrontmatter("# Just markdown")).toThrow(
			"missing YAML frontmatter",
		);
	});

	test("throws on missing name field", () => {
		const raw = ["---", "description: A skill.", "---", "# Body"].join("\n");
		expect(() => parseSkillFrontmatter(raw)).toThrow('missing required "name"');
	});

	test("throws on missing description field", () => {
		const raw = ["---", "name: my-skill", "---", "# Body"].join("\n");
		expect(() => parseSkillFrontmatter(raw)).toThrow(
			'missing required "description"',
		);
	});

	test("throws on empty name", () => {
		const raw = [
			"---",
			'name: ""',
			"description: A skill.",
			"---",
			"# Body",
		].join("\n");
		expect(() => parseSkillFrontmatter(raw)).toThrow('missing required "name"');
	});

	test("throws on empty description", () => {
		const raw = [
			"---",
			"name: my-skill",
			'description: ""',
			"---",
			"# Body",
		].join("\n");
		expect(() => parseSkillFrontmatter(raw)).toThrow(
			'missing required "description"',
		);
	});

	test("ignores non-object metadata", () => {
		const raw = [
			"---",
			"name: my-skill",
			"description: A skill.",
			"metadata: not-an-object",
			"---",
			"# Body",
		].join("\n");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.metadata).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 5x foundational skill
// ---------------------------------------------------------------------------

describe("5x foundational skill", () => {
	test("skill loads and frontmatter parses correctly", () => {
		const raw = getDefaultSkillRaw("5x");
		const fm = parseSkillFrontmatter(raw);
		expect(fm.name).toBe("5x");
		expect(fm.description.length).toBeGreaterThan(0);
	});

	test("contains Human Interaction Model section", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("## Human Interaction Model");
	});

	test("contains Delegating to Subagents section", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("## Delegating to Subagents");
	});

	test("contains Gotchas section", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("## Gotchas");
	});

	test("references all three subagent types", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("5x-plan-author");
		expect(content).toContain("5x-code-author");
		expect(content).toContain("5x-reviewer");
	});

	test("references 5x config show", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("5x config show");
	});

	test("contains Task Reuse section", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("## Task Reuse");
	});

	test("documents Task tool delegation pattern", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("subagent_type");
		expect(content).toContain("Task tool");
	});
});

// ---------------------------------------------------------------------------
// Native-first delegation: 5x-plan skill
// ---------------------------------------------------------------------------

describe("5x-plan skill — Task tool delegation", () => {
	test("skill loads", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toBeTruthy();
	});

	test("references 5x template render command", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("5x template render");
	});

	test("references 5x protocol validate command", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("5x protocol validate");
	});

	test("delegates via Task tool, not 5x invoke", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("Task tool");
		expect(content).not.toContain("5x invoke");
	});

	test("references 5x-plan-author subagent type", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("5x-plan-author");
	});

	test("contains Prerequisite Skill section referencing 5x skill", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("## Prerequisite Skill");
		expect(content).toMatch(/[Ll]oad the `5x` skill/);
	});

	test("contains Gotchas section", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("## Gotchas");
	});

	test("keeps AuthorStatus structured outcome contract", () => {
		const content = getDefaultSkillRaw("5x-plan");
		// AuthorStatus fields must be present
		expect(content).toContain('result: "complete"');
		expect(content).toContain("commit");
		expect(content).toContain('result: "needs_human"');
	});
});

// ---------------------------------------------------------------------------
// Native-first delegation: 5x-plan-review skill
// ---------------------------------------------------------------------------

describe("5x-plan-review skill — Task tool delegation", () => {
	test("references 5x template render command", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x template render");
	});

	test("references 5x protocol validate command", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x protocol validate");
	});

	test("delegates via Task tool, not 5x invoke", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("Task tool");
		expect(content).not.toContain("5x invoke");
	});

	test("references 5x-reviewer subagent type", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x-reviewer");
	});

	test("references 5x-plan-author subagent type", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x-plan-author");
	});

	test("contains Prerequisite Skill section referencing 5x skill", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("## Prerequisite Skill");
		expect(content).toMatch(/[Ll]oad the `5x` skill/);
	});

	test("contains Gotchas section", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("## Gotchas");
	});

	test("keeps ReviewerVerdict structured outcome contract", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain('readiness: "ready"');
		expect(content).toContain('readiness: "not_ready"');
		expect(content).toContain("auto_fix");
		expect(content).toContain("human_required");
	});

	test("canonical delegation example uses --record on protocol validate not invoke", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		// The example should show protocol validate doing the recording
		expect(content).toContain("5x protocol validate reviewer");
		expect(content).toContain("--record");
	});
});

// ---------------------------------------------------------------------------
// Native-first delegation: 5x-phase-execution skill
// ---------------------------------------------------------------------------

describe("5x-phase-execution skill — Task tool delegation", () => {
	test("references 5x template render command", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x template render");
	});

	test("references 5x protocol validate command", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x protocol validate");
	});

	test("delegates via Task tool, not 5x invoke", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("Task tool");
		expect(content).not.toContain("5x invoke");
	});

	test("references 5x-code-author subagent type", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x-code-author");
	});

	test("references 5x-reviewer subagent type", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x-reviewer");
	});

	test("treats session reuse as optional", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toMatch(/optional|best.effort/i);
	});

	test("documents ## Context block from 5x template render", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		// The ## Context block provides working directory to native subagents
		expect(content).toContain("## Context");
	});

	test("contains Prerequisite Skill section referencing 5x skill", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("## Prerequisite Skill");
		expect(content).toMatch(/[Ll]oad the `5x` skill/);
	});

	test("contains Gotchas section", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("## Gotchas");
	});

	test("keeps AuthorStatus and ReviewerVerdict contracts", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("AuthorStatus.commit");
		expect(content).toContain('readiness: "ready"');
	});

	test("documents checklist verification before recording phase:complete", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		// Must verify checklist completion via 5x plan phases BEFORE recording phase:complete
		expect(content).toContain("5x plan phases $PLAN_PATH");
		expect(content).toContain("done: true");
		expect(content).toContain("phase:checklist_mismatch");
	});

	test("documents escalation on checklist mismatch (no auto-reinvoke)", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		// Must escalate to human when checklist not updated
		expect(content).toMatch(/escalate|Escalate/);
		expect(content).toMatch(/do NOT.*auto.reinvok|stop immediately/i);
		expect(content).toMatch(/checklist mismatch|Checklist mismatch/i);
	});

	test("subagent recovery section exists", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("Subagent returns empty or invalid output");
	});
});

// ---------------------------------------------------------------------------
// Run watch guidance removal
// ---------------------------------------------------------------------------

describe("run watch guidance removed from native-first skills", () => {
	test("5x-plan skill does not mention run watch", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).not.toContain("run watch");
	});

	test("5x-plan-review skill does not mention run watch", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).not.toContain("run watch");
	});

	test("5x-phase-execution skill does not mention run watch", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).not.toContain("run watch");
	});

	test("Task tool delegation is referenced in all process skills", () => {
		expect(getDefaultSkillRaw("5x-plan")).toContain("Task tool");
		expect(getDefaultSkillRaw("5x-plan-review")).toContain("Task tool");
		expect(getDefaultSkillRaw("5x-phase-execution")).toContain("Task tool");
	});

	test("no process skill references 5x invoke", () => {
		expect(getDefaultSkillRaw("5x")).not.toContain("5x invoke");
		expect(getDefaultSkillRaw("5x-plan")).not.toContain("5x invoke");
		expect(getDefaultSkillRaw("5x-plan-review")).not.toContain("5x invoke");
		expect(getDefaultSkillRaw("5x-phase-execution")).not.toContain("5x invoke");
	});

	test("5x-plan skill treats --plan as output path and passes PRD separately", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("output plan path to be generated");
		expect(content).toContain("--var prd_path=$PRD_PATH");
		expect(content).not.toContain(
			"--var prd_path=$PRD_PATH --var plan_path=$PLAN_PATH",
		);
	});
});

// ---------------------------------------------------------------------------
// Task templates — transport-neutral language
// ---------------------------------------------------------------------------

describe("task templates — transport-neutral language", () => {
	const templateNames = [
		"author-fix-quality",
		"author-generate-plan",
		"author-next-phase",
		"author-process-plan-review",
		"author-process-impl-review",
		"reviewer-plan",
		"reviewer-plan-continued",
		"reviewer-commit",
	];

	test("all templates exist in loader", () => {
		const listed = listTemplates().map((t) => t.name);
		for (const name of templateNames) {
			expect(listed).toContain(name);
		}
	});

	for (const name of templateNames) {
		test(`${name}: Non-Interactive section does not say "subprocess in an automated pipeline"`, () => {
			// Import raw to check the frontmatter+body, or just render a dummy
			// For templates that need vars, we check the raw content via loader
			const { body } = (() => {
				const loader = require("../../../src/templates/loader.js");
				return loader.loadTemplate(name) as { body: string };
			})();
			// The old wording was: "You are running as a subprocess in an automated pipeline"
			expect(body).not.toContain("running as a subprocess");
		});

		test(`${name}: Non-Interactive section uses transport-neutral wording`, () => {
			const loader = require("../../../src/templates/loader.js");
			const { body } = loader.loadTemplate(name) as { body: string };
			// New wording: "delegated non-interactive workflow"
			expect(body).toContain("delegated non-interactive workflow");
		});
	}
});

// ---------------------------------------------------------------------------
// Rendered prompt content — transport-neutral language
// ---------------------------------------------------------------------------

describe("rendered templates — no subprocess-specific language in Non-Interactive section", () => {
	test("author-generate-plan rendered prompt is transport-neutral", () => {
		const result = renderTemplate("author-generate-plan", {
			prd_path: "/tmp/prd.md",
			plan_path: "/tmp/plan.md",
			plan_template_path: "/tmp/tmpl.md",
		});
		expect(result.prompt).not.toContain("running as a subprocess");
		expect(result.prompt).toContain("delegated non-interactive workflow");
	});

	test("author-next-phase rendered prompt is transport-neutral", () => {
		const result = renderTemplate("author-next-phase", {
			plan_path: "/tmp/plan.md",
			phase_number: "1",
			user_notes: "",
		});
		expect(result.prompt).not.toContain("running as a subprocess");
		expect(result.prompt).toContain("delegated non-interactive workflow");
	});

	test("reviewer-plan rendered prompt is transport-neutral", () => {
		const result = renderTemplate("reviewer-plan", {
			plan_path: "/tmp/plan.md",
			review_path: "/tmp/review.md",
			review_template_path: "/tmp/tmpl.md",
		});
		expect(result.prompt).not.toContain("running as a subprocess");
		expect(result.prompt).toContain("delegated non-interactive workflow");
	});

	test("reviewer-commit rendered prompt is transport-neutral", () => {
		const result = renderTemplate("reviewer-commit", {
			commit_hash: "abc123",
			review_path: "/tmp/review.md",
			plan_path: "/tmp/plan.md",
			review_template_path: "/tmp/tmpl.md",
		});
		expect(result.prompt).not.toContain("running as a subprocess");
		expect(result.prompt).toContain("delegated non-interactive workflow");
	});

	test("reviewer-plan-continued rendered prompt is transport-neutral", () => {
		const result = renderTemplate("reviewer-plan-continued", {
			plan_path: "/tmp/plan.md",
			review_path: "/tmp/review.md",
		});
		expect(result.prompt).not.toContain("running as a subprocess");
		expect(result.prompt).toContain("delegated non-interactive workflow");
	});
});
