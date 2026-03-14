/**
 * Unit tests for init handler — direct function calls, filesystem assertions only.
 *
 * Converted from test/integration/commands/init.test.ts (Phase 4).
 * Tests that assert on CLI stdout/stderr/exit codes remain in
 * test/integration/commands/init.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initScaffold } from "../../../src/commands/init.handler.js";
import { getDefaultTemplateRaw } from "../../../src/templates/loader.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-init-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

// ---------------------------------------------------------------------------
// initScaffold — filesystem side-effect tests
// ---------------------------------------------------------------------------

describe("initScaffold", () => {
	test("creates config file, .5x/ directory, and .gitignore in empty project", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ startDir: tmp });

			// Config file exists and is valid TOML
			const configPath = join(tmp, "5x.toml");
			expect(existsSync(configPath)).toBe(true);
			const configContent = readFileSync(configPath, "utf-8");
			expect(configContent).toContain("[author]");
			expect(configContent).toContain("[reviewer]");
			expect(configContent).toContain("# model");
			expect(configContent).toContain("# timeout");
			expect(configContent).toContain("qualityGates");
			expect(configContent).toContain("[worktree]");
			expect(configContent).toContain("# postCreate");
			expect(configContent).toContain("[paths]");
			expect(configContent).toContain(
				'plan = ".5x/templates/implementation-plan-template.md"',
			);
			expect(configContent).toContain(
				'review = ".5x/templates/review-template.md"',
			);
			expect(configContent).toContain("[db]");
			expect(configContent).toContain("maxReviewIterations");

			// .5x/ directory exists
			expect(existsSync(join(tmp, ".5x"))).toBe(true);
			expect(
				existsSync(
					join(tmp, ".5x", "templates", "implementation-plan-template.md"),
				),
			).toBe(true);
			expect(
				existsSync(join(tmp, ".5x", "templates", "review-template.md")),
			).toBe(true);

			// .gitignore contains .5x/
			const gitignorePath = join(tmp, ".gitignore");
			expect(existsSync(gitignorePath)).toBe(true);
			const gitignoreContent = readFileSync(gitignorePath, "utf-8");
			expect(gitignoreContent).toContain(".5x/");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips config if 5x.toml already exists (without --force)", async () => {
		const tmp = makeTmpDir();
		try {
			const configPath = join(tmp, "5x.toml");
			writeFileSync(
				configPath,
				"# existing config\nmaxStepsPerRun = 10\n",
				"utf-8",
			);

			await initScaffold({ startDir: tmp });

			// Original config unchanged
			const content = readFileSync(configPath, "utf-8");
			expect(content).toContain("existing config");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips config if legacy 5x.config.js exists (without --force)", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.config.js"), "export default {};", "utf-8");

			await initScaffold({ startDir: tmp });

			// Legacy config file still exists — not overwritten
			expect(existsSync(join(tmp, "5x.config.js"))).toBe(true);
			// No 5x.toml created (skipped due to legacy)
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites config file with --force", async () => {
		const tmp = makeTmpDir();
		try {
			const configPath = join(tmp, "5x.toml");
			writeFileSync(configPath, "# old config\nmaxStepsPerRun = 1\n", "utf-8");

			await initScaffold({ force: true, startDir: tmp });

			// Config was overwritten with fresh defaults
			const content = readFileSync(configPath, "utf-8");
			expect(content).not.toContain("old config");
			expect(content).toContain("[author]");
		} finally {
			cleanupDir(tmp);
		}
	});

	test(".gitignore append is idempotent", async () => {
		const tmp = makeTmpDir();
		try {
			const gitignorePath = join(tmp, ".gitignore");
			writeFileSync(gitignorePath, "node_modules/\n.5x/\n", "utf-8");

			await initScaffold({ startDir: tmp });

			// .gitignore unchanged — only one .5x/ entry
			const content = readFileSync(gitignorePath, "utf-8");
			const matches = content.match(/\.5x\//g);
			expect(matches?.length).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("appends .5x/ to existing .gitignore without duplicate", async () => {
		const tmp = makeTmpDir();
		try {
			const gitignorePath = join(tmp, ".gitignore");
			writeFileSync(gitignorePath, "node_modules/\ndist/\n", "utf-8");

			await initScaffold({ startDir: tmp });

			const content = readFileSync(gitignorePath, "utf-8");
			expect(content).toContain("node_modules/");
			expect(content).toContain(".5x/");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("handles .gitignore without trailing newline", async () => {
		const tmp = makeTmpDir();
		try {
			const gitignorePath = join(tmp, ".gitignore");
			writeFileSync(gitignorePath, "node_modules/\ndist/", "utf-8"); // no trailing newline

			await initScaffold({ startDir: tmp });

			const content = readFileSync(gitignorePath, "utf-8");
			expect(content).toContain("dist/\n.5x/\n");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips .5x/ directory if already exists", async () => {
		const tmp = makeTmpDir();
		try {
			mkdirSync(join(tmp, ".5x"), { recursive: true });

			await initScaffold({ startDir: tmp });

			// .5x/ directory still exists
			expect(existsSync(join(tmp, ".5x"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// ensureGitignore — already unit tests, moved from integration
// ---------------------------------------------------------------------------

describe("ensureGitignore", () => {
	test("creates .gitignore if missing", async () => {
		const { ensureGitignore } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const result = ensureGitignore(tmp);
			expect(result.created).toBe(true);
			expect(result.appended).toBe(false);
			expect(readFileSync(join(tmp, ".gitignore"), "utf-8")).toBe(".5x/\n");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("appends if .gitignore exists without entry", async () => {
		const { ensureGitignore } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, ".gitignore"), "node_modules/\n", "utf-8");
			const result = ensureGitignore(tmp);
			expect(result.created).toBe(false);
			expect(result.appended).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("no-ops if .gitignore already contains .5x/", async () => {
		const { ensureGitignore } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, ".gitignore"), "node_modules/\n.5x/\n", "utf-8");
			const result = ensureGitignore(tmp);
			expect(result.created).toBe(false);
			expect(result.appended).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// generateTomlConfig — already unit test, moved from integration
// ---------------------------------------------------------------------------

describe("generateTomlConfig", () => {
	test("generates valid TOML config with expected sections and keys", async () => {
		const { generateTomlConfig } = await import(
			"../../../src/commands/init.handler.js"
		);
		const content = generateTomlConfig();
		expect(content).toContain("[author]");
		expect(content).toContain("[reviewer]");
		expect(content).toContain("# model");
		expect(content).toContain("# timeout");
		expect(content).toContain("[worktree]");
		expect(content).toContain("# postCreate");
		expect(content).toContain("[paths]");
		expect(content).toContain(
			'plan = ".5x/templates/implementation-plan-template.md"',
		);
		expect(content).toContain('review = ".5x/templates/review-template.md"');
		expect(content).toContain("[db]");
		expect(content).toContain("maxAutoRetries");
		expect(content).toContain("maxStepsPerRun");
		expect(content).toContain("qualityGates");
	});
});

// ---------------------------------------------------------------------------
// ensureTemplateFiles — already unit tests, moved from integration
// ---------------------------------------------------------------------------

describe("ensureTemplateFiles", () => {
	test("creates both default template files", async () => {
		const { ensureTemplateFiles } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const result = ensureTemplateFiles(tmp, false);
			expect(result.created).toContain("implementation-plan-template.md");
			expect(result.created).toContain("review-template.md");
			expect(result.skipped).toHaveLength(0);
			expect(result.overwritten).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("does not overwrite existing templates unless forced", async () => {
		const { ensureTemplateFiles } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		const planPath = join(
			tmp,
			".5x",
			"templates",
			"implementation-plan-template.md",
		);
		try {
			mkdirSync(join(tmp, ".5x", "templates"), { recursive: true });
			writeFileSync(planPath, "CUSTOM", "utf-8");

			const first = ensureTemplateFiles(tmp, false);
			expect(first.skipped).toContain("implementation-plan-template.md");
			expect(readFileSync(planPath, "utf-8")).toBe("CUSTOM");

			const second = ensureTemplateFiles(tmp, true);
			expect(second.overwritten).toContain("implementation-plan-template.md");
			expect(readFileSync(planPath, "utf-8")).not.toBe("CUSTOM");
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// upgradePromptTemplates — smart template upgrade for `5x upgrade`
// ---------------------------------------------------------------------------

describe("upgradePromptTemplates", () => {
	test("creates missing prompt templates", async () => {
		const { upgradePromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const result = upgradePromptTemplates(tmp, false);
			// All templates should be created (none existed)
			expect(result.created.length).toBeGreaterThan(0);
			expect(result.updated).toHaveLength(0);
			expect(result.skipped).toHaveLength(0);
			expect(result.customized).toHaveLength(0);

			// Verify files exist on disk
			for (const name of result.created) {
				expect(existsSync(join(tmp, ".5x", "templates", "prompts", name))).toBe(
					true,
				);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips prompt templates that match the current bundled version", async () => {
		const { upgradePromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			// First run creates all templates
			upgradePromptTemplates(tmp, false);

			// Second run should skip all (already up to date)
			const result = upgradePromptTemplates(tmp, false);
			expect(result.created).toHaveLength(0);
			expect(result.updated).toHaveLength(0);
			expect(result.skipped.length).toBeGreaterThan(0);
			expect(result.customized).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("auto-updates stale stock templates with outdated frontmatter", async () => {
		const { upgradePromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// Simulate a stale scaffolded copy of author-next-phase:
			// same body content but missing variable_defaults in frontmatter
			const bundled = getDefaultTemplateRaw("author-next-phase");
			// Strip variable_defaults lines from frontmatter to simulate old version
			const staleContent = bundled.replace(
				/variable_defaults:\n( {2}[^\n]+\n)*/g,
				"",
			);
			// Verify we actually changed something
			expect(staleContent).not.toBe(bundled);
			expect(staleContent).not.toContain("variable_defaults:");

			writeFileSync(join(promptsDir, "author-next-phase.md"), staleContent);

			const result = upgradePromptTemplates(tmp, false);
			expect(result.updated).toContain("author-next-phase.md");
			expect(result.customized).not.toContain("author-next-phase.md");

			// Verify the file was updated to the current bundled version
			const updatedContent = readFileSync(
				join(promptsDir, "author-next-phase.md"),
				"utf-8",
			);
			expect(updatedContent).toBe(bundled);
			expect(updatedContent).toContain("variable_defaults:");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("warns about customized templates with modified body", async () => {
		const { upgradePromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// Write a customized version with different body content
			const customized = [
				"---",
				"name: author-next-phase",
				"version: 1",
				"variables: [plan_path, phase_number, user_notes]",
				'step_name: "author:implement"',
				"---",
				"",
				"CUSTOM BODY: implement {{plan_path}} phase {{phase_number}} {{user_notes}}",
			].join("\n");
			writeFileSync(join(promptsDir, "author-next-phase.md"), customized);

			const result = upgradePromptTemplates(tmp, false);
			expect(result.customized).toContain("author-next-phase.md");
			expect(result.updated).not.toContain("author-next-phase.md");

			// Verify the file was NOT modified
			const diskContent = readFileSync(
				join(promptsDir, "author-next-phase.md"),
				"utf-8",
			);
			expect(diskContent).toBe(customized);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("force mode overwrites all templates including customized ones", async () => {
		const { upgradePromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// Write a customized version
			writeFileSync(
				join(promptsDir, "author-next-phase.md"),
				"---\nname: author-next-phase\nversion: 1\nvariables: [plan_path, phase_number, user_notes]\n---\nCUSTOM {{plan_path}} {{phase_number}} {{user_notes}}",
			);

			const result = upgradePromptTemplates(tmp, true);
			expect(result.updated).toContain("author-next-phase.md");
			expect(result.customized).toHaveLength(0);

			// Verify it was overwritten with bundled version
			const diskContent = readFileSync(
				join(promptsDir, "author-next-phase.md"),
				"utf-8",
			);
			const bundled = getDefaultTemplateRaw("author-next-phase");
			expect(diskContent).toBe(bundled);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("handles mix of stale, customized, current, and missing templates", async () => {
		const { upgradePromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// author-next-phase: stale (body matches, frontmatter outdated)
			const bundledNextPhase = getDefaultTemplateRaw("author-next-phase");
			const staleNextPhase = bundledNextPhase.replace(
				/variable_defaults:\n( {2}[^\n]+\n)*/g,
				"",
			);
			writeFileSync(join(promptsDir, "author-next-phase.md"), staleNextPhase);

			// author-fix-quality: current (matches bundled exactly)
			const bundledFixQuality = getDefaultTemplateRaw("author-fix-quality");
			writeFileSync(
				join(promptsDir, "author-fix-quality.md"),
				bundledFixQuality,
			);

			// author-generate-plan: customized (different body)
			writeFileSync(
				join(promptsDir, "author-generate-plan.md"),
				"---\nname: author-generate-plan\nversion: 1\nvariables: [prd_path, plan_path, plan_template_path]\n---\nMY CUSTOM PLAN PROMPT {{prd_path}} {{plan_path}} {{plan_template_path}}",
			);

			// Other templates: missing (will be created)

			const result = upgradePromptTemplates(tmp, false);

			expect(result.updated).toContain("author-next-phase.md");
			expect(result.skipped).toContain("author-fix-quality.md");
			expect(result.customized).toContain("author-generate-plan.md");
			expect(result.created.length).toBeGreaterThan(0);
		} finally {
			cleanupDir(tmp);
		}
	});
});
