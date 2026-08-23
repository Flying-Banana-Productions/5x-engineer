/**
 * Unit tests for the harness-freshness doctor check.
 *
 * Reuses the stamp/install helpers from the 201 freshness tests.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harnessFreshnessCheck } from "../../../src/doctor/checks/harness-freshness.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../../../src/doctor/types.js";
import { opencodeLocationResolver } from "../../../src/harnesses/locations.js";
import {
	assetsFromOnDisk,
	buildManifest,
	collectInstalledAssets,
	readManifest,
	writeManifest,
} from "../../../src/harnesses/manifest.js";
import opencodePlugin from "../../../src/harnesses/opencode/plugin.js";
import { version } from "../../../src/version.js";

function makeTmpDir(kind: string): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-harness-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const AUTHOR_A = "test/author-a";
const AUTHOR_B = "test/author-b";

function writeConfig(projectRoot: string, model: string, extra = ""): void {
	writeFileSync(
		join(projectRoot, "5x.toml"),
		`[author]\nmodel = "${model}"\n${extra}`,
		"utf-8",
	);
}

async function stampOpencode(
	projectRoot: string,
	homeDir: string,
	authorModel: string,
	options?: { scope?: "project" | "user"; contextDir?: string },
): Promise<void> {
	const scope = options?.scope ?? "project";
	const ctx = {
		scope,
		projectRoot,
		force: true,
		config: { authorModel },
		homeDir,
	};
	await opencodePlugin.install(ctx);
	const locations = opencodeLocationResolver.resolve(
		scope,
		projectRoot,
		homeDir,
	);
	const rendered = await opencodePlugin.renderAssets?.(ctx);
	const onDisk = collectInstalledAssets({
		rootDir: locations.rootDir,
		locations,
		rendered: rendered ?? null,
		summaries: [],
		prior: null,
	});
	writeManifest(
		locations.rootDir,
		buildManifest({
			harness: "opencode",
			scope,
			rootDir: locations.rootDir,
			locations,
			projectRoot,
			contextDir: options?.contextDir ?? "",
			baseline: "verified",
			configResolved: true,
			inputs: {
				authorModel,
				cliVersion: version,
				harnessPluginVersion: version,
			},
			assets: assetsFromOnDisk(onDisk),
		}),
	);
}

function doctorCtx(projectRoot: string, homeDir: string): DoctorCheckContext {
	return {
		startDir: projectRoot,
		projectRoot,
		stateDir: ".5x",
		homeDir,
		dbPath: resolve(projectRoot, ".5x", "5x.db"),
		dbRelPath: join(".5x", "5x.db"),
	};
}

function asRecord(detail: unknown): Record<string, unknown> {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		return {};
	}
	return detail as Record<string, unknown>;
}

function authorAgent(projectRoot: string): string {
	return readFileSync(
		join(projectRoot, ".opencode", "agents", "5x-plan-author.md"),
		"utf-8",
	);
}

function snapshotTree(root: string): string {
	if (!existsSync(root)) return "";
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, name.name);
			if (name.isDirectory()) walk(full);
			else files.push(full);
		}
	};
	walk(root);
	files.sort();
	return files
		.map((file) => `${file}\n${readFileSync(file, "utf-8")}`)
		.join("\n--\n");
}

function snapshotOpencode(projectRoot: string): string {
	return snapshotTree(join(projectRoot, ".opencode"));
}

function opencodeFinding(findings: DoctorFinding[]): DoctorFinding | undefined {
	return findings.find(
		(f) =>
			(f.code === "HARNESS_STALE" || f.code === "HARNESS_UNKNOWN") &&
			asRecord(f.detail).harness === "opencode",
	);
}

async function applyFix(
	check: DoctorCheck,
	finding: DoctorFinding | undefined,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (!check.fix) throw new Error("expected check.fix");
	if (!finding) throw new Error("expected finding");
	return check.fix(finding, ctx);
}

describe("harness-freshness detect", () => {
	test("nothing installed → single HARNESS_FRESH ok finding", async () => {
		const project = makeTmpDir("none");
		const home = makeTmpDir("home");
		try {
			const findings = await harnessFreshnessCheck.run(
				doctorCtx(project, home),
			);
			expect(findings).toEqual([
				expect.objectContaining({
					check: "harness-freshness",
					status: "ok",
					code: "HARNESS_FRESH",
					fixable: false,
				}),
			]);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("stamped install is fresh; config change is stale and losslessly fixable", async () => {
		const project = makeTmpDir("stale");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A);

			const fresh = await harnessFreshnessCheck.run(doctorCtx(project, home));
			expect(fresh[0]?.code).toBe("HARNESS_FRESH");

			writeConfig(project, AUTHOR_B);
			const findings = await harnessFreshnessCheck.run(
				doctorCtx(project, home),
			);
			const stale = opencodeFinding(findings);
			expect(stale?.status).toBe("fail");
			expect(stale?.code).toBe("HARNESS_STALE");
			expect(stale?.fixable).toBe(true);
			expect(stale?.remediation).toBe("5x harness sync");
			const detail = asRecord(stale?.detail);
			expect(detail.harness).toBe("opencode");
			expect(detail.scope).toBe("project");
			expect(detail.losslessRefresh).toBe(true);
			expect(detail.losslessBlockers).toEqual([]);
			expect(detail.installedFrom).toEqual(
				expect.objectContaining({ contextDir: "" }),
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("hand-edited assets are fail, not fixable, and remediate --force", async () => {
		const project = makeTmpDir("edited");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A);
			writeFileSync(
				join(project, ".opencode", "agents", "5x-plan-author.md"),
				"hand-edited",
				"utf-8",
			);

			const findings = await harnessFreshnessCheck.run(
				doctorCtx(project, home),
			);
			const stale = opencodeFinding(findings);
			expect(stale?.status).toBe("fail");
			expect(stale?.fixable).toBe(false);
			expect(stale?.remediation).toBe("5x harness sync --force");
			expect(asRecord(stale?.detail).losslessRefresh).toBe(false);
			expect(asRecord(stale?.detail).losslessBlockers).toEqual([
				"assets-modified",
			]);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("user-scope stale is warn, not fixable", async () => {
		const project = makeTmpDir("user");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A, { scope: "user" });
			writeConfig(project, AUTHOR_B);

			const findings = await harnessFreshnessCheck.run(
				doctorCtx(project, home),
			);
			const stale = findings.find(
				(f) =>
					asRecord(f.detail).harness === "opencode" &&
					asRecord(f.detail).scope === "user",
			);
			expect(stale?.status).toBe("warn");
			expect(stale?.code).toBe("HARNESS_STALE");
			expect(stale?.fixable).toBe(false);
			expect(stale?.remediation).toBe(
				"5x harness install opencode --scope project",
			);
			expect(asRecord(stale?.detail).losslessBlockers).toContain(
				"shared-user-scope",
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("project install baked from a different contextDir → fail, not fixable", async () => {
		const project = makeTmpDir("ctx");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A, {
				contextDir: "packages/api",
			});
			writeConfig(project, AUTHOR_B);

			const findings = await harnessFreshnessCheck.run(
				doctorCtx(project, home),
			);
			const stale = opencodeFinding(findings);
			expect(stale?.status).toBe("fail");
			expect(stale?.fixable).toBe(false);
			expect(asRecord(stale?.detail).losslessRefresh).toBe(false);
			expect(asRecord(stale?.detail).losslessBlockers).toContain(
				"context-mismatch",
			);
			expect(asRecord(stale?.detail).harness).toBe("opencode");
			expect(asRecord(stale?.detail).scope).toBe("project");
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("freshnessWarnings=off still produces findings", async () => {
		const project = makeTmpDir("warn-off");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A);
			writeConfig(project, AUTHOR_B, '[harness]\nfreshnessWarnings = "off"\n');

			const findings = await harnessFreshnessCheck.run(
				doctorCtx(project, home),
			);
			const stale = opencodeFinding(findings);
			expect(stale?.code).toBe("HARNESS_STALE");
			expect(stale?.status).toBe("fail");
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("harness-freshness --fix", () => {
	test("syncs only when losslessRefresh", async () => {
		const project = makeTmpDir("fix-ok");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A);
			writeConfig(project, AUTHOR_B);
			const before = authorAgent(project);
			expect(before).toContain(AUTHOR_A);
			expect(before).not.toContain(AUTHOR_B);

			const ctx = doctorCtx(project, home);
			const findings = await harnessFreshnessCheck.run(ctx);
			const stale = opencodeFinding(findings);
			expect(stale?.fixable).toBe(true);
			expect(asRecord(stale?.detail).losslessRefresh).toBe(true);

			const result = await applyFix(harnessFreshnessCheck, stale, ctx);
			expect(result.attempted).toBe(true);

			const afterFindings = await harnessFreshnessCheck.run(ctx);
			expect(opencodeFinding(afterFindings)?.status).not.toBe("fail");
			expect(afterFindings[0]?.code).toBe("HARNESS_FRESH");
			const after = authorAgent(project);
			expect(after).toContain(AUTHOR_B);
			expect(after).not.toContain(AUTHOR_A);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("leaves user-scope, context-mismatch, and hand-edited assets as report-only without write", async () => {
		const project = makeTmpDir("no-write");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A);
			writeFileSync(
				join(project, ".opencode", "agents", "5x-plan-author.md"),
				"hand-edited",
				"utf-8",
			);
			const before = snapshotOpencode(project);

			const ctx = doctorCtx(project, home);
			const findings = await harnessFreshnessCheck.run(ctx);
			const stale = opencodeFinding(findings);
			expect(stale?.fixable).toBe(false);
			const result = await applyFix(harnessFreshnessCheck, stale, ctx);
			expect(result.attempted).toBe(false);

			expect(snapshotOpencode(project)).toBe(before);
			expect(
				readFileSync(
					join(project, ".opencode", "agents", "5x-plan-author.md"),
					"utf-8",
				),
			).toBe("hand-edited");
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("context-mismatch project install is not written by --fix", async () => {
		const project = makeTmpDir("ctx-fix");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A, {
				contextDir: "packages/api",
			});
			writeConfig(project, AUTHOR_B);
			const before = snapshotOpencode(project);

			const ctx = doctorCtx(project, home);
			const findings = await harnessFreshnessCheck.run(ctx);
			const stale = opencodeFinding(findings);
			expect(stale?.fixable).toBe(false);
			const result = await applyFix(harnessFreshnessCheck, stale, ctx);
			expect(result.attempted).toBe(false);
			expect(snapshotOpencode(project)).toBe(before);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("user-scope --fix does not write", async () => {
		const project = makeTmpDir("user-fix");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A, { scope: "user" });
			writeConfig(project, AUTHOR_B);
			const locations = opencodeLocationResolver.resolve("user", project, home);
			const agentPath = join(locations.agentsDir, "5x-plan-author.md");
			const before = readFileSync(agentPath, "utf-8");

			const ctx = doctorCtx(project, home);
			const findings = await harnessFreshnessCheck.run(ctx);
			const stale = findings.find(
				(f) =>
					asRecord(f.detail).harness === "opencode" &&
					asRecord(f.detail).scope === "user",
			);
			expect(stale?.fixable).toBe(false);
			const result = await applyFix(harnessFreshnessCheck, stale, ctx);
			expect(result.attempted).toBe(false);
			expect(readFileSync(agentPath, "utf-8")).toBe(before);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("re-validates losslessRefresh immediately before sync", async () => {
		const project = makeTmpDir("revalidate");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampOpencode(project, home, AUTHOR_A);
			writeConfig(project, AUTHOR_B);

			const ctx = doctorCtx(project, home);
			const findings = await harnessFreshnessCheck.run(ctx);
			const stale = opencodeFinding(findings);
			expect(stale?.fixable).toBe(true);
			expect(asRecord(stale?.detail).losslessRefresh).toBe(true);
			const before = authorAgent(project);
			expect(before).toContain(AUTHOR_A);

			const locations = opencodeLocationResolver.resolve(
				"project",
				project,
				home,
			);
			const manifest = readManifest(locations.rootDir);
			if (!manifest) throw new Error("expected stamped manifest");
			writeManifest(locations.rootDir, {
				...manifest,
				installedFrom: {
					...manifest.installedFrom,
					contextDir: "packages/api",
				},
			});

			const result = await applyFix(harnessFreshnessCheck, stale, ctx);
			expect(result.attempted).toBe(false);
			expect(authorAgent(project)).toBe(before);
			expect(authorAgent(project)).not.toContain(AUTHOR_B);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
