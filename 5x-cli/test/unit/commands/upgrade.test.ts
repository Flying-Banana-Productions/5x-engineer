/**
 * Unit tests for upgrade handler — template upgrade behavior.
 *
 * Tests that the upgrade handler correctly reports diverged prompt templates
 * without auto-writing them.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpgrade } from "../../../src/commands/upgrade.handler.js";
import { getDefaultTemplateRaw } from "../../../src/templates/loader.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-upgrade-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

describe("runUpgrade — prompt template handling", () => {
	test("does not create prompt templates when none exist on disk", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			await runUpgrade({ startDir: tmp });

			// No prompts directory should be created
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			const { existsSync } = await import("node:fs");
			expect(existsSync(promptsDir)).toBe(false);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports diverged prompt templates without overwriting them", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// Write a modified template
			const customized =
				'---\nname: author-next-phase\nversion: 1\nvariables: [plan_path, phase_number, user_notes]\nstep_name: "author:implement"\n---\nMY CUSTOM BODY {{plan_path}} {{phase_number}} {{user_notes}}';
			writeFileSync(join(promptsDir, "author-next-phase.md"), customized);

			await runUpgrade({ startDir: tmp });

			// Template should NOT have been overwritten
			const content = readFileSync(
				join(promptsDir, "author-next-phase.md"),
				"utf-8",
			);
			expect(content).toBe(customized);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("does not report prompt templates that match bundled content", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// Write a template that matches the bundled version exactly
			const bundled = getDefaultTemplateRaw("author-next-phase");
			writeFileSync(join(promptsDir, "author-next-phase.md"), bundled);

			await runUpgrade({ startDir: tmp });

			// Template should remain unchanged
			const content = readFileSync(
				join(promptsDir, "author-next-phase.md"),
				"utf-8",
			);
			expect(content).toBe(bundled);
		} finally {
			cleanupDir(tmp);
		}
	});
});
