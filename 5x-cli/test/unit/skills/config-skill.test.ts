/**
 * Deterministic content checks for the bundled `config` skill (Phase 7).
 */
import { describe, expect, test } from "bun:test";
import { renderSkillByName } from "../../../src/skills/loader.js";
import { createRenderContext } from "../../../src/skills/renderer.js";

describe("config skill content", () => {
	test("loader resolves config skill with stable name and body", () => {
		const skill = renderSkillByName("config", createRenderContext(true));
		expect(skill.name).toBe("config");
		expect(skill.content).toContain("name: config");
		expect(skill.description.length).toBeGreaterThan(20);
	});

	test("documents inspect and write CLI commands", () => {
		const body = renderSkillByName("config", createRenderContext(true)).content;
		expect(body).toContain("5x config show");
		expect(body).toContain("5x config set");
		expect(body).toContain("5x config unset");
		expect(body).toContain("5x config add");
		expect(body).toContain("5x config remove");
	});

	test("documents layering and local overrides", () => {
		const body = renderSkillByName(
			"config",
			createRenderContext(false),
		).content;
		expect(body).toMatch(/layered|nearest|merge/i);
		expect(body).toContain("5x.toml.local");
		expect(body).toContain("--local");
		expect(body).toContain("--context");
	});
});
