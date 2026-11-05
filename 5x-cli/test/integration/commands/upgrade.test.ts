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
import { PLAN_SCHEMA_AUTHORITY_INSTRUCTION } from "../../../src/plan-schema/document.js";
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

	test(
		"forced upgrade and explicit prompt refresh deliver the implementation review contract",
		async () => {
			const project = await setupProject();
			try {
				const templatesDir = join(project.dir, ".5x", "templates");
				const reviewPath = join(templatesDir, "review-template.md");
				const promptsDir = join(templatesDir, "prompts");
				mkdirSync(promptsDir, { recursive: true });
				const stalePrompt = getDefaultTemplateRaw("reviewer-commit").replace(
					"one exhaustive material pass",
					"CUSTOM REVIEW POLICY",
				);
				writeFileSync(
					reviewPath,
					"# Old review\n\n- Improvement opportunity\n",
				);
				writeFileSync(join(promptsDir, "reviewer-commit.md"), stalePrompt);

				const upgraded = await run5x(project, ["upgrade", "-f", "--no-sync"]);
				expect(upgraded.exitCode).toBe(0);
				expect(upgraded.stdout).toContain(
					"Updated .5x/templates/review-template.md",
				);
				expect(upgraded.stdout).toContain("prompt overrides are preserved");
				expect(upgraded.stdout).toContain(
					"5x init --install-templates --force",
				);
				expect(
					readFileSync(join(promptsDir, "reviewer-commit.md"), "utf-8"),
				).toBe(stalePrompt);
				const skeleton = readFileSync(reviewPath, "utf-8");
				expect(skeleton).toContain("## Nonblocking follow-ups");
				expect(skeleton).toContain("not admitted author work");
				expect(skeleton).toContain("### Prior-finding outcomes");
				expect(skeleton).toContain("partially_addressed / still_open");
				expect(skeleton).toContain("Exact base..reviewed SHAs");
				expect(skeleton).toContain("## Approved Credit Realization");
				expect(skeleton).not.toContain("Improvement opportunity");

				// Check both resolution paths: absent overrides and explicitly refreshed copies.
				for (const installed of [false, true]) {
					if (installed) {
						const init = await run5x(project, [
							"init",
							"--install-templates",
							"--force",
						]);
						expect(init.exitCode).toBe(0);
					} else {
						rmSync(promptsDir, { recursive: true });
					}
					for (const template of [
						"reviewer-commit",
						"reviewer-commit-continued",
						"author-process-impl-review",
					]) {
						const rendered = await run5x(project, [
							"template",
							"render",
							template,
							"--var",
							"commit_hash=abc",
							"--var",
							"plan_path=docs/development/plans/001-thing.md",
							"--var",
							"review_path=review.md",
							"--var",
							`review_template_path=${reviewPath}`,
						]);
						expect(rendered.exitCode).toBe(0);
						const prompt = JSON.parse(rendered.stdout).data.prompt as string;
						if (template.startsWith("reviewer-")) {
							expect(prompt).toContain("sole authority for endpoints");
							expect(prompt).toContain("full-diff retrieval command");
							expect(prompt).not.toContain("git log --oneline");
							expect(prompt).toContain("planWorkItemIds");
							expect(prompt).toContain("suppressed-alert decision references");
							expect(prompt).toContain("New or increased architecture");
						} else {
							expect(prompt).toContain("effective revision");
							expect(prompt).not.toContain("recover-plan");
							expect(prompt).toContain(
								"implement only those admitted findings",
							);
							expect(prompt).toContain(
								"Do not treat the rest of the review Markdown as a work list",
							);
							expect(prompt).toContain(
								"raw alert alone is not admitted author work",
							);
						}
						if (template === "reviewer-commit") {
							const args = [
								...prompt.matchAll(/--(item|credit-realization) '([^']+)'/g),
							].flatMap((match) => [`--${match[1]}`, match[2] as string]);
							expect(args).toHaveLength(6);
							const emitted = await run5x(project, [
								"protocol",
								"emit",
								"reviewer",
								"--no-ready",
								...args,
							]);
							expect(emitted.exitCode).toBe(0);
							const verdict = JSON.parse(emitted.stdout);
							expect(verdict.items[0].planWorkItemIds).toEqual(["W1"]);
							expect(verdict.items[1].planImpact.kind).toBe("text_only");
							expect(verdict.creditRealizations[0].realization).toBe(
								"realized",
							);
						}
					}
				}
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
					(
						await run5x(project, [
							"harness",
							"sync",
							"opencode",
							"--scope",
							"project",
						])
					).exitCode,
				).toBe(0);
				const skill = readFileSync(
					join(
						project.dir,
						".opencode",
						"skills",
						"5x-phase-execution",
						"SKILL.md",
					),
					"utf-8",
				);
				expect(skill).toContain(".data.result.governance.route");
				expect(skill).toContain("5x review corrections finish");
				expect(skill).toContain(
					"authorize → amend → assess → register → resume",
				);
				expect(skill).toContain("amendmentScope");
				expect(skill).toContain("Rationale prose is not scope");
				expect(skill).toContain("exact hash");
				expect(skill).toContain("5x review implementation amend");
				expect(skill).toContain("Registration does not complete a phase");
				expect(skill).toContain("recover-plan` is retired");
				expect(skill).not.toContain("--confirm-preserved-phases");
				expect(upgraded.stdout).toContain("Legacy recoveries:");
				expect(upgraded.stdout).toContain(
					"Discovery does not resume runs, rewrite journals, synthesize approvals, or commit project history.",
				);
				expect(upgraded.stdout).toContain("implementation-plan-amendment");
				expect(skill).toContain("5x review decide --gate");
				expect(skill).toContain("revise_plan");
				expect(skill).toContain("inheritedBudgetGovernance");
				expect(skill).toContain("next unused");
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 30000 },
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

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let from = 0;
	while (true) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) return count;
		count += 1;
		from = index + needle.length;
	}
}

function envelopeData(stdout: string): Record<string, unknown> {
	const parsed = JSON.parse(stdout) as { data?: Record<string, unknown> };
	return parsed.data ?? (parsed as Record<string, unknown>);
}

function echoedPrompt(log: string): string {
	const deltas: string[] = [];
	for (const line of log.split("\n")) {
		if (line.trim().length === 0) continue;
		const event = JSON.parse(line) as { type?: string; delta?: string };
		if (event.type === "text" && typeof event.delta === "string") {
			deltas.push(event.delta);
		}
	}
	return deltas.join("");
}

describe("schema 1 workflow assets", () => {
	const staleOverride =
		'---\nname: author-next-phase\ndescription: stale override\nversion: 1\nvariables: [plan_path, phase_number, user_notes, run_id]\nstep_name: "author:implement"\nvariable_defaults:\n  user_notes: ""\n  run_id: ""\n---\n\nImplement phase {{phase_number}} of `{{plan_path}}`.\nNotes: {{user_notes}}\n';

	test(
		"configured skeleton resolves to schema 1 and a custom path survives upgrade",
		async () => {
			const project = await setupProject();
			try {
				const shown = await run5x(project, [
					"config",
					"show",
					"--key",
					"paths.templates.plan",
				]);
				expect(shown.exitCode, shown.stderr).toBe(0);
				const configured = envelopeData(shown.stdout).value;
				expect(configured).toBe(
					join(project.dir, "docs/_implementation_plan_template.md"),
				);
				const installedPath = join(
					project.dir,
					".5x",
					"templates",
					"implementation-plan-template.md",
				);
				const bundled = readFileSync(installedPath, "utf-8");
				expect(bundled).toContain("<!-- 5x:plan-schema:1 -->");
				expect(bundled).toContain(PLAN_SCHEMA_AUTHORITY_INSTRUCTION);
				const pointed = await run5x(project, [
					"config",
					"set",
					"paths.templates.plan",
					".5x/templates/implementation-plan-template.md",
					"--local",
				]);
				expect(pointed.exitCode, `${pointed.stdout}\n${pointed.stderr}`).toBe(
					0,
				);
				const pointedShow = await run5x(project, [
					"config",
					"show",
					"--key",
					"paths.templates.plan",
				]);
				expect(pointedShow.exitCode, pointedShow.stderr).toBe(0);
				expect(envelopeData(pointedShow.stdout).value).toBe(installedPath);

				const customRelative = "docs/custom-plan-template.md";
				const customPath = join(project.dir, customRelative);
				const customBody = `<!-- custom-plan-skeleton -->\n${bundled}`;
				writeFileSync(customPath, customBody);
				const set = await run5x(project, [
					"config",
					"set",
					"paths.templates.plan",
					customRelative,
					"--local",
				]);
				expect(set.exitCode, set.stderr).toBe(0);
				const resolved = await run5x(project, [
					"config",
					"show",
					"--key",
					"paths.templates.plan",
				]);
				expect(resolved.exitCode, resolved.stderr).toBe(0);
				expect(envelopeData(resolved.stdout).value).toBe(customPath);

				const upgraded = await run5x(project, ["upgrade", "-f", "--no-sync"]);
				expect(upgraded.exitCode, upgraded.stderr).toBe(0);
				expect(readFileSync(customPath, "utf-8")).toBe(customBody);
				expect(
					readFileSync(
						join(
							project.dir,
							".5x",
							"templates",
							"implementation-plan-template.md",
						),
						"utf-8",
					),
				).toContain("<!-- 5x:plan-schema:1 -->");
				const after = await run5x(project, [
					"config",
					"show",
					"--key",
					"paths.templates.plan",
				]);
				expect(envelopeData(after.stdout).value).toBe(customPath);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 120000 },
	);

	test(
		"native and invoke renders include the authority paragraph once, including a stale override",
		async () => {
			const project = await setupProject();
			try {
				writeFileSync(
					join(project.dir, "5x.toml.local"),
					`[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = true\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n`,
				);
				const vars = [
					"--var",
					"plan_path=docs/development/plans/001-thing.md",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				];
				const bundled = await run5x(project, [
					"template",
					"render",
					"author-next-phase",
					...vars,
				]);
				expect(bundled.exitCode, bundled.stderr).toBe(0);
				const bundledPrompt = envelopeData(bundled.stdout).prompt;
				expect(typeof bundledPrompt).toBe("string");
				expect(
					countOccurrences(
						bundledPrompt as string,
						PLAN_SCHEMA_AUTHORITY_INSTRUCTION,
					),
				).toBe(1);

				const promptsDir = join(project.dir, ".5x", "templates", "prompts");
				mkdirSync(promptsDir, { recursive: true });
				const overridePath = join(promptsDir, "author-next-phase.md");
				writeFileSync(overridePath, staleOverride);
				const overridden = await run5x(project, [
					"template",
					"render",
					"author-next-phase",
					...vars,
				]);
				expect(
					overridden.exitCode,
					`${overridden.stdout}\n${overridden.stderr}`,
				).toBe(0);
				expect(overridden.stderr).toContain("older than bundled");
				const overriddenPrompt = envelopeData(overridden.stdout).prompt;
				expect(
					countOccurrences(
						overriddenPrompt as string,
						PLAN_SCHEMA_AUTHORITY_INSTRUCTION,
					),
				).toBe(1);
				expect(readFileSync(overridePath, "utf-8")).toBe(staleOverride);

				const init = await run5x(project, [
					"run",
					"init",
					"--plan",
					"docs/development/plans/001-thing.md",
					"--allow-dirty",
				]);
				expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);
				const invoked = await run5x(project, [
					"invoke",
					"author",
					"author-next-phase",
					"--quiet",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=probe",
				]);
				expect(invoked.exitCode, `${invoked.stdout}\n${invoked.stderr}`).toBe(
					0,
				);
				const logPath = envelopeData(invoked.stdout).log_path;
				expect(typeof logPath).toBe("string");
				const echoed = echoedPrompt(readFileSync(logPath as string, "utf-8"));
				expect(echoed).toContain("[SampleProvider echo]");
				expect(
					countOccurrences(echoed, PLAN_SCHEMA_AUTHORITY_INSTRUCTION),
				).toBe(1);
				expect(readFileSync(overridePath, "utf-8")).toBe(staleOverride);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 120000 },
	);

	test(
		"fresh install and sync receive 5x-plan-migration without rewriting customized skills",
		async () => {
			const project = await setupProject();
			try {
				const install = await run5x(project, [
					"harness",
					"install",
					"opencode",
					"--scope",
					"project",
				]);
				expect(install.exitCode, install.stderr).toBe(0);
				const migrationPath = opencodePath(
					project,
					"skills",
					"5x-plan-migration",
					"SKILL.md",
				);
				expect(existsSync(migrationPath)).toBe(true);
				const installedMigration = readFileSync(migrationPath, "utf-8");
				expect(installedMigration).toContain("--confirm-exclusions");
				expect(installedMigration).toContain(
					"Older CLIs fail closed by treating informational edits as raw drift.",
				);
				const foundation = readFileSync(
					opencodePath(project, "skills", "5x", "SKILL.md"),
					"utf-8",
				);
				expect(foundation).toContain("5x-plan-migration");
				expect(foundation).not.toContain("--confirm-exclusions");

				rmSync(opencodePath(project, "skills", "5x-plan-migration"), {
					recursive: true,
					force: true,
				});
				expect(existsSync(migrationPath)).toBe(false);
				const restored = await run5x(project, [
					"harness",
					"sync",
					"opencode",
					"--scope",
					"project",
				]);
				expect(
					restored.exitCode,
					`${restored.stdout}\n${restored.stderr}`,
				).toBe(0);
				expect(readFileSync(migrationPath, "utf-8")).toContain(
					"--confirm-exclusions",
				);

				const planSkill = opencodePath(
					project,
					"skills",
					"5x-plan",
					"SKILL.md",
				);
				const phaseSkill = opencodePath(
					project,
					"skills",
					"5x-phase-execution",
					"SKILL.md",
				);
				const customPlan = "# custom 5x-plan\n";
				const customPhase = "# custom 5x-phase-execution\n";
				writeFileSync(planSkill, customPlan);
				writeFileSync(phaseSkill, customPhase);
				const preserved = await run5x(project, [
					"harness",
					"sync",
					"opencode",
					"--scope",
					"project",
				]);
				expect(preserved.exitCode).not.toBe(0);
				expect(`${preserved.stdout}\n${preserved.stderr}`).toContain(
					"local modifications",
				);
				expect(readFileSync(planSkill, "utf-8")).toBe(customPlan);
				expect(readFileSync(phaseSkill, "utf-8")).toBe(customPhase);
				expect(readFileSync(migrationPath, "utf-8")).toContain(
					"--confirm-exclusions",
				);
			} finally {
				cleanupDir(project.dir);
			}
		},
		{ timeout: 120000 },
	);
});
