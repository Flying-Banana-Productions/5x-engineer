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
import { resolveLayeredConfig } from "../src/config.js";

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
			expect(result.config.paths.plans).toBe("sub-plans");
			// reviews should come from root (not overridden by sub-project)
			expect(result.config.paths.reviews).toBe("root-reviews");
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
			// Zod defaults fill gaps
			expect(result.config.paths.plans).toBe("docs/development");
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
			expect(result.config.paths.plans).toBe("docs/development");
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
			// Sub overrides only the plan template
			expect(result.config.paths.templates.plan).toBe("sub-plan-template");
			// Review template inherits from root
			expect(result.config.paths.templates.review).toBe("root-review-template");
			// Top-level paths fields unchanged from root
			expect(result.config.paths.plans).toBe("root-plans");
			expect(result.config.paths.reviews).toBe("root-reviews");
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
});
