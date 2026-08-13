/**
 * Unit tests for upgrade handler — template upgrade behavior and CLI flags.
 *
 * Tests that the upgrade handler correctly reports diverged prompt templates
 * without auto-writing them, and that `--sync` / `--no-sync` are tri-state.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@commander-js/extra-typings";
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

describe("upgrade --sync / --no-sync tri-state", () => {
	/**
	 * Same `--sync` / `--no-sync` pair `registerUpgrade` registers. Commander
	 * maps `--no-sync` → `sync: false` and leaves `sync` undefined when neither
	 * flag is passed — that tri-state is what makes "no flag ≠ `--sync`" work.
	 */
	async function parseUpgradeOpts(args: string[]): Promise<{ sync?: boolean }> {
		let captured: { sync?: boolean } = {};
		const program = new Command();
		program.exitOverride();
		program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
		program
			.command("upgrade")
			.option("--sync")
			.option("--no-sync")
			.action((opts) => {
				captured = { sync: opts.sync };
			});
		await program.parseAsync(["upgrade", ...args], { from: "user" });
		return captured;
	}

	test("neither flag leaves sync undefined (config-driven)", async () => {
		const opts = await parseUpgradeOpts([]);
		expect(opts.sync).toBeUndefined();
	});

	test("--sync sets sync: true", async () => {
		const opts = await parseUpgradeOpts(["--sync"]);
		expect(opts.sync).toBe(true);
	});

	test("--no-sync sets sync: false", async () => {
		const opts = await parseUpgradeOpts(["--no-sync"]);
		expect(opts.sync).toBe(false);
	});
});
