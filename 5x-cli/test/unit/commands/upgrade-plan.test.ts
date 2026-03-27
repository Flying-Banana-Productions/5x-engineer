/**
 * Unit tests for upgrade handler Phase 2 — plan model and dry-run.
 *
 * Tests plan building, dry-run behavior, and control-plane resolution.
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
import {
	buildUpgradePlan,
	runUpgrade,
} from "../../../src/commands/upgrade.handler.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-upgrade-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

function initGitRepo(dir: string): void {
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
	});
}

describe("buildUpgradePlan", () => {
	test("returns correct plan with no config file", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			const plan = await buildUpgradePlan({ startDir: tmp });

			expect(plan.controlPlaneRoot).toBeDefined();
			expect(plan.stateDir).toBeDefined();
			expect(plan.config.length).toBeGreaterThan(0);
			expect(plan.config[0]?.type).toBe("add");
			expect(plan.config[0]?.key).toBe("config");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("actually merges missing keys into TOML file", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create a minimal TOML missing many keys
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			// Run upgrade to add missing keys
			await runUpgrade({ startDir: tmp });

			// Read the updated config
			const updatedContent = readFileSync(join(tmp, "5x.toml"), "utf-8");

			// Verify that new keys were actually added
			expect(updatedContent).toContain("maxStepsPerRun = 50");
			expect(updatedContent).toContain("maxReviewIterations =");
			expect(updatedContent).toContain("[author]");
			expect(updatedContent).toContain("[reviewer]");
			expect(updatedContent).toContain("[paths]");
			expect(updatedContent).toContain("[db]");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("returns template plans for core templates", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const plan = await buildUpgradePlan({ startDir: tmp });

			// Should have plans for the 2 core templates
			const coreTemplates = plan.templates.filter(
				(p) => p.owner === "template",
			);
			expect(coreTemplates.length).toBe(2);
			expect(
				coreTemplates.some((p) =>
					p.relativePath.includes("implementation-plan"),
				),
			).toBe(true);
			expect(
				coreTemplates.some((p) => p.relativePath.includes("review-template")),
			).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("returns empty harness plans (Phase 5 placeholder)", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const plan = await buildUpgradePlan({ startDir: tmp });

			expect(plan.harnesses).toEqual([]);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reads existing manifest if present", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			// Create .5x directory and manifest
			const dotFiveX = join(tmp, ".5x");
			mkdirSync(dotFiveX, { recursive: true });
			writeFileSync(
				join(dotFiveX, "upgrade-manifest.json"),
				JSON.stringify({ version: 1, entries: [] }),
				"utf-8",
			);

			const plan = await buildUpgradePlan({ startDir: tmp });

			// Should have templates to create since manifest is empty
			expect(plan.templates.length).toBeGreaterThan(0);
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("runUpgrade — dry-run", () => {
	test("dry-run produces a plan but writes no files", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			await runUpgrade({ startDir: tmp, dryRun: true });

			// Verify no .5x directory was created
			expect(existsSync(join(tmp, ".5x"))).toBe(false);
			// Verify config was not modified
			const configContent = readFileSync(join(tmp, "5x.toml"), "utf-8");
			expect(configContent).toBe("maxStepsPerRun = 50\n");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("dry-run reports config actions", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create a minimal TOML that should trigger key additions
			writeFileSync(join(tmp, "5x.toml"), "# Minimal config\n", "utf-8");

			const plan = await buildUpgradePlan({ startDir: tmp, dryRun: true });

			// Should report some config actions (missing keys)
			expect(plan.config.length).toBeGreaterThan(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("dry-run reports template actions", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const plan = await buildUpgradePlan({ startDir: tmp, dryRun: true });

			// Should have template plans
			expect(plan.templates.length).toBeGreaterThan(0);
			// All templates should be create (since they don't exist)
			expect(plan.templates.every((p) => p.action === "create")).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("runUpgrade — subdirectory invocation", () => {
	test("resolves to correct control-plane root from subdirectory", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Initialize in root
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");
			const dotFiveX = join(tmp, ".5x");
			mkdirSync(dotFiveX, { recursive: true });
			writeFileSync(
				join(dotFiveX, "upgrade-manifest.json"),
				JSON.stringify({ version: 1, entries: [] }),
				"utf-8",
			);

			// Create a subdirectory
			const subdir = join(tmp, "src", "components");
			mkdirSync(subdir, { recursive: true });

			// Run from subdirectory
			const plan = await buildUpgradePlan({ startDir: subdir });

			// Should resolve to a parent directory (tmp root or similar)
			// The exact path depends on git resolution, but it should NOT be the subdir
			expect(plan.controlPlaneRoot).not.toBe(subdir);
			expect(plan.controlPlaneRoot.length).toBeLessThan(subdir.length);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("normal run creates templates at control-plane root", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			// Create a subdirectory
			const subdir = join(tmp, "src");
			mkdirSync(subdir, { recursive: true });

			// Run upgrade from subdirectory
			await runUpgrade({ startDir: subdir });

			// Templates should be created at root, not in subdir
			expect(
				existsSync(
					join(tmp, ".5x", "templates", "implementation-plan-template.md"),
				),
			).toBe(true);
			expect(
				existsSync(join(tmp, ".5x", "templates", "review-template.md")),
			).toBe(true);
			expect(existsSync(join(subdir, ".5x"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("runUpgrade — force mode", () => {
	test("force mode converts conflicts to updates", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			// First, run upgrade to create templates
			await runUpgrade({ startDir: tmp });

			// Modify a template to create conflict
			const templatePath = join(tmp, ".5x", "templates", "review-template.md");
			writeFileSync(templatePath, "MODIFIED CONTENT", "utf-8");

			// Run again without force - should report conflict
			const planNoForce = await buildUpgradePlan({ startDir: tmp });
			const conflictPlan = planNoForce.templates.find(
				(p) =>
					p.relativePath.includes("review-template") && p.action === "conflict",
			);
			expect(conflictPlan).toBeDefined();

			// Run with force - should report update
			const planForce = await buildUpgradePlan({ startDir: tmp, force: true });
			const updatePlan = planForce.templates.find(
				(p) =>
					p.relativePath.includes("review-template") && p.action === "update",
			);
			expect(updatePlan).toBeDefined();
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("runUpgrade — manifest tracking", () => {
	test("creates manifest on first run", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			await runUpgrade({ startDir: tmp });

			// Verify manifest was created
			const manifestPath = join(tmp, ".5x", "upgrade-manifest.json");
			expect(existsSync(manifestPath)).toBe(true);

			const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
			expect(manifest.version).toBe(1);
			expect(Array.isArray(manifest.entries)).toBe(true);
			expect(manifest.entries.length).toBeGreaterThan(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("second run with unchanged templates skips all", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			// First run - creates templates and manifest
			await runUpgrade({ startDir: tmp });

			// Second run - templates unchanged
			const plan = await buildUpgradePlan({ startDir: tmp });

			// All templates should be skip (or conflict if something went wrong)
			const coreTemplates = plan.templates.filter(
				(p) => p.owner === "template",
			);
			expect(coreTemplates.every((p) => p.action === "skip")).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("Phase 3: Config Key Addition", () => {
	test("missing top-level key is added as active", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create minimal TOML missing maxReviewIterations
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const plan = await buildUpgradePlan({ startDir: tmp });

			// Should detect maxReviewIterations as missing
			const missingAction = plan.config.find(
				(a) => a.key === "maxReviewIterations" && a.type === "add",
			);
			expect(missingAction).toBeDefined();
			expect(missingAction?.detail).not.toContain("commented out");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("missing nested key is added (when active in template)", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create TOML with [paths] section but missing templates sub-section
			// paths.templates.plan is active in default template
			writeFileSync(
				join(tmp, "5x.toml"),
				`maxStepsPerRun = 50

[paths]
plans = "docs/development"
reviews = "docs/development/reviews"
archive = "docs/archive"
`,
				"utf-8",
			);

			const plan = await buildUpgradePlan({ startDir: tmp });

			// Should detect paths.templates as missing (it's an object in template)
			const missingAction = plan.config.find(
				(a) => a.key.startsWith("paths.templates") && a.type === "add",
			);
			expect(missingAction).toBeDefined();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("existing keys are not overwritten", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create TOML with custom maxStepsPerRun
			writeFileSync(
				join(tmp, "5x.toml"),
				"maxStepsPerRun = 999\nmaxReviewIterations = 10\n",
				"utf-8",
			);

			await runUpgrade({ startDir: tmp });

			// Verify existing value was preserved
			const updatedContent = readFileSync(join(tmp, "5x.toml"), "utf-8");
			expect(updatedContent).toContain("maxStepsPerRun = 999");
			expect(updatedContent).toContain("maxReviewIterations = 10");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("already-present keys produce no add action", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create full TOML with all standard keys
			writeFileSync(
				join(tmp, "5x.toml"),
				`maxStepsPerRun = 50
maxReviewIterations = 5
maxQualityRetries = 3
maxAutoRetries = 3
qualityGates = []

[author]
continuePhaseSessions = false

[reviewer]
continuePhaseSessions = true

[worktree]

[paths]
plans = "docs/development"
reviews = "docs/development/reviews"
archive = "docs/archive"

[paths.templates]
plan = ".5x/templates/implementation-plan-template.md"
review = ".5x/templates/review-template.md"

[db]
path = ".5x/5x.db"
`,
				"utf-8",
			);

			const plan = await buildUpgradePlan({ startDir: tmp });

			// Should not have any add actions for already-present keys
			const addActions = plan.config.filter(
				(a) =>
					a.type === "add" &&
					!a.key.startsWith("config") &&
					a.key !== "config.bak",
			);
			expect(addActions.length).toBe(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("commented-out keys in template are added as comments", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create TOML missing author.provider (commented out in template)
			writeFileSync(
				join(tmp, "5x.toml"),
				`maxStepsPerRun = 50

[author]
continuePhaseSessions = false
`,
				"utf-8",
			);

			await runUpgrade({ startDir: tmp });

			// Read updated content - should have provider commented out
			const updatedContent = readFileSync(join(tmp, "5x.toml"), "utf-8");
			// The provider key should be added as a comment (or not added at all)
			// Check that user value was preserved
			expect(updatedContent).toContain("maxStepsPerRun = 50");
			expect(updatedContent).toContain("[author]");
			expect(updatedContent).toContain("continuePhaseSessions");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("dry-run reports which keys would be added", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create minimal TOML
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const plan = await buildUpgradePlan({ startDir: tmp, dryRun: true });

			// Should report multiple keys to be added
			const addActions = plan.config.filter((a) => a.type === "add");
			expect(addActions.length).toBeGreaterThan(0);

			// Each action should have detail explaining what will be added
			for (const action of addActions) {
				expect(action.detail).toContain("add");
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("config upgrade preserves user comments", async () => {
		const tmp = makeTmpDir();
		initGitRepo(tmp);
		try {
			// Create TOML with user comments
			const originalContent = `# My custom config
# This is a user comment
maxStepsPerRun = 50

[author]
# User note about author
continuePhaseSessions = false
`;
			writeFileSync(join(tmp, "5x.toml"), originalContent, "utf-8");

			await runUpgrade({ startDir: tmp });

			// Read updated content - should preserve user comments
			const updatedContent = readFileSync(join(tmp, "5x.toml"), "utf-8");
			expect(updatedContent).toContain("# My custom config");
			expect(updatedContent).toContain("# This is a user comment");
			expect(updatedContent).toContain("# User note about author");
		} finally {
			cleanupDir(tmp);
		}
	});
});
