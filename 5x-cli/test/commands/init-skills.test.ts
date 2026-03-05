import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureSkills as ensureSkillsFromInit } from "../../src/commands/init.js";
import {
	ensureSkills,
	getDefaultSkillRaw,
	listSkillNames,
	listSkills,
} from "../../src/skills/loader.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

async function runInit(
	cwd: string,
	extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "init", ...extraArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("Skill loader", () => {
	test("listSkillNames returns all bundled skills", () => {
		const names = listSkillNames();
		expect(names).toContain("5x-plan");
		expect(names).toContain("5x-plan-review");
		expect(names).toContain("5x-phase-execution");
		expect(names.length).toBe(3);
	});

	test("listSkills returns metadata with content", () => {
		const skills = listSkills();
		expect(skills.length).toBe(3);

		const planSkill = skills.find((s) => s.name === "5x-plan");
		expect(planSkill).toBeDefined();
		expect(planSkill?.filename).toBe("5x-plan.md");
		expect(planSkill?.content).toContain("# Skill: 5x-plan");
		expect(planSkill?.content).toContain("## Workflow");
	});

	test("getDefaultSkillRaw returns skill content", () => {
		const content = getDefaultSkillRaw("5x-plan");
		expect(content).toContain("# Skill: 5x-plan");
		expect(content).toContain("## Prerequisites");
		expect(content).toContain("## Tools");
		expect(content).toContain("## Workflow");
	});

	test("getDefaultSkillRaw throws for unknown skill", () => {
		expect(() => getDefaultSkillRaw("unknown-skill")).toThrow(
			'Unknown skill "unknown-skill"',
		);
	});
});

describe("ensureSkills", () => {
	test("creates all bundled skills on first run", () => {
		const tmp = makeTmpDir();
		try {
			const result = ensureSkills(tmp, false);

			expect(result.created).toContain("5x-plan.md");
			expect(result.created).toContain("5x-plan-review.md");
			expect(result.created).toContain("5x-phase-execution.md");
			expect(result.skipped).toHaveLength(0);
			expect(result.overwritten).toHaveLength(0);

			// Verify files were written
			const skillsDir = join(tmp, ".5x", "skills");
			expect(existsSync(join(skillsDir, "5x-plan.md"))).toBe(true);
			expect(existsSync(join(skillsDir, "5x-plan-review.md"))).toBe(true);
			expect(existsSync(join(skillsDir, "5x-phase-execution.md"))).toBe(true);

			// Verify content matches bundled source
			const planContent = readFileSync(join(skillsDir, "5x-plan.md"), "utf-8");
			expect(planContent).toContain("# Skill: 5x-plan");
			expect(planContent).toBe(getDefaultSkillRaw("5x-plan"));
		} finally {
			cleanupDir(tmp);
		}
	});

	test("does not overwrite existing skills unless forced", () => {
		const tmp = makeTmpDir();
		const skillsDir = join(tmp, ".5x", "skills");
		const planPath = join(skillsDir, "5x-plan.md");

		try {
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(planPath, "CUSTOM SKILL CONTENT", "utf-8");

			const first = ensureSkills(tmp, false);
			expect(first.skipped).toContain("5x-plan.md");
			expect(readFileSync(planPath, "utf-8")).toBe("CUSTOM SKILL CONTENT");

			const second = ensureSkills(tmp, true);
			expect(second.overwritten).toContain("5x-plan.md");
			expect(readFileSync(planPath, "utf-8")).not.toBe("CUSTOM SKILL CONTENT");
			expect(readFileSync(planPath, "utf-8")).toContain("# Skill: 5x-plan");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("handles partial existing skills (some created, some skipped)", () => {
		const tmp = makeTmpDir();
		const skillsDir = join(tmp, ".5x", "skills");

		try {
			mkdirSync(skillsDir, { recursive: true });
			// Only create one existing skill
			writeFileSync(join(skillsDir, "5x-plan.md"), "EXISTING", "utf-8");

			const result = ensureSkills(tmp, false);

			expect(result.skipped).toContain("5x-plan.md");
			expect(result.created).toContain("5x-plan-review.md");
			expect(result.created).toContain("5x-phase-execution.md");
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("5x init skills scaffolding", () => {
	test("creates skills directory and files on init", async () => {
		const tmp = makeTmpDir();
		try {
			const { stdout, exitCode } = await runInit(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Created .5x/skills/5x-plan.md");
			expect(stdout).toContain("Created .5x/skills/5x-plan-review.md");
			expect(stdout).toContain("Created .5x/skills/5x-phase-execution.md");

			// Verify skills exist
			const skillsDir = join(tmp, ".5x", "skills");
			expect(existsSync(join(skillsDir, "5x-plan.md"))).toBe(true);
			expect(existsSync(join(skillsDir, "5x-plan-review.md"))).toBe(true);
			expect(existsSync(join(skillsDir, "5x-phase-execution.md"))).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("skips existing skills without --force", async () => {
		const tmp = makeTmpDir();
		const skillsDir = join(tmp, ".5x", "skills");

		try {
			// Pre-create a skill
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, "5x-plan.md"), "CUSTOM", "utf-8");

			const { stdout, exitCode } = await runInit(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain(
				"Skipped .5x/skills/5x-plan.md (already exists)",
			);
			expect(stdout).toContain("Created .5x/skills/5x-plan-review.md");

			// Verify custom skill was preserved
			expect(readFileSync(join(skillsDir, "5x-plan.md"), "utf-8")).toBe(
				"CUSTOM",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("overwrites existing skills with --force", async () => {
		const tmp = makeTmpDir();
		const skillsDir = join(tmp, ".5x", "skills");

		try {
			// Pre-create a skill
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, "5x-plan.md"), "CUSTOM", "utf-8");

			const { stdout, exitCode } = await runInit(tmp, ["--force"]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Overwrote .5x/skills/5x-plan.md");

			// Verify skill was overwritten
			expect(readFileSync(join(skillsDir, "5x-plan.md"), "utf-8")).not.toBe(
				"CUSTOM",
			);
			expect(readFileSync(join(skillsDir, "5x-plan.md"), "utf-8")).toContain(
				"# Skill: 5x-plan",
			);
		} finally {
			cleanupDir(tmp);
		}
	});
});

describe("ensureSkills from init module", () => {
	test("re-exported ensureSkills works correctly", () => {
		const tmp = makeTmpDir();
		try {
			const result = ensureSkillsFromInit(tmp, false);

			expect(result.created).toContain("5x-plan.md");
			expect(result.created).toContain("5x-plan-review.md");
			expect(result.created).toContain("5x-phase-execution.md");
		} finally {
			cleanupDir(tmp);
		}
	});
});
