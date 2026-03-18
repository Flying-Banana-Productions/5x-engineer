/**
 * Config command handler — business logic for `5x config` subcommands.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Subcommands:
 * - show: Display the resolved config as a JSON envelope
 */

import { type FiveXConfig, resolveLayeredConfig } from "../config.js";
import { outputSuccess } from "../output.js";
import { resolveControlPlaneRoot } from "./control-plane.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigShowParams {
	/** Starting directory for control-plane root resolution (testability). */
	startDir?: string;
	/** Directory for plan-path-anchored config layering. Defaults to cwd. */
	contextDir?: string;
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

/**
 * Human-readable text formatter for `config show` output.
 *
 * Renders key config values in aligned key-value format.
 * Returns the formatted string (pure function, no side effects).
 */
export function formatConfigText(data: FiveXConfig): string {
	const lines: string[] = [];

	lines.push("Author:");
	lines.push(`  provider                ${data.author.provider}`);
	if (data.author.model) {
		lines.push(`  model                   ${data.author.model}`);
	}
	if (data.author.timeout) {
		lines.push(`  timeout                 ${data.author.timeout}s`);
	}
	lines.push(`  continuePhaseSessions   ${data.author.continuePhaseSessions}`);

	lines.push("Reviewer:");
	lines.push(`  provider                ${data.reviewer.provider}`);
	if (data.reviewer.model) {
		lines.push(`  model                   ${data.reviewer.model}`);
	}
	if (data.reviewer.timeout) {
		lines.push(`  timeout                 ${data.reviewer.timeout}s`);
	}
	lines.push(
		`  continuePhaseSessions   ${data.reviewer.continuePhaseSessions}`,
	);

	lines.push("Paths:");
	lines.push(`  plans                   ${data.paths.plans}`);
	lines.push(`  reviews                 ${data.paths.reviews}`);
	if (data.paths.planReviews) {
		lines.push(`  planReviews             ${data.paths.planReviews}`);
	}
	if (data.paths.runReviews) {
		lines.push(`  runReviews              ${data.paths.runReviews}`);
	}
	lines.push(`  archive                 ${data.paths.archive}`);
	lines.push(`  templates.plan          ${data.paths.templates.plan}`);
	lines.push(`  templates.review        ${data.paths.templates.review}`);

	lines.push("Database:");
	lines.push(`  path                    ${data.db.path}`);

	lines.push("Limits:");
	lines.push(`  maxStepsPerRun          ${data.maxStepsPerRun}`);
	lines.push(`  maxReviewIterations     ${data.maxReviewIterations}`);
	lines.push(`  maxQualityRetries       ${data.maxQualityRetries}`);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function configShow(params: ConfigShowParams = {}): Promise<void> {
	const controlPlane = resolveControlPlaneRoot(params.startDir);

	const contextDir = params.contextDir ?? process.cwd();

	const { config } = await resolveLayeredConfig(
		controlPlane.controlPlaneRoot,
		contextDir,
	);

	outputSuccess(config, (data: FiveXConfig) => {
		console.log(formatConfigText(data));
	});
}
