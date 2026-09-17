/**
 * Unit tests for upgrade handler — template upgrade behavior and CLI flags.
 *
 * Tests that the upgrade handler correctly reports diverged prompt templates
 * without auto-writing them, and that `--sync` / `--no-sync` are tri-state.
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

describe("runUpgrade — git attributes", () => {
	test("creates .gitattributes with the default records rule", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");
			await runUpgrade({ startDir: tmp });
			const ga = readFileSync(join(tmp, ".gitattributes"), "utf-8");
			expect(ga).toContain("docs/development/runs/**/*.jsonl merge=union");
			expect(existsSync(join(tmp, "docs", "development", "runs"))).toBe(false);
			expect(readFileSync(join(tmp, ".gitignore"), "utf-8")).toContain(
				"docs/development/runs/**/.txn.*",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("uses custom relative paths.records", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				`[paths]\nrecords = "custom/runs"\n`,
				"utf-8",
			);
			await runUpgrade({ startDir: tmp });
			const ga = readFileSync(join(tmp, ".gitattributes"), "utf-8");
			expect(ga).toContain("custom/runs/**/*.jsonl merge=union");
			expect(readFileSync(join(tmp, ".gitignore"), "utf-8")).toContain(
				"custom/runs/**/.txn.*",
			);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("uses custom absolute paths.records inside the repo", async () => {
		const tmp = makeTmpDir();
		try {
			const inside = join(tmp, "inside", "runs");
			writeFileSync(
				join(tmp, "5x.toml"),
				`[paths]\nrecords = ${JSON.stringify(inside)}\n`,
				"utf-8",
			);
			await runUpgrade({ startDir: tmp });
			const ga = readFileSync(join(tmp, ".gitattributes"), "utf-8");
			expect(ga).toContain("inside/runs/**/*.jsonl merge=union");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("append is idempotent and preserves unrelated attributes", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");
			writeFileSync(join(tmp, ".gitattributes"), "*.png filter=lfs\n", "utf-8");
			await runUpgrade({ startDir: tmp });
			await runUpgrade({ startDir: tmp });
			const ga = readFileSync(join(tmp, ".gitattributes"), "utf-8");
			expect(ga).toContain("*.png filter=lfs");
			expect(
				ga.match(/docs\/development\/runs\/\*\*\/\*\.jsonl merge=union/g)
					?.length,
			).toBe(1);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("outside paths.records fails at config load before attributes", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				`[paths]\nrecords = "/tmp/5x-records"\n`,
				"utf-8",
			);
			await expect(runUpgrade({ startDir: tmp })).rejects.toThrow(
				"RECORDS_ROOT_OUTSIDE_REPO",
			);
			expect(existsSync(join(tmp, ".gitattributes"))).toBe(false);
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
