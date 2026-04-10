/**
 * Harness command handler — business logic for harness install/list/uninstall.
 *
 * Framework-independent: no CLI framework imports.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveHarnessModelForRole, resolveLayeredConfig } from "../config.js";
import {
	listBundledHarnesses,
	loadHarnessPlugin,
} from "../harnesses/factory.js";
import type {
	HarnessScope,
	HarnessUninstallResult,
} from "../harnesses/types.js";
import { outputSuccess } from "../output.js";
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
	try {
		const cp = resolveControlPlaneRoot(cwd);
		const { config } = await resolveLayeredConfig(cp.controlPlaneRoot, cwd);
		authorModel = resolveHarnessModelForRole(config, "author", name);
		reviewerModel = resolveHarnessModelForRole(config, "reviewer", name);
		authorDelegationMode = config.author.delegationMode;
		reviewerDelegationMode = config.reviewer.delegationMode;
	} catch {
		// Config load failure is non-fatal — agent templates will be
		// rendered without model fields.
	}

	// 6. Resolve install locations (for reporting)
	const locations = plugin.locations.resolve(
		scope,
		projectRoot,
		params.homeDir,
	);

	// 7. Run the plugin install
	const result = await plugin.install({
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
	});

	// 8. Report results
	printInstallSummary(
		name,
		scope,
		locations.rootDir,
		result.skills,
		result.agents,
		result.rules,
		result.warnings,
	);
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
			};
		}

		harnesses.push({ name, source, description, scopes });
	}

	return { harnesses };
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
	for (const s of scopesToProcess) {
		scopes[s] = await plugin.uninstall({
			scope: s,
			projectRoot,
			homeDir: params.homeDir,
		});
	}

	return { harnessName: name, scopes };
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
function formatHarnessListText(
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
