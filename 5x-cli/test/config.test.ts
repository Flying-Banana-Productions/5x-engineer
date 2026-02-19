import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, FiveXConfigSchema, loadConfig } from "../src/config.js";

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
			expect(config.maxReviewIterations).toBe(5);
			expect(config.maxAutoIterations).toBe(10);
			expect(config.paths.plans).toBe("docs/development");
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
			expect(config.paths.plans).toBe("docs/development"); // default
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
			expect(errors.join("\n")).toContain(
				'Deprecated config key "author.adapter"',
			);
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
});
