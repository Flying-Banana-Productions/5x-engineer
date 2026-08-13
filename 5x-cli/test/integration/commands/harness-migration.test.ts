/**
 * Phase 8.2 migration coverage (201-harness-freshness).
 *
 * Pre-feature installs have no `.5x-manifest.json`. Deleting the manifest after
 * a normal install simulates that state: every fire point must emit exactly one
 * `unknown` / `no-manifest` warning, and a single `5x harness sync` establishes
 * the baseline.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MANIFEST_FILENAME } from "../../../src/harnesses/manifest.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

interface Project {
	dir: string;
	home: string;
	planPath: string;
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-harness-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

async function run5x(project: Project, args: string[]): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd: project.dir,
		env: { ...cleanGitEnv(), HOME: project.home },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function git(dir: string, args: string[]): void {
	Bun.spawnSync(["git", ...args], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function setupProject(): Promise<Project> {
	const dir = makeTmpDir();
	const home = join(dir, "fake-home");
	mkdirSync(home, { recursive: true });

	git(dir, ["init"]);
	git(dir, ["config", "user.email", "test@test.com"]);
	git(dir, ["config", "user.name", "Test"]);

	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "001-thing.md");
	writeFileSync(planPath, "# Thing\n\n## Phase 1: Setup\n\n- [ ] Do it\n");
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

	const project: Project = { dir, home, planPath };
	expect((await run5x(project, ["init"])).exitCode).toBe(0);

	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-m", "init"]);

	return project;
}

function parseEnvelope(stdout: string): {
	ok: boolean;
	data: Record<string, unknown>;
} {
	return JSON.parse(stdout) as { ok: boolean; data: Record<string, unknown> };
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * Install opencode project scope, then delete the manifest to simulate a
 * pre-feature (manifest-less) install.
 */
async function installThenDropManifest(project: Project): Promise<void> {
	expect(
		(await run5x(project, ["config", "set", "author.model", "test/model-A"]))
			.exitCode,
	).toBe(0);
	expect(
		(
			await run5x(project, [
				"harness",
				"install",
				"opencode",
				"--scope",
				"project",
			])
		).exitCode,
	).toBe(0);
	rmSync(join(project.dir, ".opencode", MANIFEST_FILENAME));
}

describe("pre-feature (manifest-less) install migration", () => {
	test(
		"each fire point warns unknown exactly once; one sync clears them",
		async () => {
			const project = await setupProject();
			try {
				await installThenDropManifest(project);

				const unknownLine =
					"opencode (project) assets have no manifest — freshness unknown";

				// --- run init ---
				const runInit = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(runInit.exitCode).toBe(0);
				expect(countOccurrences(runInit.stderr, unknownLine)).toBe(1);
				expect(runInit.stderr).toContain("fix        5x harness sync");
				const initEnvelope = parseEnvelope(runInit.stdout);
				expect(initEnvelope.ok).toBe(true);
				expect(initEnvelope.data.harness_freshness).toEqual([
					{
						harness: "opencode",
						scope: "project",
						status: "unknown",
						reason: "no-manifest",
					},
				]);

				// --- config set (baked key) ---
				const configSet = await run5x(project, [
					"config",
					"set",
					"author.model",
					"test/model-B",
				]);
				expect(configSet.exitCode).toBe(0);
				expect(countOccurrences(configSet.stderr, unknownLine)).toBe(1);
				expect(parseEnvelope(configSet.stdout).ok).toBe(true);

				// --- harness list ---
				const list = await run5x(project, ["harness", "list", "--text"]);
				expect(list.exitCode).toBe(0);
				expect(
					countOccurrences(list.stdout, "freshness: unknown (no-manifest)"),
				).toBe(1);

				// One sync adopts and clears the warning.
				const sync = await run5x(project, ["harness", "sync"]);
				expect(sync.exitCode).toBe(0);
				const syncEnvelope = parseEnvelope(sync.stdout);
				expect(syncEnvelope.ok).toBe(true);
				const results = (
					syncEnvelope.data as {
						results: { harness: string; scope: string; action: string }[];
					}
				).results;
				const opencode = results.find(
					(r) => r.harness === "opencode" && r.scope === "project",
				);
				expect(opencode?.action).toBe("adopted");

				const afterInit = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(afterInit.exitCode).toBe(0);
				expect(afterInit.stderr).not.toContain("freshness unknown");
				expect(afterInit.stderr).not.toContain("assets are stale");
				expect(
					parseEnvelope(afterInit.stdout).data.harness_freshness,
				).toBeUndefined();

				const afterList = await run5x(project, ["harness", "list", "--text"]);
				expect(afterList.stdout).toContain("freshness: fresh");
				expect(afterList.stdout).not.toContain("freshness: unknown");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 120000 },
	);
});
