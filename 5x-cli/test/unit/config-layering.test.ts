/**
 * Tests for plan-path-anchored config layering (Phase 1c).
 *
 * Verifies that `resolveLayeredConfig` correctly merges root and
 * nearest (sub-project) config files with the correct semantics:
 * - Objects: deep field-level merge
 * - Arrays: replace
 * - `db` section: always from root (sub-project override ignored with warning)
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLayeredConfig } from "../../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = "5x-layer"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeToml(dir: string, content: string): void {
	writeFileSync(join(dir, "5x.toml"), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveLayeredConfig", () => {
	test("root config only: existing behavior preserved, isLayered = false", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `maxStepsPerRun = 30\n\n[author]\nmodel = "root-model"\n`);

			const result = await resolveLayeredConfig(tmp);
			expect(result.isLayered).toBe(false);
			expect(result.config.author.model).toBe("root-model");
			expect(result.config.maxStepsPerRun).toBe(30);
			expect(result.rootConfigPath).toBe(join(tmp, "5x.toml"));
			expect(result.nearestConfigPath).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("sub-project config overrides paths.*: correct merge", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				`[paths]\nplans = "root-plans"\nreviews = "root-reviews"\n`,
			);
			const subDir = join(tmp, "sub-project");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `[paths]\nplans = "sub-plans"\n`);

			const result = await resolveLayeredConfig(tmp, subDir);
			expect(result.isLayered).toBe(true);
			// paths.* values are always absolute after config loading
			expect(result.config.paths.plans).toBe(join(subDir, "sub-plans"));
			// reviews should come from root (not overridden by sub-project)
			expect(result.config.paths.reviews).toBe(join(tmp, "root-reviews"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("sub-project config overrides qualityGates: array replace, not append", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `qualityGates = ["bun test", "bun run lint"]\n`);
			const subDir = join(tmp, "sub-project");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `qualityGates = ["pytest"]\n`);

			const result = await resolveLayeredConfig(tmp, subDir);
			expect(result.isLayered).toBe(true);
			// Array replace, NOT ["bun test", "bun run lint", "pytest"]
			expect(result.config.qualityGates).toEqual(["pytest"]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("sub-project sets author.timeout only: inherits author.model from root (deep merge)", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				`[author]\nmodel = "claude-opus"\nprovider = "opencode"\n`,
			);
			const subDir = join(tmp, "sub-project");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `[author]\ntimeout = 300\n`);

			const result = await resolveLayeredConfig(tmp, subDir);
			expect(result.isLayered).toBe(true);
			expect(result.config.author.model).toBe("claude-opus");
			expect(result.config.author.timeout).toBe(300);
			expect(result.config.author.provider).toBe("opencode");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("sub-project sets db.path: ignored with warning, root db.path used", async () => {
		const tmp = makeTmpDir();
		const warnings: string[] = [];
		const warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			writeToml(tmp, `[db]\npath = "root-state"\n`);
			const subDir = join(tmp, "sub-project");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `[db]\npath = "sub-state"\n`);

			const result = await resolveLayeredConfig(tmp, subDir, warn);
			expect(result.isLayered).toBe(true);
			expect(result.config.db.path).toBe("root-state");
			expect(warnings.some((w) => w.includes('"db" section'))).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("no root config, sub-project config only: sub-project provides all settings", async () => {
		const tmp = makeTmpDir();
		try {
			// No root config
			const subDir = join(tmp, "sub-project");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `maxStepsPerRun = 75\n[author]\nmodel = "sub-model"\n`);

			const result = await resolveLayeredConfig(tmp, subDir);
			// When root has no config, nearest is the only source (but still layered)
			expect(result.config.maxStepsPerRun).toBe(75);
			expect(result.config.author.model).toBe("sub-model");
			// Zod defaults fill gaps — resolved to absolute against workspace root
			expect(result.config.paths.plans).toBe(join(tmp, "docs/development"));
			expect(result.rootConfigPath).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("no config at all: Zod defaults returned, isLayered = false", async () => {
		const tmp = makeTmpDir();
		try {
			const result = await resolveLayeredConfig(tmp);
			expect(result.isLayered).toBe(false);
			expect(result.config.author.provider).toBe("opencode");
			// Zod defaults resolved to absolute against workspace root
			expect(result.config.paths.plans).toBe(join(tmp, "docs/development"));
			expect(result.config.qualityGates).toEqual([]);
			expect(result.rootConfigPath).toBeNull();
			expect(result.nearestConfigPath).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("contextDir inside sub-project: walks up and finds nearest 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `[author]\nmodel = "root-model"\n`);
			const subDir = join(tmp, "packages", "my-pkg");
			mkdirSync(subDir, { recursive: true });
			writeToml(join(tmp, "packages"), `[author]\ntimeout = 120\n`);
			// contextDir is deeper, should walk up to packages/5x.toml
			const deepDir = join(subDir, "src", "lib");
			mkdirSync(deepDir, { recursive: true });

			const result = await resolveLayeredConfig(tmp, deepDir);
			expect(result.isLayered).toBe(true);
			// Should have root model + nearest timeout
			expect(result.config.author.model).toBe("root-model");
			expect(result.config.author.timeout).toBe(120);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("contextDir at repo root: finds root 5x.toml only, no layering", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `[author]\nmodel = "root-model"\n`);

			const result = await resolveLayeredConfig(tmp, tmp);
			expect(result.isLayered).toBe(false);
			expect(result.config.author.model).toBe("root-model");
			expect(result.rootConfigPath).toBe(join(tmp, "5x.toml"));
			expect(result.nearestConfigPath).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("deep merge: nested objects merge field-by-field", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				[
					"[paths]",
					'plans = "root-plans"',
					'reviews = "root-reviews"',
					"",
					"[paths.templates]",
					'plan = "root-plan-template"',
					'review = "root-review-template"',
				].join("\n"),
			);
			const subDir = join(tmp, "sub");
			mkdirSync(subDir, { recursive: true });
			writeToml(
				subDir,
				["[paths.templates]", 'plan = "sub-plan-template"'].join("\n"),
			);

			const result = await resolveLayeredConfig(tmp, subDir);
			expect(result.isLayered).toBe(true);
			// Sub overrides only the plan template — resolved against sub-project dir
			expect(result.config.paths.templates.plan).toBe(
				join(subDir, "sub-plan-template"),
			);
			// Review template inherits from root — resolved against root dir
			expect(result.config.paths.templates.review).toBe(
				join(tmp, "root-review-template"),
			);
			// Top-level paths fields unchanged from root — resolved against root dir
			expect(result.config.paths.plans).toBe(join(tmp, "root-plans"));
			expect(result.config.paths.reviews).toBe(join(tmp, "root-reviews"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("no root config, sub-project sets db.path: ignored with warning", async () => {
		const tmp = makeTmpDir();
		const warnings: string[] = [];
		const warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			const subDir = join(tmp, "sub-project");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `[db]\npath = "sub-state"\n`);

			const result = await resolveLayeredConfig(tmp, subDir, warn);
			// db.path should be Zod default, not sub-project value
			expect(result.config.db.path).toBe(".5x/5x.db");
			expect(warnings.some((w) => w.includes('"db" section'))).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("multiple scalar overrides: all take effect", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				[
					"maxStepsPerRun = 50",
					"maxReviewIterations = 5",
					"maxQualityRetries = 3",
				].join("\n"),
			);
			const subDir = join(tmp, "sub");
			mkdirSync(subDir, { recursive: true });
			writeToml(
				subDir,
				["maxStepsPerRun = 25", "maxQualityRetries = 1"].join("\n"),
			);

			const result = await resolveLayeredConfig(tmp, subDir);
			expect(result.isLayered).toBe(true);
			expect(result.config.maxStepsPerRun).toBe(25);
			expect(result.config.maxReviewIterations).toBe(5); // from root
			expect(result.config.maxQualityRetries).toBe(1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("root config with invalid TOML: throws actionable error", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), "not valid { toml ][", "utf-8");

			await expect(resolveLayeredConfig(tmp)).rejects.toThrow(
				/Failed to load.*5x\.toml/,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("nearest config with invalid TOML: throws actionable error", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `[author]\nmodel = "root-model"\n`);
			const subDir = join(tmp, "sub-project");
			mkdirSync(subDir, { recursive: true });
			writeFileSync(join(subDir, "5x.toml"), "not valid { toml ][", "utf-8");

			await expect(resolveLayeredConfig(tmp, subDir)).rejects.toThrow(
				/Failed to load.*5x\.toml/,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("merged config with invalid schema: throws actionable error", async () => {
		const tmp = makeTmpDir();
		try {
			// maxStepsPerRun must be positive integer — string value should fail validation
			writeToml(tmp, `maxStepsPerRun = -1\n`);

			await expect(resolveLayeredConfig(tmp)).rejects.toThrow(/Invalid config/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// Path resolution tests (Phase 1, 019-orchestrator-improvements)
	// -----------------------------------------------------------------------

	test("sub-project relative paths.plans resolves against sub-project dir", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `[paths]\nplans = "root-plans"\n`);
			const subDir = join(tmp, "packages", "foo");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `[paths]\nplans = "docs/development"\n`);

			const result = await resolveLayeredConfig(tmp, subDir);
			// Sub-project relative path resolves against sub-project config dir
			expect(result.config.paths.plans).toBe(join(subDir, "docs/development"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("root relative paths.plans resolves against root dir", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `[paths]\nplans = "docs/plans"\n`);

			const result = await resolveLayeredConfig(tmp);
			expect(result.config.paths.plans).toBe(join(tmp, "docs/plans"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("absolute paths pass through unchanged", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `[paths]\nplans = "/opt/plans"\n`);

			const result = await resolveLayeredConfig(tmp);
			expect(result.config.paths.plans).toBe("/opt/plans");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("nested paths.templates.plan resolves correctly for sub-project", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				`[paths.templates]\nplan = "root-template.md"\nreview = "root-review.md"\n`,
			);
			const subDir = join(tmp, "packages", "bar");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `[paths.templates]\nplan = "templates/plan.md"\n`);

			const result = await resolveLayeredConfig(tmp, subDir);
			expect(result.config.paths.templates.plan).toBe(
				join(subDir, "templates/plan.md"),
			);
			// Review template inherits from root
			expect(result.config.paths.templates.review).toBe(
				join(tmp, "root-review.md"),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("merged config produces all-absolute paths", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				`[paths]\nplans = "root-plans"\nreviews = "root-reviews"\n`,
			);
			const subDir = join(tmp, "sub");
			mkdirSync(subDir, { recursive: true });
			writeToml(subDir, `[paths]\nplans = "sub-plans"\n`);

			const result = await resolveLayeredConfig(tmp, subDir);
			// All paths absolute
			expect(result.config.paths.plans.startsWith("/")).toBe(true);
			expect(result.config.paths.reviews.startsWith("/")).toBe(true);
			expect(result.config.paths.archive.startsWith("/")).toBe(true);
			expect(result.config.paths.templates.plan.startsWith("/")).toBe(true);
			expect(result.config.paths.templates.review.startsWith("/")).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("config with no explicit paths (Zod defaults only) produces absolute paths", async () => {
		const tmp = makeTmpDir();
		try {
			// Config has no paths section — all paths come from Zod defaults
			writeToml(tmp, `maxStepsPerRun = 10\n`);

			const result = await resolveLayeredConfig(tmp);
			// All Zod default paths resolved against workspace root
			expect(result.config.paths.plans).toBe(join(tmp, "docs/development"));
			expect(result.config.paths.reviews).toBe(
				join(tmp, "docs/development/reviews"),
			);
			expect(result.config.paths.archive).toBe(join(tmp, "docs/archive"));
			expect(result.config.paths.templates.plan).toBe(
				join(tmp, "docs/_implementation_plan_template.md"),
			);
			expect(result.config.paths.templates.review).toBe(
				join(tmp, "docs/development/reviews/_review_template.md"),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("non-layered config (single config file) also produces absolute paths", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(tmp, `[paths]\nplans = "my-plans"\n`);

			const result = await resolveLayeredConfig(tmp);
			expect(result.isLayered).toBe(false);
			// Single config paths are absolute
			expect(result.config.paths.plans).toBe(join(tmp, "my-plans"));
			// Zod defaults are also absolute
			expect(result.config.paths.reviews.startsWith("/")).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
