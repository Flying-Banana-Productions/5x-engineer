/**
 * Tests for harness asset installer helpers.
 *
 * Phase 2 (014-harness-native-subagent-orchestration).
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
import {
	installAgentFiles,
	installFiles,
	installSkillFiles,
} from "../../../src/harnesses/installer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
// installFiles tests
// ---------------------------------------------------------------------------

describe("installFiles", () => {
	test("creates files in the target directory", () => {
		const tmp = makeTmpDir();
		try {
			const targetDir = join(tmp, "target");
			const result = installFiles(
				targetDir,
				[
					{ filename: "foo.md", content: "foo content" },
					{ filename: "bar.md", content: "bar content" },
				],
				false,
			);

			expect(existsSync(join(targetDir, "foo.md"))).toBe(true);
			expect(existsSync(join(targetDir, "bar.md"))).toBe(true);
			expect(readFileSync(join(targetDir, "foo.md"), "utf-8")).toBe(
				"foo content",
			);
			expect(result.created).toContain("foo.md");
			expect(result.created).toContain("bar.md");
			expect(result.overwritten).toHaveLength(0);
			expect(result.skipped).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("creates target directory if it does not exist", () => {
		const tmp = makeTmpDir();
		try {
			const targetDir = join(tmp, "nested", "deep", "target");
			installFiles(
				targetDir,
				[{ filename: "test.md", content: "content" }],
				false,
			);
			expect(existsSync(targetDir)).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips existing files when force is false", () => {
		const tmp = makeTmpDir();
		try {
			const targetDir = join(tmp, "target");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "existing.md"), "ORIGINAL", "utf-8");

			const result = installFiles(
				targetDir,
				[{ filename: "existing.md", content: "NEW CONTENT" }],
				false,
			);

			expect(result.skipped).toContain("existing.md");
			expect(result.created).toHaveLength(0);
			// File should not be overwritten
			expect(readFileSync(join(targetDir, "existing.md"), "utf-8")).toBe(
				"ORIGINAL",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing files when force is true", () => {
		const tmp = makeTmpDir();
		try {
			const targetDir = join(tmp, "target");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "existing.md"), "ORIGINAL", "utf-8");

			const result = installFiles(
				targetDir,
				[{ filename: "existing.md", content: "NEW CONTENT" }],
				true,
			);

			expect(result.overwritten).toContain("existing.md");
			expect(result.created).toHaveLength(0);
			expect(result.skipped).toHaveLength(0);
			expect(readFileSync(join(targetDir, "existing.md"), "utf-8")).toBe(
				"NEW CONTENT",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("is idempotent — second call with same files skips all", () => {
		const tmp = makeTmpDir();
		try {
			const targetDir = join(tmp, "target");

			installFiles(
				targetDir,
				[{ filename: "a.md", content: "content" }],
				false,
			);
			const second = installFiles(
				targetDir,
				[{ filename: "a.md", content: "content" }],
				false,
			);

			expect(second.skipped).toContain("a.md");
			expect(second.created).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// installSkillFiles tests
// ---------------------------------------------------------------------------

describe("installSkillFiles", () => {
	test("installs skills as <name>/SKILL.md", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			const result = installSkillFiles(
				skillsDir,
				[
					{ name: "my-skill", content: "skill content" },
					{ name: "other-skill", content: "other content" },
				],
				false,
			);

			expect(existsSync(join(skillsDir, "my-skill", "SKILL.md"))).toBe(true);
			expect(existsSync(join(skillsDir, "other-skill", "SKILL.md"))).toBe(true);
			expect(result.created).toContain("my-skill/SKILL.md");
			expect(result.created).toContain("other-skill/SKILL.md");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips existing skills without --force", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			mkdirSync(join(skillsDir, "existing-skill"), { recursive: true });
			writeFileSync(
				join(skillsDir, "existing-skill", "SKILL.md"),
				"ORIGINAL",
				"utf-8",
			);

			const result = installSkillFiles(
				skillsDir,
				[{ name: "existing-skill", content: "NEW CONTENT" }],
				false,
			);

			expect(result.skipped).toContain("existing-skill/SKILL.md");
			expect(
				readFileSync(join(skillsDir, "existing-skill", "SKILL.md"), "utf-8"),
			).toBe("ORIGINAL");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing skills with --force", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			mkdirSync(join(skillsDir, "existing-skill"), { recursive: true });
			writeFileSync(
				join(skillsDir, "existing-skill", "SKILL.md"),
				"ORIGINAL",
				"utf-8",
			);

			const result = installSkillFiles(
				skillsDir,
				[{ name: "existing-skill", content: "NEW CONTENT" }],
				true,
			);

			expect(result.overwritten).toContain("existing-skill/SKILL.md");
			expect(
				readFileSync(join(skillsDir, "existing-skill", "SKILL.md"), "utf-8"),
			).toBe("NEW CONTENT");
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// installAgentFiles tests
// ---------------------------------------------------------------------------

describe("installAgentFiles", () => {
	test("installs agents as <name>.md files", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			const result = installAgentFiles(
				agentsDir,
				[
					{ name: "5x-reviewer", content: "reviewer content" },
					{ name: "5x-orchestrator", content: "orchestrator content" },
				],
				false,
			);

			expect(existsSync(join(agentsDir, "5x-reviewer.md"))).toBe(true);
			expect(existsSync(join(agentsDir, "5x-orchestrator.md"))).toBe(true);
			expect(result.created).toContain("5x-reviewer.md");
			expect(result.created).toContain("5x-orchestrator.md");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips existing agent files without --force", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "5x-reviewer.md"), "ORIGINAL", "utf-8");

			const result = installAgentFiles(
				agentsDir,
				[{ name: "5x-reviewer", content: "NEW CONTENT" }],
				false,
			);

			expect(result.skipped).toContain("5x-reviewer.md");
			expect(readFileSync(join(agentsDir, "5x-reviewer.md"), "utf-8")).toBe(
				"ORIGINAL",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing agent files with --force", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "5x-reviewer.md"), "ORIGINAL", "utf-8");

			const result = installAgentFiles(
				agentsDir,
				[{ name: "5x-reviewer", content: "NEW CONTENT" }],
				true,
			);

			expect(result.overwritten).toContain("5x-reviewer.md");
			expect(readFileSync(join(agentsDir, "5x-reviewer.md"), "utf-8")).toBe(
				"NEW CONTENT",
			);
		} finally {
			cleanupDir(tmp);
		}
	});
});
