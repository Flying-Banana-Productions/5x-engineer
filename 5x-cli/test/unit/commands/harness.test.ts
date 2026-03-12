/**
 * Unit tests for harness handler — direct function calls, filesystem assertions only.
 *
 * Converted from test/integration/commands/harness.test.ts (Phase 4).
 * Tests that assert on CLI stdout/stderr/exit codes or require HOME env
 * mutation remain in test/integration/commands/harness.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessInstall } from "../../../src/commands/harness.handler.js";
import { initScaffold } from "../../../src/commands/init.handler.js";
import { listAgentTemplates } from "../../../src/harnesses/opencode/loader.js";
import { listSkillNames } from "../../../src/skills/loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-harness-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/**
 * Bootstrap a minimal 5x project in a temp dir via direct handler call.
 */
async function bootstrapProject(dir: string): Promise<void> {
	await initScaffold({ startDir: dir });
}

// ---------------------------------------------------------------------------
// `harnessInstall` — project scope, filesystem side-effect tests
// ---------------------------------------------------------------------------

describe("harnessInstall --scope project", () => {
	test("installs all bundled skills under .opencode/skills/", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const skillNames = listSkillNames();
			for (const name of skillNames) {
				const skillPath = join(tmp, ".opencode", "skills", name, "SKILL.md");
				expect(existsSync(skillPath)).toBe(true);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("installs all bundled agent profiles under .opencode/agents/", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const agentNames = listAgentTemplates().map((a) => a.name);
			for (const name of agentNames) {
				const agentPath = join(tmp, ".opencode", "agents", `${name}.md`);
				expect(existsSync(agentPath)).toBe(true);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("installs 3 skills and 4 agents (3 subagents + 1 orchestrator)", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			const skillsDir = join(tmp, ".opencode", "skills");
			const agentsDir = join(tmp, ".opencode", "agents");

			const skillNames = listSkillNames();
			expect(skillNames).toHaveLength(3);

			const agentNames = listAgentTemplates().map((a) => a.name);
			expect(agentNames).toHaveLength(4);

			for (const name of skillNames) {
				expect(existsSync(join(skillsDir, name, "SKILL.md"))).toBe(true);
			}
			for (const name of agentNames) {
				expect(existsSync(join(agentsDir, `${name}.md`))).toBe(true);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("fails when control plane state DB is absent", async () => {
		const tmp = makeTmpDir();
		try {
			expect(
				async () =>
					await harnessInstall({
						name: "opencode",
						scope: "project",
						startDir: tmp,
					}),
			).toThrow("5x init");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("idempotent: second run without --force skips all files", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);

			// First run
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Capture file contents after first install
			const skillNames = listSkillNames();
			const firstContents = new Map<string, string>();
			for (const name of skillNames) {
				const skillPath = join(tmp, ".opencode", "skills", name, "SKILL.md");
				firstContents.set(skillPath, readFileSync(skillPath, "utf-8"));
			}

			// Second run (no --force)
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Files unchanged after second run
			for (const [path, content] of firstContents) {
				expect(readFileSync(path, "utf-8")).toBe(content);
			}
		} finally {
			cleanupDir(tmp);
		}
	});

	test("--force overwrites existing skill and agent files", async () => {
		const tmp = makeTmpDir();
		try {
			await bootstrapProject(tmp);

			// First install
			await harnessInstall({
				name: "opencode",
				scope: "project",
				startDir: tmp,
			});

			// Overwrite existing content in one skill file
			const skillPath = join(tmp, ".opencode", "skills", "5x-plan", "SKILL.md");
			writeFileSync(skillPath, "# custom content", "utf-8");

			// Second run with --force
			await harnessInstall({
				name: "opencode",
				scope: "project",
				force: true,
				startDir: tmp,
			});

			// File should be restored to bundled content
			const restored = readFileSync(skillPath, "utf-8");
			expect(restored).not.toBe("# custom content");
			expect(restored).toContain("5x-plan");
		} finally {
			cleanupDir(tmp);
		}
	});
});
