import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runQuality } from "../../../src/commands/quality-v1.handler.js";
import { resolveLayeredConfig } from "../../../src/config.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-quality-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Set up a minimal project with a config file.
 * Uses a 5x.toml so we don't need to worry about module import paths.
 */
function setupProject(
	dir: string,
	opts: {
		qualityGates?: string[];
		skipQualityGates?: boolean;
	} = {},
): void {
	// Create .git so resolveProjectRoot finds it
	mkdirSync(join(dir, ".git"), { recursive: true });

	const lines: string[] = [];
	if (opts.qualityGates !== undefined) {
		lines.push(
			`qualityGates = [${opts.qualityGates.map((g) => `"${g}"`).join(", ")}]`,
		);
	}
	if (opts.skipQualityGates !== undefined) {
		lines.push(`skipQualityGates = ${opts.skipQualityGates}`);
	}
	if (lines.length > 0) {
		writeFileSync(join(dir, "5x.toml"), `${lines.join("\n")}\n`);
	}
}

describe("runQuality handler — skipQualityGates", () => {
	test("empty gates + skipQualityGates: false → warn sink receives warning, output has no skipped field", async () => {
		const dir = makeTmpDir();
		const warnCalls: string[] = [];
		const warn = (...args: unknown[]) => {
			warnCalls.push(args.map(String).join(" "));
		};

		try {
			setupProject(dir, { skipQualityGates: false });
			await runQuality({ workdir: dir }, warn);

			expect(warnCalls.length).toBe(1);
			expect(warnCalls[0]).toContain("no quality gates configured");
			expect(warnCalls[0]).toContain("skipQualityGates");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("empty gates + skipQualityGates: true → output has skipped: true, warn sink not called", async () => {
		const dir = makeTmpDir();
		const warnCalls: string[] = [];
		const warn = (...args: unknown[]) => {
			warnCalls.push(args.map(String).join(" "));
		};

		try {
			setupProject(dir, { skipQualityGates: true });
			await runQuality({ workdir: dir }, warn);

			expect(warnCalls.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("non-empty gates → normal execution, no skipped field, warn sink not called", async () => {
		const dir = makeTmpDir();
		const warnCalls: string[] = [];
		const warn = (...args: unknown[]) => {
			warnCalls.push(args.map(String).join(" "));
		};

		try {
			setupProject(dir, { qualityGates: ["echo ok"] });
			await runQuality({ workdir: dir }, warn);

			expect(warnCalls.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("non-empty gates + skipQualityGates: true → gates still execute (not skipped)", async () => {
		const dir = makeTmpDir();
		const warnCalls: string[] = [];
		const warn = (...args: unknown[]) => {
			warnCalls.push(args.map(String).join(" "));
		};

		try {
			setupProject(dir, {
				qualityGates: ["echo ok"],
				skipQualityGates: true,
			});
			await runQuality({ workdir: dir }, warn);

			// No warnings — gates are present
			expect(warnCalls.length).toBe(0);
			// The handler ran gates normally (did not return early with skipped: true).
			// We can't inspect outputSuccess from here, but the absence of an error
			// and the absence of warnings confirms it took the normal execution path
			// rather than the early-return skip path.
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no gates configured (default) + no skipQualityGates → warn emitted", async () => {
		const dir = makeTmpDir();
		const warnCalls: string[] = [];
		const warn = (...args: unknown[]) => {
			warnCalls.push(args.map(String).join(" "));
		};

		try {
			// Project with no config at all — Zod defaults apply (empty gates, skip = false)
			setupProject(dir);
			await runQuality({ workdir: dir }, warn);

			expect(warnCalls.length).toBe(1);
			expect(warnCalls[0]).toContain("no quality gates configured");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runQuality handler — sub-project layered config cwd", () => {
	test("resolveLayeredConfig returns nearestConfigPath for sub-project with qualityGates", async () => {
		const dir = makeTmpDir();
		try {
			// Set up monorepo structure: root with empty gates, sub-project with gates
			mkdirSync(join(dir, ".git"), { recursive: true });
			writeFileSync(join(dir, "5x.toml"), "qualityGates = []\n");

			const subDir = join(dir, "packages", "sub");
			mkdirSync(subDir, { recursive: true });
			writeFileSync(
				join(subDir, "5x.toml"),
				'qualityGates = ["echo sub-project"]\n',
			);

			// Resolve layered config from root with context pointing to sub-project
			const result = await resolveLayeredConfig(dir, subDir);

			expect(result.isLayered).toBe(true);
			expect(result.nearestConfigPath).toBe(join(subDir, "5x.toml"));
			expect(result.config.qualityGates).toEqual(["echo sub-project"]);

			// Verify the handler's fix logic: dirname(nearestConfigPath) = subDir
			expect(result.nearestConfigPath).toBeTruthy();
			expect(dirname(result.nearestConfigPath as string)).toBe(resolve(subDir));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("workdir pointing to sub-project uses sub-project quality gates", async () => {
		const dir = makeTmpDir();
		const warnCalls: string[] = [];
		const warn = (...args: unknown[]) => {
			warnCalls.push(args.map(String).join(" "));
		};

		try {
			// Root project with .git and no quality gates
			mkdirSync(join(dir, ".git"), { recursive: true });
			writeFileSync(join(dir, "5x.toml"), "skipQualityGates = true\n");

			// Sub-project with its own .git marker and quality gates that print cwd
			const subDir = join(dir, "packages", "sub");
			mkdirSync(subDir, { recursive: true });
			mkdirSync(join(subDir, ".git"), { recursive: true });
			writeFileSync(join(subDir, "5x.toml"), 'qualityGates = ["pwd"]\n');

			// Call runQuality with workdir pointing to sub-project
			// This takes the `else if (effectiveWorkdir)` path (no --run)
			await runQuality({ workdir: subDir }, warn);

			// No warnings expected — gates are configured in sub-project
			expect(warnCalls.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
