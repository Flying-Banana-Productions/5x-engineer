import { describe, expect, test } from "bun:test";
import { parseClaudePluginConfig } from "../../../../packages/provider-claude-code/src/index.js";

describe("parseClaudePluginConfig", () => {
	test("returns safe defaults on missing / invalid input", () => {
		expect(parseClaudePluginConfig(undefined)).toEqual({
			permissionMode: "dangerously-skip",
			claudeBinary: "claude",
		});
	});

	test("preserves existing typed fields", () => {
		const cfg = parseClaudePluginConfig({
			permissionMode: "default",
			bare: true,
			tools: ["Read", "Write"],
			maxBudgetUsd: 2,
			systemPrompt: "sys",
			appendSystemPrompt: "extra",
			claudeBinary: "/usr/local/bin/claude",
		});
		expect(cfg.permissionMode).toBe("default");
		expect(cfg.bare).toBe(true);
		expect(cfg.tools).toEqual(["Read", "Write"]);
		expect(cfg.maxBudgetUsd).toBe(2);
		expect(cfg.systemPrompt).toBe("sys");
		expect(cfg.appendSystemPrompt).toBe("extra");
		expect(cfg.claudeBinary).toBe("/usr/local/bin/claude");
	});

	test("accepts all valid effort levels", () => {
		for (const level of ["low", "medium", "high", "max"] as const) {
			const cfg = parseClaudePluginConfig({ effort: level });
			expect(cfg.effort).toBe(level);
		}
	});

	test("drops invalid effort values", () => {
		expect(parseClaudePluginConfig({ effort: "crazy" }).effort).toBeUndefined();
		expect(parseClaudePluginConfig({ effort: 5 }).effort).toBeUndefined();
		expect(parseClaudePluginConfig({ effort: null }).effort).toBeUndefined();
	});

	test("parses addDir and filters non-strings / empty entries", () => {
		const cfg = parseClaudePluginConfig({
			addDir: ["../sibling", "", "/abs", 42, null],
		});
		expect(cfg.addDir).toEqual(["../sibling", "/abs"]);
	});

	test("drops non-array addDir", () => {
		expect(
			parseClaudePluginConfig({ addDir: "../nope" }).addDir,
		).toBeUndefined();
		expect(parseClaudePluginConfig({ addDir: [] }).addDir).toBeUndefined();
	});

	test("parses fallbackModel when non-empty string", () => {
		expect(
			parseClaudePluginConfig({ fallbackModel: "sonnet" }).fallbackModel,
		).toBe("sonnet");
	});

	test("drops empty / non-string fallbackModel", () => {
		expect(
			parseClaudePluginConfig({ fallbackModel: "" }).fallbackModel,
		).toBeUndefined();
		expect(
			parseClaudePluginConfig({ fallbackModel: 123 }).fallbackModel,
		).toBeUndefined();
	});

	test("parses disallowedTools and filters non-strings / empty entries", () => {
		const cfg = parseClaudePluginConfig({
			disallowedTools: ["Bash(rm:*)", "", "Edit", 0],
		});
		expect(cfg.disallowedTools).toEqual(["Bash(rm:*)", "Edit"]);
	});

	test("drops non-array disallowedTools", () => {
		expect(
			parseClaudePluginConfig({ disallowedTools: "Edit" }).disallowedTools,
		).toBeUndefined();
		expect(
			parseClaudePluginConfig({ disallowedTools: [] }).disallowedTools,
		).toBeUndefined();
	});

	test("round-trips all new fields together", () => {
		const cfg = parseClaudePluginConfig({
			effort: "high",
			addDir: ["../other"],
			fallbackModel: "sonnet",
			disallowedTools: ["Bash(rm:*)"],
		});
		expect(cfg.effort).toBe("high");
		expect(cfg.addDir).toEqual(["../other"]);
		expect(cfg.fallbackModel).toBe("sonnet");
		expect(cfg.disallowedTools).toEqual(["Bash(rm:*)"]);
	});

	test("parses apiKey when non-empty string", () => {
		expect(parseClaudePluginConfig({ apiKey: "sk-ant-123" }).apiKey).toBe(
			"sk-ant-123",
		);
	});

	test("drops empty / non-string apiKey", () => {
		expect(parseClaudePluginConfig({ apiKey: "" }).apiKey).toBeUndefined();
		expect(parseClaudePluginConfig({ apiKey: 123 }).apiKey).toBeUndefined();
		expect(parseClaudePluginConfig({ apiKey: null }).apiKey).toBeUndefined();
	});
});
