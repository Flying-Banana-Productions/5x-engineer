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
import { parse as tomlParse } from "@decimalturn/toml-patch";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-upgrade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

async function runUpgrade(
	cwd: string,
	extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "upgrade", ...extraArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("5x upgrade", () => {
	test("creates 5x.toml with defaults when no config exists", async () => {
		const tmp = makeTmpDir();
		try {
			const { stdout, exitCode } = await runUpgrade(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Config:");
			expect(stdout).toContain("creating 5x.toml");
			expect(stdout).toContain("Database:");
			expect(stdout).toContain("Templates:");
			expect(stdout).toContain("Upgrade complete.");

			// TOML file was created
			const tomlPath = join(tmp, "5x.toml");
			expect(existsSync(tomlPath)).toBe(true);
			const parsed = tomlParse(readFileSync(tomlPath, "utf-8")) as Record<
				string,
				unknown
			>;
			expect(parsed.maxStepsPerRun).toBe(50);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("migrates 5x.config.js to 5x.toml", async () => {
		const tmp = makeTmpDir();
		try {
			const jsPath = join(tmp, "5x.config.js");
			writeFileSync(
				jsPath,
				`export default {
	maxAutoIterations: 20,
	author: { provider: "claude-code", adapter: "old-adapter" },
	qualityGates: ["bun test"],
};`,
				"utf-8",
			);

			const { stdout, exitCode } = await runUpgrade(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("Created 5x.toml from existing config");
			expect(stdout).toContain("5x.config.js");
			expect(stdout).toContain(".bak");
			expect(stdout).toContain('Renamed "maxAutoIterations"');

			// TOML file exists with migrated values
			const tomlPath = join(tmp, "5x.toml");
			expect(existsSync(tomlPath)).toBe(true);
			const parsed = tomlParse(readFileSync(tomlPath, "utf-8")) as Record<
				string,
				unknown
			>;
			expect(parsed.maxStepsPerRun).toBe(20);
			expect(parsed).not.toHaveProperty("maxAutoIterations");

			// JS file was renamed to .bak
			expect(existsSync(jsPath)).toBe(false);
			expect(existsSync(`${jsPath}.bak`)).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});

	test("reports 5x.toml as up-to-date when no changes needed", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(
				join(tmp, "5x.toml"),
				`maxStepsPerRun = 50\n\n[author]\nprovider = "opencode"\n`,
				"utf-8",
			);

			const { stdout, exitCode } = await runUpgrade(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("up-to-date");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("creates fresh database when none exists", async () => {
		const tmp = makeTmpDir();
		try {
			// Create a minimal config so DB path is resolved
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const { stdout, exitCode } = await runUpgrade(tmp);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("No database found");
		} finally {
			cleanupDir(tmp);
		}
	});

	test("refreshes templates", async () => {
		const tmp = makeTmpDir();
		try {
			writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

			const { stdout, exitCode } = await runUpgrade(tmp);

			expect(exitCode).toBe(0);
			// Templates should be created
			expect(stdout).toContain("Templates:");
			expect(
				existsSync(
					join(tmp, ".5x", "templates", "implementation-plan-template.md"),
				),
			).toBe(true);
		} finally {
			cleanupDir(tmp);
		}
	});
});
