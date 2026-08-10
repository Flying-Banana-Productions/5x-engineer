/**
 * Integration tests for the harness freshness fire points.
 *
 * Phase 5 (201-harness-freshness): `run init`, `config set`, and `harness list`
 * each surface a Tier 1 staleness signal; `invoke` deliberately does not (D5).
 *
 * Warnings are stderr-only, so every test also asserts the stdout envelope
 * stays parseable — the whole point of the stderr-first decision.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Project {
	dir: string;
	home: string;
	planPath: string;
}

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-freshness-fire-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * `HOME` is pinned to a temp dir so the developer's own user-scope harness
 * install never leaks a warning into these assertions.
 */
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

/** A committed git repo with `5x init` run, a plan file, and a fake HOME. */
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
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n.opencode/\n");

	const project: Project = { dir, home, planPath };
	expect((await run5x(project, ["init"])).exitCode).toBe(0);

	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-m", "init"]);

	return project;
}

async function setModel(project: Project, model: string): Promise<CmdResult> {
	return run5x(project, ["config", "set", "author.model", model]);
}

async function installOpencode(project: Project): Promise<CmdResult> {
	return run5x(project, [
		"harness",
		"install",
		"opencode",
		"--scope",
		"project",
		"--force",
	]);
}

function parseEnvelope(stdout: string): {
	ok: boolean;
	data: Record<string, unknown>;
} {
	return JSON.parse(stdout) as { ok: boolean; data: Record<string, unknown> };
}

/** Install opencode, then change the baked model so the install is stale. */
async function makeStale(project: Project): Promise<void> {
	expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
	expect((await installOpencode(project)).exitCode).toBe(0);
	expect((await setModel(project, "test/model-B")).exitCode).toBe(0);
}

// ---------------------------------------------------------------------------
// 5.1 — `run init`
// ---------------------------------------------------------------------------

describe("run init freshness fire point", () => {
	test(
		"a stale install warns on stderr and adds harness_freshness to the envelope",
		async () => {
			const project = await setupProject();
			try {
				await makeStale(project);

				const result = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(result.exitCode).toBe(0);

				expect(result.stderr).toContain("opencode (project) assets are stale");
				expect(result.stderr).toContain(
					"installed  author.model = test/model-A",
				);
				expect(result.stderr).toContain(
					"current    author.model = test/model-B",
				);
				expect(result.stderr).toContain("fix        5x harness sync");

				// stdout stays a parseable envelope; the new fields are additive.
				const envelope = parseEnvelope(result.stdout);
				expect(envelope.ok).toBe(true);
				expect(envelope.data.run_id).toBeDefined();
				expect(envelope.data.warnings).toEqual([
					"opencode (project) assets are stale",
				]);
				expect(envelope.data.harness_freshness).toEqual([
					{
						harness: "opencode",
						scope: "project",
						status: "stale",
						reason: "inputs-changed",
					},
				]);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"a fresh install is silent and leaves the envelope unchanged",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);

				const result = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(result.exitCode).toBe(0);
				expect(result.stderr).not.toContain("assets are");

				const envelope = parseEnvelope(result.stdout);
				expect(envelope.data.warnings).toBeUndefined();
				expect(envelope.data.harness_freshness).toBeUndefined();
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		'harness.freshnessWarnings = "off" suppresses stderr and the JSON fields',
		async () => {
			const project = await setupProject();
			try {
				await makeStale(project);
				expect(
					(
						await run5x(project, [
							"config",
							"set",
							"harness.freshnessWarnings",
							"off",
						])
					).exitCode,
				).toBe(0);

				const result = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(result.exitCode).toBe(0);
				expect(result.stderr).not.toContain("assets are stale");

				const envelope = parseEnvelope(result.stdout);
				expect(envelope.ok).toBe(true);
				expect(envelope.data.warnings).toBeUndefined();
				expect(envelope.data.harness_freshness).toBeUndefined();
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"a resumed run warns exactly once, like a new run",
		async () => {
			const project = await setupProject();
			try {
				await makeStale(project);

				const first = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(first.exitCode).toBe(0);

				const resumed = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(resumed.exitCode).toBe(0);

				const envelope = parseEnvelope(resumed.stdout);
				expect(envelope.data.resumed).toBe(true);
				expect(envelope.data.harness_freshness).toHaveLength(1);
				expect(
					resumed.stderr.split("opencode (project) assets are stale").length -
						1,
				).toBe(1);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

// ---------------------------------------------------------------------------
// 5.2 — `config set`
// ---------------------------------------------------------------------------

describe("config set freshness fire point", () => {
	test(
		"a baked key warns at the point of cause; a non-baked key stays silent",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);

				const baked = await setModel(project, "test/model-B");
				expect(baked.exitCode).toBe(0);
				expect(baked.stderr).toContain("opencode (project) assets are stale");
				expect(baked.stderr).toContain("fix        5x harness sync");
				expect(parseEnvelope(baked.stdout).ok).toBe(true);

				const unbaked = await run5x(project, [
					"config",
					"set",
					"maxStepsPerRun",
					"10",
				]);
				expect(unbaked.exitCode).toBe(0);
				expect(unbaked.stderr).not.toContain("assets are stale");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"unsetting a baked key warns too",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);

				const unset = await run5x(project, ["config", "unset", "author.model"]);
				expect(unset.exitCode).toBe(0);
				expect(unset.stderr).toContain("opencode (project) assets are stale");
				expect(unset.stderr).toContain("current    author.model = (unset)");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"a baked-key change with nothing installed stays silent",
		async () => {
			const project = await setupProject();
			try {
				const result = await setModel(project, "test/model-A");
				expect(result.exitCode).toBe(0);
				expect(result.stderr).not.toContain("assets are");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 60000 },
	);
});

// ---------------------------------------------------------------------------
// 5.3 — `harness list`
// ---------------------------------------------------------------------------

describe("harness list freshness column", () => {
	test(
		"shows stale after a model change and fresh once the baseline is re-established",
		async () => {
			const project = await setupProject();
			try {
				await makeStale(project);

				const stale = await run5x(project, ["harness", "list", "--text"]);
				expect(stale.exitCode).toBe(0);
				expect(stale.stdout).toContain("freshness: stale (inputs-changed)");

				// `harness install --force` is the Phase 3 way to re-baseline;
				// `5x harness sync` (Phase 6) becomes the one-step form.
				expect((await installOpencode(project)).exitCode).toBe(0);

				const fresh = await run5x(project, ["harness", "list", "--text"]);
				expect(fresh.exitCode).toBe(0);
				expect(fresh.stdout).toContain("freshness: fresh");
				expect(fresh.stdout).not.toContain("freshness: stale");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"JSON output carries freshness only for installed scopes",
		async () => {
			const project = await setupProject();
			try {
				await makeStale(project);

				const result = await run5x(project, ["harness", "list"]);
				expect(result.exitCode).toBe(0);

				const data = parseEnvelope(result.stdout).data as {
					harnesses: {
						name: string;
						scopes: Record<
							string,
							{ installed: boolean; freshness?: { status: string } }
						>;
					}[];
				};
				const opencode = data.harnesses.find((h) => h.name === "opencode");
				expect(opencode?.scopes.project?.freshness?.status).toBe("stale");
				expect(opencode?.scopes.user?.installed).toBe(false);
				expect(opencode?.scopes.user?.freshness).toBeUndefined();
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

// ---------------------------------------------------------------------------
// 5.4 — `invoke` is deliberately not a fire point (D5)
// ---------------------------------------------------------------------------

describe("invoke freshness silence", () => {
	test(
		"emits nothing about freshness on a stale install",
		async () => {
			const project = await setupProject();
			try {
				await makeStale(project);

				const init = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(init.exitCode).toBe(0);
				const runId = parseEnvelope(init.stdout).data.run_id as string;

				// Fails early on template resolution — enough to prove the handler
				// path emits no freshness output before doing any provider work.
				const invoke = await run5x(project, [
					"invoke",
					"author",
					"definitely-not-a-template",
					"--run",
					runId,
				]);
				expect(invoke.stderr).not.toContain("assets are stale");
				expect(invoke.stderr).not.toContain("5x harness sync");
				expect(invoke.stdout).not.toContain("harness_freshness");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});
