/**
 * Harness command handler — business logic for harness install/list/uninstall.
 *
 * Framework-independent: no CLI framework imports.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.js";
import {
	listBundledHarnesses,
	loadHarnessPlugin,
} from "../harnesses/factory.js";
import type {
	HarnessScope,
	HarnessUninstallResult,
} from "../harnesses/types.js";
import { outputSuccess } from "../output.js";
import { listSkills } from "../skills/loader.js";
import { DB_FILENAME, resolveCheckoutRoot } from "./control-plane.js";

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
	/** Home directory override for user scope — defaults to `process.env.HOME`. */
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
	/** Home directory override for user scope — defaults to `process.env.HOME`. */
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
	files: string[];
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
	/** Home directory override for user scope — defaults to `process.env.HOME`. */
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
	try {
		const { config } = await loadConfig(projectRoot);
		authorModel = config.author?.model?.trim() || undefined;
		reviewerModel = config.reviewer?.model?.trim() || undefined;
	} catch {
		// Config load failure is non-fatal — agent templates will be
		// rendered without model fields.
	}

	// 6. Gather bundled skills
	const skills = listSkills();

	// 7. Run the plugin install
	const result = await plugin.install({
		scope,
		projectRoot,
		force,
		skills,
		config: { authorModel, reviewerModel },
		homeDir: params.homeDir,
	});

	// 8. Report results
	printInstallSummary(name, scope, result.skills, result.agents);
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
	const output = await buildHarnessListData(params?.startDir, params?.homeDir);
	printListSummary(output);
	outputSuccess(output);
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
		const { skillNames, agentNames } = plugin.describe();

		const scopes: Partial<Record<HarnessScope, HarnessScopeStatus>> = {};

		for (const scope of plugin.supportedScopes) {
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

			scopes[scope] = {
				installed: files.length > 0,
				files,
			};
		}

		harnesses.push({ name, source, description, scopes });
	}

	return { harnesses };
}

/**
 * Print a human-readable list summary to stderr.
 */
function printListSummary(output: HarnessListOutput): void {
	for (const entry of output.harnesses) {
		console.error(`  ${entry.name} (${entry.source})`);
		for (const [scope, status] of Object.entries(entry.scopes)) {
			if (!status) continue;
			const stateLabel = status.installed ? "installed" : "not installed";
			console.error(`    ${scope}: ${stateLabel}`);
			for (const file of status.files) {
				console.error(`      ${file}`);
			}
		}
	}
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
	printUninstallSummary(output);
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

/**
 * Print a human-readable uninstall summary to stderr.
 */
function printUninstallSummary(output: HarnessUninstallOutput): void {
	for (const [scope, result] of Object.entries(output.scopes)) {
		if (!result) continue;
		const label = scope === "user" ? "user" : "project";

		for (const name of result.skills.removed) {
			console.error(`  Removed skill (${label}): ${name}`);
		}
		for (const name of result.skills.notFound) {
			console.error(`  Not found skill (${label}): ${name}`);
		}
		for (const name of result.agents.removed) {
			console.error(`  Removed agent (${label}): ${name}`);
		}
		for (const name of result.agents.notFound) {
			console.error(`  Not found agent (${label}): ${name}`);
		}
	}

	console.error(`  ${output.harnessName} uninstall complete.`);
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
	skills: { created: string[]; overwritten: string[]; skipped: string[] },
	agents: { created: string[]; overwritten: string[]; skipped: string[] },
): void {
	const label = scope === "user" ? "user" : "project";

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

	console.log(`  ${harnessName} ${label} install complete.`);
}
