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
import { resolveLayeredConfig } from "../../../src/config.js";
import { getDefaultTemplateRaw } from "../../../src/templates/loader.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

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

/** Minimal git repo so `resolveControlPlaneRoot` anchors to the repo root. */
function initGitRepo(dir: string): void {
	const env = cleanGitEnv();
	const run = (args: string[]) => {
		const r = Bun.spawnSync(["git", ...args], {
			cwd: dir,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (r.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
		}
	};
	run(["init"]);
	run(["config", "user.email", "test@test.com"]);
	run(["config", "user.name", "Test"]);
	writeFileSync(join(dir, "README.md"), "# test\n");
	run(["add", "."]);
	run(["commit", "-m", "initial"]);
}

// ---------------------------------------------------------------------------
// initScaffold — filesystem side-effect tests
// ---------------------------------------------------------------------------

describe("initScaffold", () => {
	test("creates .5x/ directory and .gitignore without root 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ startDir: tmp });

			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);

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

			// .gitignore contains .5x/ and machine-local config
			const gitignorePath = join(tmp, ".gitignore");
			expect(existsSync(gitignorePath)).toBe(true);
			const gitignoreContent = readFileSync(gitignorePath, "utf-8");
			expect(gitignoreContent).toContain(".5x/");
			expect(gitignoreContent).toContain("5x.toml.local");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("does not delete or overwrite existing 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			const configPath = join(tmp, "5x.toml");
			writeFileSync(
				configPath,
				"# existing config\nmaxStepsPerRun = 10\n",
				"utf-8",
			);

			await initScaffold({ startDir: tmp });

			const content = readFileSync(configPath, "utf-8");
			expect(content).toContain("existing config");
			expect(content).toContain("maxStepsPerRun = 10");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("root init with --force does not create 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ force: true, startDir: tmp });
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("leaves legacy 5x.config.js in place and does not add 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.config.js"), "export default {};", "utf-8");

			await initScaffold({ startDir: tmp });

			expect(existsSync(join(tmp, "5x.config.js"))).toBe(true);
			expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("resolveLayeredConfig after root init uses defaults with no config files", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ startDir: tmp });

			const layered = await resolveLayeredConfig(tmp, tmp);
			expect(layered.rootConfigPath).toBeNull();
			expect(layered.nearestConfigPath).toBeNull();
			expect(layered.localPaths).toHaveLength(0);
			expect(layered.config.author.provider).toBe("opencode");
			expect(layered.config.maxStepsPerRun).toBe(250);
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
			await initScaffold({ startDir: tmp });

			const content = readFileSync(gitignorePath, "utf-8");
			expect(content.match(/\.5x\//g)?.length).toBe(1);
			expect(content.match(/5x\.toml\.local/g)?.length).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("appends ignore entries to existing .gitignore without duplicate", async () => {
		const tmp = makeTmpDir();
		try {
			const gitignorePath = join(tmp, ".gitignore");
			writeFileSync(gitignorePath, "node_modules/\ndist/\n", "utf-8");

			await initScaffold({ startDir: tmp });

			const content = readFileSync(gitignorePath, "utf-8");
			expect(content).toContain("node_modules/");
			expect(content).toContain(".5x/");
			expect(content).toContain("5x.toml.local");
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
			expect(content).toContain("5x.toml.local");
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
// initScaffold — sub-project paths-only config
// ---------------------------------------------------------------------------

describe("initScaffold — sub-project", () => {
	test("errors when root is not initialized", async () => {
		const tmp = makeTmpDir();
		try {
			await expect(
				initScaffold({
					startDir: tmp,
					subProjectPath: "packages/api",
				}),
			).rejects.toThrow(/Root project must be initialized first/);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("creates packages/api/5x.toml with only [paths] after root init", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ startDir: tmp });

			await initScaffold({
				startDir: tmp,
				subProjectPath: "packages/api",
			});

			const subToml = join(tmp, "packages", "api", "5x.toml");
			expect(existsSync(subToml)).toBe(true);
			const text = readFileSync(subToml, "utf-8");
			expect(text).toContain("[paths]");
			expect(text).toContain('plans = "docs/development"');
			expect(text).not.toContain("[author]");
			expect(text).not.toContain("[db]");
			expect(text).not.toContain("[reviewer]");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("creates 5x.toml in cwd when --sub-project-path=. from a subdir", async () => {
		const tmp = makeTmpDir();
		try {
			initGitRepo(tmp);
			await initScaffold({ startDir: tmp });
			const subDir = join(tmp, "packages", "api");
			mkdirSync(subDir, { recursive: true });

			await initScaffold({
				startDir: subDir,
				subProjectPath: ".",
			});

			expect(existsSync(join(subDir, "5x.toml"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips existing sub-project 5x.toml without --force", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ startDir: tmp });
			const subToml = join(tmp, "packages", "api", "5x.toml");
			mkdirSync(join(tmp, "packages", "api"), { recursive: true });
			writeFileSync(subToml, "custom = true\n", "utf-8");

			await initScaffold({
				startDir: tmp,
				subProjectPath: "packages/api",
			});

			expect(readFileSync(subToml, "utf-8")).toContain("custom = true");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites sub-project 5x.toml with --force", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ startDir: tmp });
			const subToml = join(tmp, "packages", "api", "5x.toml");
			mkdirSync(join(tmp, "packages", "api"), { recursive: true });
			writeFileSync(subToml, "custom = true\n", "utf-8");

			await initScaffold({
				startDir: tmp,
				subProjectPath: "packages/api",
				force: true,
			});

			const text = readFileSync(subToml, "utf-8");
			expect(text).toContain("[paths]");
			expect(text).not.toContain("custom");
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
			expect(readFileSync(join(tmp, ".gitignore"), "utf-8")).toBe(
				".5x/\n5x.toml.local\n",
			);
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
			const gi = readFileSync(join(tmp, ".gitignore"), "utf-8");
			expect(gi).toContain(".5x/");
			expect(gi).toContain("5x.toml.local");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("no-ops if .gitignore already contains all entries", async () => {
		const { ensureGitignore } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, ".gitignore"),
				"node_modules/\n.5x/\n5x.toml.local\n",
				"utf-8",
			);
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
// initScaffold — prompt template opt-in behavior
// ---------------------------------------------------------------------------

describe("initScaffold — prompt templates", () => {
	test("does NOT create .5x/templates/prompts/ by default", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ startDir: tmp });

			// Prompt templates directory should not exist
			expect(existsSync(join(tmp, ".5x", "templates", "prompts"))).toBe(false);

			// Artifact templates still exist
			expect(
				existsSync(
					join(tmp, ".5x", "templates", "implementation-plan-template.md"),
				),
			).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("creates prompt templates with --install-templates", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ startDir: tmp, installTemplates: true });

			// Prompt templates directory should exist with templates
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			expect(existsSync(promptsDir)).toBe(true);
			expect(existsSync(join(promptsDir, "author-next-phase.md"))).toBe(true);
			expect(existsSync(join(promptsDir, "reviewer-plan.md"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("--force without --install-templates does NOT create prompt templates", async () => {
		const tmp = makeTmpDir();
		try {
			await initScaffold({ force: true, startDir: tmp });

			// Prompt templates directory should not exist
			expect(existsSync(join(tmp, ".5x", "templates", "prompts"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("--install-templates --force overwrites existing prompt templates", async () => {
		const tmp = makeTmpDir();
		try {
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// Write a customized version
			writeFileSync(
				join(promptsDir, "author-next-phase.md"),
				'---\nname: author-next-phase\nversion: 1\nvariables: [plan_path, phase_number, user_notes]\nstep_name: "author:implement"\n---\nCUSTOM {{plan_path}} {{phase_number}} {{user_notes}}',
			);

			await initScaffold({
				force: true,
				installTemplates: true,
				startDir: tmp,
			});

			// Template was overwritten with bundled version
			const content = readFileSync(
				join(promptsDir, "author-next-phase.md"),
				"utf-8",
			);
			const bundled = getDefaultTemplateRaw("author-next-phase");
			expect(content).toBe(bundled);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// checkInstalledPromptTemplates — upgrade-time template checking
// ---------------------------------------------------------------------------

describe("checkInstalledPromptTemplates", () => {
	test("returns empty when prompts directory does not exist", async () => {
		const { checkInstalledPromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const result = checkInstalledPromptTemplates(tmp);
			expect(result.current).toHaveLength(0);
			expect(result.diverged).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports current templates that match bundled content", async () => {
		const { checkInstalledPromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			const bundled = getDefaultTemplateRaw("author-next-phase");
			writeFileSync(join(promptsDir, "author-next-phase.md"), bundled);

			const result = checkInstalledPromptTemplates(tmp);
			expect(result.current).toContain("author-next-phase.md");
			expect(result.diverged).not.toContain("author-next-phase.md");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports diverged templates that differ from bundled content", async () => {
		const { checkInstalledPromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			writeFileSync(
				join(promptsDir, "author-next-phase.md"),
				'---\nname: author-next-phase\nversion: 1\nvariables: [plan_path, phase_number, user_notes]\nstep_name: "author:implement"\n---\nCUSTOM BODY',
			);

			const result = checkInstalledPromptTemplates(tmp);
			expect(result.diverged).toContain("author-next-phase.md");
			expect(result.current).not.toContain("author-next-phase.md");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips templates that were removed from disk (loader uses bundled fallback)", async () => {
		const { checkInstalledPromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			// Create prompts dir with only one template (others "removed")
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			const bundled = getDefaultTemplateRaw("reviewer-plan");
			writeFileSync(join(promptsDir, "reviewer-plan.md"), bundled);

			const result = checkInstalledPromptTemplates(tmp);
			// Only reviewer-plan should appear (others are missing, not reported)
			expect(result.current).toContain("reviewer-plan.md");
			expect(result.current).not.toContain("author-next-phase.md");
			expect(result.diverged).not.toContain("author-next-phase.md");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("handles mix of current and diverged templates", async () => {
		const { checkInstalledPromptTemplates } = await import(
			"../../../src/commands/init.handler.js"
		);
		const tmp = makeTmpDir();
		try {
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// Current: matches bundled exactly
			const bundledFixQuality = getDefaultTemplateRaw("author-fix-quality");
			writeFileSync(
				join(promptsDir, "author-fix-quality.md"),
				bundledFixQuality,
			);

			// Diverged: different content
			writeFileSync(
				join(promptsDir, "author-generate-plan.md"),
				'---\nname: author-generate-plan\nversion: 1\nvariables: [prd_path, plan_path, plan_template_path]\nstep_name: "author:generate-plan"\n---\nMY CUSTOM PLAN PROMPT',
			);

			const result = checkInstalledPromptTemplates(tmp);
			expect(result.current).toContain("author-fix-quality.md");
			expect(result.diverged).toContain("author-generate-plan.md");
		} finally {
			cleanupDir(tmp);
		}
	});
});
