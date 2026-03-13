/**
 * Unit tests for skills uninstall handler — direct function calls, filesystem assertions only.
 *
 * Tests use startDir and homeDir overrides pointing to temp directories —
 * no process-wide env mutation or real home directory writes.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsInstall, skillsUninstall } from "../../../src/commands/skills.handler.js";
import { listSkillNames } from "../../../src/skills/loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-skills-uninstall-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
// `skillsUninstall` — project scope
// ---------------------------------------------------------------------------

describe("skillsUninstall project scope", () => {
	test("removes all installed skill files from project scope", async () => {
		const tmp = makeTmpDir();
		try {
			// First install with startDir
			await skillsInstall({ scope: "project", installRoot: ".agents", startDir: tmp });

			// Verify files exist
			const skillNames = listSkillNames();
			for (const name of skillNames) {
				expect(existsSync(join(tmp, ".agents", "skills", name, "SKILL.md"))).toBe(true);
			}

			// Uninstall
			const output = await skillsUninstall({
				scope: "project",
				startDir: tmp,
			});

			// Verify files removed
			for (const name of skillNames) {
				expect(existsSync(join(tmp, ".agents", "skills", name, "SKILL.md"))).toBe(false);
			}

			// Verify output
			expect(output.scope).toBe("project");
			expect(output.scopes.project).toBeDefined();
			expect(output.scopes.project?.removed.length).toBe(skillNames.length);
			expect(output.scopes.user).toBeUndefined();
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports not-found gracefully when files are missing", async () => {
		const tmp = makeTmpDir();
		try {
			// Uninstall without installing first
			const output = await skillsUninstall({
				scope: "project",
				startDir: tmp,
			});

			const skillNames = listSkillNames();

			expect(output.scopes.project).toBeDefined();
			expect(output.scopes.project?.removed).toHaveLength(0);
			expect(output.scopes.project?.notFound.length).toBe(skillNames.length);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("cleans up empty directories after removal", async () => {
		const tmp = makeTmpDir();
		try {
			// Install then uninstall with startDir
			await skillsInstall({ scope: "project", installRoot: ".agents", startDir: tmp });
			await skillsUninstall({ scope: "project", startDir: tmp });

			// Verify directories are cleaned up
			expect(existsSync(join(tmp, ".agents", "skills"))).toBe(false);
			expect(existsSync(join(tmp, ".agents"))).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("respects --install-root override", async () => {
		const tmp = makeTmpDir();
		try {
			// Install with custom root and startDir
			await skillsInstall({ scope: "project", installRoot: ".claude", startDir: tmp });

			// Verify files exist
			const skillNames = listSkillNames();
			for (const name of skillNames) {
				expect(existsSync(join(tmp, ".claude", "skills", name, "SKILL.md"))).toBe(true);
			}

			// Uninstall with same custom root
			const output = await skillsUninstall({
				scope: "project",
				installRoot: ".claude",
				startDir: tmp,
			});

			// Verify files removed
			for (const name of skillNames) {
				expect(existsSync(join(tmp, ".claude", "skills", name, "SKILL.md"))).toBe(false);
			}

			expect(output.installRoot).toBe(".claude");
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// `skillsUninstall` — user scope
// ---------------------------------------------------------------------------

describe("skillsUninstall user scope", () => {
	test("removes all installed skill files from user scope", async () => {
		const tmp = makeTmpDir();
		const fakeHome = makeTmpDir();
		try {
			// Install to fake home with homeDir override
			await skillsInstall({ scope: "user", installRoot: ".agents", homeDir: fakeHome });

			// Verify files exist
			const skillNames = listSkillNames();
			for (const name of skillNames) {
				expect(existsSync(join(fakeHome, ".agents", "skills", name, "SKILL.md"))).toBe(true);
			}

			// Uninstall from fake home
			const output = await skillsUninstall({
				scope: "user",
				homeDir: fakeHome,
			});

			// Verify files removed
			for (const name of skillNames) {
				expect(existsSync(join(fakeHome, ".agents", "skills", name, "SKILL.md"))).toBe(false);
			}

			expect(output.scope).toBe("user");
			expect(output.scopes.user).toBeDefined();
			expect(output.scopes.user?.removed.length).toBe(skillNames.length);
			expect(output.scopes.project).toBeUndefined();
		} finally {
			cleanupDir(tmp);
			cleanupDir(fakeHome);
		}
	});

	test("cleans up empty directories after removal (user scope)", async () => {
		const tmp = makeTmpDir();
		const fakeHome = makeTmpDir();
		try {
			// Install then uninstall with homeDir override
			await skillsInstall({ scope: "user", installRoot: ".agents", homeDir: fakeHome });
			await skillsUninstall({ scope: "user", homeDir: fakeHome });

			// Verify directories are cleaned up
			expect(existsSync(join(fakeHome, ".agents", "skills"))).toBe(false);
			expect(existsSync(join(fakeHome, ".agents"))).toBe(false);
		} finally {
			cleanupDir(tmp);
			cleanupDir(fakeHome);
		}
	});
});

// ---------------------------------------------------------------------------
// `skillsUninstall` — all scope
// ---------------------------------------------------------------------------

describe("skillsUninstall all scope", () => {
	test("removes from both user and project scopes", async () => {
		const tmp = makeTmpDir();
		const fakeHome = makeTmpDir();
		try {
			// Install to both scopes with proper overrides
			await skillsInstall({ scope: "project", installRoot: ".agents", startDir: tmp });
			await skillsInstall({ scope: "user", installRoot: ".agents", homeDir: fakeHome });

			const skillNames = listSkillNames();

			// Verify both scopes have files
			for (const name of skillNames) {
				expect(existsSync(join(tmp, ".agents", "skills", name, "SKILL.md"))).toBe(true);
				expect(existsSync(join(fakeHome, ".agents", "skills", name, "SKILL.md"))).toBe(true);
			}

			// Uninstall all
			const output = await skillsUninstall({
				scope: "all",
				startDir: tmp,
				homeDir: fakeHome,
			});

			// Verify both scopes are empty
			for (const name of skillNames) {
				expect(existsSync(join(tmp, ".agents", "skills", name, "SKILL.md"))).toBe(false);
				expect(existsSync(join(fakeHome, ".agents", "skills", name, "SKILL.md"))).toBe(false);
			}

			expect(output.scope).toBe("all");
			expect(output.scopes.project).toBeDefined();
			expect(output.scopes.user).toBeDefined();
			expect(output.scopes.project?.removed.length).toBe(skillNames.length);
			expect(output.scopes.user?.removed.length).toBe(skillNames.length);
		} finally {
			cleanupDir(tmp);
			cleanupDir(fakeHome);
		}
	});

	test("handles mixed state (one scope installed, one not)", async () => {
		const tmp = makeTmpDir();
		const fakeHome = makeTmpDir();
		try {
			// Only install to project scope with startDir
			await skillsInstall({ scope: "project", installRoot: ".agents", startDir: tmp });

			const skillNames = listSkillNames();

			// Uninstall all
			const output = await skillsUninstall({
				scope: "all",
				startDir: tmp,
				homeDir: fakeHome,
			});

			// Project scope should report removed
			expect(output.scopes.project?.removed.length).toBe(skillNames.length);
			expect(output.scopes.project?.notFound).toHaveLength(0);

			// User scope should report not-found
			expect(output.scopes.user?.removed).toHaveLength(0);
			expect(output.scopes.user?.notFound.length).toBe(skillNames.length);
		} finally {
			cleanupDir(tmp);
			cleanupDir(fakeHome);
		}
	});
});

// ---------------------------------------------------------------------------
// `skillsUninstall` — user-created file preservation
// ---------------------------------------------------------------------------

describe("skillsUninstall preserves user-created files", () => {
	test("preserves user-created files in skills directory", async () => {
		const tmp = makeTmpDir();
		try {
			// Install bundled skills with startDir
			await skillsInstall({ scope: "project", installRoot: ".agents", startDir: tmp });

			// Create a user-created skill directory with files
			const customSkillDir = join(tmp, ".agents", "skills", "my-custom-skill");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(join(customSkillDir, "SKILL.md"), "# Custom Skill", "utf-8");
			writeFileSync(join(customSkillDir, "extra.txt"), "extra file", "utf-8");

			// Uninstall bundled skills
			await skillsUninstall({ scope: "project", startDir: tmp });

			// User-created skill should remain
			expect(existsSync(join(customSkillDir, "SKILL.md"))).toBe(true);
			expect(existsSync(join(customSkillDir, "extra.txt"))).toBe(true);

			// The skills directory should still exist (not empty due to custom skill)
			expect(existsSync(join(tmp, ".agents", "skills"))).toBe(true);
			expect(existsSync(join(tmp, ".agents"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("preserves user-created files inside bundled skill directories", async () => {
		const tmp = makeTmpDir();
		try {
			// Install bundled skills with startDir
			await skillsInstall({ scope: "project", installRoot: ".agents", startDir: tmp });

			// Add an extra file to a bundled skill directory
			const skillDir = join(tmp, ".agents", "skills", "5x-plan");
			writeFileSync(join(skillDir, "custom.txt"), "custom file", "utf-8");

			// Uninstall bundled skills
			await skillsUninstall({ scope: "project", startDir: tmp });

			// The SKILL.md should be removed
			expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);

			// But custom.txt should remain (directory not empty, so not removed)
			expect(existsSync(join(skillDir, "custom.txt"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});
});

// ---------------------------------------------------------------------------
// `skillsUninstall` — validation
// ---------------------------------------------------------------------------

describe("skillsUninstall validation", () => {
	test("throws on invalid scope value", async () => {
		const tmp = makeTmpDir();
		try {
			await expect(
				skillsUninstall({
					scope: "global" as "all",
					startDir: tmp,
				}),
			).rejects.toThrow("Invalid scope");
		} finally {
			cleanupDir(tmp);
		}
	});
});
