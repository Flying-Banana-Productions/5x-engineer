import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, defineConfig, FiveXConfigSchema } from "../src/config.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `5x-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("config", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("missing config uses defaults", async () => {
    const { config, configPath } = await loadConfig(tmp);
    expect(configPath).toBeNull();
    expect(config.author.adapter).toBe("claude-code");
    expect(config.reviewer.adapter).toBe("claude-code");
    expect(config.qualityGates).toEqual([]);
    expect(config.maxReviewIterations).toBe(5);
    expect(config.maxAutoIterations).toBe(10);
    expect(config.paths.plans).toBe("docs/development");
  });

  test("valid config loads and merges with defaults", async () => {
    writeFileSync(
      join(tmp, "5x.config.js"),
      `export default { author: { adapter: "opencode" }, qualityGates: ["bun test"] };`
    );
    const { config, configPath } = await loadConfig(tmp);
    expect(configPath).toBe(join(tmp, "5x.config.js"));
    expect(config.author.adapter).toBe("opencode");
    expect(config.reviewer.adapter).toBe("claude-code"); // default
    expect(config.qualityGates).toEqual(["bun test"]);
  });

  test("partial config fills in defaults", async () => {
    writeFileSync(
      join(tmp, "5x.config.js"),
      `export default { maxReviewIterations: 10 };`
    );
    const { config } = await loadConfig(tmp);
    expect(config.maxReviewIterations).toBe(10);
    expect(config.maxQualityRetries).toBe(3); // default
    expect(config.paths.plans).toBe("docs/development"); // default
  });

  test("invalid adapter value throws with clear message", async () => {
    writeFileSync(
      join(tmp, "5x.config.js"),
      `export default { author: { adapter: "gpt-4" } };`
    );
    await expect(loadConfig(tmp)).rejects.toThrow("Invalid config");
  });

  test("invalid type throws with path info", async () => {
    writeFileSync(
      join(tmp, "5x.config.js"),
      `export default { maxReviewIterations: "not-a-number" };`
    );
    await expect(loadConfig(tmp)).rejects.toThrow("Invalid config");
  });

  test("syntax error in config throws actionable message", async () => {
    writeFileSync(
      join(tmp, "5x.config.js"),
      `export default {{{ broken`
    );
    await expect(loadConfig(tmp)).rejects.toThrow("Failed to load");
  });

  test(".mjs variant loads", async () => {
    writeFileSync(
      join(tmp, "5x.config.mjs"),
      `export default { author: { adapter: "opencode" } };`
    );
    const { config, configPath } = await loadConfig(tmp);
    expect(configPath).toEndWith("5x.config.mjs");
    expect(config.author.adapter).toBe("opencode");
  });

  test(".js takes precedence over .mjs", async () => {
    writeFileSync(
      join(tmp, "5x.config.js"),
      `export default { author: { adapter: "claude-code" } };`
    );
    writeFileSync(
      join(tmp, "5x.config.mjs"),
      `export default { author: { adapter: "opencode" } };`
    );
    const { config } = await loadConfig(tmp);
    expect(config.author.adapter).toBe("claude-code");
  });

  test("walks up directories to find config", async () => {
    const child = join(tmp, "a", "b", "c");
    mkdirSync(child, { recursive: true });
    writeFileSync(
      join(tmp, "5x.config.js"),
      `export default { maxReviewIterations: 42 };`
    );
    const { config, configPath } = await loadConfig(child);
    expect(configPath).toBe(join(tmp, "5x.config.js"));
    expect(config.maxReviewIterations).toBe(42);
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
