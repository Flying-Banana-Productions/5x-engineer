/**
 * Tests for OpenCode harness location resolution, agent template rendering,
 * and correct file generation for project vs user scope.
 *
 * Phase 2 (014-harness-native-subagent-orchestration).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	listBundledHarnesses,
	loadHarnessPlugin,
} from "../../../src/harnesses/factory.js";
import {
	installAgentFiles,
	installSkillFiles,
} from "../../../src/harnesses/installer.js";
import { opencodeLocationResolver } from "../../../src/harnesses/locations.js";
import {
	listAgentTemplates,
	renderAgentTemplate,
	renderAgentTemplates,
} from "../../../src/harnesses/opencode/loader.js";
import opencodePlugin from "../../../src/harnesses/opencode/plugin.js";
import { listSkillNames } from "../../../src/skills/loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("Harness factory", () => {
	test("lists opencode as a bundled harness", () => {
		const harnesses = listBundledHarnesses();
		expect(harnesses).toContain("opencode");
	});

	test("loadHarnessPlugin resolves the bundled opencode plugin", async () => {
		const { plugin } = await loadHarnessPlugin("opencode");
		expect(plugin).toBeDefined();
		expect(plugin.name).toBe("opencode");
		expect(plugin.supportedScopes).toContain("project");
		expect(plugin.supportedScopes).toContain("user");
		expect(typeof plugin.install).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// Location resolution tests
// ---------------------------------------------------------------------------

describe("OpenCode location resolver", () => {
	test("project scope resolves to .opencode/agents/ and .opencode/skills/", () => {
		const projectRoot = "/home/user/my-project";
		const locations = opencodeLocationResolver.resolve("project", projectRoot);

		expect(locations.agentsDir).toBe(join(projectRoot, ".opencode", "agents"));
		expect(locations.skillsDir).toBe(join(projectRoot, ".opencode", "skills"));
	});

	test("user scope resolves to ~/.config/opencode/ directories", () => {
		const projectRoot = "/home/user/my-project"; // ignored for user scope
		const locations = opencodeLocationResolver.resolve("user", projectRoot);

		const expectedBase = join(homedir(), ".config", "opencode");
		expect(locations.agentsDir).toBe(join(expectedBase, "agents"));
		expect(locations.skillsDir).toBe(join(expectedBase, "skills"));
	});

	test("user scope uses ~/.config/opencode NOT ~/.opencode", () => {
		const locations = opencodeLocationResolver.resolve("user", "/some/root");

		// Must use XDG-style path, not ~/.opencode/
		expect(locations.agentsDir).not.toContain("/.opencode/");
		expect(locations.agentsDir).toContain("/.config/opencode/");
	});

	test("project scope ignores home directory", () => {
		const projectRoot = "/tmp/my-project";
		const locations = opencodeLocationResolver.resolve("project", projectRoot);

		// Must be project-relative, not home-relative
		expect(locations.agentsDir).toContain(projectRoot);
		expect(locations.agentsDir).not.toContain(homedir());
	});
});

// ---------------------------------------------------------------------------
// Agent template tests
// ---------------------------------------------------------------------------

describe("OpenCode agent templates", () => {
	test("listAgentTemplates returns all four agents", () => {
		const templates = listAgentTemplates();
		const names = templates.map((t) => t.name);

		expect(names).toContain("5x-reviewer");
		expect(names).toContain("5x-plan-author");
		expect(names).toContain("5x-code-author");
		expect(names).toContain("5x-orchestrator");
		expect(templates).toHaveLength(4);
	});

	test("reviewer template has mode: subagent and role: reviewer", () => {
		const templates = listAgentTemplates();
		const reviewer = templates.find((t) => t.name === "5x-reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.mode).toBe("subagent");
		expect(reviewer?.role).toBe("reviewer");
	});

	test("plan-author template has mode: subagent and role: author", () => {
		const templates = listAgentTemplates();
		const planAuthor = templates.find((t) => t.name === "5x-plan-author");

		expect(planAuthor).toBeDefined();
		expect(planAuthor?.mode).toBe("subagent");
		expect(planAuthor?.role).toBe("author");
	});

	test("code-author template has mode: subagent and role: author", () => {
		const templates = listAgentTemplates();
		const codeAuthor = templates.find((t) => t.name === "5x-code-author");

		expect(codeAuthor).toBeDefined();
		expect(codeAuthor?.mode).toBe("subagent");
		expect(codeAuthor?.role).toBe("author");
	});

	test("orchestrator template has mode: primary and role: null", () => {
		const templates = listAgentTemplates();
		const orchestrator = templates.find((t) => t.name === "5x-orchestrator");

		expect(orchestrator).toBeDefined();
		expect(orchestrator?.mode).toBe("primary");
		expect(orchestrator?.role).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Template rendering: model injection
// ---------------------------------------------------------------------------

describe("renderAgentTemplates — model injection", () => {
	test("renders without models when config has no model fields", () => {
		const rendered = renderAgentTemplates({});

		for (const tmpl of rendered) {
			// No model line should appear in frontmatter
			expect(tmpl.content).not.toMatch(/^model:/m);
		}
	});

	test("injects reviewer model into 5x-reviewer when reviewerModel is set", () => {
		const rendered = renderAgentTemplates({
			reviewerModel: "anthropic/claude-sonnet-4-5",
		});

		const reviewer = rendered.find((t) => t.name === "5x-reviewer");
		expect(reviewer).toBeDefined();
		expect(reviewer?.content).toContain('model: "anthropic/claude-sonnet-4-5"');
	});

	test("injects author model into 5x-plan-author when authorModel is set", () => {
		const rendered = renderAgentTemplates({
			authorModel: "anthropic/claude-opus-4-5",
		});

		const planAuthor = rendered.find((t) => t.name === "5x-plan-author");
		expect(planAuthor).toBeDefined();
		expect(planAuthor?.content).toContain('model: "anthropic/claude-opus-4-5"');
	});

	test("injects author model into 5x-code-author when authorModel is set", () => {
		const rendered = renderAgentTemplates({
			authorModel: "anthropic/claude-opus-4-5",
		});

		const codeAuthor = rendered.find((t) => t.name === "5x-code-author");
		expect(codeAuthor).toBeDefined();
		expect(codeAuthor?.content).toContain('model: "anthropic/claude-opus-4-5"');
	});

	test("orchestrator never gets a model field even when models are configured", () => {
		const rendered = renderAgentTemplates({
			authorModel: "anthropic/claude-opus-4-5",
			reviewerModel: "anthropic/claude-sonnet-4-5",
		});

		const orchestrator = rendered.find((t) => t.name === "5x-orchestrator");
		expect(orchestrator).toBeDefined();
		expect(orchestrator?.content).not.toMatch(/^model:/m);
	});

	test("model is injected at the start of frontmatter (after ---)", () => {
		const rendered = renderAgentTemplates({
			reviewerModel: "anthropic/claude-sonnet-4-5",
		});

		const reviewer = rendered.find((t) => t.name === "5x-reviewer");
		expect(reviewer).toBeDefined();

		// The model line should appear immediately after the opening ---
		// reviewer is guaranteed non-null by toBeDefined() above
		const lines = reviewer?.content.split("\n") ?? [];
		expect(lines[0]).toBe("---");
		expect(lines[1]).toBe('model: "anthropic/claude-sonnet-4-5"');
	});

	test("empty string model is treated as absent (no model injection)", () => {
		const rendered = renderAgentTemplates({
			authorModel: "",
			reviewerModel: "  ", // whitespace only
		});

		for (const tmpl of rendered) {
			expect(tmpl.content).not.toMatch(/^model:/m);
		}
	});
});

// ---------------------------------------------------------------------------
// Single template rendering
// ---------------------------------------------------------------------------

describe("renderAgentTemplate — single template", () => {
	test("returns template by name", () => {
		const result = renderAgentTemplate("5x-reviewer", {});
		expect(result).toBeDefined();
		expect(result?.name).toBe("5x-reviewer");
	});

	test("returns undefined for unknown agent name", () => {
		const result = renderAgentTemplate("nonexistent-agent", {});
		expect(result).toBeUndefined();
	});

	test("injects model for single template lookup", () => {
		const result = renderAgentTemplate("5x-reviewer", {
			reviewerModel: "openai/gpt-5",
		});
		expect(result?.content).toContain('model: "openai/gpt-5"');
	});
});

// ---------------------------------------------------------------------------
// Reviewer tool constraints
// ---------------------------------------------------------------------------

describe("5x-reviewer template content", () => {
	test("reviewer frontmatter has no tool restrictions", () => {
		const result = renderAgentTemplate("5x-reviewer", {});
		expect(result).toBeDefined();

		const content = result?.content;
		// Reviewer has no allowedTools/disallowedTools restrictions
		expect(content).not.toContain("allowedTools");
		expect(content).not.toContain("disallowedTools");
		// No write:false or edit:false in the reviewer frontmatter
		expect(content).not.toContain("write: false");
		expect(content).not.toContain("edit: false");
	});

	test("reviewer uses correct OpenCode tool names (not legacy names)", () => {
		const result = renderAgentTemplate("5x-reviewer", {});
		expect(result).toBeDefined();

		const content = result?.content;
		// Must NOT use Claude Code or legacy tool names
		expect(content).not.toContain("read_file");
		expect(content).not.toContain("write_file");
		expect(content).not.toContain("run_terminal_cmd");
		expect(content).not.toContain("list_directory");
		expect(content).not.toContain("search_files");
	});

	test("reviewer mode is subagent", () => {
		const result = renderAgentTemplate("5x-reviewer", {});
		expect(result?.content).toContain("mode: subagent");
	});
});

// ---------------------------------------------------------------------------
// Orchestrator content
// ---------------------------------------------------------------------------

describe("5x-orchestrator template content", () => {
	test("orchestrator disables write and edit tools", () => {
		const result = renderAgentTemplate("5x-orchestrator", {});
		expect(result).toBeDefined();
		const content = result?.content;
		expect(content).toContain("write: false");
		expect(content).toContain("edit: false");
	});

	test("orchestrator mode is primary", () => {
		const result = renderAgentTemplate("5x-orchestrator", {});
		expect(result?.content).toContain("mode: primary");
	});

	test("orchestrator prompt describes delegation pattern", () => {
		const result = renderAgentTemplate("5x-orchestrator", {});
		expect(result).toBeDefined();
		const content = result?.content;

		// Must reference the three core skills
		expect(content).toContain("5x-plan");
		expect(content).toContain("5x-plan-review");
		expect(content).toContain("5x-phase-execution");

		// Must describe the template render → sub-agent → validate pattern
		expect(content).toContain("5x template render");
		expect(content).toContain("5x protocol validate");
	});

	test("orchestrator references the three sub-agents", () => {
		const result = renderAgentTemplate("5x-orchestrator", {});
		expect(result).toBeDefined();
		const content = result?.content;

		expect(content).toContain("5x-plan-author");
		expect(content).toContain("5x-code-author");
		expect(content).toContain("5x-reviewer");
	});
});

// ---------------------------------------------------------------------------
// Model YAML escaping
// ---------------------------------------------------------------------------

describe("renderAgentTemplates — model YAML escaping", () => {
	test("escapes double-quotes in model string", () => {
		const rendered = renderAgentTemplates({
			reviewerModel: 'vendor/"quoted-model"',
		});
		const reviewer = rendered.find((t) => t.name === "5x-reviewer");
		expect(reviewer?.content).toContain('model: "vendor/\\"quoted-model\\""');
	});

	test("escapes backslashes in model string", () => {
		const rendered = renderAgentTemplates({
			reviewerModel: "vendor\\model",
		});
		const reviewer = rendered.find((t) => t.name === "5x-reviewer");
		expect(reviewer?.content).toContain('model: "vendor\\\\model"');
	});

	test("escapes newlines in model string", () => {
		const rendered = renderAgentTemplates({
			authorModel: "vendor/model\ninjected",
		});
		const codeAuthor = rendered.find((t) => t.name === "5x-code-author");
		expect(codeAuthor?.content).toContain('model: "vendor/model\\ninjected"');
		// The raw newline must not appear in the frontmatter value
		expect(codeAuthor?.content).not.toContain(
			'model: "vendor/model\ninjected"',
		);
	});

	test("escapes carriage returns in model string", () => {
		const rendered = renderAgentTemplates({
			reviewerModel: "vendor/model\r\ninjected",
		});
		const reviewer = rendered.find((t) => t.name === "5x-reviewer");
		expect(reviewer?.content).toContain('model: "vendor/model\\r\\ninjected"');
	});

	test("escapes combined special characters in model string", () => {
		// Input: backslash + double-quote + mid-string newline (not trimmed away)
		const rendered = renderAgentTemplates({
			authorModel: 'vendor\\\n"<model>"',
		});
		const planAuthor = rendered.find((t) => t.name === "5x-plan-author");
		// Expected YAML value: vendor\\<escaped-newline>\"<model>\"
		expect(planAuthor?.content).toContain(
			'model: "vendor\\\\\\n\\"<model>\\""',
		);
	});
});

// ---------------------------------------------------------------------------
// No cwd field (OpenCode does not support it)
// ---------------------------------------------------------------------------

describe("agent templates — no cwd field", () => {
	test("no agent template contains a cwd frontmatter field", () => {
		const rendered = renderAgentTemplates({
			authorModel: "some/model",
			reviewerModel: "some/model",
		});

		for (const tmpl of rendered) {
			// cwd is not a supported OpenCode frontmatter field
			expect(tmpl.content).not.toMatch(/^cwd:/m);
		}
	});
});

// ---------------------------------------------------------------------------
// Plugin describe()
// ---------------------------------------------------------------------------

describe("opencode plugin describe()", () => {
	test("returns correct skill names", () => {
		const desc = opencodePlugin.describe();
		const expectedSkills = listSkillNames();

		expect(desc.skillNames).toEqual(expectedSkills);
		expect(desc.skillNames).toContain("5x-plan");
		expect(desc.skillNames).toContain("5x-plan-review");
		expect(desc.skillNames).toContain("5x-phase-execution");
	});

	test("returns correct agent names", () => {
		const desc = opencodePlugin.describe();
		const expectedAgents = listAgentTemplates().map((t) => t.name);

		expect(desc.agentNames).toEqual(expectedAgents);
		expect(desc.agentNames).toContain("5x-reviewer");
		expect(desc.agentNames).toContain("5x-plan-author");
		expect(desc.agentNames).toContain("5x-code-author");
		expect(desc.agentNames).toContain("5x-orchestrator");
	});
});

// ---------------------------------------------------------------------------
// Plugin uninstall()
// ---------------------------------------------------------------------------

describe("opencode plugin uninstall()", () => {
	test("removes installed files for project scope", async () => {
		const tmp = makeTmpDir();
		try {
			const locations = opencodeLocationResolver.resolve("project", tmp);
			const desc = opencodePlugin.describe();

			// Install files first
			installSkillFiles(
				locations.skillsDir,
				desc.skillNames.map((n) => ({ name: n, content: "content" })),
				false,
			);
			installAgentFiles(
				locations.agentsDir,
				desc.agentNames.map((n) => ({ name: n, content: "content" })),
				false,
			);

			// Verify installed
			for (const name of desc.skillNames) {
				expect(existsSync(join(locations.skillsDir, name, "SKILL.md"))).toBe(
					true,
				);
			}

			const result = await opencodePlugin.uninstall({
				scope: "project",
				projectRoot: tmp,
			});

			// Verify removed
			expect(result.skills.removed.length).toBe(desc.skillNames.length);
			expect(result.agents.removed.length).toBe(desc.agentNames.length);
			expect(result.skills.notFound).toHaveLength(0);
			expect(result.agents.notFound).toHaveLength(0);

			for (const name of desc.skillNames) {
				expect(existsSync(join(locations.skillsDir, name, "SKILL.md"))).toBe(
					false,
				);
			}
			for (const name of desc.agentNames) {
				expect(existsSync(join(locations.agentsDir, `${name}.md`))).toBe(false);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports not-found for missing files", async () => {
		const tmp = makeTmpDir();
		try {
			// Don't install anything — just uninstall
			const result = await opencodePlugin.uninstall({
				scope: "project",
				projectRoot: tmp,
			});

			const desc = opencodePlugin.describe();
			expect(result.skills.notFound.length).toBe(desc.skillNames.length);
			expect(result.agents.notFound.length).toBe(desc.agentNames.length);
			expect(result.skills.removed).toHaveLength(0);
			expect(result.agents.removed).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("cleans empty directories after removal", async () => {
		const tmp = makeTmpDir();
		try {
			const locations = opencodeLocationResolver.resolve("project", tmp);
			const desc = opencodePlugin.describe();

			// Install files first
			installSkillFiles(
				locations.skillsDir,
				desc.skillNames.map((n) => ({ name: n, content: "content" })),
				false,
			);
			installAgentFiles(
				locations.agentsDir,
				desc.agentNames.map((n) => ({ name: n, content: "content" })),
				false,
			);

			await opencodePlugin.uninstall({
				scope: "project",
				projectRoot: tmp,
			});

			// Both skills and agents dirs should be cleaned up
			expect(existsSync(locations.skillsDir)).toBe(false);
			expect(existsSync(locations.agentsDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});
