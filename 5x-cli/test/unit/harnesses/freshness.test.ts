/**
 * Tests for the harness freshness orchestration layer.
 *
 * Phase 4 (201-harness-freshness).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatFreshnessWarning,
	freshnessWarningsEnabled,
	listInstalledAssetPaths,
	runHarnessFreshnessChecks,
} from "../../../src/harnesses/freshness.js";
import { opencodeLocationResolver } from "../../../src/harnesses/locations.js";
import {
	assetsFromOnDisk,
	buildManifest,
	collectInstalledAssets,
	type FreshnessReport,
	writeManifest,
} from "../../../src/harnesses/manifest.js";
import opencodePlugin from "../../../src/harnesses/opencode/plugin.js";
import { version } from "../../../src/version.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(kind: string): string {
	const dir = join(
		tmpdir(),
		`5x-freshness-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/** Install opencode project-scope assets the way `harness install` would. */
async function installOpencode(
	projectRoot: string,
	homeDir: string,
	authorModel: string,
) {
	const ctx = {
		scope: "project" as const,
		projectRoot,
		force: true,
		config: { authorModel },
		homeDir,
	};
	const result = await opencodePlugin.install(ctx);
	return { ctx, result };
}

/** Stamp a verified manifest describing exactly what is on disk. */
async function stampManifest(
	projectRoot: string,
	homeDir: string,
	authorModel: string,
	options?: { withAssets?: boolean },
): Promise<void> {
	const { ctx } = await installOpencode(projectRoot, homeDir, authorModel);
	const locations = opencodeLocationResolver.resolve(
		"project",
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
			scope: "project",
			rootDir: locations.rootDir,
			locations,
			projectRoot,
			contextDir: "",
			baseline: "verified",
			configResolved: true,
			inputs: {
				authorModel,
				cliVersion: version,
				harnessPluginVersion: version,
			},
			assets: options?.withAssets === false ? [] : assetsFromOnDisk(onDisk),
		}),
	);
}

function makeReport(overrides?: Partial<FreshnessReport>): FreshnessReport {
	return {
		harness: "opencode",
		scope: "project",
		rootDir: "/home/me/dev/foo/.opencode",
		tier: 1,
		status: "stale",
		reason: "inputs-changed",
		inputDeltas: [
			{
				key: "author.model",
				installed: "anthropic/claude-sonnet-4-6",
				current: "anthropic/claude-opus-4-1",
			},
		],
		assetDeltas: [],
		losslessRefresh: false,
		losslessBlockers: [],
		installedFrom: { projectRoot: "/home/me/dev/foo", contextDir: "" },
		baseline: "verified",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("runHarnessFreshnessChecks — discovery", () => {
	test("covers the bundled harness × supported-scope grid", async () => {
		const project = makeTmpDir("grid");
		const home = makeTmpDir("home");
		try {
			const reports = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
			});
			expect(reports.map((r) => `${r.harness}:${r.scope}`).sort()).toEqual([
				"cursor:project",
				"cursor:user",
				"opencode:project",
				"opencode:user",
				"universal:project",
				"universal:user",
			]);
			// Nothing installed anywhere — every report is silent.
			expect(reports.every((r) => r.status === "not-installed")).toBe(true);
			expect(reports.every((r) => formatFreshnessWarning(r) === "")).toBe(true);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("harness and scope options filter the grid", async () => {
		const project = makeTmpDir("filter");
		const home = makeTmpDir("home");
		try {
			const byHarness = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
				harness: "opencode",
			});
			expect(byHarness.map((r) => r.scope)).toEqual(["project", "user"]);

			const byScope = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
				scope: "project",
			});
			expect(byScope.every((r) => r.scope === "project")).toBe(true);
			expect(byScope).toHaveLength(3);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("installed assets without a manifest report unknown", async () => {
		const project = makeTmpDir("adopt");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await installOpencode(project, home, AUTHOR_A);

			const [projectReport] = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
				harness: "opencode",
				scope: "project",
			});
			expect(projectReport?.status).toBe("unknown");
			expect(projectReport?.reason).toBe("no-manifest");
			expect(projectReport?.baseline).toBeNull();
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a stamped install is fresh, and a config change makes it stale", async () => {
		const project = makeTmpDir("stale");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampManifest(project, home, AUTHOR_A);

			const [fresh] = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
				harness: "opencode",
				scope: "project",
			});
			expect(fresh?.status).toBe("fresh");
			expect(fresh?.inputDeltas).toEqual([]);

			writeConfig(project, AUTHOR_B);
			const [stale] = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
				harness: "opencode",
				scope: "project",
			});
			expect(stale?.status).toBe("stale");
			expect(stale?.reason).toBe("inputs-changed");
			expect(stale?.inputDeltas).toEqual([
				{ key: "author.model", installed: AUTHOR_A, current: AUTHOR_B },
			]);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("tier2 re-renders and sees a hand-edited asset", async () => {
		const project = makeTmpDir("tier2");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampManifest(project, home, AUTHOR_A);

			const [clean] = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
				harness: "opencode",
				scope: "project",
				tier2: true,
			});
			expect(clean?.tier).toBe(2);
			expect(clean?.status).toBe("fresh");
			expect(clean?.losslessRefresh).toBe(true);

			const locations = opencodeLocationResolver.resolve(
				"project",
				project,
				home,
			);
			const edited = listInstalledAssetPaths(
				opencodePlugin,
				"project",
				locations,
			)[0];
			expect(edited).toBeDefined();
			writeFileSync(
				join(locations.rootDir, ...(edited as string).split("/")),
				"hand-edited",
				"utf-8",
			);

			const [modified] = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
				harness: "opencode",
				scope: "project",
				tier2: true,
			});
			expect(modified?.status).toBe("stale");
			expect(modified?.reason).toBe("assets-modified");
			expect(modified?.assetDeltas).toContainEqual({
				path: edited as string,
				state: "modified",
			});
			expect(modified?.losslessRefresh).toBe(false);
			expect(modified?.losslessBlockers).toEqual(["assets-modified"]);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a config that fails to resolve at check time reports stale, never throws", async () => {
		const project = makeTmpDir("badconfig");
		const home = makeTmpDir("home");
		try {
			writeConfig(project, AUTHOR_A);
			await stampManifest(project, home, AUTHOR_A);
			writeFileSync(join(project, "5x.toml"), "this = = broken", "utf-8");

			const [report] = await runHarnessFreshnessChecks({
				startDir: project,
				homeDir: home,
				harness: "opencode",
				scope: "project",
			});
			// Unreadable config bakes nothing, so the recorded model reads as
			// removed — stale, which prompts a sync, rather than silently fresh.
			expect(report?.status).toBe("stale");
			expect(report?.inputDeltas).toEqual([
				{ key: "author.model", installed: AUTHOR_A, current: null },
			]);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Warning copy
// ---------------------------------------------------------------------------

describe("formatFreshnessWarning", () => {
	test("stale report names only the changed field and the fix", () => {
		expect(formatFreshnessWarning(makeReport())).toBe(
			[
				"⚠ opencode (project) assets are stale",
				"  installed  author.model = anthropic/claude-sonnet-4-6",
				"  current    author.model = anthropic/claude-opus-4-1",
				"  fix        5x harness sync",
			].join("\n"),
		);
	});

	test("unchanged fields never appear", () => {
		const text = formatFreshnessWarning(makeReport());
		expect(text).not.toContain("reviewer.model");
		expect(text).not.toContain("cliVersion");
	});

	test("no-manifest variant omits the delta lines", () => {
		const text = formatFreshnessWarning(
			makeReport({
				status: "unknown",
				reason: "no-manifest",
				inputDeltas: [],
				installedFrom: null,
				baseline: null,
			}),
		);
		expect(text).toBe(
			[
				"⚠ opencode (project) assets have no manifest — freshness unknown",
				"  fix        5x harness sync",
			].join("\n"),
		);
	});

	test("unverified-baseline variant shows retained deltas plus the note", () => {
		const text = formatFreshnessWarning(
			makeReport({
				status: "unknown",
				reason: "baseline-unverified",
				baseline: "unverified",
			}),
		);
		expect(text).toBe(
			[
				"⚠ opencode (project) assets are partially installed — freshness unknown",
				"  installed  author.model = anthropic/claude-sonnet-4-6",
				"  current    author.model = anthropic/claude-opus-4-1",
				"  note       `harness install` preserved existing agent files; no verified baseline",
				"  fix        5x harness sync",
			].join("\n"),
		);
	});

	test("unverified-baseline variant without a retained baseline omits the deltas", () => {
		const text = formatFreshnessWarning(
			makeReport({
				status: "unknown",
				reason: "baseline-unverified",
				baseline: "unverified",
				inputDeltas: [],
			}),
		);
		expect(text.split("\n")).toEqual([
			"⚠ opencode (project) assets are partially installed — freshness unknown",
			"  note       `harness install` preserved existing agent files; no verified baseline",
			"  fix        5x harness sync",
		]);
	});

	test("user scope reports provenance and the project-scope remediation", () => {
		const text = formatFreshnessWarning(
			makeReport({
				scope: "user",
				losslessBlockers: ["shared-user-scope"],
			}),
		);
		expect(text).toBe(
			[
				"⚠ opencode (user) assets were baked from /home/me/dev/foo",
				"  installed  author.model = anthropic/claude-sonnet-4-6",
				"  current    author.model = anthropic/claude-opus-4-1",
				"  note       user-scope assets are shared across projects and are never auto-refreshed",
				"  fix        5x harness install opencode --scope project",
			].join("\n"),
		);
	});

	test("an unset value renders as (unset)", () => {
		const text = formatFreshnessWarning(
			makeReport({
				inputDeltas: [
					{ key: "author.model", installed: null, current: "openai/gpt-5" },
				],
			}),
		);
		expect(text).toContain("  installed  author.model = (unset)");
	});

	test("fresh and not-installed reports render nothing", () => {
		expect(
			formatFreshnessWarning(makeReport({ status: "fresh", reason: null })),
		).toBe("");
		expect(
			formatFreshnessWarning(
				makeReport({ status: "not-installed", reason: null }),
			),
		).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Suppression key
// ---------------------------------------------------------------------------

describe("freshnessWarningsEnabled", () => {
	test("defaults to on for a config that never mentions harness", async () => {
		const project = makeTmpDir("warn-default");
		try {
			writeConfig(project, AUTHOR_A);
			expect(await freshnessWarningsEnabled(project)).toBe(true);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});

	test('honors harness.freshnessWarnings = "off"', async () => {
		const project = makeTmpDir("warn-off");
		try {
			writeConfig(
				project,
				AUTHOR_A,
				'\n[harness]\nfreshnessWarnings = "off"\n',
			);
			expect(await freshnessWarningsEnabled(project)).toBe(false);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});

	test("an unresolvable config keeps warnings on", async () => {
		const project = makeTmpDir("warn-broken");
		try {
			writeFileSync(join(project, "5x.toml"), "this = = broken", "utf-8");
			expect(await freshnessWarningsEnabled(project)).toBe(true);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});
});
