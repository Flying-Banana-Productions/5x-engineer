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
			expect(config.author.adapter).toBe("claude-code");
			expect(config.reviewer.adapter).toBe("claude-code");
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
				`export default { author: { adapter: "opencode" }, qualityGates: ["bun test"] };`,
			);
			const { config, configPath } = await loadConfig(tmp);
			expect(configPath).toBe(join(tmp, "5x.config.js"));
			expect(config.author.adapter).toBe("opencode");
			expect(config.reviewer.adapter).toBe("claude-code"); // default
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

	test("invalid adapter value throws with clear message", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { adapter: "gpt-4" } };`,
			);
			await expect(loadConfig(tmp)).rejects.toThrow("Invalid config");
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
				`export default { author: { adapter: "opencode" } };`,
			);
			const { config, configPath } = await loadConfig(tmp);
			expect(configPath).toEndWith("5x.config.mjs");
			expect(config.author.adapter).toBe("opencode");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test(".js takes precedence over .mjs", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.config.js"),
				`export default { author: { adapter: "claude-code" } };`,
			);
			writeFileSync(
				join(tmp, "5x.config.mjs"),
				`export default { author: { adapter: "opencode" } };`,
			);
			const { config } = await loadConfig(tmp);
			expect(config.author.adapter).toBe("claude-code");
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
		const partial = defineConfig({ author: { adapter: "opencode" } });
		expect(partial.author?.adapter).toBe("opencode");
	});

	test("schema validates full config shape", () => {
		const result = FiveXConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.author.adapter).toBe("claude-code");
		}
	});
});
