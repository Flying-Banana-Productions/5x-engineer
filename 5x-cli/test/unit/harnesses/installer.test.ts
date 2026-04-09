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
	installRuleFiles,
	installSkillFiles,
	removeDirIfEmpty,
	removeStaleAgentFiles,
	uninstallAgentFiles,
	uninstallRuleFiles,
	uninstallSkillFiles,
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

	test("skips existing files when force is false and content matches", () => {
		const tmp = makeTmpDir();
		try {
			const targetDir = join(tmp, "target");
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(join(targetDir, "existing.md"), "SAME CONTENT", "utf-8");

			const result = installFiles(
				targetDir,
				[{ filename: "existing.md", content: "SAME CONTENT" }],
				false,
			);

			expect(result.skipped).toContain("existing.md");
			expect(result.created).toHaveLength(0);
			expect(result.overwritten).toHaveLength(0);
			// File should not be overwritten
			expect(readFileSync(join(targetDir, "existing.md"), "utf-8")).toBe(
				"SAME CONTENT",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing files when force is false but content differs", () => {
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

	test("skips existing skills without --force when content matches", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			mkdirSync(join(skillsDir, "existing-skill"), { recursive: true });
			writeFileSync(
				join(skillsDir, "existing-skill", "SKILL.md"),
				"SAME CONTENT",
				"utf-8",
			);

			const result = installSkillFiles(
				skillsDir,
				[{ name: "existing-skill", content: "SAME CONTENT" }],
				false,
			);

			expect(result.skipped).toContain("existing-skill/SKILL.md");
			expect(
				readFileSync(join(skillsDir, "existing-skill", "SKILL.md"), "utf-8"),
			).toBe("SAME CONTENT");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing skills without --force when content differs", () => {
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

			expect(result.overwritten).toContain("existing-skill/SKILL.md");
			expect(result.skipped).toHaveLength(0);
			expect(
				readFileSync(join(skillsDir, "existing-skill", "SKILL.md"), "utf-8"),
			).toBe("NEW CONTENT");
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

	test("skips existing agent files without --force when content matches", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(join(agentsDir, "5x-reviewer.md"), "SAME CONTENT", "utf-8");

			const result = installAgentFiles(
				agentsDir,
				[{ name: "5x-reviewer", content: "SAME CONTENT" }],
				false,
			);

			expect(result.skipped).toContain("5x-reviewer.md");
			expect(readFileSync(join(agentsDir, "5x-reviewer.md"), "utf-8")).toBe(
				"SAME CONTENT",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing agent files without --force when content differs", () => {
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

			expect(result.overwritten).toContain("5x-reviewer.md");
			expect(result.skipped).toHaveLength(0);
			expect(readFileSync(join(agentsDir, "5x-reviewer.md"), "utf-8")).toBe(
				"NEW CONTENT",
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

// ---------------------------------------------------------------------------
// installRuleFiles tests
// ---------------------------------------------------------------------------

describe("installRuleFiles", () => {
	test("installs rules as <name>.mdc files", () => {
		const tmp = makeTmpDir();
		try {
			const rulesDir = join(tmp, "rules");
			const result = installRuleFiles(
				rulesDir,
				[{ name: "5x-orchestrator", content: "rule content" }],
				false,
			);

			expect(existsSync(join(rulesDir, "5x-orchestrator.mdc"))).toBe(true);
			expect(result.created).toContain("5x-orchestrator.mdc");
			expect(result.overwritten).toHaveLength(0);
			expect(result.skipped).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips existing rule files without --force when content matches", () => {
		const tmp = makeTmpDir();
		try {
			const rulesDir = join(tmp, "rules");
			mkdirSync(rulesDir, { recursive: true });
			writeFileSync(
				join(rulesDir, "5x-orchestrator.mdc"),
				"SAME CONTENT",
				"utf-8",
			);

			const result = installRuleFiles(
				rulesDir,
				[{ name: "5x-orchestrator", content: "SAME CONTENT" }],
				false,
			);

			expect(result.skipped).toContain("5x-orchestrator.mdc");
			expect(readFileSync(join(rulesDir, "5x-orchestrator.mdc"), "utf-8")).toBe(
				"SAME CONTENT",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing rule files without --force when content differs", () => {
		const tmp = makeTmpDir();
		try {
			const rulesDir = join(tmp, "rules");
			mkdirSync(rulesDir, { recursive: true });
			writeFileSync(join(rulesDir, "5x-orchestrator.mdc"), "ORIGINAL", "utf-8");

			const result = installRuleFiles(
				rulesDir,
				[{ name: "5x-orchestrator", content: "NEW CONTENT" }],
				false,
			);

			expect(result.overwritten).toContain("5x-orchestrator.mdc");
			expect(result.skipped).toHaveLength(0);
			expect(readFileSync(join(rulesDir, "5x-orchestrator.mdc"), "utf-8")).toBe(
				"NEW CONTENT",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing rule files with --force", () => {
		const tmp = makeTmpDir();
		try {
			const rulesDir = join(tmp, "rules");
			mkdirSync(rulesDir, { recursive: true });
			writeFileSync(join(rulesDir, "5x-orchestrator.mdc"), "ORIGINAL", "utf-8");

			const result = installRuleFiles(
				rulesDir,
				[{ name: "5x-orchestrator", content: "NEW CONTENT" }],
				true,
			);

			expect(result.overwritten).toContain("5x-orchestrator.mdc");
			expect(readFileSync(join(rulesDir, "5x-orchestrator.mdc"), "utf-8")).toBe(
				"NEW CONTENT",
			);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// removeDirIfEmpty tests
// ---------------------------------------------------------------------------

describe("removeDirIfEmpty", () => {
	test("removes an empty directory", () => {
		const tmp = makeTmpDir();
		try {
			const emptyDir = join(tmp, "empty");
			mkdirSync(emptyDir);
			expect(existsSync(emptyDir)).toBe(true);

			removeDirIfEmpty(emptyDir);

			expect(existsSync(emptyDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("preserves a non-empty directory", () => {
		const tmp = makeTmpDir();
		try {
			const dir = join(tmp, "notempty");
			mkdirSync(dir);
			writeFileSync(join(dir, "file.txt"), "content", "utf-8");

			removeDirIfEmpty(dir);

			expect(existsSync(dir)).toBe(true);
			expect(existsSync(join(dir, "file.txt"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("no-ops on a missing directory", () => {
		const tmp = makeTmpDir();
		try {
			const missing = join(tmp, "does-not-exist");

			// Should not throw
			removeDirIfEmpty(missing);

			expect(existsSync(missing)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// uninstallSkillFiles tests
// ---------------------------------------------------------------------------

describe("uninstallSkillFiles", () => {
	test("removes known skill files", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			// Install first
			installSkillFiles(
				skillsDir,
				[
					{ name: "my-skill", content: "skill content" },
					{ name: "other-skill", content: "other content" },
				],
				false,
			);

			const result = uninstallSkillFiles(skillsDir, [
				"my-skill",
				"other-skill",
			]);

			expect(result.removed).toContain("my-skill/SKILL.md");
			expect(result.removed).toContain("other-skill/SKILL.md");
			expect(result.notFound).toHaveLength(0);
			expect(existsSync(join(skillsDir, "my-skill", "SKILL.md"))).toBe(false);
			expect(existsSync(join(skillsDir, "other-skill", "SKILL.md"))).toBe(
				false,
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports not-found for missing skills", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			mkdirSync(skillsDir, { recursive: true });

			const result = uninstallSkillFiles(skillsDir, ["nonexistent"]);

			expect(result.notFound).toContain("nonexistent/SKILL.md");
			expect(result.removed).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("cleans empty skill subdirectories", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			installSkillFiles(
				skillsDir,
				[{ name: "my-skill", content: "content" }],
				false,
			);

			uninstallSkillFiles(skillsDir, ["my-skill"]);

			// Skill subdir should be removed (was empty after SKILL.md deletion)
			expect(existsSync(join(skillsDir, "my-skill"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("cleans empty skills parent directory", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			installSkillFiles(
				skillsDir,
				[{ name: "only-skill", content: "content" }],
				false,
			);

			uninstallSkillFiles(skillsDir, ["only-skill"]);

			// Skills dir itself should be removed (empty after all skill dirs removed)
			expect(existsSync(skillsDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("leaves user-created files intact", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			// Install a skill
			installSkillFiles(
				skillsDir,
				[{ name: "my-skill", content: "content" }],
				false,
			);
			// Add a user-created file in the skill dir
			writeFileSync(
				join(skillsDir, "my-skill", "custom.md"),
				"user file",
				"utf-8",
			);

			uninstallSkillFiles(skillsDir, ["my-skill"]);

			// SKILL.md should be removed
			expect(existsSync(join(skillsDir, "my-skill", "SKILL.md"))).toBe(false);
			// User file should still exist
			expect(existsSync(join(skillsDir, "my-skill", "custom.md"))).toBe(true);
			// Skill subdir should NOT be removed (not empty)
			expect(existsSync(join(skillsDir, "my-skill"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("leaves non-empty parent dir intact", () => {
		const tmp = makeTmpDir();
		try {
			const skillsDir = join(tmp, "skills");
			installSkillFiles(
				skillsDir,
				[
					{ name: "skill-a", content: "content a" },
					{ name: "skill-b", content: "content b" },
				],
				false,
			);

			// Only uninstall one — parent dir should remain
			uninstallSkillFiles(skillsDir, ["skill-a"]);

			expect(existsSync(join(skillsDir, "skill-a"))).toBe(false);
			expect(existsSync(join(skillsDir, "skill-b", "SKILL.md"))).toBe(true);
			expect(existsSync(skillsDir)).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// uninstallAgentFiles tests
// ---------------------------------------------------------------------------

describe("uninstallAgentFiles", () => {
	test("removes known agent files", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			installAgentFiles(
				agentsDir,
				[
					{ name: "5x-reviewer", content: "reviewer content" },
					{ name: "5x-orchestrator", content: "orchestrator content" },
				],
				false,
			);

			const result = uninstallAgentFiles(agentsDir, [
				"5x-reviewer",
				"5x-orchestrator",
			]);

			expect(result.removed).toContain("5x-reviewer.md");
			expect(result.removed).toContain("5x-orchestrator.md");
			expect(result.notFound).toHaveLength(0);
			expect(existsSync(join(agentsDir, "5x-reviewer.md"))).toBe(false);
			expect(existsSync(join(agentsDir, "5x-orchestrator.md"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports not-found for missing agents", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			mkdirSync(agentsDir, { recursive: true });

			const result = uninstallAgentFiles(agentsDir, ["nonexistent"]);

			expect(result.notFound).toContain("nonexistent.md");
			expect(result.removed).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("cleans empty agents directory after removal", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			installAgentFiles(
				agentsDir,
				[{ name: "only-agent", content: "content" }],
				false,
			);

			uninstallAgentFiles(agentsDir, ["only-agent"]);

			expect(existsSync(agentsDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("leaves user-created files intact", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			installAgentFiles(
				agentsDir,
				[{ name: "5x-reviewer", content: "content" }],
				false,
			);
			// Add a user-created file
			writeFileSync(
				join(agentsDir, "my-custom-agent.md"),
				"user agent",
				"utf-8",
			);

			uninstallAgentFiles(agentsDir, ["5x-reviewer"]);

			// Managed file removed
			expect(existsSync(join(agentsDir, "5x-reviewer.md"))).toBe(false);
			// User file still exists
			expect(existsSync(join(agentsDir, "my-custom-agent.md"))).toBe(true);
			// Directory still exists (not empty)
			expect(existsSync(agentsDir)).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// uninstallRuleFiles tests
// ---------------------------------------------------------------------------

describe("uninstallRuleFiles", () => {
	test("removes known rule files", () => {
		const tmp = makeTmpDir();
		try {
			const rulesDir = join(tmp, "rules");
			installRuleFiles(
				rulesDir,
				[{ name: "5x-orchestrator", content: "rule content" }],
				false,
			);

			const result = uninstallRuleFiles(rulesDir, ["5x-orchestrator"]);

			expect(result.removed).toContain("5x-orchestrator.mdc");
			expect(result.notFound).toHaveLength(0);
			expect(existsSync(join(rulesDir, "5x-orchestrator.mdc"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports not-found for missing rules", () => {
		const tmp = makeTmpDir();
		try {
			const rulesDir = join(tmp, "rules");
			mkdirSync(rulesDir, { recursive: true });

			const result = uninstallRuleFiles(rulesDir, ["5x-orchestrator"]);

			expect(result.notFound).toContain("5x-orchestrator.mdc");
			expect(result.removed).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("cleans empty rules directory after removal", () => {
		const tmp = makeTmpDir();
		try {
			const rulesDir = join(tmp, "rules");
			installRuleFiles(
				rulesDir,
				[{ name: "5x-orchestrator", content: "rule content" }],
				false,
			);

			uninstallRuleFiles(rulesDir, ["5x-orchestrator"]);

			expect(existsSync(rulesDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// removeStaleAgentFiles tests
// ---------------------------------------------------------------------------

describe("removeStaleAgentFiles", () => {
	test("removes stale 5x-managed agent files not in keep-set", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			// Install 5x-managed agents
			installAgentFiles(
				agentsDir,
				[
					{ name: "5x-reviewer", content: "reviewer content" },
					{ name: "5x-plan-author", content: "plan author content" },
					{ name: "5x-code-author", content: "code author content" },
					{ name: "5x-orchestrator", content: "orchestrator content" },
				],
				false,
			);

			// Simulate mixed-mode transition: keep only reviewer and orchestrator
			const keepNames = ["5x-reviewer", "5x-orchestrator"];
			const managedNames = [
				"5x-reviewer",
				"5x-plan-author",
				"5x-code-author",
				"5x-orchestrator",
			];
			const removed = removeStaleAgentFiles(agentsDir, keepNames, managedNames);

			// Should have removed the stale author agents
			expect(removed).toContain("5x-plan-author.md");
			expect(removed).toContain("5x-code-author.md");
			expect(removed).toHaveLength(2);

			// Verify files are actually gone
			expect(existsSync(join(agentsDir, "5x-plan-author.md"))).toBe(false);
			expect(existsSync(join(agentsDir, "5x-code-author.md"))).toBe(false);

			// Kept files should remain
			expect(existsSync(join(agentsDir, "5x-reviewer.md"))).toBe(true);
			expect(existsSync(join(agentsDir, "5x-orchestrator.md"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("preserves user-authored and third-party agent files", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			// Install 5x-managed agents
			installAgentFiles(
				agentsDir,
				[
					{ name: "5x-reviewer", content: "reviewer content" },
					{ name: "5x-orchestrator", content: "orchestrator content" },
				],
				false,
			);

			// Add user-authored and third-party agents
			writeFileSync(
				join(agentsDir, "my-custom-agent.md"),
				"custom agent content",
				"utf-8",
			);
			writeFileSync(
				join(agentsDir, "third-party-helper.md"),
				"third party content",
				"utf-8",
			);

			// Simulate transition to invoke/invoke (only orchestrator kept)
			const keepNames = ["5x-orchestrator"];
			const managedNames = ["5x-reviewer", "5x-orchestrator"];
			const removed = removeStaleAgentFiles(agentsDir, keepNames, managedNames);

			// Should have removed only the stale 5x-managed file
			expect(removed).toContain("5x-reviewer.md");
			expect(removed).toHaveLength(1);

			// User-authored files should be preserved
			expect(existsSync(join(agentsDir, "my-custom-agent.md"))).toBe(true);
			expect(existsSync(join(agentsDir, "third-party-helper.md"))).toBe(true);

			// Orchestrator should remain
			expect(existsSync(join(agentsDir, "5x-orchestrator.md"))).toBe(true);

			// Reviewer should be removed
			expect(existsSync(join(agentsDir, "5x-reviewer.md"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("no-ops when agents directory does not exist", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "nonexistent", "agents");
			const removed = removeStaleAgentFiles(
				agentsDir,
				["5x-reviewer"],
				["5x-reviewer", "5x-orchestrator"],
			);
			expect(removed).toHaveLength(0);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("no-ops when all managed agents are in keep-set", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			installAgentFiles(
				agentsDir,
				[
					{ name: "5x-reviewer", content: "reviewer content" },
					{ name: "5x-orchestrator", content: "orchestrator content" },
				],
				false,
			);

			// Keep all managed agents
			const keepNames = ["5x-reviewer", "5x-orchestrator"];
			const managedNames = ["5x-reviewer", "5x-orchestrator"];
			const removed = removeStaleAgentFiles(agentsDir, keepNames, managedNames);

			expect(removed).toHaveLength(0);
			expect(existsSync(join(agentsDir, "5x-reviewer.md"))).toBe(true);
			expect(existsSync(join(agentsDir, "5x-orchestrator.md"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("cleans empty agents directory after removing all stale files", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			installAgentFiles(
				agentsDir,
				[{ name: "5x-reviewer", content: "reviewer content" }],
				false,
			);

			// Remove all managed agents (transition to invoke mode)
			const keepNames: string[] = [];
			const managedNames = ["5x-reviewer"];
			removeStaleAgentFiles(agentsDir, keepNames, managedNames);

			// Directory should be removed since it was empty
			expect(existsSync(agentsDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("preserves non-.md files in agents directory", () => {
		const tmp = makeTmpDir();
		try {
			const agentsDir = join(tmp, "agents");
			installAgentFiles(
				agentsDir,
				[{ name: "5x-reviewer", content: "reviewer content" }],
				false,
			);

			// Add non-.md files
			writeFileSync(join(agentsDir, "config.json"), "{}", "utf-8");
			writeFileSync(join(agentsDir, "notes.txt"), "notes", "utf-8");

			// Remove all managed agents
			const keepNames: string[] = [];
			const managedNames = ["5x-reviewer"];
			removeStaleAgentFiles(agentsDir, keepNames, managedNames);

			// Non-.md files should be preserved
			expect(existsSync(join(agentsDir, "config.json"))).toBe(true);
			expect(existsSync(join(agentsDir, "notes.txt"))).toBe(true);

			// Managed .md file should be removed
			expect(existsSync(join(agentsDir, "5x-reviewer.md"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});
});
