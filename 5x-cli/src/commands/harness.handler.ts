/**
 * Harness command handler — business logic for harness install/list.
 *
 * Framework-independent: no citty imports.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.js";
import {
	listBundledHarnesses,
	loadHarnessPlugin,
} from "../harnesses/factory.js";
import type { HarnessScope } from "../harnesses/types.js";
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
	});

	// 8. Report results
	printInstallSummary(name, scope, result.skills, result.agents);
}

/**
 * List available harnesses (bundled names only for now).
 */
export function harnessList(): void {
	const names = listBundledHarnesses();
	for (const name of names) {
		console.log(`  ${name}`);
	}
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
