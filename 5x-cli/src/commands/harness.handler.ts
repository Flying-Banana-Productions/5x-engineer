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
	assetsFromOnDisk,
	buildManifest,
	collectInstalledAssets,
	type FreshnessReason,
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
import { outputSuccess } from "../output.js";
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
	let authorModel: string | undefined;
	let reviewerModel: string | undefined;
	let authorDelegationMode: "native" | "invoke" | undefined;
	let reviewerDelegationMode: "native" | "invoke" | undefined;
	// `configResolved: false` marks an install that baked undefined models
	// because config resolution threw. Recording those as if intentional would
	// make the first *successful* load read as a config change (§2.1).
	let configResolved = false;
	// The exact directory handed to `resolveLayeredConfig` — config resolves per
	// context while assets install once per root, so freshness has no defined
	// operand without it (§2.1).
	const contextDir = cwd;
	try {
		const cp = resolveControlPlaneRoot(cwd);
		const { config } = await resolveLayeredConfig(cp.controlPlaneRoot, cwd);
		authorModel = resolveHarnessModelForRole(config, "author", name);
		reviewerModel = resolveHarnessModelForRole(config, "reviewer", name);
		authorDelegationMode = config.author.delegationMode;
		reviewerDelegationMode = config.reviewer.delegationMode;
		configResolved = true;
	} catch {
		// Config load failure is non-fatal (unchanged) — agent templates will be
		// rendered without model fields.
	}

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
		config: {
			authorModel,
			reviewerModel,
			authorDelegationMode,
			reviewerDelegationMode,
		},
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
		configResolved,
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

	const summaries: KindedInstallSummary[] = [
		{ kind: "skill" as const, summary: result.skills },
		{ kind: "agent" as const, summary: result.agents },
		...(result.rules ? [{ kind: "rule" as const, summary: result.rules }] : []),
	];

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

	const out: string[] = [];
	for (const { kind, summary } of summaries) {
		const prefix =
			kind === "skill" ? "skills/" : kind === "agent" ? "agents/" : "rules/";
		for (const entry of summary.skipped) out.push(`${prefix}${entry}`);
	}
	return out;
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
