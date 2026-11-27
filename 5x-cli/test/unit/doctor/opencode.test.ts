/**
 * Unit tests for the `opencode` doctor check (binary version detection).
 *
 * The version runner is injected, so no `opencode` process is spawned.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createOpencodeCheck,
	OPENCODE_CHECK_ID,
	OPENCODE_MISSING,
	OPENCODE_OUTDATED,
	type OpenCodeVersionResult,
	parseOpenCodeVersionOutput,
} from "../../../src/doctor/checks/opencode.js";
import type { DoctorCheckContext } from "../../../src/doctor/types.js";
import { opencodeLocationResolver } from "../../../src/harnesses/locations.js";
import { MANIFEST_FILENAME } from "../../../src/harnesses/manifest.js";
import { MIN_OPENCODE_VERSION } from "../../../src/providers/opencode.js";

const dirs: string[] = [];

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir(kind: string): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-opencode-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

/** Project whose roles use a non-OpenCode provider, with an empty home. */
function nonOpencodeProject(): DoctorCheckContext {
	const projectRoot = makeTmpDir("project");
	const homeDir = makeTmpDir("home");
	writeFileSync(
		join(projectRoot, "5x.toml"),
		'[author]\nprovider = "sample"\n\n[reviewer]\nprovider = "sample"\n',
		"utf-8",
	);
	return {
		startDir: projectRoot,
		projectRoot,
		homeDir,
		dbPath: join(projectRoot, ".5x", "5x.db"),
		dbRelPath: ".5x/5x.db",
	};
}

/** Project with no config: both roles default to the `opencode` provider. */
function defaultProviderProject(): DoctorCheckContext {
	const projectRoot = makeTmpDir("project");
	const homeDir = makeTmpDir("home");
	return {
		startDir: projectRoot,
		projectRoot,
		homeDir,
		dbPath: join(projectRoot, ".5x", "5x.db"),
		dbRelPath: ".5x/5x.db",
	};
}

function writeOpencodeManifest(
	ctx: DoctorCheckContext,
	scope: "project" | "user",
): void {
	const { rootDir } = opencodeLocationResolver.resolve(
		scope,
		ctx.projectRoot,
		ctx.homeDir,
	);
	mkdirSync(rootDir, { recursive: true });
	writeFileSync(join(rootDir, MANIFEST_FILENAME), "{}", "utf-8");
}

/** Process env without inherited GIT_* variables (e.g. from a git hook). */
function gitEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return env;
}

function runner(result: OpenCodeVersionResult) {
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		run: async () => {
			calls++;
			return result;
		},
	};
}

function versionOutput(stdout: string): OpenCodeVersionResult {
	return { kind: "output", stdout, stderr: "", exitCode: 0 };
}

describe("parseOpenCodeVersionOutput", () => {
	test("reads bare 1.x and prefixed 2.x output", () => {
		expect(parseOpenCodeVersionOutput("1.2.3\n")).toBe("1.2.3");
		expect(parseOpenCodeVersionOutput("opencode v2.4.2\n")).toBe("2.4.2");
		expect(parseOpenCodeVersionOutput("2.5.0-beta.1")).toBe("2.5.0");
	});

	test("rejects output with no semver token", () => {
		expect(parseOpenCodeVersionOutput("")).toBeUndefined();
		expect(parseOpenCodeVersionOutput("opencode dev")).toBeUndefined();
		expect(parseOpenCodeVersionOutput("v2.4")).toBeUndefined();
	});

	test("ignores version-like fragments inside other text", () => {
		expect(
			parseOpenCodeVersionOutput("launcher needs Node 1.2.3\n"),
		).toBeUndefined();
		expect(
			parseOpenCodeVersionOutput("warning: node v1.2.3 is unsupported"),
		).toBeUndefined();
		expect(parseOpenCodeVersionOutput("opencode 1.2.3 (dev)")).toBeUndefined();
	});

	test("finds a complete version line among other output lines", () => {
		expect(
			parseOpenCodeVersionOutput("notice: update available\nopencode v2.4.2\n"),
		).toBe("2.4.2");
	});
});

describe("opencode doctor check", () => {
	test("not applicable: non-OpenCode providers and no manifest report nothing without running opencode", async () => {
		const ctx = nonOpencodeProject();
		const version = runner({ kind: "missing" });
		const check = createOpencodeCheck({ runVersion: version.run });
		expect(check.id).toBe(OPENCODE_CHECK_ID);
		expect(await check.run(ctx)).toEqual([]);
		expect(version.calls).toBe(0);
	});

	test("applies when a role resolves to the opencode provider (default)", async () => {
		const ctx = defaultProviderProject();
		const version = runner({ kind: "missing" });
		const findings = await createOpencodeCheck({
			runVersion: version.run,
		}).run(ctx);
		expect(version.calls).toBe(1);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.detail).toMatchObject({
			appliesBecause: ["author.provider", "reviewer.provider"],
		});
	});

	test("applies when a project or user OpenCode harness manifest exists", async () => {
		for (const scope of ["project", "user"] as const) {
			const ctx = nonOpencodeProject();
			writeOpencodeManifest(ctx, scope);
			const version = runner({ kind: "missing" });
			const findings = await createOpencodeCheck({
				runVersion: version.run,
			}).run(ctx);
			expect(version.calls).toBe(1);
			expect(findings[0]?.detail).toMatchObject({
				appliesBecause: [`harness:${scope}`],
			});
		}
	});

	test("missing binary → opencode-missing warn, not fixable", async () => {
		const ctx = defaultProviderProject();
		const findings = await createOpencodeCheck({
			runVersion: runner({ kind: "missing" }).run,
		}).run(ctx);
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding?.check).toBe(OPENCODE_CHECK_ID);
		expect(finding?.code).toBe(OPENCODE_MISSING);
		expect(finding?.status).toBe("warn");
		expect(finding?.fixable).toBe(false);
		expect(finding?.message).toContain(MIN_OPENCODE_VERSION);
		expect(finding?.remediation).toContain("opencode");
	});

	test("1.x → opencode-outdated with `opencode upgrade --major`", async () => {
		const ctx = defaultProviderProject();
		const findings = await createOpencodeCheck({
			runVersion: runner(versionOutput("1.2.3\n")).run,
		}).run(ctx);
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding?.code).toBe(OPENCODE_OUTDATED);
		expect(finding?.status).toBe("warn");
		expect(finding?.fixable).toBe(false);
		expect(finding?.remediation).toBe("opencode upgrade --major");
		expect(finding?.message).toContain(MIN_OPENCODE_VERSION);
		expect(finding?.message).toContain("found 1.2.3");
		expect(finding?.detail).toMatchObject({
			found: "1.2.3",
			minimum: MIN_OPENCODE_VERSION,
		});
	});

	test("older 2.x → opencode-outdated with `opencode upgrade`", async () => {
		const ctx = defaultProviderProject();
		const findings = await createOpencodeCheck({
			runVersion: runner(versionOutput("opencode v2.0.0\n")).run,
		}).run(ctx);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.code).toBe(OPENCODE_OUTDATED);
		expect(findings[0]?.remediation).toBe("opencode upgrade");
		expect(findings[0]?.message).toContain("found 2.0.0");
	});

	test("current 2.x (the minimum and newer) reports nothing", async () => {
		const ctx = defaultProviderProject();
		for (const out of [
			MIN_OPENCODE_VERSION,
			`opencode v${MIN_OPENCODE_VERSION}`,
			"opencode v99.0.0",
		]) {
			const findings = await createOpencodeCheck({
				runVersion: runner(versionOutput(`${out}\n`)).run,
			}).run(ctx);
			expect(findings).toEqual([]);
		}
	});

	test("nonzero exit is not version evidence, even with a version-like line", async () => {
		const ctx = defaultProviderProject();
		for (const result of [
			{
				kind: "output",
				stdout: "",
				stderr: "launcher needs Node 1.2.3\n",
				exitCode: 1,
			},
			{ kind: "output", stdout: "1.2.3\n", stderr: "", exitCode: 1 },
		] as OpenCodeVersionResult[]) {
			const findings = await createOpencodeCheck({
				runVersion: runner(result).run,
			}).run(ctx);
			expect(findings).toEqual([]);
		}
	});

	test("version-like noise on a successful probe reports nothing", async () => {
		const ctx = defaultProviderProject();
		const findings = await createOpencodeCheck({
			runVersion: runner({
				kind: "output",
				stdout: "",
				stderr: "launcher needs Node 1.2.3\n",
				exitCode: 0,
			}).run,
		}).run(ctx);
		expect(findings).toEqual([]);
	});

	test("unparseable output or a runner error reports nothing", async () => {
		const ctx = defaultProviderProject();
		for (const result of [
			versionOutput("opencode dev build\n"),
			{ kind: "output", stdout: "", stderr: "boom", exitCode: 1 },
			{ kind: "error", message: "timed out" },
		] as OpenCodeVersionResult[]) {
			const findings = await createOpencodeCheck({
				runVersion: runner(result).run,
			}).run(ctx);
			expect(findings).toEqual([]);
		}
	});

	test("linked worktree: project manifest is resolved from the current checkout", async () => {
		const mainDir = makeTmpDir("main");
		const wtDir = join(makeTmpDir("wt-parent"), "linked");
		const homeDir = makeTmpDir("home");
		const git = (args: string[], cwd: string) => {
			const res = Bun.spawnSync(["git", ...args], {
				cwd,
				env: {
					...gitEnv(),
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@example.com",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@example.com",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			if (res.exitCode !== 0) {
				throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
			}
		};
		writeFileSync(
			join(mainDir, "5x.toml"),
			'[author]\nprovider = "sample"\n\n[reviewer]\nprovider = "sample"\n',
			"utf-8",
		);
		git(["init", "-q", "-b", "main"], mainDir);
		git(["add", "5x.toml"], mainDir);
		git(["commit", "-q", "-m", "init"], mainDir);
		git(["worktree", "add", "-q", wtDir, "-b", "feature"], mainDir);

		// Control-plane root is the main checkout; the manifest exists only in
		// the linked checkout where `5x harness install` would have put it.
		const linkedCtx: DoctorCheckContext = {
			startDir: wtDir,
			projectRoot: mainDir,
			homeDir,
			dbPath: join(mainDir, ".5x", "5x.db"),
			dbRelPath: ".5x/5x.db",
		};
		writeOpencodeManifest({ ...linkedCtx, projectRoot: wtDir }, "project");

		const linked = runner({ kind: "missing" });
		const findings = await createOpencodeCheck({
			runVersion: linked.run,
		}).run(linkedCtx);
		expect(linked.calls).toBe(1);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.code).toBe(OPENCODE_MISSING);
		expect(findings[0]?.detail).toMatchObject({
			appliesBecause: ["harness:project"],
		});

		// Inverse: from the main checkout, the linked checkout's manifest does
		// not apply.
		const main = runner({ kind: "missing" });
		expect(
			await createOpencodeCheck({ runVersion: main.run }).run({
				...linkedCtx,
				startDir: mainDir,
			}),
		).toEqual([]);
		expect(main.calls).toBe(0);
	});
});
