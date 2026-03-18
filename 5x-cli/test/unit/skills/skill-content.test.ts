/**
 * Tests for Phase 4 skill rewrites — 014-harness-native-subagent.
 *
 * Validates that:
 * - Skill SKILL.md files load correctly via the skill loader
 * - Skills describe native-first delegation (5x template render, 5x protocol validate)
 * - Skills document the fallback path (5x invoke)
 * - Skills describe native agent detection order
 * - Task prompt templates use transport-neutral language
 */

import { describe, expect, test } from "bun:test";
import {
	getDefaultSkillRaw,
	listSkillNames,
	listSkills,
	parseSkillFrontmatter,
} from "../../../src/skills/loader.js";
import {
	listTemplates,
	renderTemplate,
} from "../../../src/templates/loader.js";

// ---------------------------------------------------------------------------
// Skill loader tests
// ---------------------------------------------------------------------------

describe("skill loader — Phase 4 rewrites", () => {
	test("all skills load without error", () => {
		expect(() => getDefaultSkillRaw("5x")).not.toThrow();
		expect(() => getDefaultSkillRaw("5x-plan")).not.toThrow();
		expect(() => getDefaultSkillRaw("5x-plan-review")).not.toThrow();
		expect(() => getDefaultSkillRaw("5x-phase-execution")).not.toThrow();
	});

	test("all skill names are listed", () => {
		const names = listSkillNames();
		expect(names).toContain("5x");
		expect(names).toContain("5x-plan");
		expect(names).toContain("5x-plan-review");
		expect(names).toContain("5x-phase-execution");
		// Do not hard-code total count — new skills may be added
		expect(names.length).toBeGreaterThanOrEqual(4);
	});

	test("listSkills returns metadata for all expected skills", () => {
		const skills = listSkills();
		expect(skills.length).toBeGreaterThanOrEqual(4);
		for (const skill of skills) {
			expect(skill.name).toBeTruthy();
			expect(skill.description).toBeTruthy();
			expect(skill.content).toBeTruthy();
		}
	});

	test("skill frontmatter parses correctly for all skills", () => {
		for (const name of [
			"5x",
			"5x-plan",
			"5x-plan-review",
			"5x-phase-execution",
		]) {
			const raw = getDefaultSkillRaw(name);
			const fm = parseSkillFrontmatter(raw);
			expect(fm.name).toBe(name);
			expect(fm.description.length).toBeGreaterThan(0);
		}
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

	test("contains Delegating Sub-Agent Work section", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("## Delegating Sub-Agent Work");
	});

	test("contains Timeout section", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("## Timeout Layers");
	});

	test("contains Gotchas section", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("## Gotchas");
	});

	test("references all four agent names", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("5x-orchestrator");
		expect(content).toContain("5x-plan-author");
		expect(content).toContain("5x-code-author");
		expect(content).toContain("5x-reviewer");
	});

	test("references 5x config show", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("5x config show");
	});

	test("documents native agent detection order: project scope before user scope before fallback", () => {
		const content = getDefaultSkillRaw("5x");
		const sectionIdx = content.indexOf("Native agent detection order");
		expect(sectionIdx).toBeGreaterThan(-1);
		const section = content.slice(sectionIdx);
		const projectIdx = section.indexOf(".opencode/agents/");
		const userIdx = section.indexOf("~/.config/opencode/agents/");
		const fallbackIdx = section.indexOf("5x invoke");
		expect(projectIdx).toBeGreaterThan(-1);
		expect(userIdx).toBeGreaterThan(-1);
		expect(fallbackIdx).toBeGreaterThan(-1);
		expect(projectIdx).toBeLessThan(userIdx);
		expect(userIdx).toBeLessThan(fallbackIdx);
	});
});

// ---------------------------------------------------------------------------
// Native-first delegation: 5x-plan skill
// ---------------------------------------------------------------------------

describe("5x-plan skill — native-first delegation", () => {
	let skillContent: string;

	test("setup", () => {
		skillContent = getDefaultSkillRaw("5x-plan");
		expect(skillContent).toBeTruthy();
	});

	test("references 5x template render command", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("5x template render");
	});

	test("references 5x protocol validate command", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("5x protocol validate");
	});

	test("documents native agent detection order: project scope before user scope before fallback", () => {
		const content = getDefaultSkillRaw("5x-plan");
		// Find the "Native agent detection order" section
		const sectionIdx = content.indexOf("Native agent detection order");
		expect(sectionIdx).toBeGreaterThan(-1);
		// Extract from that section onward for positional checks
		const section = content.slice(sectionIdx);
		const projectIdx = section.indexOf(".opencode/agents/");
		const userIdx = section.indexOf("~/.config/opencode/agents/");
		const fallbackIdx = section.indexOf("5x invoke");
		// All three must be present in the section
		expect(projectIdx).toBeGreaterThan(-1);
		expect(userIdx).toBeGreaterThan(-1);
		expect(fallbackIdx).toBeGreaterThan(-1);
		// Order within the section: project scope → user scope → fallback
		expect(projectIdx).toBeLessThan(userIdx);
		expect(userIdx).toBeLessThan(fallbackIdx);
	});

	test("preserves 5x invoke as last-resort fallback", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("5x invoke");
		// Fallback label should appear
		expect(content).toContain("Fallback");
		// In the detection order section, 5x invoke appears after user scope
		const sectionIdx = content.indexOf("Native agent detection order");
		const section = content.slice(sectionIdx);
		const userIdx = section.indexOf("~/.config/opencode/agents/");
		const invokeIdx = section.indexOf("5x invoke");
		expect(userIdx).toBeLessThan(invokeIdx);
	});

	test("references 5x-plan-author native agent name", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("5x-plan-author");
	});

	test("references 5x-orchestrator agent name", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("5x-orchestrator");
	});

	test("treats session reuse as optional", () => {
		const content = getDefaultSkillRaw("5x-plan");
		// Session reuse should be described as optional/best-effort
		expect(content).toMatch(/optional|best.effort/i);
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

describe("5x-plan-review skill — native-first delegation", () => {
	test("references 5x template render command", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x template render");
	});

	test("references 5x protocol validate command", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x protocol validate");
	});

	test("documents native agent detection order: project scope before user scope before fallback", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		// Find the "Native agent detection order" section
		const sectionIdx = content.indexOf("Native agent detection order");
		expect(sectionIdx).toBeGreaterThan(-1);
		// Extract from that section onward for positional checks
		const section = content.slice(sectionIdx);
		const projectIdx = section.indexOf(".opencode/agents/");
		const userIdx = section.indexOf("~/.config/opencode/agents/");
		const fallbackIdx = section.indexOf("5x invoke");
		// All three must be present in the section
		expect(projectIdx).toBeGreaterThan(-1);
		expect(userIdx).toBeGreaterThan(-1);
		expect(fallbackIdx).toBeGreaterThan(-1);
		// Order within the section: project scope → user scope → fallback
		expect(projectIdx).toBeLessThan(userIdx);
		expect(userIdx).toBeLessThan(fallbackIdx);
	});

	test("preserves 5x invoke as last-resort fallback", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x invoke");
		// In the detection order section, 5x invoke appears after user scope
		const sectionIdx = content.indexOf("Native agent detection order");
		const section = content.slice(sectionIdx);
		const userIdx = section.indexOf("~/.config/opencode/agents/");
		const invokeIdx = section.indexOf("5x invoke");
		expect(userIdx).toBeLessThan(invokeIdx);
	});

	test("references 5x-reviewer native agent name", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x-reviewer");
	});

	test("references 5x-plan-author native agent name", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x-plan-author");
	});

	test("references 5x-orchestrator agent name", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x-orchestrator");
	});

	test("treats session reuse as optional", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toMatch(/optional|best.effort/i);
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

describe("5x-phase-execution skill — native-first delegation", () => {
	test("references 5x template render command", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x template render");
	});

	test("references 5x protocol validate command", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x protocol validate");
	});

	test("documents native agent detection order: project scope before user scope before fallback", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		// Find the "Native agent detection order" section
		const sectionIdx = content.indexOf("Native agent detection order");
		expect(sectionIdx).toBeGreaterThan(-1);
		// Extract from that section onward for positional checks
		const section = content.slice(sectionIdx);
		const projectIdx = section.indexOf(".opencode/agents/");
		const userIdx = section.indexOf("~/.config/opencode/agents/");
		const fallbackIdx = section.indexOf("5x invoke");
		// All three must be present in the section
		expect(projectIdx).toBeGreaterThan(-1);
		expect(userIdx).toBeGreaterThan(-1);
		expect(fallbackIdx).toBeGreaterThan(-1);
		// Order within the section: project scope → user scope → fallback
		expect(projectIdx).toBeLessThan(userIdx);
		expect(userIdx).toBeLessThan(fallbackIdx);
	});

	test("preserves 5x invoke as last-resort fallback", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x invoke");
		// Fallback section must be documented
		expect(content).toContain("Fallback");
		// In the detection order section, 5x invoke appears after user scope
		const sectionIdx = content.indexOf("Native agent detection order");
		const section = content.slice(sectionIdx);
		const userIdx = section.indexOf("~/.config/opencode/agents/");
		const invokeIdx = section.indexOf("5x invoke");
		expect(userIdx).toBeLessThan(invokeIdx);
	});

	test("references 5x-code-author native agent name", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x-code-author");
	});

	test("references 5x-reviewer native agent name", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x-reviewer");
	});

	test("references 5x-orchestrator agent name", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x-orchestrator");
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

	test("native subagent recovery section exists", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain(
			"Native subagent returns empty or invalid output",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 4: run watch guidance removal
// ---------------------------------------------------------------------------

describe("Phase 4: run watch guidance removed from native-first skills", () => {
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

	test("5x invoke fallback is preserved in all skills", () => {
		// 5x invoke should still be documented as fallback
		expect(getDefaultSkillRaw("5x-plan")).toContain("5x invoke");
		expect(getDefaultSkillRaw("5x-plan-review")).toContain("5x invoke");
		expect(getDefaultSkillRaw("5x-phase-execution")).toContain("5x invoke");
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

describe("task templates — transport-neutral language (Phase 4)", () => {
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
