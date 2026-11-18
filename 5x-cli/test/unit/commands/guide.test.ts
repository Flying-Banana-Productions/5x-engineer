/**
 * Unit tests for the guide handler — direct calls, filesystem assertions only.
 *
 * A guide is the standalone form of a task prompt. These tests pin the
 * contract: the project's planning rules survive, the delegated-workflow
 * ending does not, and building a guide has no side effects.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPlanGuide,
	DELEGATED_ONLY_SECTIONS,
	PLAN_GUIDE_TEMPLATE,
	PLAN_PATH_PLACEHOLDER,
	SOURCE_PLACEHOLDER,
	stripSections,
} from "../../../src/commands/guide.handler.js";
import { CliError } from "../../../src/output.js";
import { realpathExisting } from "../../../src/paths.js";
import { getDefaultTemplateRaw } from "../../../src/templates/loader.js";

const SKELETON = ".5x/templates/implementation-plan-template.md";
const PROMPT_OVERRIDE = `.5x/templates/prompts/${PLAN_GUIDE_TEMPLATE}.md`;

interface ProjectOptions {
	/** Write the configured plan skeleton. Default true. */
	skeleton?: boolean;
	/** Extra files, relative to the project root. */
	files?: Record<string, string>;
}

/** A project outside git: the config file anchors the root. */
function makeProject(opts: ProjectOptions = {}): string {
	const dir = join(
		tmpdir(),
		`5x-guide-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const files: Record<string, string> = {
		"5x.toml": '[paths]\nplans = "docs/plans"\n',
		"docs/tdd/limiter.md": "# Rate limiter TDD\n",
		...(opts.skeleton === false ? {} : { [SKELETON]: "# {Plan Title}\n" }),
		...opts.files,
	};
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
	mkdirSync(join(dir, "docs/plans"), { recursive: true });
	return realpathExisting(dir);
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

const quiet = () => {};

async function expectCliError(
	promise: Promise<unknown>,
): Promise<InstanceType<typeof CliError>> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(CliError);
		return err as InstanceType<typeof CliError>;
	}
	throw new Error("expected a CliError");
}

describe("buildPlanGuide", () => {
	test("keeps the planning rules and replaces the delegated ending", async () => {
		const dir = makeProject();
		try {
			const result = await buildPlanGuide({
				source: "docs/tdd/limiter.md",
				out: "docs/plans/031-limiter.plan.md",
				startDir: dir,
				warn: quiet,
			});
			const { prompt } = result;

			// The project's rules, with paths the agent can type from its cwd.
			expect(prompt).toContain("### Plan Requirements");
			expect(prompt).toContain("## Delivery Budget");
			expect(prompt).toContain("Requirements document: docs/tdd/limiter.md");
			expect(prompt).toContain(
				"Target plan output path: docs/plans/031-limiter.plan.md",
			);
			expect(prompt).toContain(`Plan template to follow: ${SKELETON}`);

			// Nothing that only a delegated worker inside a run may do.
			expect(prompt).not.toContain("## Non-Interactive Execution");
			expect(prompt).not.toContain("## Completion");
			expect(prompt).not.toContain("5x commit --run");
			expect(prompt).not.toContain("5x protocol emit author --complete");

			// The standalone ending.
			expect(prompt).toContain("## Standalone Authoring");
			expect(prompt).toContain("stop and ask the operator instead");
			expect(prompt).toContain(
				"5x plan phases docs/plans/031-limiter.plan.md | jq '.data.executability'",
			);
			expect(prompt).toContain("`5x-plan-review` skill");
			expect(prompt).not.toContain("### Output path");
			expect(prompt).not.toContain("### Requirements");
			expect(prompt).not.toContain("## Plan Template");

			expect(result).toMatchObject({
				guide: "plan",
				source_path: join(dir, "docs/tdd/limiter.md"),
				plan_path: join(dir, "docs/plans/031-limiter.plan.md"),
				plans_dir: join(dir, "docs/plans"),
				plan_template_path: join(dir, SKELETON),
				plan_template_inlined: false,
				template_source: "bundled",
			});
		} finally {
			cleanup(dir);
		}
	});

	test("never commits on its own initiative or prescribes git commands", async () => {
		const dir = makeProject();
		try {
			const { prompt } = await buildPlanGuide({
				out: "docs/plans/a.md",
				startDir: dir,
				warn: quiet,
			});
			expect(prompt).toContain(
				"Do not commit, create a branch, or push without the operator's go-ahead.",
			);
			expect(prompt).toContain("Follow this repository's conventions");
			expect(prompt).not.toMatch(/^\s*git (add|commit|push|checkout)\b/m);
		} finally {
			cleanup(dir);
		}
	});

	test("has no side effects", async () => {
		const dir = makeProject();
		try {
			await buildPlanGuide({
				source: "docs/tdd/limiter.md",
				out: "docs/plans/new/a.md",
				startDir: dir,
				warn: quiet,
			});
			expect(existsSync(join(dir, ".5x/5x.db"))).toBe(false);
			expect(existsSync(join(dir, "docs/plans/new"))).toBe(false);
		} finally {
			cleanup(dir);
		}
	});

	test("without a source or plan path, tells the agent how to supply them", async () => {
		const dir = makeProject();
		try {
			const result = await buildPlanGuide({ startDir: dir, warn: quiet });
			const { prompt } = result;

			expect(result.source_path).toBeNull();
			expect(result.plan_path).toBeNull();
			expect(prompt).toContain(`Requirements document: ${SOURCE_PLACEHOLDER}`);
			expect(prompt).toContain("### Requirements");
			expect(prompt).toContain("ask the operator\nbefore writing anything");
			expect(prompt).toContain("### Output path");
			expect(prompt).toContain("Plans for this project live in `docs/plans`.");
			expect(prompt).toContain(`5x plan phases ${PLAN_PATH_PLACEHOLDER} | jq`);
		} finally {
			cleanup(dir);
		}
	});

	test("warns before overwriting an existing plan", async () => {
		const dir = makeProject({ files: { "docs/plans/a.md": "# Old\n" } });
		try {
			const { prompt } = await buildPlanGuide({
				out: "docs/plans/a.md",
				startDir: dir,
				warn: quiet,
			});
			expect(prompt).toContain("A file already exists at `docs/plans/a.md`.");
		} finally {
			cleanup(dir);
		}
	});

	test("inlines the bundled skeleton when none is on disk", async () => {
		const dir = makeProject({ skeleton: false });
		try {
			const result = await buildPlanGuide({
				out: "docs/plans/a.md",
				startDir: dir,
				warn: quiet,
			});
			expect(result.plan_template_inlined).toBe(true);
			expect(result.prompt).not.toContain(`follow: ${SKELETON}`);
			expect(result.prompt).toContain("## Plan Template");
			expect(result.prompt).toContain("<!-- 5x:plan-schema:1 -->");
			// The skeleton is fenced so its headings are not read as guide sections.
			expect(result.prompt).toMatch(
				/\n`{3,}markdown\n<!-- 5x:plan-schema:1 -->/,
			);
		} finally {
			cleanup(dir);
		}
	});

	test("honors a project prompt override, even one without the delegated headings", async () => {
		const override = stripSections(
			getDefaultTemplateRaw(PLAN_GUIDE_TEMPLATE).replace(
				"### Plan Requirements",
				"### Plan Requirements\n\n- HOUSE RULE: every phase names an owner.",
			),
			DELEGATED_ONLY_SECTIONS,
		).text;
		const dir = makeProject({ files: { [PROMPT_OVERRIDE]: override } });
		try {
			const result = await buildPlanGuide({
				out: "docs/plans/a.md",
				startDir: dir,
				warn: quiet,
			});
			expect(result.template_source).toBe("override");
			expect(result.prompt).toContain(
				"HOUSE RULE: every phase names an owner.",
			);
			expect(result.prompt).toContain("## Standalone Authoring");
		} finally {
			cleanup(dir);
		}
	});

	test("rejects a missing requirements document", async () => {
		const dir = makeProject();
		try {
			const err = await expectCliError(
				buildPlanGuide({ source: "nope.md", startDir: dir, warn: quiet }),
			);
			expect(err.code).toBe("SOURCE_NOT_FOUND");
			expect(err.exitCode).toBe(2);
		} finally {
			cleanup(dir);
		}
	});

	test("rejects a plan path outside paths.plans, as run init would", async () => {
		const dir = makeProject();
		try {
			const err = await expectCliError(
				buildPlanGuide({ out: "docs/a.md", startDir: dir, warn: quiet }),
			);
			expect(err.code).toBe("INVALID_ARGS");
			expect(err.message).toContain("must be inside configured paths.plans");
		} finally {
			cleanup(dir);
		}
	});
});

describe("delegated-only sections", () => {
	test("the bundled plan prompt still has the headings the guide removes", () => {
		const { removed } = stripSections(
			getDefaultTemplateRaw(PLAN_GUIDE_TEMPLATE),
			DELEGATED_ONLY_SECTIONS,
		);
		expect(removed).toEqual([...DELEGATED_ONLY_SECTIONS]);
	});
});

describe("stripSections", () => {
	test("removes a section up to the next level-2 heading", () => {
		const { text, removed } = stripSections(
			"# T\n\n## Keep\n\na\n\n## Drop\n\nb\n\n### Sub\n\nc\n\n## Also keep\n\nd\n",
			["Drop"],
		);
		expect(removed).toEqual(["Drop"]);
		expect(text).toBe("# T\n\n## Keep\n\na\n\n## Also keep\n\nd");
	});

	test("ignores headings inside fenced code blocks", () => {
		const md = "## Keep\n\n```md\n## Drop\n```\n\nafter\n\n## Drop\n\ngone\n";
		const { text, removed } = stripSections(md, ["Drop"]);
		expect(removed).toEqual(["Drop"]);
		expect(text).toBe("## Keep\n\n```md\n## Drop\n```\n\nafter");
	});

	test("reports nothing removed when the heading is absent", () => {
		const { text, removed } = stripSections("## Keep\n\na\n", ["Drop"]);
		expect(removed).toEqual([]);
		expect(text).toBe("## Keep\n\na");
	});
});
