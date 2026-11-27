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
import { createRenderContext } from "../../../src/skills/renderer.js";
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
		expect(names).toContain("5x-issue-resolution");
		expect(names.length).toBe(8);
	});

	test("listSkills returns metadata with description and content", () => {
		const skills = listSkills();
		expect(skills.length).toBe(8);

		const planSkill = skills.find((s) => s.name === "5x-plan");
		expect(planSkill).toBeDefined();
		expect(planSkill?.description).toContain("implementation plan");
		expect(planSkill?.content).toContain("---");
		expect(planSkill?.content).toContain("name: 5x-plan");
		expect(planSkill?.content).toContain("## Workflow");
	});

	test("renders OpenCode-native continuation parameter names", () => {
		const combined = listSkills()
			.map((skill) => skill.content)
			.join("\n\n");

		expect(combined).toContain("sessionID=");
		expect(combined).not.toContain("task_id");
		expect(combined).not.toContain("resume=");
	});

	test("does not leak unresolved harness token placeholders", () => {
		for (const skill of listSkills()) {
			expect(skill.content).not.toContain("[[");
		}
	});

	test("names the 2.x subagent tool and agent parameter", () => {
		const combined = listSkills()
			.map((skill) => skill.content)
			.join("\n\n");

		expect(combined).toContain("`subagent` tool");
		expect(combined).toContain('agent="5x-reviewer"');
		expect(combined).not.toContain("Task tool");
		expect(combined).not.toContain("subagent_type");
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
			"5x-plan-migration",
			"5x-issue-resolution",
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

	test("documents subagent tool delegation pattern", () => {
		const content = getDefaultSkillRaw("5x");
		expect(content).toContain("`subagent` tool's `agent` parameter");
		expect(content).toContain("LAUNCH=<`subagent` tool: agent=<agent>");
		expect(content).toContain("Wait for that child's");
		expect(content).not.toContain("subagent_type");
		expect(content).not.toContain("Task tool");
	});
});

// ---------------------------------------------------------------------------
// Native-first delegation: 5x-plan skill
// ---------------------------------------------------------------------------

describe("5x-plan skill — subagent tool delegation", () => {
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

	test("delegates via subagent tool, not 5x invoke", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("`subagent` tool");
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

	test("requires complete Delivery Budget evidence in generated plans", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("## Delivery Budget");
		expect(content).toContain("stable");
		expect(content).toContain("minimal-compliant effort/architecture deltas");
		expect(content).toContain("before/after");
	});
});

// ---------------------------------------------------------------------------
// Native-first delegation: 5x-plan-review skill
// ---------------------------------------------------------------------------

describe("5x-plan-review skill — subagent tool delegation", () => {
	test("references 5x template render command", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x template render");
	});

	test("references 5x protocol validate command", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("5x protocol validate");
	});

	test("delegates via subagent tool, not 5x invoke", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("`subagent` tool");
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

	test("documents advisory budget preflight and review lifecycle", () => {
		const content = getDefaultSkillRaw("5x-plan-review");
		expect(content).toContain("BUDGET_SECTION_MISSING");
		expect(content).toContain("BUDGET_DEBT_CLAIM_EVIDENCE_MISSING");
		expect(content).toContain("baselineAssessment");
		expect(content).toContain("new or changed");
		expect(content).toContain("--opt-in-budget-baseline");
		expect(content).toContain(
			"Ignore `result.budget.requiresHuman` for routing",
		);
		expect(content).toContain("Reviewers never emit");
	});

	test("renders the opt-in command for the reviewer delegation mode", () => {
		const native = getDefaultSkillRaw(
			"5x-plan-review",
			createRenderContext(true),
		);
		const invoke = getDefaultSkillRaw(
			"5x-plan-review",
			createRenderContext(false),
		);
		const nativeOptIn =
			"5x protocol validate reviewer --opt-in-budget-baseline";
		const invokeOptIn =
			"5x invoke reviewer reviewer-plan --opt-in-budget-baseline";

		expect(native).toContain(nativeOptIn);
		expect(native).not.toContain(invokeOptIn);
		expect(invoke).toContain(invokeOptIn);
		expect(invoke).not.toContain(nativeOptIn);
	});
});

// ---------------------------------------------------------------------------
// Native-first delegation: 5x-phase-execution skill
// ---------------------------------------------------------------------------

describe("5x-phase-execution skill — subagent tool delegation", () => {
	test("references 5x template render command", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x template render");
	});

	test("references 5x protocol validate command", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x protocol validate");
	});

	test("delegates via subagent tool, not 5x invoke", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("`subagent` tool");
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
// Ambient run identity + phase finish idiom (area 204)
// ---------------------------------------------------------------------------

describe("ambient run identity and phase finish idiom", () => {
	test("combined skills contain FIVEX_RUN and phase finish", () => {
		const combined = listSkills()
			.map((skill) => skill.content)
			.join("\n\n");
		expect(combined).toContain("FIVEX_RUN");
		expect(combined).toContain("phase finish");
	});

	test("5x-phase-execution keeps granular quality and protocol fallbacks", () => {
		const content = getDefaultSkillRaw("5x-phase-execution");
		expect(content).toContain("5x protocol validate");
		expect(content).toContain("5x quality run");
		expect(content).toContain("5x phase finish");
		expect(content).toContain("export FIVEX_RUN");
	});

	test("windows skill exports FIVEX_RUN", () => {
		const content = getDefaultSkillRaw("5x-windows");
		expect(content).toContain("FIVEX_RUN");
		expect(content).toContain("phase finish");
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

	test("subagent tool delegation is referenced in all process skills", () => {
		expect(getDefaultSkillRaw("5x-plan")).toContain("`subagent` tool");
		expect(getDefaultSkillRaw("5x-plan-review")).toContain("`subagent` tool");
		expect(getDefaultSkillRaw("5x-phase-execution")).toContain(
			"`subagent` tool",
		);
	});

	test("no process skill references 5x invoke", () => {
		// Foundation skill documents delegation mode precedence (may mention invoke).
		expect(getDefaultSkillRaw("5x")).not.toContain(
			"5x invoke <author|reviewer>",
		);
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

// ---------------------------------------------------------------------------
// OpenCode 2.x background delegation lifecycle, in all four delegation modes
// ---------------------------------------------------------------------------

const DELEGATION_MODES = [
	{ label: "all-native", author: true, reviewer: true },
	{ label: "all-invoke", author: false, reviewer: false },
	{ label: "author-invoke/reviewer-native", author: false, reviewer: true },
	{ label: "author-native/reviewer-invoke", author: true, reviewer: false },
] as const;

const COMPLETION_RESULT =
	"RESULT=<final JSON object from $CHILD_SESSION_ID's completion report>";
/** A line that pipes a result into the recording/validation consumer. */
const CONSUMER = /\|\s*5x (protocol validate|phase finish)\b/;
const VALIDATE_AUTHOR = /echo "\$RESULT" \| 5x protocol validate author\b/;
const VALIDATE_REVIEWER = /echo "\$RESULT" \| 5x protocol validate reviewer\b/;
const PHASE_FINISH = /^echo "\$RESULT" \| 5x phase finish --phase \$PHASE\b/;

/**
 * Every planned native launch site (Phase 4.2), the step it lives in, and the
 * step that holds its own validation/recording consumer. `role` selects the
 * delegation modes in which the site renders; `any` renders whenever at least
 * one role is native. `loopBack` is wording the launch step must contain when
 * its consumer is an earlier step it loops back to.
 */
interface ExpectedSite {
	skill: string;
	step: string;
	agent: string;
	role: "author" | "reviewer" | "any";
	consumerStep: string;
	consumer: RegExp;
	loopBack?: string;
}

const PE_STEP2 =
	"#### Step 2: Quality, protocol, and checklist (`phase finish`)";

const EXPECTED_SITES: ExpectedSite[] = [
	{
		skill: "5x",
		step: "### Native delegation (`subagent` tool)",
		agent: "<agent>",
		role: "any",
		consumerStep: "### Native delegation (`subagent` tool)",
		consumer: /echo "\$RESULT" \| 5x protocol validate <role>/,
	},
	{
		skill: "5x-plan",
		step: "### Step 2: Generate the plan",
		agent: "5x-plan-author",
		role: "author",
		consumerStep: "### Step 2: Generate the plan",
		consumer: VALIDATE_AUTHOR,
	},
	{
		skill: "5x-plan-review",
		step: "### Delegating sub-agent work (native reviewer)",
		agent: "5x-reviewer",
		role: "reviewer",
		consumerStep: "### Delegating sub-agent work (native reviewer)",
		consumer: VALIDATE_REVIEWER,
	},
	{
		skill: "5x-plan-review",
		step: "### Step 1: Review",
		agent: "5x-reviewer",
		role: "reviewer",
		consumerStep: "### Step 1: Review",
		consumer: VALIDATE_REVIEWER,
	},
	{
		skill: "5x-plan-review",
		step: "### Step 3: Author revision or final corrections",
		agent: "5x-plan-author",
		role: "author",
		consumerStep: "### Step 3: Author revision or final corrections",
		consumer: VALIDATE_AUTHOR,
	},
	{
		skill: "5x-phase-execution",
		step: "#### Step 1: Author implements",
		agent: "5x-code-author",
		role: "author",
		consumerStep: PE_STEP2,
		consumer: PHASE_FINISH,
	},
	{
		skill: "5x-phase-execution",
		step: "##### Step 2a: Quality retry",
		agent: "5x-code-author",
		role: "author",
		consumerStep: "##### Step 2a: Quality retry",
		consumer: PHASE_FINISH,
	},
	{
		skill: "5x-phase-execution",
		step: "#### Step 3: Code review",
		agent: "5x-reviewer",
		role: "reviewer",
		consumerStep: "#### Step 3: Code review",
		consumer: VALIDATE_REVIEWER,
	},
	{
		skill: "5x-phase-execution",
		step: "#### Step 5: Author fixes review items",
		agent: "5x-code-author",
		role: "author",
		consumerStep: PE_STEP2,
		consumer: PHASE_FINISH,
		loopBack: "loop back to Step 2",
	},
	{
		skill: "5x-issue-resolution",
		step: "### Step 1: Planning run and intake",
		agent: "5x-plan-author",
		role: "author",
		consumerStep: "### Step 1: Planning run and intake",
		consumer: VALIDATE_AUTHOR,
	},
];

function expectedSitesFor(mode: {
	author: boolean;
	reviewer: boolean;
}): ExpectedSite[] {
	return EXPECTED_SITES.filter((s) =>
		s.role === "any"
			? mode.author || mode.reviewer
			: s.role === "author"
				? mode.author
				: mode.reviewer,
	);
}

interface LaunchSite {
	skill: string;
	line: number;
	agent: string;
}

function launchSites(skill: string, lines: string[]): LaunchSite[] {
	const sites: LaunchSite[] = [];
	lines.forEach((text, line) => {
		const m = text.match(/^LAUNCH=<`subagent` tool: agent=("([^"]+)"|<agent>)/);
		if (m) sites.push({ skill, line, agent: m[2] ?? "<agent>" });
	});
	return sites;
}

/** Markdown heading lines (outside fenced code), with their line index. */
function headings(lines: string[]): { line: number; text: string }[] {
	const out: { line: number; text: string }[] = [];
	let fenced = false;
	lines.forEach((text, line) => {
		if (text.startsWith("```")) fenced = !fenced;
		else if (!fenced && /^#{2,6} \S/.test(text)) out.push({ line, text });
	});
	return out;
}

/** The step a line belongs to: the nearest preceding heading. */
function stepOf(lines: string[], line: number): string {
	const hs = headings(lines).filter((h) => h.line <= line);
	return hs[hs.length - 1]?.text ?? "";
}

/** [start, end) of the step whose heading is exactly `heading`. */
function stepRange(lines: string[], heading: string): [number, number] {
	const hs = headings(lines);
	const idx = hs.findIndex((h) => h.text === heading);
	expect(idx).toBeGreaterThanOrEqual(0);
	return [hs[idx]?.line ?? -1, hs[idx + 1]?.line ?? lines.length];
}

describe("OpenCode background delegation lifecycle (four modes)", () => {
	for (const mode of DELEGATION_MODES) {
		describe(mode.label, () => {
			const skills = listSkills(
				createRenderContext(false, mode.author, mode.reviewer),
			);

			test("renders no unresolved tokens", () => {
				for (const skill of skills) {
					expect(skill.content).not.toContain("[[");
				}
			});

			test("native launch sites are exactly the planned sites for the configured roles", () => {
				const actual = skills.flatMap((skill) => {
					const lines = skill.content.split("\n");
					return launchSites(skill.name, lines).map((site) => ({
						skill: site.skill,
						step: stepOf(lines, site.line),
						agent: site.agent,
					}));
				});
				const expected = expectedSitesFor(mode).map((s) => ({
					skill: s.skill,
					step: s.step,
					agent: s.agent,
				}));
				const key = (s: { skill: string; step: string; agent: string }) =>
					`${s.skill} | ${s.step} | ${s.agent}`;
				expect(actual.map(key).sort()).toEqual(expected.map(key).sort());
			});

			test("each launch's child id and completed RESULT feed that step's own $RESULT consumer", () => {
				for (const exp of expectedSitesFor(mode)) {
					const skill = skills.find((s) => s.name === exp.skill);
					const lines = (skill?.content ?? "").split("\n");
					const [stepStart, stepEnd] = stepRange(lines, exp.step);
					const sites = launchSites(exp.skill, lines).filter(
						(s) =>
							s.agent === exp.agent && s.line > stepStart && s.line < stepEnd,
					);
					expect(sites).toHaveLength(1);
					const site = sites[0] as LaunchSite;

					// LAUNCH may span a continuation line before the child id.
					let i = site.line + 1;
					if (lines[i]?.trim().startsWith("sessionID=")) i++;
					expect(lines[i]).toBe("CHILD_SESSION_ID=<sessionID from LAUNCH>");
					const resultIdx = lines.indexOf(COMPLETION_RESULT, i);
					expect(resultIdx).toBeGreaterThan(i);
					expect(resultIdx).toBeLessThan(stepEnd);
					// Only comments sit between the child id and RESULT.
					for (const between of lines.slice(i + 1, resultIdx)) {
						expect(between.startsWith("#")).toBe(true);
					}

					// The consumer lives in this site's own consumer step: after RESULT
					// when it is the same step or a later one, never borrowed from
					// another step's validation.
					const [cStart, cEnd] = stepRange(lines, exp.consumerStep);
					const searchFrom = cStart === stepStart ? resultIdx + 1 : cStart;
					const consumerIdx = lines.findIndex(
						(l, idx) => idx >= searchFrom && idx < cEnd && CONSUMER.test(l),
					);
					expect(consumerIdx).toBeGreaterThan(-1);
					const consumerLine = lines[consumerIdx] ?? "";
					expect(consumerLine).toMatch(exp.consumer);
					expect(consumerLine).toContain('"$RESULT"');
					expect(consumerLine).not.toContain("$LAUNCH");

					if (cStart < stepStart) {
						// Loop-back consumer: the launch step routes to it explicitly.
						expect(exp.loopBack).toBeDefined();
						expect(lines.slice(resultIdx, stepEnd).join("\n")).toContain(
							exp.loopBack as string,
						);
					} else {
						// No other launch starts before this result is consumed.
						const nextLaunch = lines.findIndex(
							(l, idx) => idx > site.line && l.startsWith("LAUNCH=<"),
						);
						if (nextLaunch >= 0) {
							expect(nextLaunch).toBeGreaterThan(consumerIdx);
						}
					}
				}
			});

			test("no consumer validates the launch acknowledgment", () => {
				for (const skill of skills) {
					for (const l of skill.content
						.split("\n")
						.filter((x) => CONSUMER.test(x))) {
						expect(l).not.toContain("$LAUNCH");
					}
					expect(skill.content).not.toMatch(/\$LAUNCH\b/);
				}
			});
			test("invoke-only renders contain no native tool or lifecycle lines", () => {
				if (mode.author || mode.reviewer) return;
				const combined = skills.map((s) => s.content).join("\n\n");
				expect(combined).not.toContain("`subagent` tool");
				expect(combined).not.toContain("LAUNCH=");
				expect(combined).not.toContain("CHILD_SESSION_ID");
			});

			test("reviewer continuation passes sessionID from the saved child id", () => {
				if (!mode.reviewer) return;
				const planReview = skills.find((s) => s.name === "5x-plan-review");
				const phase = skills.find((s) => s.name === "5x-phase-execution");
				for (const skill of [planReview, phase]) {
					const lines = (skill?.content ?? "").split("\n");
					const sites = launchSites(skill?.name ?? "", lines).filter(
						(s) => s.agent === "5x-reviewer",
					);
					expect(sites.length).toBeGreaterThan(0);
					for (const site of sites) {
						expect(lines[site.line + 1]?.trim()).toBe(
							"sessionID=$NATIVE_SUBTASK_ID (omit if empty)>",
						);
					}
				}
				expect(planReview?.content).toContain(
					"NATIVE_SUBTASK_ID=$CHILD_SESSION_ID",
				);
				expect(planReview?.content).toContain(
					"Capture `$NATIVE_SUBTASK_ID` from `$CHILD_SESSION_ID`",
				);
				expect(phase?.content).toContain(
					"set `$NATIVE_SUBTASK_ID` from `$CHILD_SESSION_ID`",
				);
				expect(planReview?.content).not.toContain("agent id from");
			});
		});
	}
});
