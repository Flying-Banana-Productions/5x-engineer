import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyModelOverrides,
	defineConfig,
	FiveXConfigSchema,
	loadConfig,
	resolveDelegationContext,
	resolveHarnessModelForRole,
} from "../../src/config.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("config", () => {
	test("missing config uses defaults", async () => {
		const tmp = makeTmpDir();
		try {
			const { config, configPath } = await loadConfig(tmp);
			expect(configPath).toBeNull();
			// Phase 1: adapter field removed — model field is optional string
			expect(config.author.model).toBeUndefined();
			expect(config.reviewer.model).toBeUndefined();
			expect(config.qualityGates).toEqual([]);
			expect(config.worktree.postCreate).toBeUndefined();
			expect(config.maxReviewIterations).toBe(5);
			expect(config.maxAutoIterations).toBe(10);
			// paths.* values are always absolute after config loading
			expect(config.paths.plans).toBe(join(tmp, "docs/development"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("worktree postCreate command is supported", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { worktree: { postCreate: "bun run setup:worktree" } };`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.worktree.postCreate).toBe("bun run setup:worktree");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("valid config loads and merges with defaults", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { model: "anthropic/claude-sonnet-4-6" }, qualityGates: ["bun test"] };`,
			);
			const { config, configPath } = await loadConfig(tmp);
			expect(configPath).toBe(join(tmp, "5x.config.js"));
			expect(config.author.model).toBe("anthropic/claude-sonnet-4-6");
			expect(config.reviewer.model).toBeUndefined(); // default
			expect(config.qualityGates).toEqual(["bun test"]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("partial config fills in defaults", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { maxReviewIterations: 10 };`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.maxReviewIterations).toBe(10);
			expect(config.maxQualityRetries).toBe(3); // default
			// paths.* default resolved to absolute against projectRoot
			expect(config.paths.plans).toBe(join(tmp, "docs/development"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("both author and reviewer models can be configured", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { model: "model-a" }, reviewer: { model: "model-b" } };`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.author.model).toBe("model-a");
			expect(config.reviewer.model).toBe("model-b");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("invalid type throws with path info", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { maxReviewIterations: "not-a-number" };`,
			);
			await expect(loadConfig(tmp)).rejects.toThrow("Invalid config");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("syntax error in config throws actionable message", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.config.js"), `export default {{{ broken`);
			await expect(loadConfig(tmp)).rejects.toThrow("Failed to load");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test(".mjs variant loads", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.mjs"),
				`export default { author: { model: "anthropic/claude-haiku" } };`,
			);
			const { config, configPath } = await loadConfig(tmp);
			expect(configPath).toEndWith("5x.config.mjs");
			expect(config.author.model).toBe("anthropic/claude-haiku");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test(".js takes precedence over .mjs", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { model: "model-js" } };`,
			);
			writeFileSync(
				join(tmp, "5x.config.mjs"),
				`export default { author: { model: "model-mjs" } };`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.author.model).toBe("model-js");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("walks up directories to find config", async () => {
		const tmp = makeTmpDir();
		try {
			const child = join(tmp, "a", "b", "c");
			mkdirSync(child, { recursive: true });
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { maxReviewIterations: 42 };`,
			);
			const { config, configPath } = await loadConfig(child);
			expect(configPath).toBe(join(tmp, "5x.config.js"));
			expect(config.maxReviewIterations).toBe(42);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("defineConfig passes through partial config", () => {
		const partial = defineConfig({
			author: { model: "anthropic/claude-opus" },
		});
		expect(partial.author?.model).toBe("anthropic/claude-opus");
	});

	test("warns on unknown/deprecated keys", async () => {
		const tmp = makeTmpDir();
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { adapter: "opencode" }, extra: true };`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.author.model).toBeUndefined();
			expect(errors.join("\n")).toContain('"author.adapter" is deprecated');
			expect(errors.join("\n")).toContain('Unknown config key "extra"');
		} finally {
			console.error = original;
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("schema validates full config shape", () => {
		const result = FiveXConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			// Phase 1: model field is optional, no default
			expect(result.data.author.model).toBeUndefined();
			expect(result.data.reviewer.model).toBeUndefined();
		}
	});

	test("CLI model overrides take precedence over config models", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { model: "config-author" }, reviewer: { model: "config-reviewer" } };`,
			);
			const { config } = await loadConfig(tmp);
			const overridden = applyModelOverrides(config, {
				authorModel: "cli-author",
				reviewerModel: "cli-reviewer",
			});

			expect(overridden.author.model).toBe("cli-author");
			expect(overridden.reviewer.model).toBe("cli-reviewer");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("CLI model overrides can be applied independently", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { model: "config-author" }, reviewer: { model: "config-reviewer" } };`,
			);
			const { config } = await loadConfig(tmp);

			const reviewerOnly = applyModelOverrides(config, {
				reviewerModel: "cli-reviewer",
			});
			expect(reviewerOnly.author.model).toBe("config-author");
			expect(reviewerOnly.reviewer.model).toBe("cli-reviewer");

			const authorOnly = applyModelOverrides(config, {
				authorModel: "cli-author",
			});
			expect(authorOnly.author.model).toBe("cli-author");
			expect(authorOnly.reviewer.model).toBe("config-reviewer");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("resolveHarnessModelForRole", () => {
	test("uses harnessModels entry when present", () => {
		const config = FiveXConfigSchema.parse({
			author: {
				model: "fallback-a",
				harnessModels: { opencode: "oc-a", cursor: "cu-a" },
			},
			reviewer: {
				model: "fallback-r",
				harnessModels: { opencode: "oc-r", cursor: "cu-r" },
			},
		});
		expect(resolveHarnessModelForRole(config, "author", "opencode")).toBe(
			"oc-a",
		);
		expect(resolveHarnessModelForRole(config, "author", "cursor")).toBe("cu-a");
		expect(resolveHarnessModelForRole(config, "reviewer", "opencode")).toBe(
			"oc-r",
		);
	});

	test("falls back to model when harness override missing", () => {
		const config = FiveXConfigSchema.parse({
			author: { model: "only-a", harnessModels: { cursor: "cu" } },
			reviewer: { model: "only-r" },
		});
		expect(resolveHarnessModelForRole(config, "author", "opencode")).toBe(
			"only-a",
		);
		expect(resolveHarnessModelForRole(config, "author", "cursor")).toBe("cu");
		expect(resolveHarnessModelForRole(config, "reviewer", "opencode")).toBe(
			"only-r",
		);
	});

	test("empty override string falls back to model", () => {
		const config = FiveXConfigSchema.parse({
			author: { model: "fb", harnessModels: { opencode: "   " } },
		});
		expect(resolveHarnessModelForRole(config, "author", "opencode")).toBe("fb");
	});
});

// ---------------------------------------------------------------------------
// TOML config loading
// ---------------------------------------------------------------------------

describe("TOML config", () => {
	test("loads 5x.toml with basic config", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				`maxStepsPerRun = 25\n\n[author]\nmodel = "anthropic/claude-sonnet-4-6"\n`,
			);
			const { config, configPath } = await loadConfig(tmp);
			expect(configPath).toBe(join(tmp, "5x.toml"));
			expect(config.maxStepsPerRun).toBe(25);
			expect(config.author.model).toBe("anthropic/claude-sonnet-4-6");
			expect(config.reviewer.model).toBeUndefined(); // default
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("loads 5x.toml with author.harnessModels", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				`[author]
model = "fallback-author"
[author.harnessModels]
opencode = "anthropic/oc"
cursor = "claude-3-5-cursor"
`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.author.model).toBe("fallback-author");
			expect(config.author.harnessModels).toEqual({
				opencode: "anthropic/oc",
				cursor: "claude-3-5-cursor",
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("5x.toml takes precedence over 5x.config.js", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), `[author]\nmodel = "toml-model"\n`);
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { model: "js-model" } };`,
			);
			const { config, configPath } = await loadConfig(tmp);
			expect(configPath).toEndWith("5x.toml");
			expect(config.author.model).toBe("toml-model");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("TOML syntax error throws actionable message", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), `[broken\nkey = !!!`);
			await expect(loadConfig(tmp)).rejects.toThrow("Failed to load");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("TOML with full config shape loads correctly", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				[
					"maxStepsPerRun = 100",
					"maxReviewIterations = 10",
					"maxQualityRetries = 5",
					"maxAutoRetries = 2",
					'qualityGates = ["bun test", "bun run lint"]',
					"",
					"[author]",
					'provider = "claude-code"',
					'model = "model-a"',
					"timeout = 300",
					"",
					"[reviewer]",
					'provider = "opencode"',
					'model = "model-b"',
					"",
					"[worktree]",
					'postCreate = "bun install"',
					"",
					"[paths]",
					'plans = "custom/plans"',
					'reviews = "custom/reviews"',
					'archive = "custom/archive"',
					"",
					"[paths.templates]",
					'plan = "custom/plan.md"',
					'review = "custom/review.md"',
					"",
					"[db]",
					'path = "custom/5x.db"',
				].join("\n"),
			);
			const { config } = await loadConfig(tmp);
			expect(config.maxStepsPerRun).toBe(100);
			expect(config.qualityGates).toEqual(["bun test", "bun run lint"]);
			expect(config.author.provider).toBe("claude-code");
			expect(config.author.model).toBe("model-a");
			expect(config.author.timeout).toBe(300);
			expect(config.reviewer.provider).toBe("opencode");
			expect(config.worktree.postCreate).toBe("bun install");
			// paths.* values are always absolute after config loading
			expect(config.paths.plans).toBe(join(tmp, "custom/plans"));
			expect(config.paths.templates.plan).toBe(join(tmp, "custom/plan.md"));
			expect(config.db.path).toBe("custom/5x.db"); // db.path is NOT in paths.*, not normalized
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("TOML walks up directories to find config", async () => {
		const tmp = makeTmpDir();
		try {
			const child = join(tmp, "a", "b", "c");
			mkdirSync(child, { recursive: true });
			writeFileSync(join(tmp, "5x.toml"), `maxReviewIterations = 42\n`);
			const { config, configPath } = await loadConfig(child);
			expect(configPath).toBe(join(tmp, "5x.toml"));
			expect(config.maxReviewIterations).toBe(42);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// loadConfig() path normalization (Phase 1, 019-orchestrator-improvements)
// ---------------------------------------------------------------------------

describe("loadConfig path normalization", () => {
	test("config with relative paths.plans returns absolute path resolved against config file's directory", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), `[paths]\nplans = "my-plans"\n`);
			const { config } = await loadConfig(tmp);
			expect(config.paths.plans).toBe(join(tmp, "my-plans"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("no config file (Zod defaults only) returns absolute paths resolved against projectRoot", async () => {
		const tmp = makeTmpDir();
		try {
			const { config } = await loadConfig(tmp);
			// All Zod default paths resolved against projectRoot
			expect(config.paths.plans).toBe(join(tmp, "docs/development"));
			expect(config.paths.reviews).toBe(join(tmp, "docs/development/reviews"));
			expect(config.paths.archive).toBe(join(tmp, "docs/archive"));
			expect(config.paths.templates.plan).toBe(
				join(tmp, "docs/_implementation_plan_template.md"),
			);
			expect(config.paths.templates.review).toBe(
				join(tmp, "docs/development/reviews/_review_template.md"),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("already-absolute paths pass through unchanged", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				`[paths]\nplans = "/opt/custom-plans"\n`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.paths.plans).toBe("/opt/custom-plans");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("nested paths.templates.plan relative value resolves correctly", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				`[paths.templates]\nplan = "templates/my-plan.md"\n`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.paths.templates.plan).toBe(
				join(tmp, "templates/my-plan.md"),
			);
			// Review template should also be absolute (Zod default)
			expect(config.paths.templates.review).toBe(
				join(tmp, "docs/development/reviews/_review_template.md"),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("config found in parent directory resolves paths against parent dir", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), `[paths]\nplans = "docs/plans"\n`);
			const child = join(tmp, "a", "b");
			mkdirSync(child, { recursive: true });
			const { config } = await loadConfig(child);
			// Paths resolved against the config file's directory (parent), not child
			expect(config.paths.plans).toBe(join(tmp, "docs/plans"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// delegationMode config (Phase 1, 019-mixed-mode-delegation)
// ---------------------------------------------------------------------------

describe("delegationMode config", () => {
	test("default config has delegationMode: native for both roles", () => {
		const config = FiveXConfigSchema.parse({});
		expect(config.author.delegationMode).toBe("native");
		expect(config.reviewer.delegationMode).toBe("native");
	});

	test("explicit delegationMode: invoke on author is parsed correctly", () => {
		const config = FiveXConfigSchema.parse({
			author: { delegationMode: "invoke" },
		});
		expect(config.author.delegationMode).toBe("invoke");
		expect(config.reviewer.delegationMode).toBe("native"); // default
	});

	test("explicit delegationMode: invoke on reviewer is parsed correctly", () => {
		const config = FiveXConfigSchema.parse({
			reviewer: { delegationMode: "invoke" },
		});
		expect(config.author.delegationMode).toBe("native"); // default
		expect(config.reviewer.delegationMode).toBe("invoke");
	});

	test("both roles can have delegationMode: invoke", () => {
		const config = FiveXConfigSchema.parse({
			author: { delegationMode: "invoke" },
			reviewer: { delegationMode: "invoke" },
		});
		expect(config.author.delegationMode).toBe("invoke");
		expect(config.reviewer.delegationMode).toBe("invoke");
	});

	test("delegationMode loads from TOML config", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				`[author]\ndelegationMode = "invoke"\n\n[reviewer]\ndelegationMode = "native"\n`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.author.delegationMode).toBe("invoke");
			expect(config.reviewer.delegationMode).toBe("native");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("resolveDelegationContext", () => {
	test("native/native returns both native flags true", () => {
		const config = FiveXConfigSchema.parse({
			author: { delegationMode: "native" },
			reviewer: { delegationMode: "native" },
		});
		const ctx = resolveDelegationContext(config);
		expect(ctx.authorNative).toBe(true);
		expect(ctx.reviewerNative).toBe(true);
	});

	test("invoke/native returns authorNative false, reviewerNative true", () => {
		const config = FiveXConfigSchema.parse({
			author: { delegationMode: "invoke" },
			reviewer: { delegationMode: "native" },
		});
		const ctx = resolveDelegationContext(config);
		expect(ctx.authorNative).toBe(false);
		expect(ctx.reviewerNative).toBe(true);
	});

	test("native/invoke returns authorNative true, reviewerNative false", () => {
		const config = FiveXConfigSchema.parse({
			author: { delegationMode: "native" },
			reviewer: { delegationMode: "invoke" },
		});
		const ctx = resolveDelegationContext(config);
		expect(ctx.authorNative).toBe(true);
		expect(ctx.reviewerNative).toBe(false);
	});

	test("invoke/invoke returns both native flags false", () => {
		const config = FiveXConfigSchema.parse({
			author: { delegationMode: "invoke" },
			reviewer: { delegationMode: "invoke" },
		});
		const ctx = resolveDelegationContext(config);
		expect(ctx.authorNative).toBe(false);
		expect(ctx.reviewerNative).toBe(false);
	});

	test("default config (no explicit delegationMode) returns both native", () => {
		const config = FiveXConfigSchema.parse({});
		const ctx = resolveDelegationContext(config);
		expect(ctx.authorNative).toBe(true);
		expect(ctx.reviewerNative).toBe(true);
	});
});
