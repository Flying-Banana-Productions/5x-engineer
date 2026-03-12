/**
 * Tests for OpenCode harness location resolution, agent template rendering,
 * and correct file generation for project vs user scope.
 *
 * Phase 2 (014-harness-native-subagent-orchestration).
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	getHarnessLocationResolver,
	listSupportedHarnesses,
	opencodeLocationResolver,
} from "../../src/harnesses/locations.js";
import {
	listAgentTemplates,
	renderAgentTemplate,
	renderAgentTemplates,
} from "../../src/harnesses/opencode/loader.js";

// ---------------------------------------------------------------------------
// Location resolution tests
// ---------------------------------------------------------------------------

describe("OpenCode location resolver", () => {
	test("lists opencode as a supported harness", () => {
		const harnesses = listSupportedHarnesses();
		expect(harnesses).toContain("opencode");
	});

	test("getHarnessLocationResolver returns resolver for opencode", () => {
		const resolver = getHarnessLocationResolver("opencode");
		expect(resolver).toBeDefined();
		expect(resolver?.name).toBe("opencode");
	});

	test("getHarnessLocationResolver returns undefined for unknown harness", () => {
		const resolver = getHarnessLocationResolver("nonexistent-harness");
		expect(resolver).toBeUndefined();
	});

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
		expect(reviewer?.content).toContain("model: anthropic/claude-sonnet-4-5");
	});

	test("injects author model into 5x-plan-author when authorModel is set", () => {
		const rendered = renderAgentTemplates({
			authorModel: "anthropic/claude-opus-4-5",
		});

		const planAuthor = rendered.find((t) => t.name === "5x-plan-author");
		expect(planAuthor).toBeDefined();
		expect(planAuthor?.content).toContain("model: anthropic/claude-opus-4-5");
	});

	test("injects author model into 5x-code-author when authorModel is set", () => {
		const rendered = renderAgentTemplates({
			authorModel: "anthropic/claude-opus-4-5",
		});

		const codeAuthor = rendered.find((t) => t.name === "5x-code-author");
		expect(codeAuthor).toBeDefined();
		expect(codeAuthor?.content).toContain("model: anthropic/claude-opus-4-5");
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
		expect(lines[1]).toBe("model: anthropic/claude-sonnet-4-5");
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
		expect(result?.content).toContain("model: openai/gpt-5");
	});
});

// ---------------------------------------------------------------------------
// Reviewer tool constraints
// ---------------------------------------------------------------------------

describe("5x-reviewer template content", () => {
	test("reviewer frontmatter disables write and edit tools", () => {
		const result = renderAgentTemplate("5x-reviewer", {});
		expect(result).toBeDefined();

		const content = result?.content;
		// Must disable write and edit
		expect(content).toContain("write: false");
		expect(content).toContain("edit: false");
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
