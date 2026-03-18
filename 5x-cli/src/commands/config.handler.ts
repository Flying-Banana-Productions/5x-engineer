/**
 * Config command handler — business logic for `5x config` subcommands.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Subcommands:
 * - show: Display the resolved config as a JSON envelope
 */

import { resolveLayeredConfig } from "../config.js";
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

export interface ConfigShowOutput {
	author: {
		provider: string;
		model?: string;
		timeout?: number;
		continuePhaseSessions: boolean;
	};
	reviewer: {
		provider: string;
		model?: string;
		timeout?: number;
		continuePhaseSessions: boolean;
	};
	opencode: {
		url?: string;
	};
	qualityGates: string[];
	skipQualityGates: boolean;
	paths: {
		plans: string;
		reviews: string;
		planReviews?: string;
		runReviews?: string;
		archive: string;
		templates: {
			plan: string;
			review: string;
		};
	};
	db: {
		path: string;
	};
	worktree: {
		postCreate?: string;
	};
	maxStepsPerRun: number;
	maxReviewIterations: number;
	maxQualityRetries: number;
	maxAutoIterations: number;
	maxAutoRetries: number;
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

/**
 * Human-readable text formatter for `config show` output.
 *
 * Renders key config values in aligned key-value format.
 */
export function formatConfigText(data: ConfigShowOutput): void {
	console.log("Author:");
	console.log(`  provider                ${data.author.provider}`);
	if (data.author.model) {
		console.log(`  model                   ${data.author.model}`);
	}
	if (data.author.timeout) {
		console.log(`  timeout                 ${data.author.timeout}s`);
	}
	console.log(`  continuePhaseSessions   ${data.author.continuePhaseSessions}`);

	console.log("Reviewer:");
	console.log(`  provider                ${data.reviewer.provider}`);
	if (data.reviewer.model) {
		console.log(`  model                   ${data.reviewer.model}`);
	}
	if (data.reviewer.timeout) {
		console.log(`  timeout                 ${data.reviewer.timeout}s`);
	}
	console.log(
		`  continuePhaseSessions   ${data.reviewer.continuePhaseSessions}`,
	);

	console.log("Paths:");
	console.log(`  plans                   ${data.paths.plans}`);
	console.log(`  reviews                 ${data.paths.reviews}`);
	if (data.paths.planReviews) {
		console.log(`  planReviews             ${data.paths.planReviews}`);
	}
	if (data.paths.runReviews) {
		console.log(`  runReviews              ${data.paths.runReviews}`);
	}
	console.log(`  archive                 ${data.paths.archive}`);
	console.log(`  templates.plan          ${data.paths.templates.plan}`);
	console.log(`  templates.review        ${data.paths.templates.review}`);

	console.log("Database:");
	console.log(`  path                    ${data.db.path}`);

	console.log("Limits:");
	console.log(`  maxStepsPerRun          ${data.maxStepsPerRun}`);
	console.log(`  maxReviewIterations     ${data.maxReviewIterations}`);
	console.log(`  maxQualityRetries       ${data.maxQualityRetries}`);
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

	const output: ConfigShowOutput = {
		author: {
			provider: config.author.provider,
			...(config.author.model ? { model: config.author.model } : {}),
			...(config.author.timeout ? { timeout: config.author.timeout } : {}),
			continuePhaseSessions: config.author.continuePhaseSessions,
		},
		reviewer: {
			provider: config.reviewer.provider,
			...(config.reviewer.model ? { model: config.reviewer.model } : {}),
			...(config.reviewer.timeout ? { timeout: config.reviewer.timeout } : {}),
			continuePhaseSessions: config.reviewer.continuePhaseSessions,
		},
		opencode: {
			...(config.opencode.url ? { url: config.opencode.url } : {}),
		},
		qualityGates: config.qualityGates,
		skipQualityGates: config.skipQualityGates,
		paths: {
			plans: config.paths.plans,
			reviews: config.paths.reviews,
			...(config.paths.planReviews
				? { planReviews: config.paths.planReviews }
				: {}),
			...(config.paths.runReviews
				? { runReviews: config.paths.runReviews }
				: {}),
			archive: config.paths.archive,
			templates: {
				plan: config.paths.templates.plan,
				review: config.paths.templates.review,
			},
		},
		db: {
			path: config.db.path,
		},
		worktree: {
			...(config.worktree.postCreate
				? { postCreate: config.worktree.postCreate }
				: {}),
		},
		maxStepsPerRun: config.maxStepsPerRun,
		maxReviewIterations: config.maxReviewIterations,
		maxQualityRetries: config.maxQualityRetries,
		maxAutoIterations: config.maxAutoIterations,
		maxAutoRetries: config.maxAutoRetries,
	};

	outputSuccess(output, formatConfigText);
}
