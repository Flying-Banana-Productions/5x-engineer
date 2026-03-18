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
import { formatConfigText } from "../../../src/commands/config.handler.js";
import { type FiveXConfig, resolveLayeredConfig } from "../../../src/config.js";

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

/**
 * Build a minimal FiveXConfig for formatter tests. Allows overrides.
 */
function makeConfig(overrides: Partial<FiveXConfig> = {}): FiveXConfig {
	return {
		author: {
			provider: "opencode",
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
		...overrides,
	} as FiveXConfig;
}

// ---------------------------------------------------------------------------
// Text formatter tests
// ---------------------------------------------------------------------------

describe("formatConfigText", () => {
	test("returns string with expected key-value sections", () => {
		const config = makeConfig({
			author: {
				provider: "test-provider",
				model: "gpt-4",
				timeout: 120,
				continuePhaseSessions: false,
			},
			reviewer: {
				provider: "review-provider",
				continuePhaseSessions: true,
			},
		});

		const text = formatConfigText(config);

		// Verify section headers are present
		expect(text).toContain("Author:");
		expect(text).toContain("Reviewer:");
		expect(text).toContain("Paths:");
		expect(text).toContain("Database:");
		expect(text).toContain("Limits:");

		// Verify key-value content for author
		expect(text).toContain("provider");
		expect(text).toContain("test-provider");
		expect(text).toContain("model");
		expect(text).toContain("gpt-4");
		expect(text).toContain("timeout");
		expect(text).toContain("120s");
		expect(text).toContain("continuePhaseSessions");

		// Verify reviewer values
		expect(text).toContain("review-provider");

		// Verify limits
		expect(text).toContain("maxStepsPerRun");
		expect(text).toContain("50");
		expect(text).toContain("maxReviewIterations");
		expect(text).toContain("5");
		expect(text).toContain("maxQualityRetries");
		expect(text).toContain("3");
	});

	test("renders optional fields when present", () => {
		const config = makeConfig({
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
		});

		const text = formatConfigText(config);

		expect(text).toContain("planReviews");
		expect(text).toContain("/plan-reviews");
		expect(text).toContain("runReviews");
		expect(text).toContain("/run-reviews");
		expect(text).toContain("reviewer-model");
		expect(text).toContain("60s");
	});

	test("omits optional fields when absent", () => {
		const config = makeConfig();

		const text = formatConfigText(config);

		// No model or timeout lines for default config
		expect(text).not.toContain("model");
		expect(text).not.toContain("timeout");
		expect(text).not.toContain("planReviews");
		expect(text).not.toContain("runReviews");
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

	test("passthrough/plugin config keys are preserved", async () => {
		const tmp = makeTmpDir();
		try {
			writeToml(
				tmp,
				[
					"[author]",
					'provider = "acme"',
					"",
					"[acme]",
					'apiKey = "sk-test"',
					'region = "us-east-1"',
				].join("\n"),
			);

			const result = await resolveLayeredConfig(tmp);
			// Plugin config should survive via .passthrough()
			const configAny = result.config as Record<string, unknown>;
			expect(configAny.acme).toBeDefined();
			const acme = configAny.acme as Record<string, unknown>;
			expect(acme.apiKey).toBe("sk-test");
			expect(acme.region).toBe("us-east-1");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
