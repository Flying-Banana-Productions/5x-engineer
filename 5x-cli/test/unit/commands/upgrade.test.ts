/**
 * Unit tests for upgrade handler — template upgrade behavior.
 *
 * Tests that the upgrade handler correctly auto-updates stale stock
 * prompt templates and warns about customized ones.
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
	test("auto-updates stale stock prompt templates during upgrade", async () => {
		const tmp = makeTmpDir();
		try {
			// Set up a minimal project with config
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			// Create .5x/templates/prompts/ with stale template
			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			const bundled = getDefaultTemplateRaw("author-next-phase");
			// Simulate pre-variable_defaults scaffolded copy
			const stale = bundled.replace(/variable_defaults:\n( {2}[^\n]+\n)*/g, "");
			writeFileSync(join(promptsDir, "author-next-phase.md"), stale);

			await runUpgrade({ startDir: tmp });

			// Template should have been auto-updated
			const updated = readFileSync(
				join(promptsDir, "author-next-phase.md"),
				"utf-8",
			);
			expect(updated).toBe(bundled);
			expect(updated).toContain("variable_defaults:");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("does not overwrite customized prompt templates during upgrade", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const promptsDir = join(tmp, ".5x", "templates", "prompts");
			mkdirSync(promptsDir, { recursive: true });

			// Write a customized template with different body
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
});
