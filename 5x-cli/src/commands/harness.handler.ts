/**
 * Harness command handler — business logic for harness install/list/uninstall.
 *
 * Framework-independent: no CLI framework imports.
 */

import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { resolveHarnessModelForRole, resolveLayeredConfig } from "../config.js";
import {
	listBundledHarnesses,
	loadHarnessPlugin,
} from "../harnesses/factory.js";
import {
	freshnessWarningsEnabled,
	runHarnessFreshnessChecks,
} from "../harnesses/freshness.js";
import { removeDirIfEmpty } from "../harnesses/installer.js";
import type { HarnessLocations } from "../harnesses/locations.js";
import {
	type AssetDeltaState,
	assetsFromOnDisk,
	buildManifest,
	collectInstalledAssets,
	type FreshnessReason,
	type FreshnessReport,
	type FreshnessStatus,
	hashContent,
	type InputDelta,
	type KindedInstallSummary,
	MANIFEST_FILENAME,
	type ManifestBaseline,
	readManifest,
	removeManifest,
	verifyInstalledInventory,
	writeManifest,
} from "../harnesses/manifest.js";
import type {
	HarnessInstallContext,
	HarnessInstallResult,
	HarnessPlugin,
	HarnessScope,
	HarnessUninstallResult,
	RenderedAsset,
} from "../harnesses/types.js";
import { outputError, outputSuccess } from "../output.js";
import { version } from "../version.js";
import {
	DB_FILENAME,
	resolveCheckoutRoot,
	resolveControlPlaneRoot,
} from "./control-plane.js";

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface HarnessInstallParams {
	/** Harness name (e.g. "opencode"). */
	name: string;
	/** Install scope — may be undefined if omitted by the user. */
	scope?: string;
	/** Whether to overwrite existing files. */
	force?: boolean;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
	/** Home directory override for user scope — defaults to `homedir()` from `node:os`. */
	homeDir?: string;
}

export interface HarnessUninstallParams {
	/** Harness name (e.g. "opencode"). */
	name: string;
	/** Uninstall scope — one of "project" or "user". */
	scope?: string;
	/** Uninstall from all supported scopes. */
	all?: boolean;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
	/** Home directory override for user scope — defaults to `homedir()` from `node:os`. */
	homeDir?: string;
}

/** Typed output from the uninstall data layer. */
export interface HarnessUninstallOutput {
	harnessName: string;
	/** Only the scopes that were actually processed. */
	scopes: Partial<Record<HarnessScope, HarnessUninstallResult>>;
	/** Per scope: whether a `.5x-manifest.json` existed and was removed. */
	manifests: Partial<Record<HarnessScope, boolean>>;
}

/** Tier 1 freshness summary for one installed scope (201-harness-freshness §2.4). */
export interface HarnessScopeFreshness {
	status: FreshnessStatus;
	reason: FreshnessReason;
	inputDeltas: InputDelta[];
}

/** Per-scope installed state for harness list output. */
export interface HarnessScopeStatus {
	installed: boolean;
	root: string;
	files: string[];
	unsupported?: {
		rules?: boolean;
	};
	capabilities?: {
		rules?: boolean;
	};
	/** Tier 1 freshness (§2.4). Absent when the scope is not installed. */
	freshness?: HarnessScopeFreshness;
}

/** A single harness entry in list output. */
export interface HarnessListEntry {
	name: string;
	source: "bundled" | "external";
	description: string;
	/** Only scopes the plugin supports (from plugin.supportedScopes). */
	scopes: Partial<Record<HarnessScope, HarnessScopeStatus>>;
}

/** Typed output from the list data layer. */
export interface HarnessListOutput {
	harnesses: HarnessListEntry[];
}

export interface HarnessListParams {
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
	/** Home directory override for user scope — defaults to `homedir()` from `node:os`. */
	homeDir?: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Install a harness integration.
 *
 * Loads the harness plugin (external-first, bundled fallback), validates
 * the scope, checks prerequisites, and delegates to the plugin's install.
 */
export async function harnessInstall(
	params: HarnessInstallParams,
): Promise<void> {
	const { name, force = false } = params;

	// 1. Load the harness plugin
	const { plugin } = await loadHarnessPlugin(name);

	// 2. Resolve and validate scope
	const scope = resolveScope(params.scope, plugin.supportedScopes, name);

	// 3. Determine project root
	const cwd = resolve(params.startDir ?? ".");
	const checkoutRoot = resolveCheckoutRoot(cwd);
	const projectRoot = checkoutRoot ?? cwd;

	// 4. Project scope prerequisite: control-plane state DB must exist
	if (scope === "project") {
		const stateDb = join(projectRoot, ".5x", DB_FILENAME);
		if (!existsSync(stateDb)) {
			throw new Error(
				"5x project not initialized. Run `5x init` first before installing harness assets.",
			);
		}
	}

	// 5. Load config for model settings (non-fatal for user scope)
	//    The exact directory handed to `resolveLayeredConfig` is the context —
	//    config resolves per context while assets install once per root, so
	//    freshness has no defined operand without it (§2.1).
	const contextDir = cwd;
	const baked = await resolveBakedConfig(cwd, name);

	// 6. Resolve install locations (for reporting)
	const locations = plugin.locations.resolve(
		scope,
		projectRoot,
		params.homeDir,
	);

	// 7. Run the plugin install
	const installCtx: HarnessInstallContext = {
		scope,
		projectRoot,
		force,
		config: baked.config,
		homeDir: params.homeDir,
	};
	const result = await plugin.install(installCtx);

	// 8. Record what was baked — read prior → verify → write (§3.2).
	//    Only runs when install succeeded; never on throw.
	const manifest = await recordInstallManifest({
		name,
		scope,
		plugin,
		installCtx,
		locations,
		result,
		projectRoot,
		contextDir,
		configResolved: baked.configResolved,
	});

	// 9. Report results
	printInstallSummary(
		name,
		scope,
		locations.rootDir,
		result.skills,
		result.agents,
		result.rules,
		result.warnings,
		manifest,
	);
}

/** The baked config surface for one harness, plus whether it resolved at all. */
interface BakedConfig {
	config: HarnessInstallContext["config"];
	/**
	 * `false` marks an install that baked undefined models because config
	 * resolution threw. Recording those as if intentional would make the first
	 * *successful* load read as a config change (§2.1).
	 */
	configResolved: boolean;
}

/**
 * Resolve the per-role models and delegation modes that get baked into this
 * harness's assets.
 *
 * A config that fails to resolve is non-fatal (unchanged behavior): agent
 * templates simply render without model fields, and `configResolved: false`
 * keeps the resulting manifest from ever reading `fresh`.
 *
 * Shared by `install` and `sync` so both bake from exactly the same surface.
 */
async function resolveBakedConfig(
	cwd: string,
	harnessName: string,
): Promise<BakedConfig> {
	try {
		const cp = resolveControlPlaneRoot(cwd);
		const { config } = await resolveLayeredConfig(cp.controlPlaneRoot, cwd);
		return {
			config: {
				authorModel: resolveHarnessModelForRole(config, "author", harnessName),
				reviewerModel: resolveHarnessModelForRole(
					config,
					"reviewer",
					harnessName,
				),
				authorDelegationMode: config.author.delegationMode,
				reviewerDelegationMode: config.reviewer.delegationMode,
			},
			configResolved: true,
		};
	} catch {
		return { config: {}, configResolved: false };
	}
}

/** Tag each `InstallSummary` a plugin returned with the asset kind it describes. */
function kindedSummaries(result: HarnessInstallResult): KindedInstallSummary[] {
	return [
		{ kind: "skill" as const, summary: result.skills },
		{ kind: "agent" as const, summary: result.agents },
		...(result.rules ? [{ kind: "rule" as const, summary: result.rules }] : []),
	];
}

/** The `rootDir`-relative directory prefix each asset kind installs under. */
function manifestPrefixForKind(kind: RenderedAsset["kind"]): string {
	switch (kind) {
		case "skill":
			return "skills/";
		case "agent":
			return "agents/";
		case "rule":
			return "rules/";
	}
}

/**
 * Manifest-relative paths for one field of every summary — the summaries report
 * bare names (`5x-plan/SKILL.md`, `5x-plan-author.md`), so the kind is what
 * resolves them to a path a manifest (and a user) can read.
 */
function summaryPaths(
	summaries: KindedInstallSummary[],
	pick: (summary: KindedInstallSummary["summary"]) => string[] | undefined,
): string[] {
	const out: string[] = [];
	for (const { kind, summary } of summaries) {
		for (const entry of pick(summary) ?? []) {
			out.push(`${manifestPrefixForKind(kind)}${entry}`);
		}
	}
	return out.sort();
}

/** Outcome of the post-install manifest write, for install reporting. */
interface InstallManifestOutcome {
	baseline: ManifestBaseline;
	/** Manifest-relative paths install preserved rather than rewriting. */
	preserved: string[];
}

/**
 * Verify the installed inventory, then write `.5x-manifest.json` at the
 * install root.
 *
 * A manifest never claims a baseline it did not verify: `install()` keeps its
 * skip-on-exist semantics for agent files, so the file set after a non-force
 * reinstall can be a mixture of freshly rendered skills and previously baked
 * agents. When the byte compare fails, the current inputs are *not* adopted —
 * a prior manifest's baseline is retained so warnings can still name the
 * changed fields — and `baseline: "unverified"` forbids ever reading `fresh`
 * until `5x harness sync` establishes a real baseline (§3.2).
 */
async function recordInstallManifest(args: {
	name: string;
	scope: HarnessScope;
	plugin: HarnessPlugin;
	installCtx: HarnessInstallContext;
	locations: HarnessLocations;
	result: HarnessInstallResult;
	projectRoot: string;
	contextDir: string;
	configResolved: boolean;
}): Promise<InstallManifestOutcome> {
	const { locations, result } = args;

	// Install never mutates the prior manifest — it is evidence, read first.
	const prior = readManifest(locations.rootDir);
	const rendered = (await args.plugin.renderAssets?.(args.installCtx)) ?? null;

	const summaries = kindedSummaries(result);

	const onDisk = collectInstalledAssets({
		rootDir: locations.rootDir,
		locations,
		rendered,
		summaries,
		prior,
	});
	const verified = verifyInstalledInventory({
		rendered,
		onDisk,
		summaries: summaries.map((s) => s.summary),
	});

	const currentInputs = {
		authorModel: args.installCtx.config.authorModel,
		reviewerModel: args.installCtx.config.reviewerModel,
		authorDelegationMode: args.installCtx.config.authorDelegationMode,
		reviewerDelegationMode: args.installCtx.config.reviewerDelegationMode,
		cliVersion: version,
		harnessPluginVersion: args.plugin.version ?? version,
		plugin: args.plugin.fingerprintInputs?.(args.installCtx) ?? {},
	};

	const manifest = buildManifest({
		harness: args.name,
		scope: args.scope,
		rootDir: locations.rootDir,
		locations,
		projectRoot: args.projectRoot,
		contextDir: toRelativeContextDir(args.projectRoot, args.contextDir),
		baseline: verified ? "verified" : "unverified",
		// Verified: adopt this bake as the baseline. Unverified: retain the prior
		// baseline when there is one, else record the attempted inputs for
		// diagnostics only — `baseline: "unverified"` forbids `fresh` either way.
		configResolved: verified
			? args.configResolved
			: (prior?.configResolved ?? args.configResolved),
		inputs: verified ? currentInputs : (prior?.inputs ?? currentInputs),
		// Always the true on-disk bytes — a normal reinstall must never look
		// like a hand-edit.
		assets: assetsFromOnDisk(onDisk),
	});
	writeManifest(locations.rootDir, manifest);

	return {
		baseline: manifest.baseline,
		preserved: verified ? [] : preservedPaths(rendered, onDisk, summaries),
	};
}

/**
 * The paths that actually cost this install its baseline.
 *
 * With a render available that is exactly the set whose on-disk bytes differ
 * from what was rendered — listing every skipped-but-identical skill would bury
 * the one stale agent the user needs to see. Without a render there is nothing
 * to compare against, so the skipped set is the best available evidence.
 */
function preservedPaths(
	rendered: RenderedAsset[] | null,
	onDisk: Map<string, string>,
	summaries: KindedInstallSummary[],
): string[] {
	if (rendered) {
		return rendered
			.filter((asset) => onDisk.get(asset.path) !== hashContent(asset.content))
			.map((asset) => asset.path);
	}

	return summaryPaths(summaries, (summary) => summary.skipped);
}

/**
 * `installedFrom.contextDir` relative to `projectRoot`, POSIX-separated,
 * `""` for the root context — so a committed project-scope manifest compares
 * equal across machines and platforms.
 */
function toRelativeContextDir(projectRoot: string, contextDir: string): string {
	const rel = relative(projectRoot, contextDir);
	return rel === "" ? "" : rel.split(sep).join("/");
}

/**
 * List available harnesses with installed state and file listing.
 *
 * Two-layer design: `buildHarnessListData()` builds the typed result,
 * then the outer function prints a human-readable summary and outputs
 * the JSON envelope.
 */
export async function harnessList(
	params?: HarnessListParams,
): Promise<HarnessListOutput> {
	const log = console.log;
	const output = await buildHarnessListData(params?.startDir, params?.homeDir);
	outputSuccess(output, (data) => formatHarnessListText(data, log));
	return output;
}

/**
 * Core data layer for harness list — returns typed result without printing.
 * Enables unit tests to assert on return values directly.
 */
export async function buildHarnessListData(
	startDir?: string,
	homeDir?: string,
): Promise<HarnessListOutput> {
	const cwd = resolve(startDir ?? ".");
	const projectRoot = resolveCheckoutRoot(cwd) ?? cwd;

	const names = listBundledHarnesses();
	const harnesses: HarnessListEntry[] = [];
	const freshness = await collectScopeFreshness(cwd, homeDir);

	for (const name of names) {
		const { plugin, source } = await loadHarnessPlugin(name);
		const description = plugin.description;

		const scopes: Partial<Record<HarnessScope, HarnessScopeStatus>> = {};

		for (const scope of plugin.supportedScopes) {
			const { skillNames, agentNames, ruleNames, capabilities } =
				plugin.describe(scope);
			const locations = plugin.locations.resolve(scope, projectRoot, homeDir);
			const files: string[] = [];

			// Check skill files
			for (const skillName of skillNames) {
				const filePath = join(locations.skillsDir, skillName, "SKILL.md");
				if (existsSync(filePath)) {
					files.push(`skills/${skillName}/SKILL.md`);
				}
			}

			// Check agent files
			for (const agentName of agentNames) {
				const filePath = join(locations.agentsDir, `${agentName}.md`);
				if (existsSync(filePath)) {
					files.push(`agents/${agentName}.md`);
				}
			}

			// Check rule files
			if (capabilities?.rules === true && locations.rulesDir) {
				for (const ruleName of ruleNames ?? []) {
					const filePath = join(locations.rulesDir, `${ruleName}.mdc`);
					if (existsSync(filePath)) {
						files.push(`rules/${ruleName}.mdc`);
					}
				}
			}

			const unsupportedRules =
				capabilities?.rules === false ||
				(capabilities?.rules === undefined && !locations.rulesDir);

			scopes[scope] = {
				installed: files.length > 0,
				root: locations.rootDir,
				files,
				unsupported: unsupportedRules ? { rules: true } : undefined,
				capabilities,
				// A scope with no managed files on disk has nothing to be stale, and
				// the freshness engine reports it `not-installed` — omit the field
				// entirely rather than surface a status that means "n/a".
				freshness:
					files.length > 0 ? freshness.get(`${name}:${scope}`) : undefined,
			};
		}

		harnesses.push({ name, source, description, scopes });
	}

	return { harnesses };
}

/**
 * Tier 1 freshness for the whole harness × scope grid, keyed `harness:scope`.
 *
 * One `runHarnessFreshnessChecks` call resolves config once for every entry, so
 * `list` stays a single config load. A failure degrades `list` to its
 * pre-freshness output instead of failing it — listing what is installed must
 * keep working when the freshness engine cannot answer.
 *
 * `harness.freshnessWarnings = "off"` silences every Phase 5 fire point, and
 * `list` is one of them: the map stays empty so no scope carries a `freshness`
 * field in either text or JSON output. The check runs before the engine, so
 * suppression also skips the work.
 */
async function collectScopeFreshness(
	startDir: string,
	homeDir?: string,
): Promise<Map<string, HarnessScopeFreshness>> {
	const byScope = new Map<string, HarnessScopeFreshness>();
	try {
		if (!(await freshnessWarningsEnabled(startDir))) return byScope;

		for (const report of await runHarnessFreshnessChecks({
			startDir,
			homeDir,
		})) {
			byScope.set(`${report.harness}:${report.scope}`, {
				status: report.status,
				reason: report.reason,
				inputDeltas: report.inputDeltas,
			});
		}
	} catch {
		// Reported as absent freshness, not as a failed list.
	}
	return byScope;
}

// ---------------------------------------------------------------------------
// Sync (Phase 6)
// ---------------------------------------------------------------------------

export interface HarnessSyncParams {
	/** Restrict to one harness; default = every harness with installed assets. */
	name?: string;
	/** Restrict to one scope; default = every supported scope. */
	scope?: string;
	/** Report only; make no writes. Runs Tier 2. */
	check?: boolean;
	/** Overwrite hand-edited assets. */
	force?: boolean;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
	/** Home directory override for user scope — defaults to `homedir()` from `node:os`. */
	homeDir?: string;
}

/**
 * What sync did to one (harness, scope) pair.
 *
 * `sync-unverified` is a failure to baseline, not a success: the assets were
 * rewritten but the post-write byte compare still did not pass, so the manifest
 * records `unverified` and the scope keeps warning.
 */
export type HarnessSyncAction =
	| "synced"
	| "adopted"
	| "skipped-fresh"
	| "skipped-modified"
	| "checked"
	| "sync-unverified";

export interface HarnessSyncScopeResult {
	harness: string;
	scope: HarnessScope;
	root: string;
	action: HarnessSyncAction;
	/** Freshness status before sync ran. */
	before: FreshnessStatus;
	/** Manifest-relative paths written (or, under `--check`, that would be). */
	changed: string[];
	/** Stale managed assets removed. */
	removed: string[];
	/** Hand-edited paths left alone (no `--force`). */
	preserved: string[];
	notes: string[];
}

export interface HarnessSyncOutput {
	results: HarnessSyncScopeResult[];
	/** Stated explicitly: externally-published harnesses are not swept (§5.1). */
	sweptBundledOnly: true;
}

/** Asset delta states a sync would rewrite. `modified` only with `--force`. */
const REWRITTEN_DELTA_STATES: ReadonlySet<AssetDeltaState> = new Set([
	"drifted",
	"added",
	"missing",
	"modified",
]);

/**
 * Re-render every installed harness scope so the assets on disk match the
 * config resolving right now.
 *
 * Two-layer design: `harnessSyncCore()` builds the typed result and never
 * throws on a blocked scope (`5x upgrade` consumes it), while this outer
 * function turns a wholly-blocked sync into `HARNESS_ASSETS_MODIFIED` and
 * prints the envelope.
 */
export async function harnessSync(
	params: HarnessSyncParams,
): Promise<HarnessSyncOutput> {
	const output = await harnessSyncCore(params);

	// A sync where every target was blocked by a hand-edit refreshed nothing:
	// the user asked for a refresh and got none, so it fails rather than
	// reporting success. A partial block completes and reports (§6.1 step 4).
	// `--check` is exempt — it makes no writes, so there is nothing to refuse.
	const blocked = output.results.filter(
		(result) => result.action === "skipped-modified",
	);
	if (
		!params.check &&
		blocked.length > 0 &&
		blocked.length === output.results.length
	) {
		outputError(
			"HARNESS_ASSETS_MODIFIED",
			"Harness assets have local modifications and were preserved. " +
				"Re-run with --force to overwrite them.",
			{ results: output.results },
		);
	}

	outputSuccess(output, (data) => formatHarnessSyncText(data));
	return output;
}

/**
 * Core data layer for harness sync — returns the typed result without printing
 * and without throwing on individual blocked scopes.
 *
 * Sync never *creates* an install: a scope with no managed assets on disk is
 * skipped entirely, because installing is `5x harness install`'s job.
 */
export async function harnessSyncCore(
	params: HarnessSyncParams,
): Promise<HarnessSyncOutput> {
	const cwd = resolve(params.startDir ?? ".");
	const projectRoot = resolveCheckoutRoot(cwd) ?? cwd;
	const scope = await resolveSyncScope(params);

	// One Tier 2 sweep resolves config once for the whole grid; correctness beats
	// speed here, and sync is not a hot path.
	const reports = await runHarnessFreshnessChecks({
		startDir: cwd,
		homeDir: params.homeDir,
		harness: params.name,
		scope,
		tier2: true,
	});

	const results: HarnessSyncScopeResult[] = [];
	for (const report of reports) {
		if (report.status === "not-installed") continue;
		results.push(await syncOneScope(report, { cwd, projectRoot, params }));
	}

	return { results, sweptBundledOnly: true };
}

/** Validate `--scope` against the plugin when one harness was named. */
async function resolveSyncScope(
	params: HarnessSyncParams,
): Promise<HarnessScope | undefined> {
	if (!params.scope) return undefined;
	if (params.scope !== "project" && params.scope !== "user") {
		throw new Error(
			`Invalid scope "${params.scope}". Supported: project, user.`,
		);
	}
	if (params.name) {
		const { plugin } = await loadHarnessPlugin(params.name);
		if (!plugin.supportedScopes.includes(params.scope)) {
			throw new Error(
				`Invalid scope "${params.scope}" for harness "${params.name}". ` +
					`Supported: ${plugin.supportedScopes.join(", ")}.`,
			);
		}
	}
	return params.scope;
}

/**
 * Decide and apply sync for one already-installed scope.
 *
 * The order of the guards is the policy (§6.1): fresh short-circuits (which is
 * what makes sync idempotent), a hand-edit blocks before anything is written,
 * `--check` reports the deltas a real run would apply, and only then does the
 * forced re-render run.
 */
async function syncOneScope(
	report: FreshnessReport,
	ctx: {
		cwd: string;
		projectRoot: string;
		params: HarnessSyncParams;
	},
): Promise<HarnessSyncScopeResult> {
	const { plugin } = await loadHarnessPlugin(report.harness);
	const locations = plugin.locations.resolve(
		report.scope,
		ctx.projectRoot,
		ctx.params.homeDir,
	);

	const base = {
		harness: report.harness,
		scope: report.scope,
		root: locations.rootDir,
		before: report.status,
		changed: [] as string[],
		removed: [] as string[],
		preserved: [] as string[],
		notes: [] as string[],
	};

	const modified = report.assetDeltas
		.filter((delta) => delta.state === "modified")
		.map((delta) => delta.path);

	// `fresh` already implies a verified baseline (§4.2 step 4), so an unverified
	// manifest whose retained inputs happen to match cannot short-circuit here.
	if (report.status === "fresh") return { ...base, action: "skipped-fresh" };

	// A recorded hash is what makes "the user edited this" decidable, so sync
	// reports and preserves rather than inheriting the installer's silent
	// clobber. Adoption (no recorded hashes) has nothing to compare and falls
	// through to the force path below.
	if (modified.length > 0 && !ctx.params.force) {
		return {
			...base,
			action: "skipped-modified",
			preserved: modified,
			notes: ["locally modified — re-run with --force to overwrite"],
		};
	}

	const adopting = isAdoption(locations.rootDir);

	if (ctx.params.check) {
		return {
			...base,
			action: "checked",
			changed: report.assetDeltas
				.filter((delta) => REWRITTEN_DELTA_STATES.has(delta.state))
				.map((delta) => delta.path),
			removed: report.assetDeltas
				.filter((delta) => delta.state === "orphaned")
				.map((delta) => delta.path),
			notes: adopting
				? [
						"no verified baseline on disk — sync would overwrite every managed asset and adopt one",
					]
				: [],
		};
	}

	// `force: true` is what makes sync the command that establishes a baseline:
	// every managed asset is rewritten, so the Phase 3 verification passes and
	// the manifest can honestly record `verified` (§2.5, §3.2).
	const baked = await resolveBakedConfig(ctx.cwd, report.harness);
	const installCtx: HarnessInstallContext = {
		scope: report.scope,
		projectRoot: ctx.projectRoot,
		force: true,
		config: baked.config,
		homeDir: ctx.params.homeDir,
	};
	const result = await plugin.install(installCtx);

	// The same verify-then-write sequence install uses — one manifest assembler,
	// one definition of "verified".
	const manifest = await recordInstallManifest({
		name: report.harness,
		scope: report.scope,
		plugin,
		installCtx,
		locations,
		result,
		projectRoot: ctx.projectRoot,
		contextDir: ctx.cwd,
		configResolved: baked.configResolved,
	});

	const summaries = kindedSummaries(result);
	const notes: string[] = [];
	if (adopting) {
		notes.push(
			"no verified baseline on disk — every managed asset was overwritten and a baseline adopted",
		);
	}
	if (modified.length > 0) {
		notes.push("--force overwrote locally modified assets");
	}
	if (manifest.baseline !== "verified") {
		notes.push(
			"assets were rewritten but could not be verified — no baseline established",
		);
	}

	return {
		...base,
		action:
			manifest.baseline !== "verified"
				? "sync-unverified"
				: adopting
					? "adopted"
					: "synced",
		changed: summaryPaths(summaries, (summary) => [
			...summary.created,
			...summary.overwritten,
		]),
		removed: summaryPaths(summaries, (summary) => summary.removed),
		notes,
	};
}

/**
 * True when there is no recorded baseline to protect — no readable manifest, or
 * one that records no asset hashes at all.
 *
 * Adoption is the case where a hand-edit is indistinguishable from config drift,
 * so the mitigation is legibility: force-install and list every path overwritten
 * (§2.5). An unverified manifest that *does* carry hashes is not adoption —
 * hand-edits stay detectable, so the preserve-without-`--force` rule applies.
 */
function isAdoption(rootDir: string): boolean {
	const prior = readManifest(rootDir);
	return prior === null || prior.assets.length === 0;
}

/** Print a human-readable sync summary. */
export function formatHarnessSyncText(
	data: HarnessSyncOutput,
	log: (...args: unknown[]) => void = console.log,
): void {
	if (data.results.length === 0) {
		log("No installed harness assets to sync.");
	}

	for (const [i, result] of data.results.entries()) {
		log(`harness: ${result.harness}`);
		log(`scope: ${result.scope}`);
		log(`  action: ${result.action}`);
		log(`  before: ${result.before}`);
		log(`  root: ${result.root}`);
		logPathList(log, "changed", result.changed);
		logPathList(log, "removed", result.removed);
		logPathList(log, "preserved", result.preserved);
		for (const note of result.notes) log(`  note: ${note}`);
		if (i < data.results.length - 1) log("");
	}

	log("");
	log("Note: only bundled harnesses are swept. Externally-published harness");
	log("      packages are not — run `5x harness sync <name>` for those.");
}

function logPathList(
	log: (...args: unknown[]) => void,
	label: string,
	paths: string[],
): void {
	log(`  ${label}:`);
	if (paths.length === 0) {
		log("    (none)");
		return;
	}
	for (const path of paths) log(`    ${path}`);
}

/**
 * Uninstall a harness integration.
 *
 * Two-layer design: `harnessUninstallCore()` builds the typed result,
 * then the outer function prints a summary and returns the data.
 */
export async function harnessUninstall(
	params: HarnessUninstallParams,
): Promise<HarnessUninstallOutput> {
	const output = await harnessUninstallCore(params);
	outputSuccess(output);
	return output;
}

/**
 * Core data layer for harness uninstall — returns typed result without
 * printing. Enables unit tests to assert on return values directly.
 */
async function harnessUninstallCore(
	params: HarnessUninstallParams,
): Promise<HarnessUninstallOutput> {
	const { name, scope, all } = params;

	// 1. Load the harness plugin
	const { plugin } = await loadHarnessPlugin(name);

	// 2. Validate: exactly one of --scope or --all must be set
	if (scope && all) {
		throw new Error(
			"Cannot specify both --scope and --all. Use one or the other.",
		);
	}
	if (!scope && !all) {
		throw new Error(
			"Must specify either --scope or --all for harness uninstall.",
		);
	}

	// 3. Determine scopes to process
	let scopesToProcess: HarnessScope[];
	if (all) {
		scopesToProcess = [...plugin.supportedScopes];
	} else {
		// Validate scope against supported scopes
		if (!plugin.supportedScopes.includes(scope as HarnessScope)) {
			throw new Error(
				`Invalid scope "${scope}" for harness "${name}". ` +
					`Supported: ${plugin.supportedScopes.join(", ")}.`,
			);
		}
		scopesToProcess = [scope as HarnessScope];
	}

	// 4. Resolve project root: resolveCheckoutRoot(cwd) ?? cwd
	const cwd = resolve(params.startDir ?? ".");
	const projectRoot = resolveCheckoutRoot(cwd) ?? cwd;

	// 5. No 5x init prerequisite check — uninstall should work even
	//    if the project state DB is missing or removed.

	// 6. Run uninstall for each scope
	const scopes: Partial<Record<HarnessScope, HarnessUninstallResult>> = {};
	const manifests: Partial<Record<HarnessScope, boolean>> = {};
	for (const s of scopesToProcess) {
		const locations = plugin.locations.resolve(s, projectRoot, params.homeDir);
		// Remove the manifest *before* uninstall: the plugin's emptiness sweeps
		// only cover skills/agents/rules dirs, so a surviving root-level manifest
		// would keep an otherwise-empty `.opencode/` alive.
		manifests[s] = removeManifest(locations.rootDir);
		scopes[s] = await plugin.uninstall({
			scope: s,
			projectRoot,
			homeDir: params.homeDir,
		});
		// Now able to succeed — but still empty-only, so a user's own
		// `opencode.json` at the root keeps the directory.
		removeDirIfEmpty(locations.rootDir);
	}

	return { harnessName: name, scopes, manifests };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the --scope value against the plugin's supported scopes.
 *
 * - If the plugin supports exactly one scope, auto-infer it.
 * - If the plugin supports multiple scopes and --scope is omitted, error.
 * - If the provided scope is not supported, error.
 */
function resolveScope(
	rawScope: string | undefined,
	supportedScopes: readonly string[],
	harnessName: string,
): HarnessScope {
	if (supportedScopes.length === 1) {
		const only = supportedScopes[0] as HarnessScope;
		if (rawScope && rawScope !== only) {
			throw new Error(
				`Harness "${harnessName}" only supports --scope ${only}.`,
			);
		}
		return only;
	}

	if (!rawScope) {
		throw new Error(
			`Harness "${harnessName}" supports multiple scopes. ` +
				`Specify --scope (${supportedScopes.join(" | ")}).`,
		);
	}

	if (!supportedScopes.includes(rawScope)) {
		throw new Error(
			`Invalid scope "${rawScope}" for harness "${harnessName}". ` +
				`Supported: ${supportedScopes.join(", ")}.`,
		);
	}

	return rawScope as HarnessScope;
}

/**
 * Print a human-readable install summary to stdout.
 */
function printInstallSummary(
	harnessName: string,
	scope: HarnessScope,
	rootDir: string,
	skills: { created: string[]; overwritten: string[]; skipped: string[] },
	agents: { created: string[]; overwritten: string[]; skipped: string[] },
	rules?: { created: string[]; overwritten: string[]; skipped: string[] },
	warnings?: string[],
	manifest?: InstallManifestOutcome,
): void {
	const label = scope === "user" ? "user" : "project";

	console.log(`  Install root: ${rootDir}`);

	for (const name of skills.created) {
		console.log(`  Created skill: ${name}`);
	}
	for (const name of skills.overwritten) {
		console.log(`  Overwrote skill: ${name}`);
	}
	for (const name of skills.skipped) {
		console.log(`  Skipped skill: ${name} (already exists)`);
	}

	for (const name of agents.created) {
		console.log(`  Created agent: ${name}`);
	}
	for (const name of agents.overwritten) {
		console.log(`  Overwrote agent: ${name}`);
	}
	for (const name of agents.skipped) {
		console.log(`  Skipped agent: ${name} (already exists)`);
	}

	if (rules) {
		for (const name of rules.created) {
			console.log(`  Created rule: ${name}`);
		}
		for (const name of rules.overwritten) {
			console.log(`  Overwrote rule: ${name}`);
		}
		for (const name of rules.skipped) {
			console.log(`  Skipped rule: ${name} (already exists)`);
		}
	}

	for (const warning of warnings ?? []) {
		console.log(`  Warning: ${warning}`);
	}

	if (manifest) {
		console.log(`  Wrote manifest: ${MANIFEST_FILENAME}`);
		if (manifest.baseline === "unverified") {
			// stderr so the signal survives a piped/parsed stdout (§2.4).
			console.error(
				"  Warning: existing assets were preserved — freshness baseline not established; run '5x harness sync'",
			);
			for (const path of manifest.preserved) {
				console.error(`    preserved: ${path}`);
			}
		}
	}

	if (harnessName === "cursor" && scope === "user") {
		console.log(
			"  Note: Cursor user rules are settings-managed. Install with --scope project to add the orchestrator rule.",
		);
	}

	console.log(`  ${harnessName} ${label} install complete.`);
}

/**
 * Print a human-readable harness list grouped by scope and file type.
 */
export function formatHarnessListText(
	data: HarnessListOutput,
	log: (...args: unknown[]) => void = console.log,
): void {
	for (const [i, harness] of data.harnesses.entries()) {
		log(`harness: ${harness.name}`);
		log(`source: ${harness.source}`);
		log(`description: ${harness.description}`);

		for (const scope of ["project", "user"] as const) {
			const status = harness.scopes[scope];
			if (!status) continue;

			log(`${scope}:`);
			log(`  installed: ${status.installed}`);
			if (status.freshness) {
				const { status: freshnessStatus, reason } = status.freshness;
				log(
					`  freshness: ${reason ? `${freshnessStatus} (${reason})` : freshnessStatus}`,
				);
			}
			log(`  root: ${status.root}`);

			const skills = status.files.filter((file) => file.startsWith("skills/"));
			const agents = status.files.filter((file) => file.startsWith("agents/"));
			const rules = status.files.filter((file) => file.startsWith("rules/"));

			log("  skills:");
			if (skills.length === 0) {
				log("    (none)");
			} else {
				for (const file of skills) log(`    ${file}`);
			}

			log("  agents:");
			if (agents.length === 0) {
				log("    (none)");
			} else {
				for (const file of agents) log(`    ${file}`);
			}

			if (status.unsupported?.rules === true) {
				log("  rules: unsupported");
				if (harness.name === "cursor" && scope === "user") {
					log(
						"  Note: Cursor user rules are settings-managed and not file-backed. Install with --scope project to add the orchestrator rule.",
					);
				}
			} else {
				log("  rules:");
				if (rules.length === 0) {
					log("    (none)");
				} else {
					for (const file of rules) log(`    ${file}`);
				}
			}
		}

		if (i < data.harnesses.length - 1) {
			log("");
		}
	}
}
