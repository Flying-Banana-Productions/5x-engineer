/**
 * Harness asset freshness orchestration (201-harness-freshness, Phase 4).
 *
 * `manifest.ts` is deliberately plugin-free so Tier 1 stays cheap on hot paths.
 * This module is the layer above it: it loads plugins, resolves config once,
 * decides which (harness, scope) pairs actually have assets on disk, and turns
 * each into a {@link FreshnessReport}.
 *
 * `runHarnessFreshnessChecks()` is the public seam every consumer shares —
 * `run init`, `config set`, `harness list`, `harness sync`, `upgrade`, and
 * eventually `5x doctor` (area #3) — so the freshness verdict has exactly one
 * definition.
 */

import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	resolveCheckoutRoot,
	resolveControlPlaneRoot,
} from "../commands/control-plane.js";
import { resolveHarnessModelForRole, resolveLayeredConfig } from "../config.js";
import { version } from "../version.js";
import { listBundledHarnesses, loadHarnessPlugin } from "./factory.js";
import type { HarnessLocations } from "./locations.js";
import {
	compareManifest,
	type FreshnessReport,
	makeAssetReader,
	type RawManifestInputs,
} from "./manifest.js";
import type {
	HarnessInstallContext,
	HarnessPlugin,
	HarnessScope,
	RenderedAsset,
} from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FreshnessCheckOptions {
	/** Working directory the check runs from — defaults to `resolve(".")`. */
	startDir?: string;
	/** Home directory override for user scope. */
	homeDir?: string;
	/** Restrict to one harness; default = all bundled harnesses. */
	harness?: string;
	/** Restrict to one scope; default = every supported scope. */
	scope?: HarnessScope;
	/** Run the re-render comparison. Default false (Tier 1). */
	tier2?: boolean;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Produce one {@link FreshnessReport} per installed-or-not (harness, scope) pair.
 *
 * Config is resolved once and reused for every pair — the per-role model still
 * varies per harness (`harnessModels.<harness>`), but the file I/O does not.
 * A config that fails to resolve is not fatal: the current inputs simply read as
 * unset, which compares stale rather than silently fresh.
 */
export async function runHarnessFreshnessChecks(
	options?: FreshnessCheckOptions,
): Promise<FreshnessReport[]> {
	const cwd = resolve(options?.startDir ?? ".");
	const projectRoot = resolveCheckoutRoot(cwd) ?? cwd;
	const currentContextDir = toRelativeContextDir(projectRoot, cwd);

	const config = await resolveConfigOrNull(cwd);

	const names = options?.harness ? [options.harness] : listBundledHarnesses();

	const reports: FreshnessReport[] = [];
	for (const name of names) {
		const { plugin } = await loadHarnessPlugin(name);

		for (const scope of plugin.supportedScopes) {
			if (options?.scope && options.scope !== scope) continue;

			const locations = plugin.locations.resolve(
				scope,
				projectRoot,
				options?.homeDir,
			);
			const installCtx: HarnessInstallContext = {
				scope,
				projectRoot,
				force: false,
				config: {
					authorModel: config
						? resolveHarnessModelForRole(config, "author", name)
						: undefined,
					reviewerModel: config
						? resolveHarnessModelForRole(config, "reviewer", name)
						: undefined,
					authorDelegationMode: config?.author.delegationMode,
					reviewerDelegationMode: config?.reviewer.delegationMode,
				},
				homeDir: options?.homeDir,
			};

			const current: RawManifestInputs = {
				...installCtx.config,
				cliVersion: version,
				harnessPluginVersion: plugin.version ?? version,
				plugin: safeFingerprintInputs(plugin, installCtx),
			};

			const rendered = options?.tier2
				? await safeRenderAssets(plugin, installCtx)
				: undefined;

			reports.push(
				compareManifest({
					harness: name,
					scope,
					rootDir: locations.rootDir,
					installed:
						listInstalledAssetPaths(plugin, scope, locations).length > 0,
					current,
					currentContextDir,
					...(options?.tier2
						? {
								...(rendered ? { rendered } : {}),
								readAsset: makeAssetReader(locations.rootDir),
							}
						: {}),
				}),
			);
		}
	}

	return reports;
}

/**
 * Manifest-relative paths of every managed asset actually present on disk.
 *
 * Shared with `harness list`'s file inventory: "installed" means at least one
 * managed file exists, not that the directory does.
 */
export function listInstalledAssetPaths(
	plugin: HarnessPlugin,
	scope: HarnessScope,
	locations: HarnessLocations,
): string[] {
	const { skillNames, agentNames, ruleNames, capabilities } =
		plugin.describe(scope);
	const files: string[] = [];

	for (const skillName of skillNames) {
		if (existsSync(join(locations.skillsDir, skillName, "SKILL.md"))) {
			files.push(`skills/${skillName}/SKILL.md`);
		}
	}
	for (const agentName of agentNames) {
		if (existsSync(join(locations.agentsDir, `${agentName}.md`))) {
			files.push(`agents/${agentName}.md`);
		}
	}
	if (capabilities?.rules === true && locations.rulesDir) {
		for (const ruleName of ruleNames ?? []) {
			if (existsSync(join(locations.rulesDir, `${ruleName}.mdc`))) {
				files.push(`rules/${ruleName}.mdc`);
			}
		}
	}

	return files;
}

/**
 * True when `harness.freshnessWarnings` is "on" (the default).
 *
 * An unresolvable config keeps warnings on: the default posture is the safe
 * one, and silence would be indistinguishable from freshness.
 */
export async function freshnessWarningsEnabled(
	startDir?: string,
): Promise<boolean> {
	const config = await resolveConfigOrNull(resolve(startDir ?? "."));
	return config?.harness?.freshnessWarnings !== "off";
}

/**
 * Fire-point helper (Phase 5): run the check, print one warning block per
 * stale/unknown report to stderr, and return the reports that warned.
 *
 * Never throws and never rejects. Every fire point is a diagnostic bolted onto
 * a command that must still succeed on its own terms — a broken freshness check
 * blocking `run init` or a config write would be strictly worse than the status
 * quo — so failure degrades to silence.
 *
 * Warnings go to stderr so `--json` stdout envelopes stay parseable; callers
 * that also want the additive JSON fields use the returned reports.
 */
export async function emitFreshnessWarnings(
	options?: FreshnessCheckOptions,
): Promise<FreshnessReport[]> {
	try {
		if (!(await freshnessWarningsEnabled(options?.startDir))) return [];

		const warned = (await runHarnessFreshnessChecks(options)).filter(
			(report) => report.status === "stale" || report.status === "unknown",
		);
		for (const report of warned) console.error(formatFreshnessWarning(report));
		return warned;
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Warning copy (§2.4)
// ---------------------------------------------------------------------------

/** Column the value of each labeled line starts at, per §2.4's copy. */
function labeled(label: string, value: string): string {
	return `  ${label.padEnd(11)}${value}`;
}

/**
 * Human-readable warning block for one stale or unknown report.
 *
 * Only changed fields are printed. `not-installed` and `fresh` reports produce
 * an empty string, so callers can map over every report without filtering.
 */
export function formatFreshnessWarning(report: FreshnessReport): string {
	if (report.status === "not-installed" || report.status === "fresh") return "";

	const lines: string[] = [headline(report)];

	for (const delta of report.inputDeltas) {
		lines.push(labeled("installed", `${delta.key} = ${show(delta.installed)}`));
		lines.push(labeled("current", `${delta.key} = ${show(delta.current)}`));
	}

	if (report.reason === "baseline-unverified") {
		lines.push(
			labeled(
				"note",
				"`harness install` preserved existing agent files; no verified baseline",
			),
		);
	}

	if (report.scope === "user") {
		// D4 — user-scope assets are warn-only permanently, and Phase 0.1 verified
		// that a project-scope install wins the name collision, so the fix is
		// directive rather than advisory.
		lines.push(
			labeled(
				"note",
				"user-scope assets are shared across projects and are never auto-refreshed",
			),
		);
		lines.push(
			labeled("fix", `5x harness install ${report.harness} --scope project`),
		);
	} else {
		lines.push(labeled("fix", "5x harness sync"));
	}

	return lines.join("\n");
}

function headline(report: FreshnessReport): string {
	const who = `${report.harness} (${report.scope})`;

	if (report.scope === "user" && report.installedFrom) {
		return `⚠ ${who} assets were baked from ${report.installedFrom.projectRoot}`;
	}

	switch (report.reason) {
		case "baseline-unverified":
			return `⚠ ${who} assets are partially installed — freshness unknown`;
		case "config-unresolved":
			return `⚠ ${who} assets were installed without resolved config — freshness unknown`;
		case "manifest-unreadable":
			return `⚠ ${who} assets have an unreadable manifest — freshness unknown`;
		case "no-manifest":
			return `⚠ ${who} assets have no manifest — freshness unknown`;
		default:
			return `⚠ ${who} assets are stale`;
	}
}

function show(value: string | null): string {
	return value ?? "(unset)";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve config for `cwd`, or `null` when it cannot be resolved.
 *
 * Freshness is a diagnostic: it must never turn a broken config into a failed
 * `run init` or `config set`.
 */
async function resolveConfigOrNull(cwd: string) {
	try {
		const cp = resolveControlPlaneRoot(cwd);
		const { config } = await resolveLayeredConfig(cp.controlPlaneRoot, cwd);
		return config;
	} catch {
		return null;
	}
}

/**
 * `contextDir` relative to `projectRoot`, POSIX-separated, `""` at the root —
 * the same normalization the install-time manifest write uses, so the two are
 * comparable across machines and platforms.
 */
function toRelativeContextDir(projectRoot: string, contextDir: string): string {
	const rel = relative(projectRoot, contextDir);
	return rel === "" ? "" : rel.split(sep).join("/");
}

/**
 * A plugin that throws while rendering degrades Tier 2, it does not fail it.
 *
 * Shared with `harness sync --check`, which projects the write set from the same
 * render and needs the same tolerance.
 */
export async function safeRenderAssets(
	plugin: HarnessPlugin,
	ctx: HarnessInstallContext,
): Promise<RenderedAsset[] | undefined> {
	try {
		return await plugin.renderAssets?.(ctx);
	} catch {
		return undefined;
	}
}

/** Same tolerance for the optional plugin fingerprint inputs (D1). */
function safeFingerprintInputs(
	plugin: HarnessPlugin,
	ctx: HarnessInstallContext,
): Record<string, string | number> {
	try {
		return plugin.fingerprintInputs?.(ctx) ?? {};
	} catch {
		return {};
	}
}
