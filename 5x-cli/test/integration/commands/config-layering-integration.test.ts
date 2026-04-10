/**
 * Integration tests for plan-path-anchored config layering (Phase 1c).
 *
 * Verifies that command handlers thread contextDir correctly so that
 * sub-project `5x.toml` overrides are used when the plan is under
 * a sub-project.
 *
 * Test matrix coverage:
 * - invoke --run for plan under sub-project: config from sub-project 5x.toml
 * - quality run --run for plan under sub-project: qualityGates from sub-project
 * - run init for plan under sub-project: sub-project settings
 * - Plan creation from sub-project cwd: paths from nearest 5x.toml
 * - Plan creation from repo root cwd: root paths
 *
 * Each test creates its own temp dirs with `finally` cleanup for concurrent safety.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const env = cleanGitEnv();
const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(prefix = "5x-cli-int"): string {
	const dir = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

/**
 * Set up a monorepo project with a root config and a sub-project config.
 * Root config has one set of quality gates, sub-project has different ones.
 */
function setupMonorepo(dir: string): {
	rootPlanPath: string;
	subPlanPath: string;
} {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);

	mkdirSync(join(dir, ".5x"), { recursive: true });
	const { Database } = require("bun:sqlite");
	new Database(join(dir, ".5x", "5x.db")).close();
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

	// Root config with root quality gates
	writeFileSync(
		join(dir, "5x.toml"),
		'qualityGates = ["echo root-gate"]\n\n[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
	);

	// Root plan
	const rootPlanDir = join(dir, "docs", "development");
	mkdirSync(rootPlanDir, { recursive: true });
	const rootPlanPath = join(rootPlanDir, "root-plan.md");
	writeFileSync(
		rootPlanPath,
		"# Root Plan\n\n## Phase 1: Setup\n\n- [ ] Task\n",
	);

	// Sub-project with its own config
	// paths.plans is relative to the config file's directory (sub-project/)
	const subDir = join(dir, "sub-project");
	mkdirSync(subDir, { recursive: true });
	writeFileSync(
		join(subDir, "5x.toml"),
		'qualityGates = ["echo sub-gate"]\n\n[paths]\nplans = "docs/development"\narchive = "docs/archive"\n',
	);

	// Sub-project plan
	const subPlanDir = join(subDir, "docs", "development");
	mkdirSync(subPlanDir, { recursive: true });
	const subPlanPath = join(subPlanDir, "sub-plan.md");
	writeFileSync(
		subPlanPath,
		"# Sub Plan\n\n## Phase 1: Setup\n\n- [ ] Sub Task\n",
	);

	git(["add", "-A"], dir);
	git(["commit", "-m", "init monorepo"], dir);

	return {
		rootPlanPath,
		subPlanPath,
	};
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(
	cwd: string,
	args: string[],
	timeoutMs = 15000,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill("SIGINT"), timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

function cleanup(dirs: string[]): void {
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
}

// ===========================================================================
// Config layering integration tests
// ===========================================================================

describe("config layering integration", () => {
	test(
		"quality run --run for plan under sub-project uses sub-project qualityGates",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { subPlanPath } = setupMonorepo(tmp);

				// Init a run with the sub-project plan
				const initResult = await run5x(tmp, [
					"run",
					"init",
					"--plan",
					subPlanPath,
				]);
				expect(initResult.exitCode).toBe(0);
				const initData = parseJson(initResult.stdout);
				const runId = (initData.data as { run_id: string }).run_id;

				// Run quality with --run targeting sub-project plan
				const result = await run5x(tmp, ["quality", "run", "--run", runId]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as {
					passed: boolean;
					results: { command: string; output?: string }[];
				};
				// Should have executed sub-project gates, not root gates
				expect(data.results.length).toBeGreaterThan(0);
				expect(data.results[0]?.command).toBe("echo sub-gate");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"quality run --run for plan at repo root uses root qualityGates",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { rootPlanPath } = setupMonorepo(tmp);

				// Init a run with the root plan
				const initResult = await run5x(tmp, [
					"run",
					"init",
					"--plan",
					rootPlanPath,
				]);
				expect(initResult.exitCode).toBe(0);
				const initData = parseJson(initResult.stdout);
				const runId = (initData.data as { run_id: string }).run_id;

				// Run quality with --run targeting root plan
				const result = await run5x(tmp, ["quality", "run", "--run", runId]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as {
					passed: boolean;
					results: { command: string; output?: string }[];
				};
				// Should have executed root gates, not sub-project gates
				expect(data.results.length).toBeGreaterThan(0);
				expect(data.results[0]?.command).toBe("echo root-gate");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --run for plan under sub-project resolves config from sub-project",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { subPlanPath } = setupMonorepo(tmp);

				// Init a run with the sub-project plan
				const initResult = await run5x(tmp, [
					"run",
					"init",
					"--plan",
					subPlanPath,
				]);
				expect(initResult.exitCode).toBe(0);
				const initData = parseJson(initResult.stdout);
				const runId = (initData.data as { run_id: string }).run_id;

				// Invoke should succeed with the sub-project plan context
				const result = await run5x(tmp, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					`plan_path=${subPlanPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				// The invoke succeeded using the sub-project config context
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run init for plan under sub-project uses sub-project settings",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupMonorepo(tmp);

				// The sub-project plan should be accepted and the run
				// should use settings from sub-project context
				const subPlanPath = join(
					tmp,
					"sub-project",
					"docs",
					"development",
					"sub-plan.md",
				);
				const result = await run5x(tmp, ["run", "init", "--plan", subPlanPath]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as { run_id: string };
				expect(data.run_id).toBeTruthy();

				// Verify the run was created in the root DB (single source of truth)
				const listResult = await run5x(tmp, ["run", "list"]);
				const listData = parseJson(listResult.stdout);
				const runs = (listData.data as { runs: { id: string }[] }).runs;
				expect(runs.some((r) => r.id === data.run_id)).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run init accepts a missing output plan path under sub-project paths.plans",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupMonorepo(tmp);
				// paths.plans is relative to the config file's directory (sub-project/)
				writeFileSync(
					join(tmp, "sub-project", "5x.toml"),
					'qualityGates = ["echo sub-gate"]\n\n[paths]\nplans = "plans/drafts"\n',
				);

				const outputPlanPath = join(
					tmp,
					"sub-project",
					"plans",
					"drafts",
					"generated-plan.md",
				);
				const result = await run5x(tmp, [
					"run",
					"init",
					"--plan",
					outputPlanPath,
					"--allow-dirty",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as { plan_path: string; run_id: string };
				expect(data.run_id).toBeTruthy();
				expect(data.plan_path).toBe(outputPlanPath);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"sub-project config inherits unset fields from root (deep merge)",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { subPlanPath } = setupMonorepo(tmp);

				// The sub-project 5x.toml only sets qualityGates.
				// It should inherit author.provider, author.model, etc. from root.
				// This is verified implicitly: invoke --run with the sub-project
				// plan should still work with the sample provider (defined in root).
				const initResult = await run5x(tmp, [
					"run",
					"init",
					"--plan",
					subPlanPath,
				]);
				const initData = parseJson(initResult.stdout);
				const runId = (initData.data as { run_id: string }).run_id;

				const result = await run5x(tmp, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					`plan_path=${subPlanPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				// If deep merge works, the sample provider (from root config)
				// should still be used. If merge failed, this would error.
				expect(json.ok).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 30000 },
	);
});

// ===========================================================================
// Config layering — path resolution
//
// Verifies that path-dependent commands (plan phases, plan list, plan archive,
// run state/list/relink) resolve config.paths.plans and config.paths.archive
// relative to the sub-project's config file when CWD is the sub-project.
// ===========================================================================

describe("config layering — path resolution", () => {
	test(
		"plan phases resolves bare filename from sub-project paths.plans",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupMonorepo(tmp);
				const subCwd = join(tmp, "sub-project");

				const result = await run5x(subCwd, ["plan", "phases", "sub-plan.md"]);
				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as { phases: unknown[] };
				expect(data.phases.length).toBeGreaterThan(0);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"plan list from sub-project CWD lists sub-project plans",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupMonorepo(tmp);
				const subCwd = join(tmp, "sub-project");

				const result = await run5x(subCwd, ["plan", "list"]);
				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as {
					plans_dir: string;
					plans: { plan_path: string }[];
				};
				// plans_dir should point to the sub-project's plans directory
				expect(data.plans_dir).toContain("sub-project");
				// Should find the sub-project plan, not the root plan
				const paths = data.plans.map((p) => p.plan_path);
				expect(paths.some((p) => p.includes("sub-plan"))).toBe(true);
				expect(paths.some((p) => p.includes("root-plan"))).toBe(false);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"plan archive from sub-project CWD archives to sub-project paths.archive",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { subPlanPath } = setupMonorepo(tmp);
				const subCwd = join(tmp, "sub-project");

				// Init + complete a run so the plan is archivable
				const init = await run5x(tmp, ["run", "init", "--plan", subPlanPath]);
				const runId = (parseJson(init.stdout).data as { run_id: string })
					.run_id;
				await run5x(tmp, ["run", "complete", "--run", runId]);

				// Archive using bare filename from sub-project CWD
				const result = await run5x(subCwd, ["plan", "archive", "sub-plan.md"]);
				expect(result.exitCode).toBe(0);

				// File should be in sub-project/docs/archive/, not root docs/archive/
				const subArchive = join(subCwd, "docs", "archive", "sub-plan.md");
				expect(existsSync(subArchive)).toBe(true);
				expect(existsSync(subPlanPath)).toBe(false);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"plan archive --all from sub-project CWD scans sub-project plans dir",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { subPlanPath } = setupMonorepo(tmp);
				const subCwd = join(tmp, "sub-project");

				// Init + complete a run for the sub-project plan
				const init = await run5x(tmp, ["run", "init", "--plan", subPlanPath]);
				const runId = (parseJson(init.stdout).data as { run_id: string })
					.run_id;
				await run5x(tmp, ["run", "complete", "--run", runId]);

				const result = await run5x(subCwd, ["plan", "archive", "--all"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					archived: { plan_path: string }[];
				};
				// Should archive sub-project plan, not root plan
				expect(data.archived.length).toBe(1);
				expect(data.archived[0]?.plan_path).toContain("sub-project");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"run state --plan resolves bare filename from sub-project paths.plans",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { subPlanPath } = setupMonorepo(tmp);
				const subCwd = join(tmp, "sub-project");

				const init = await run5x(tmp, ["run", "init", "--plan", subPlanPath]);
				const runId = (parseJson(init.stdout).data as { run_id: string })
					.run_id;

				// Query state using bare filename from sub-project CWD
				const result = await run5x(subCwd, [
					"run",
					"state",
					"--plan",
					"sub-plan.md",
				]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					run: { id: string };
				};
				expect(data.run.id).toBe(runId);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"run list --plan resolves bare filename from sub-project paths.plans",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { subPlanPath } = setupMonorepo(tmp);
				const subCwd = join(tmp, "sub-project");

				const init = await run5x(tmp, ["run", "init", "--plan", subPlanPath]);
				const runId = (parseJson(init.stdout).data as { run_id: string })
					.run_id;

				const result = await run5x(subCwd, [
					"run",
					"list",
					"--plan",
					"sub-plan.md",
				]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					runs: { id: string }[];
				};
				expect(data.runs.some((r) => r.id === runId)).toBe(true);
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"run relink --plan auto-search uses sub-project paths.plans",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { subPlanPath } = setupMonorepo(tmp);
				const subCwd = join(tmp, "sub-project");

				const init = await run5x(tmp, ["run", "init", "--plan", subPlanPath]);
				const runId = (parseJson(init.stdout).data as { run_id: string })
					.run_id;
				await run5x(tmp, ["run", "complete", "--run", runId]);

				// Auto-search from sub-project CWD should find the plan
				const result = await run5x(subCwd, [
					"run",
					"relink",
					"--run",
					runId,
					"--plan",
				]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					plan_path: string;
				};
				expect(data.plan_path).toContain("sub-project");
			} finally {
				cleanup([tmp]);
			}
		},
		{ timeout: 15000 },
	);
});
