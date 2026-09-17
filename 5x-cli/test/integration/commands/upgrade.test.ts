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
import { parse as tomlParse } from "@decimalturn/toml-patch";
import {
	computeFingerprint,
	type HarnessManifest,
	MANIFEST_FILENAME,
} from "../../../src/harnesses/manifest.js";
import { getDefaultTemplateRaw } from "../../../src/templates/loader.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

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
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

async function runUpgrade(
	cwd: string,
	extraArgs: string[] = [],
	homeDir?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "upgrade", ...extraArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: {
			...cleanGitEnv(),
			...(homeDir ? { HOME: homeDir } : {}),
		},
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

describe("5x upgrade", () => {
	test(
		"does not create 5x.toml when no config exists",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runUpgrade(tmp);

				expect(exitCode).toBe(0);
				expect(stdout).toContain("Config:");
				expect(stdout).toContain("skipping config upgrade");
				expect(stdout).toContain("Database:");
				expect(stdout).toContain("Templates:");
				expect(stdout).toContain("Git attributes:");
				expect(stdout).toContain("Upgrade complete.");

				expect(existsSync(join(tmp, "5x.toml"))).toBe(false);
				expect(existsSync(join(tmp, ".gitattributes"))).toBe(true);
				expect(readFileSync(join(tmp, ".gitattributes"), "utf-8")).toContain(
					"docs/development/runs/**/*.jsonl merge=union",
				);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"writes merge=union gitattributes for a custom records path",
		async () => {
			const tmp = makeTmpDir();
			try {
				writeFileSync(
					join(tmp, "5x.toml"),
					`[paths]\nrecords = "custom/runs"\n`,
					"utf-8",
				);
				const { stdout, exitCode } = await runUpgrade(tmp);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("Git attributes:");
				expect(readFileSync(join(tmp, ".gitattributes"), "utf-8")).toContain(
					"custom/runs/**/*.jsonl merge=union",
				);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"migrates 5x.config.js to 5x.toml",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"reports 5x.toml as up-to-date when no changes needed",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"creates fresh database when none exists",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"refreshes artifact templates",
		async () => {
			const tmp = makeTmpDir();
			try {
				writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

				const { stdout, exitCode } = await runUpgrade(tmp);

				expect(exitCode).toBe(0);
				expect(stdout).toContain("Templates:");
				expect(
					existsSync(
						join(tmp, ".5x", "templates", "implementation-plan-template.md"),
					),
				).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"does not create prompt templates when none exist on disk",
		async () => {
			const tmp = makeTmpDir();
			try {
				writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

				const { stdout, exitCode } = await runUpgrade(tmp);

				expect(exitCode).toBe(0);
				// No prompts directory should be created
				expect(existsSync(join(tmp, ".5x", "templates", "prompts"))).toBe(
					false,
				);
				// Should report templates as up-to-date
				expect(stdout).toContain("up-to-date");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"warns about diverged prompt templates without overwriting them",
		async () => {
			const tmp = makeTmpDir();
			try {
				writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

				const promptsDir = join(tmp, ".5x", "templates", "prompts");
				mkdirSync(promptsDir, { recursive: true });

				// Write a customized template (different body)
				const customized =
					'---\nname: author-next-phase\nversion: 1\nvariables: [plan_path, phase_number, user_notes]\nstep_name: "author:implement"\n---\nCUSTOM BODY {{plan_path}} {{phase_number}} {{user_notes}}';
				writeFileSync(join(promptsDir, "author-next-phase.md"), customized);

				const { stdout, exitCode } = await runUpgrade(tmp);

				expect(exitCode).toBe(0);
				expect(stdout).toContain(
					"Warning: .5x/templates/prompts/author-next-phase.md differs from the bundled version",
				);
				expect(stdout).toContain("5x init --install-templates --force");

				// File should NOT be modified
				const content = readFileSync(
					join(promptsDir, "author-next-phase.md"),
					"utf-8",
				);
				expect(content).toBe(customized);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"reports matching prompt templates without warning",
		async () => {
			const tmp = makeTmpDir();
			try {
				writeFileSync(join(tmp, "5x.toml"), "maxStepsPerRun = 50\n", "utf-8");

				const promptsDir = join(tmp, ".5x", "templates", "prompts");
				mkdirSync(promptsDir, { recursive: true });

				// Write a template that matches bundled exactly
				const bundled = getDefaultTemplateRaw("author-next-phase");
				writeFileSync(join(promptsDir, "author-next-phase.md"), bundled);

				const { stdout, exitCode } = await runUpgrade(tmp);

				expect(exitCode).toBe(0);
				expect(stdout).toContain(
					"Skipped .5x/templates/prompts/author-next-phase.md (matches bundled)",
				);
				expect(stdout).not.toContain("Warning");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Phase 7 — harness freshness sweep
// ---------------------------------------------------------------------------

interface Project {
	dir: string;
	home: string;
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
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

async function setupProject(): Promise<Project> {
	const dir = makeTmpDir();
	const home = join(dir, "fake-home");
	mkdirSync(home, { recursive: true });

	git(dir, ["init"]);
	git(dir, ["config", "user.email", "test@test.com"]);
	git(dir, ["config", "user.name", "Test"]);

	const planDir = join(dir, "docs", "development", "plans");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(
		join(planDir, "001-thing.md"),
		"# Thing\n\n## Phase 1: Setup\n\n- [ ] Do it\n",
	);
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n.opencode/\n");

	const project: Project = { dir, home };
	expect((await run5x(project, ["init"])).exitCode).toBe(0);

	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-m", "init"]);

	return project;
}

function opencodePath(project: Project, ...parts: string[]): string {
	return join(project.dir, ".opencode", ...parts);
}

function readManifestFile(project: Project): HarnessManifest {
	return JSON.parse(
		readFileSync(opencodePath(project, MANIFEST_FILENAME), "utf-8"),
	) as HarnessManifest;
}

function writeManifestFile(project: Project, manifest: HarnessManifest): void {
	writeFileSync(
		opencodePath(project, MANIFEST_FILENAME),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf-8",
	);
}

function readAuthorAgent(project: Project): string {
	return readFileSync(
		opencodePath(project, "agents", "5x-plan-author.md"),
		"utf-8",
	);
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

function snapshotBytes(project: Project): Map<string, string> {
	const out = new Map<string, string>();
	for (const rel of [
		[MANIFEST_FILENAME],
		["agents", "5x-plan-author.md"],
		["agents", "5x-reviewer.md"],
		["skills", "5x", "SKILL.md"],
	]) {
		const path = opencodePath(project, ...rel);
		if (existsSync(path)) out.set(path, readFileSync(path, "utf-8"));
	}
	return out;
}

const BUNDLED_CAVEAT =
	"only bundled harnesses (opencode, cursor, universal) are checked";

describe("5x upgrade harness freshness (Phase 7)", () => {
	test(
		"default config reports stale lossless project install and writes nothing",
		async () => {
			const project = await setupProject();
			try {
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/A"]))
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
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/B"]))
						.exitCode,
				).toBe(0);

				// Stock init leaves no [harness] table — autoSync defaults off.
				const toml = readFileSync(join(project.dir, "5x.toml"), "utf-8");
				expect(toml).not.toContain("[harness]");

				const beforeMtimes = snapshotMtimes(project);
				const beforeBytes = snapshotBytes(project);
				const beforeManifest = readManifestFile(project);

				const { stdout, exitCode } = await runUpgrade(
					project.dir,
					[],
					project.home,
				);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("Harness assets:");
				expect(stdout).toContain("opencode (project): stale");
				expect(stdout).toContain(
					"run '5x harness sync' (or set harness.autoSync = true)",
				);
				expect(stdout).toContain(BUNDLED_CAVEAT);
				expect(stdout).not.toContain("→ synced");

				expect(snapshotMtimes(project)).toEqual(beforeMtimes);
				expect(snapshotBytes(project)).toEqual(beforeBytes);
				expect(readManifestFile(project)).toEqual(beforeManifest);
				expect(readAuthorAgent(project)).toContain("test/A");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"harness.autoSync = true auto-syncs a lossless project-scope install",
		async () => {
			const project = await setupProject();
			try {
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/A"]))
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
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/B"]))
						.exitCode,
				).toBe(0);
				expect(
					(await run5x(project, ["config", "set", "harness.autoSync", "true"]))
						.exitCode,
				).toBe(0);

				const { stdout, exitCode } = await runUpgrade(
					project.dir,
					[],
					project.home,
				);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("opencode (project): stale → synced");
				expect(readAuthorAgent(project)).toContain("test/B");
				expect(readAuthorAgent(project)).not.toContain("test/A");
				const manifest = readManifestFile(project);
				expect(manifest.baseline).toBe("verified");
				expect(manifest.inputs.authorModel).toBe("test/B");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"older cliVersion marks stale; syncs only with autoSync or --sync",
		async () => {
			const project = await setupProject();
			try {
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/A"]))
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

				// Simulate a prior CLI version bake: rewrite inputs + hash so the
				// fingerprint compare sees a real inputs-changed delta.
				const manifest = readManifestFile(project);
				manifest.inputs.cliVersion = "0.0.1";
				manifest.hash = computeFingerprint(manifest.inputs);
				writeManifestFile(project, manifest);

				const beforeBytes = snapshotBytes(project);
				const reportOnly = await runUpgrade(project.dir, [], project.home);
				expect(reportOnly.exitCode).toBe(0);
				expect(reportOnly.stdout).toContain(
					"opencode (project): stale (inputs-changed)",
				);
				expect(reportOnly.stdout).not.toContain("→ synced");
				expect(snapshotBytes(project)).toEqual(beforeBytes);

				const withFlag = await runUpgrade(
					project.dir,
					["--sync"],
					project.home,
				);
				expect(withFlag.exitCode).toBe(0);
				expect(withFlag.stdout).toContain("opencode (project): stale → synced");
				expect(readManifestFile(project).inputs.cliVersion).not.toBe("0.0.1");
				expect(readManifestFile(project).baseline).toBe("verified");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"user-scope install is reported but never synced by upgrade",
		async () => {
			const project = await setupProject();
			try {
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/A"]))
						.exitCode,
				).toBe(0);
				expect(
					(
						await run5x(project, [
							"harness",
							"install",
							"opencode",
							"--scope",
							"user",
						])
					).exitCode,
				).toBe(0);
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/B"]))
						.exitCode,
				).toBe(0);
				expect(
					(await run5x(project, ["config", "set", "harness.autoSync", "true"]))
						.exitCode,
				).toBe(0);

				const userAgent = join(
					project.home,
					".config",
					"opencode",
					"agents",
					"5x-plan-author.md",
				);
				const before = readFileSync(userAgent, "utf-8");

				const auto = await runUpgrade(project.dir, [], project.home);
				expect(auto.exitCode).toBe(0);
				expect(auto.stdout).toMatch(/opencode \(user\): (stale|unknown)/);
				expect(auto.stdout).toContain("shared-user-scope");
				expect(auto.stdout).not.toContain("opencode (user): stale → synced");
				expect(readFileSync(userAgent, "utf-8")).toBe(before);

				const forced = await runUpgrade(project.dir, ["--sync"], project.home);
				expect(forced.exitCode).toBe(0);
				expect(forced.stdout).toContain("shared-user-scope");
				expect(forced.stdout).not.toContain("opencode (user): stale → synced");
				expect(readFileSync(userAgent, "utf-8")).toBe(before);
				expect(before).toContain("test/A");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"--no-sync reports and writes nothing even when autoSync is true",
		async () => {
			const project = await setupProject();
			try {
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/A"]))
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
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/B"]))
						.exitCode,
				).toBe(0);
				expect(
					(await run5x(project, ["config", "set", "harness.autoSync", "true"]))
						.exitCode,
				).toBe(0);

				const beforeBytes = snapshotBytes(project);
				const { stdout, exitCode } = await runUpgrade(
					project.dir,
					["--no-sync"],
					project.home,
				);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("opencode (project): stale");
				expect(stdout).not.toContain("→ synced");
				expect(stdout).toContain(
					"run '5x harness sync' (or set harness.autoSync = true)",
				);
				expect(snapshotBytes(project)).toEqual(beforeBytes);
				expect(readAuthorAgent(project)).toContain("test/A");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 90000 },
	);

	test(
		"--sync overrides context-mismatch but preserves a hand-edited asset",
		async () => {
			const project = await setupProject();
			try {
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/A"]))
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

				// Stale via model change + blocked by context-mismatch. autoSync
				// alone must not write; --sync may override that one blocker.
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/B"]))
						.exitCode,
				).toBe(0);
				const mismatched = readManifestFile(project);
				mismatched.installedFrom.contextDir = "packages/api";
				writeManifestFile(project, mismatched);

				expect(
					(await run5x(project, ["config", "set", "harness.autoSync", "true"]))
						.exitCode,
				).toBe(0);

				const blockedByContext = await runUpgrade(
					project.dir,
					[],
					project.home,
				);
				expect(blockedByContext.exitCode).toBe(0);
				expect(blockedByContext.stdout).toContain("context-mismatch");
				expect(blockedByContext.stdout).not.toContain("→ synced");
				expect(readAuthorAgent(project)).toContain("test/A");

				const synced = await runUpgrade(project.dir, ["--sync"], project.home);
				expect(synced.exitCode).toBe(0);
				expect(synced.stdout).toContain("opencode (project): stale → synced");
				expect(readManifestFile(project).installedFrom.contextDir).toBe("");
				expect(readAuthorAgent(project)).toContain("test/B");

				// Hand-edit: --sync must not clobber (no --force on upgrade).
				const agentPath = opencodePath(project, "agents", "5x-plan-author.md");
				const handEdited = `${readFileSync(agentPath, "utf-8")}\n<!-- hand -->\n`;
				writeFileSync(agentPath, handEdited);
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/C"]))
						.exitCode,
				).toBe(0);

				const blocked = await runUpgrade(project.dir, ["--sync"], project.home);
				expect(blocked.exitCode).toBe(0);
				expect(blocked.stdout).toContain("assets-modified");
				expect(blocked.stdout).not.toContain(
					"opencode (project): stale → synced",
				);
				expect(readFileSync(agentPath, "utf-8")).toBe(handEdited);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 120000 },
	);

	test(
		"baseline unverified is reported and never auto-synced under any flag",
		async () => {
			const project = await setupProject();
			try {
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/A"]))
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
				expect(
					(await run5x(project, ["config", "set", "author.model", "test/B"]))
						.exitCode,
				).toBe(0);
				// Plain reinstall → unverified baseline (Phase 6 / §1.1).
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
				expect(readManifestFile(project).baseline).toBe("unverified");

				expect(
					(await run5x(project, ["config", "set", "harness.autoSync", "true"]))
						.exitCode,
				).toBe(0);

				for (const args of [[], ["--sync"], ["--no-sync"]] as string[][]) {
					const before = snapshotBytes(project);
					const { stdout, exitCode } = await runUpgrade(
						project.dir,
						args,
						project.home,
					);
					expect(exitCode).toBe(0);
					expect(stdout).toContain("opencode (project): unknown");
					expect(stdout).toContain("baseline-unverified");
					expect(stdout).not.toContain("→ synced");
					expect(snapshotBytes(project)).toEqual(before);
					expect(readManifestFile(project).baseline).toBe("unverified");
				}
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 120000 },
	);

	test(
		"bundled-only caveat appears in upgrade output",
		async () => {
			const project = await setupProject();
			try {
				const { stdout, exitCode } = await runUpgrade(
					project.dir,
					[],
					project.home,
				);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("Harness assets:");
				expect(stdout).toContain(BUNDLED_CAVEAT);
				expect(stdout).toContain("Externally-published harness packages");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 60000 },
	);
});
