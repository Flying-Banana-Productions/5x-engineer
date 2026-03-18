/**
 * Unit tests for `config show` — direct function calls, no stdout capture.
 *
 * Tests pure config-resolution and text-formatting helpers.
 * CLI subprocess tests live in test/integration/commands/config-show.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConfigShowOutput,
	formatConfigText,
} from "../../../src/commands/config.handler.js";
import { resolveLayeredConfig } from "../../../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = "5x-cfg-unit"): string {
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
// Text formatter tests
// ---------------------------------------------------------------------------

describe("formatConfigText", () => {
	test("renders key config values in human-readable format", () => {
		const output: ConfigShowOutput = {
			author: {
				provider: "opencode",
				model: "gpt-4",
				timeout: 120,
				continuePhaseSessions: false,
			},
			reviewer: {
				provider: "opencode",
				continuePhaseSessions: true,
			},
			opencode: {},
			qualityGates: ["bun test"],
			skipQualityGates: false,
			paths: {
				plans: "/project/docs/development",
				reviews: "/project/docs/development/reviews",
				archive: "/project/docs/archive",
				templates: {
					plan: "/project/docs/_plan_template.md",
					review: "/project/docs/_review_template.md",
				},
			},
			db: { path: ".5x/5x.db" },
			worktree: {},
			maxStepsPerRun: 50,
			maxReviewIterations: 5,
			maxQualityRetries: 3,
			maxAutoIterations: 10,
			maxAutoRetries: 3,
		};

		// formatConfigText writes to console.log which is silenced in tests.
		// We verify it doesn't throw and returns void.
		const result = formatConfigText(output);
		expect(result).toBeUndefined();
	});

	test("renders optional fields when present", () => {
		const output: ConfigShowOutput = {
			author: {
				provider: "custom",
				model: "custom-model",
				continuePhaseSessions: false,
			},
			reviewer: {
				provider: "custom",
				model: "reviewer-model",
				timeout: 60,
				continuePhaseSessions: false,
			},
			opencode: { url: "http://localhost:3000" },
			qualityGates: [],
			skipQualityGates: true,
			paths: {
				plans: "/plans",
				reviews: "/reviews",
				planReviews: "/plan-reviews",
				runReviews: "/run-reviews",
				archive: "/archive",
				templates: {
					plan: "/t/plan.md",
					review: "/t/review.md",
				},
			},
			db: { path: ".5x/5x.db" },
			worktree: { postCreate: "npm install" },
			maxStepsPerRun: 25,
			maxReviewIterations: 3,
			maxQualityRetries: 2,
			maxAutoIterations: 5,
			maxAutoRetries: 1,
		};

		// Verify it doesn't throw
		const result = formatConfigText(output);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Config resolution tests
// ---------------------------------------------------------------------------

describe("config resolution via resolveLayeredConfig", () => {
	test("resolves custom values from 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				[
					"maxReviewIterations = 7",
					"maxQualityRetries = 5",
					"",
					"[author]",
					'provider = "custom-provider"',
					'model = "custom-model"',
					"",
					"[paths]",
					'plans = "my-plans"',
				].join("\n"),
			);

			const result = await resolveLayeredConfig(tmp);
			expect(result.config.maxReviewIterations).toBe(7);
			expect(result.config.maxQualityRetries).toBe(5);
			expect(result.config.author.provider).toBe("custom-provider");
			expect(result.config.author.model).toBe("custom-model");
			expect(result.config.paths.plans).toBe(join(tmp, "my-plans"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("layered resolution: sub-project overrides root values", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				[
					"maxReviewIterations = 7",
					"",
					"[author]",
					'provider = "root-provider"',
					'model = "root-model"',
				].join("\n"),
			);

			const subDir = join(tmp, "packages", "api");
			mkdirSync(subDir, { recursive: true });
			writeToml(
				subDir,
				[
					"[author]",
					'model = "sub-model"',
					"",
					"[paths]",
					'plans = "sub-plans"',
				].join("\n"),
			);

			const result = await resolveLayeredConfig(tmp, subDir);
			expect(result.isLayered).toBe(true);
			// Sub-project overrides
			expect(result.config.author.model).toBe("sub-model");
			expect(result.config.paths.plans).toBe(join(subDir, "sub-plans"));
			// Root values preserved
			expect(result.config.author.provider).toBe("root-provider");
			expect(result.config.maxReviewIterations).toBe(7);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("defaults returned when no config file exists", async () => {
		const tmp = makeTmpDir();
		try {
			const result = await resolveLayeredConfig(tmp);
			expect(result.config.author.provider).toBe("opencode");
			expect(result.config.maxReviewIterations).toBe(5);
			expect(result.config.maxQualityRetries).toBe(3);
			expect(result.config.maxStepsPerRun).toBe(50);
			expect(result.rootConfigPath).toBeNull();
			expect(result.isLayered).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
