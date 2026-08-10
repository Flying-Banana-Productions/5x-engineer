/**
 * Integration tests for `5x harness sync` (Phase 6, 201-harness-freshness).
 *
 * The headline case is §1.1: `harness install` skips existing agent files, so
 * changing `author.model` and reinstalling refreshes the skills and leaves the
 * baked agent model stale. `sync` is the command that fixes it — and the only
 * one guaranteed to establish a `verified` freshness baseline.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type HarnessManifest,
	MANIFEST_FILENAME,
} from "../../../src/harnesses/manifest.js";
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

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-harness-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

/** `HOME` is pinned so a developer's own user-scope install never leaks in. */
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
	]);
}

function opencodePath(project: Project, ...parts: string[]): string {
	return join(project.dir, ".opencode", ...parts);
}

function readManifestFile(project: Project): HarnessManifest {
	return JSON.parse(
		readFileSync(opencodePath(project, MANIFEST_FILENAME), "utf-8"),
	) as HarnessManifest;
}

function readAuthorAgent(project: Project): string {
	return readFileSync(
		opencodePath(project, "agents", "5x-plan-author.md"),
		"utf-8",
	);
}

interface SyncScopeResult {
	harness: string;
	scope: string;
	root: string;
	action: string;
	before: string;
	changed: string[];
	removed: string[];
	preserved: string[];
	notes: string[];
}

function parseSync(stdout: string): SyncScopeResult[] {
	const envelope = JSON.parse(stdout) as {
		ok: boolean;
		data: { results: SyncScopeResult[]; sweptBundledOnly: boolean };
	};
	expect(envelope.ok).toBe(true);
	expect(envelope.data.sweptBundledOnly).toBe(true);
	return envelope.data.results;
}

function opencodeProject(results: SyncScopeResult[]): SyncScopeResult {
	const found = results.find(
		(r) => r.harness === "opencode" && r.scope === "project",
	);
	expect(found).toBeDefined();
	return found as SyncScopeResult;
}

/** mtime (ns) of every managed file plus the manifest, keyed by path. */
function snapshotMtimes(project: Project): Map<string, bigint> {
	const out = new Map<string, bigint>();
	for (const rel of [
		[MANIFEST_FILENAME],
		["agents", "5x-plan-author.md"],
		["agents", "5x-reviewer.md"],
		["skills", "5x", "SKILL.md"],
	]) {
		const path = opencodePath(project, ...rel);
		if (existsSync(path))
			out.set(path, statSync(path, { bigint: true }).mtimeNs);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 6.3 — the §1.1 regression
// ---------------------------------------------------------------------------

describe("sync refreshes baked agent models", () => {
	test(
		"a model change that install would skip is applied by sync and re-baselined",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				const skillBefore = readFileSync(
					opencodePath(project, "skills", "5x", "SKILL.md"),
					"utf-8",
				);

				expect((await setModel(project, "test/model-B")).exitCode).toBe(0);
				// The bug: the agent file is still baked from model A.
				expect(readAuthorAgent(project)).toContain("test/model-A");

				const sync = await run5x(project, ["harness", "sync"]);
				expect(sync.exitCode).toBe(0);
				const result = opencodeProject(parseSync(sync.stdout));
				expect(result.action).toBe("synced");
				expect(result.before).toBe("stale");
				expect(result.changed).toContain("agents/5x-plan-author.md");

				expect(readAuthorAgent(project)).toContain("test/model-B");
				expect(readAuthorAgent(project)).not.toContain("test/model-A");
				// The skill markdown does not vary with the model, so its bytes are
				// unchanged even though sync rewrote it.
				expect(
					readFileSync(
						opencodePath(project, "skills", "5x", "SKILL.md"),
						"utf-8",
					),
				).toBe(skillBefore);

				const manifest = readManifestFile(project);
				expect(manifest.baseline).toBe("verified");
				expect(manifest.inputs.authorModel).toBe("test/model-B");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

describe("no false-fresh via plain reinstall", () => {
	test(
		"a plain reinstall keeps warning until sync establishes the baseline",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				expect((await setModel(project, "test/model-B")).exitCode).toBe(0);

				// The folk remedy: reinstall without --force.
				expect((await installOpencode(project)).exitCode).toBe(0);
				expect(readAuthorAgent(project)).toContain("test/model-A");
				expect(readManifestFile(project).baseline).toBe("unverified");

				// Tier 1 must read `unknown`, never `fresh`.
				const list = await run5x(project, ["harness", "list", "--text"]);
				expect(list.stdout).toContain(
					"freshness: unknown (baseline-unverified)",
				);

				// And `run init` still warns.
				const runInit = await run5x(project, [
					"run",
					"init",
					"--plan",
					project.planPath,
					"--allow-dirty",
				]);
				expect(runInit.exitCode).toBe(0);
				expect(runInit.stderr).toContain(
					"opencode (project) assets are partially installed",
				);

				// Only sync flips it.
				const sync = await run5x(project, ["harness", "sync"]);
				expect(sync.exitCode).toBe(0);
				expect(opencodeProject(parseSync(sync.stdout)).action).toBe("synced");
				expect(readAuthorAgent(project)).toContain("test/model-B");
				expect(readManifestFile(project).baseline).toBe("verified");

				const after = await run5x(project, ["harness", "list", "--text"]);
				expect(after.stdout).toContain("freshness: fresh");
				expect(after.stdout).not.toContain("freshness: unknown");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 120000 },
	);
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe("sync idempotence", () => {
	test(
		"a second run reports skipped-fresh and touches nothing",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				expect((await run5x(project, ["harness", "sync"])).exitCode).toBe(0);

				const before = snapshotMtimes(project);
				const second = await run5x(project, ["harness", "sync"]);
				expect(second.exitCode).toBe(0);

				const result = opencodeProject(parseSync(second.stdout));
				expect(result.action).toBe("skipped-fresh");
				expect(result.changed).toEqual([]);
				expect(result.removed).toEqual([]);

				expect(snapshotMtimes(project)).toEqual(before);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

// ---------------------------------------------------------------------------
// Hand-edits
// ---------------------------------------------------------------------------

describe("sync and hand-edited assets", () => {
	test(
		"preserves a hand-edit without --force and overwrites it with --force",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);

				const agentPath = opencodePath(project, "agents", "5x-plan-author.md");
				writeFileSync(
					agentPath,
					`${readFileSync(agentPath, "utf-8")}\n<!-- hand edit -->\n`,
				);

				const blocked = await run5x(project, ["harness", "sync"]);
				// Every target was blocked, so the sync failed rather than quietly
				// reporting success.
				expect(blocked.exitCode).toBe(2);
				const error = JSON.parse(blocked.stdout) as {
					ok: boolean;
					error: { code: string; detail: { results: SyncScopeResult[] } };
				};
				expect(error.ok).toBe(false);
				expect(error.error.code).toBe("HARNESS_ASSETS_MODIFIED");
				expect(opencodeProject(error.error.detail.results).action).toBe(
					"skipped-modified",
				);
				expect(opencodeProject(error.error.detail.results).preserved).toContain(
					"agents/5x-plan-author.md",
				);
				expect(readFileSync(agentPath, "utf-8")).toContain(
					"<!-- hand edit -->",
				);

				const forced = await run5x(project, ["harness", "sync", "--force"]);
				expect(forced.exitCode).toBe(0);
				expect(opencodeProject(parseSync(forced.stdout)).action).toBe("synced");
				expect(readFileSync(agentPath, "utf-8")).not.toContain(
					"<!-- hand edit -->",
				);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

describe("sync adopts a manifest-less install", () => {
	test(
		"force-installs, writes a verified manifest, and lists what it overwrote",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				rmSync(opencodePath(project, MANIFEST_FILENAME));

				const sync = await run5x(project, ["harness", "sync"]);
				expect(sync.exitCode).toBe(0);

				const result = opencodeProject(parseSync(sync.stdout));
				expect(result.action).toBe("adopted");
				expect(result.before).toBe("unknown");
				// Legibility is the mitigation: without a recorded hash a hand-edit is
				// indistinguishable from config drift, so every path is listed.
				expect(result.changed).toContain("agents/5x-plan-author.md");
				expect(result.changed).toContain("skills/5x/SKILL.md");
				expect(result.notes.join(" ")).toContain("adopted");

				expect(readManifestFile(project).baseline).toBe("verified");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

describe("sync --check", () => {
	test(
		"reports the deltas a real sync would apply and writes nothing",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				expect((await setModel(project, "test/model-B")).exitCode).toBe(0);

				const before = snapshotMtimes(project);
				const manifestBefore = readFileSync(
					opencodePath(project, MANIFEST_FILENAME),
					"utf-8",
				);

				const check = await run5x(project, ["harness", "sync", "--check"]);
				expect(check.exitCode).toBe(0);

				const result = opencodeProject(parseSync(check.stdout));
				expect(result.action).toBe("checked");
				expect(result.before).toBe("stale");
				expect(result.changed).toContain("agents/5x-plan-author.md");

				expect(snapshotMtimes(project)).toEqual(before);
				expect(
					readFileSync(opencodePath(project, MANIFEST_FILENAME), "utf-8"),
				).toBe(manifestBefore);
				expect(readAuthorAgent(project)).toContain("test/model-A");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

describe("sync --check over a manifest-less install", () => {
	test(
		"reports the assets adoption would overwrite instead of an empty change set",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				rmSync(opencodePath(project, MANIFEST_FILENAME));

				const before = snapshotMtimes(project);
				const check = await run5x(project, ["harness", "sync", "--check"]);
				expect(check.exitCode).toBe(0);

				const result = opencodeProject(parseSync(check.stdout));
				expect(result.action).toBe("checked");
				expect(result.before).toBe("unknown");
				// There are no recorded hashes to diff against, but a real sync would
				// still force-overwrite every managed asset and adopt a baseline —
				// `--check` must say so rather than report nothing.
				expect(result.changed).toContain("agents/5x-plan-author.md");
				expect(result.changed).toContain("skills/5x/SKILL.md");
				expect(result.notes.join(" ")).toContain("adopt");

				// Still a report, not a write.
				expect(snapshotMtimes(project)).toEqual(before);
				expect(existsSync(opencodePath(project, MANIFEST_FILENAME))).toBe(
					false,
				);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"the checked change set matches what the following real sync reports",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				rmSync(opencodePath(project, MANIFEST_FILENAME));

				const check = await run5x(project, ["harness", "sync", "--check"]);
				expect(check.exitCode).toBe(0);
				const checked = opencodeProject(parseSync(check.stdout));

				const sync = await run5x(project, ["harness", "sync"]);
				expect(sync.exitCode).toBe(0);
				const applied = opencodeProject(parseSync(sync.stdout));

				expect(applied.action).toBe("adopted");
				expect([...checked.changed].sort()).toEqual(
					[...applied.changed].sort(),
				);
				expect([...checked.removed].sort()).toEqual(
					[...applied.removed].sort(),
				);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 120000 },
	);
});

describe("sync --check reports pending removals", () => {
	test(
		"a native → invoke change lists the agents sync would sweep",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				expect(
					(
						await run5x(project, [
							"config",
							"set",
							"author.delegationMode",
							"invoke",
						])
					).exitCode,
				).toBe(0);

				const check = await run5x(project, ["harness", "sync", "--check"]);
				expect(check.exitCode).toBe(0);
				const result = opencodeProject(parseSync(check.stdout));
				expect(result.removed).toContain("agents/5x-plan-author.md");
				expect(result.removed).toContain("agents/5x-code-author.md");
				// The reviewer agent is still rendered, so it is rewritten, not swept.
				expect(result.removed).not.toContain("agents/5x-reviewer.md");
				expect(result.changed).toContain("agents/5x-reviewer.md");

				// The file is still there — `--check` only reports.
				expect(
					existsSync(opencodePath(project, "agents", "5x-plan-author.md")),
				).toBe(true);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

// ---------------------------------------------------------------------------
// Delegation-mode transition
// ---------------------------------------------------------------------------

describe("sync removes orphaned agents on a delegation-mode change", () => {
	test(
		"native → invoke drops the author agents and only those",
		async () => {
			const project = await setupProject();
			try {
				expect((await setModel(project, "test/model-A")).exitCode).toBe(0);
				expect((await installOpencode(project)).exitCode).toBe(0);
				expect(
					existsSync(opencodePath(project, "agents", "5x-plan-author.md")),
				).toBe(true);

				expect(
					(
						await run5x(project, [
							"config",
							"set",
							"author.delegationMode",
							"invoke",
						])
					).exitCode,
				).toBe(0);

				const sync = await run5x(project, ["harness", "sync"]);
				expect(sync.exitCode).toBe(0);
				const result = opencodeProject(parseSync(sync.stdout));
				expect(result.removed).toContain("agents/5x-plan-author.md");
				expect(result.removed).toContain("agents/5x-code-author.md");

				expect(
					existsSync(opencodePath(project, "agents", "5x-plan-author.md")),
				).toBe(false);
				// The reviewer role did not change, so its agent survives.
				expect(
					existsSync(opencodePath(project, "agents", "5x-reviewer.md")),
				).toBe(true);
				expect(readManifestFile(project).baseline).toBe("verified");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);
});

// ---------------------------------------------------------------------------
// 6.2 — CLI wiring
// ---------------------------------------------------------------------------

describe("5x harness sync --help", () => {
	test(
		"lists the flags and examples",
		async () => {
			const project = await setupProject();
			try {
				const help = await run5x(project, ["harness", "sync", "--help"]);
				expect(help.exitCode).toBe(0);
				expect(help.stdout).toContain("--check");
				expect(help.stdout).toContain("--force");
				expect(help.stdout).toContain("-s, --scope <scope>");
				expect(help.stdout).toContain("5x harness sync opencode -s project");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 60000 },
	);
});
