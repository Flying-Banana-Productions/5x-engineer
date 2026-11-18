/**
 * Guide command handlers — business logic for `5x guide`.
 *
 * A guide is the standalone form of a task prompt: the same project rules a
 * delegated worker gets, with the delegated-workflow ending replaced by
 * instructions for an agent working directly with the operator, outside a run.
 *
 * Guides are read-only. They open no database, start no run, take no lock and
 * write nothing, so they work in a repository that has never run `5x init`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveLayeredConfig } from "../config.js";
import {
	getOutputFormat,
	isOutputFormatExplicit,
	outputError,
	outputSuccess,
} from "../output.js";
import { isPathUnder, relativePathUnder } from "../paths.js";
import { DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE } from "../templates/default-artifacts.js";
import {
	getTemplateSource,
	renderTemplate,
	setTemplateOverrideDir,
} from "../templates/loader.js";
import {
	controlPlaneStatePath,
	resolveControlPlaneRoot,
} from "./control-plane.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuidePlanParams {
	/** Requirements document (TDD, PRD, saved issue body). Optional. */
	source?: string;
	/** Target plan path. Optional; must resolve inside `paths.plans`. */
	out?: string;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
	/** Warning sink for config loading — defaults to stderr. */
	warn?: (...args: unknown[]) => void;
}

export interface GuidePlanResult {
	guide: "plan";
	/** The complete guide, as markdown. */
	prompt: string;
	/** Absolute requirements path, or null when none was given. */
	source_path: string | null;
	/** Absolute plan path, or null when the agent is left to choose one. */
	plan_path: string | null;
	/** Absolute configured plans directory. */
	plans_dir: string;
	/** Absolute configured plan skeleton path. */
	plan_template_path: string;
	/** True when the skeleton is missing on disk and the bundled one is inlined. */
	plan_template_inlined: boolean;
	/** Whether the task prompt came from the bundle or a project override. */
	template_source: "bundled" | "override";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The task prompt a plan guide is built from. */
export const PLAN_GUIDE_TEMPLATE = "author-generate-plan";

/**
 * Sections of the task prompt that only make sense for a delegated worker.
 * The guide drops them and appends its own ending instead.
 */
export const DELEGATED_ONLY_SECTIONS = [
	"Non-Interactive Execution",
	"Completion",
] as const;

/** Stand-in used throughout the guide when no plan path was given. */
export const PLAN_PATH_PLACEHOLDER = "<plan-path>";

/** Stand-in used throughout the guide when no requirements file was given. */
export const SOURCE_PLACEHOLDER = "<requirements>";

/** Where the guide points when the configured skeleton is missing on disk. */
const INLINED_TEMPLATE_REFERENCE =
	'the "Plan Template" section at the end of this guide';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove level-2 sections by heading text. A section runs from its heading to
 * the next level-1 or level-2 heading outside a fenced code block.
 */
export function stripSections(
	markdown: string,
	headings: readonly string[],
): { text: string; removed: string[] } {
	const wanted = new Set(headings);
	const removed: string[] = [];
	const kept: string[] = [];
	let skipping = false;
	let fence: string | null = null;

	for (const line of markdown.split("\n")) {
		const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1] as string;
			if (fence === null) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length)
				fence = null;
		} else if (fence === null) {
			const heading = /^(#{1,2})\s+(.*?)\s*#*\s*$/.exec(line);
			if (heading) {
				const title = heading[2] as string;
				skipping = heading[1] === "##" && wanted.has(title);
				if (skipping) removed.push(title);
			}
		}
		if (!skipping) kept.push(line);
	}

	return { text: kept.join("\n").trimEnd(), removed };
}

/** A path as the agent should type it: relative to its cwd when possible. */
function displayPath(absPath: string, cwd: string): string {
	const rel = relativePathUnder(absPath, cwd);
	if (rel === null || rel === "") return absPath;
	return rel.replace(/\\/g, "/");
}

/** A fence long enough to wrap content that itself contains fences. */
function fenceFor(content: string): string {
	const longest = (content.match(/`+/g) ?? []).reduce(
		(max, run) => Math.max(max, run.length),
		0,
	);
	return "`".repeat(Math.max(3, longest + 1));
}

interface StandaloneSectionInput {
	source: string | null;
	plan: string | null;
	planExists: boolean;
	plansDir: string;
	inlinedTemplate: string | null;
}

/** The ending the guide owns: everything after the project's planning rules. */
function standaloneSection(input: StandaloneSectionInput): string {
	const plan = input.plan ?? PLAN_PATH_PLACEHOLDER;
	const parts: string[] = [];

	parts.push(
		[
			"## Standalone Authoring",
			"",
			"You are working directly with the operator, outside a 5x run. This section",
			"replaces any delegated-workflow completion instructions above.",
			"",
			"- Your job is to author the plan only. Do not run `5x run init`, do not review",
			"  your own plan, and do not start implementing it.",
			"- You may ask the operator questions. Wherever the instructions above say to",
			"  return `needs_human`, stop and ask the operator instead.",
			"- Do not run `5x commit` or `5x protocol emit`; both belong to a 5x run.",
		].join("\n"),
	);

	if (input.source === null) {
		parts.push(
			[
				"### Requirements",
				"",
				`No requirements file was given. \`${SOURCE_PLACEHOLDER}\` in this guide means the`,
				"requirements the operator has given you in this conversation, such as a pasted",
				"document, an issue body, or a description. If you have none, ask the operator",
				"before writing anything. A reviewer will later read the plan without this",
				"conversation, so the plan must state those requirements well enough to stand",
				"on its own.",
			].join("\n"),
		);
	}

	if (input.plan === null) {
		parts.push(
			[
				"### Output path",
				"",
				`No output path was given. Plans for this project live in \`${input.plansDir}\`.`,
				"Choose a file name there that matches the plans already present, and ask the",
				"operator if no convention is evident. Use that path wherever",
				`\`${PLAN_PATH_PLACEHOLDER}\` appears in this guide.`,
			].join("\n"),
		);
	} else if (input.planExists) {
		parts.push(
			[
				"### Output path",
				"",
				`A file already exists at \`${plan}\`. Confirm with the operator before`,
				"overwriting it.",
			].join("\n"),
		);
	}

	parts.push(
		[
			"### Check the plan",
			"",
			`    5x plan phases ${plan} | jq '.data.executability'`,
			"",
			"The plan must parse, have at least one phase, and report `executable: true`.",
			"If a phase has no executable items, preview the fix with:",
			"",
			`    5x plan repair-checklists --plan ${plan} --dry-run`,
		].join("\n"),
	);

	parts.push(
		[
			"### Commit",
			"",
			"Do not commit, create a branch, or push without the operator's go-ahead.",
			"Once the plan passes the check above, ask the operator how they want it",
			"committed.",
			"",
			"If they ask you to commit it:",
			"",
			"- Follow this repository's conventions as documented (CONTRIBUTING, AGENTS.md",
			"  / CLAUDE.md, recent `git log`) for branch naming and commit message format.",
			"- If the current branch looks protected or is the default branch and the",
			"  repository works through feature branches, say so and ask which branch to use.",
			"- Commit only the plan file. Do not push unless asked.",
		].join("\n"),
	);

	parts.push(
		[
			"### Hand off",
			"",
			"Tell the operator where the plan is and whether it is committed (and on which",
			"branch). The plan must be committed, and reachable from the branch the",
			"orchestrator will run on, before plan review can start in their orchestrating",
			"harness (the `5x-plan-review` skill on that path). Report any assumptions or",
			"open questions you recorded in the plan.",
		].join("\n"),
	);

	if (input.inlinedTemplate !== null) {
		const fence = fenceFor(input.inlinedTemplate);
		parts.push(
			[
				"## Plan Template",
				"",
				"This project has no plan template on disk, so this is the bundled 5x default.",
				"Follow it as the plan template referred to above.",
				"",
				`${fence}markdown`,
				input.inlinedTemplate.trimEnd(),
				fence,
			].join("\n"),
		);
	}

	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Build the plan-authoring guide. Throws `CliError` on invalid input; never
 * writes to disk or opens the control-plane database.
 */
export async function buildPlanGuide(
	params: GuidePlanParams = {},
): Promise<GuidePlanResult> {
	const cwd = resolve(params.startDir ?? ".");
	const controlPlane = resolveControlPlaneRoot(cwd);
	const projectRoot = controlPlane.controlPlaneRoot;

	// --- Requirements document --------------------------------------------
	let sourcePath: string | null = null;
	if (params.source !== undefined) {
		sourcePath = resolve(cwd, params.source);
		if (!existsSync(sourcePath)) {
			outputError(
				"SOURCE_NOT_FOUND",
				`Requirements document not found: ${sourcePath}`,
				{ source_path: sourcePath },
				2,
			);
		}
	}

	// --- Plan path and the config that governs it -------------------------
	// Like `run init`, config is anchored to the plan's location so a
	// sub-project's `paths.plans` and plan template apply.
	const planPath = params.out !== undefined ? resolve(cwd, params.out) : null;
	if (planPath && !isPathUnder(planPath, projectRoot)) {
		outputError(
			"PLAN_OUTSIDE_CONTROL_PLANE",
			`Plan path \`${planPath}\` is outside the repository root \`${projectRoot}\`. Move the plan under the repository root.`,
			{ plan_path: planPath, control_plane_root: projectRoot },
		);
	}

	const layered = await resolveLayeredConfig(
		projectRoot,
		planPath ? dirname(planPath) : cwd,
		params.warn,
	);
	const config = layered.config;
	const plansDir = resolve(projectRoot, config.paths.plans);

	if (planPath && !isPathUnder(planPath, plansDir)) {
		const configPath = layered.nearestConfigPath ?? layered.rootConfigPath;
		const configHint = configPath
			? ` Update \`${configPath}\` if this project should use a different plans directory.`
			: " Configure `[paths].plans` in `5x.toml` if this project should use a different plans directory.";
		outputError(
			"INVALID_ARGS",
			`Plan path \`${planPath}\` must be inside configured paths.plans directory \`${plansDir}\`.${configHint}`,
			{
				plan_path: planPath,
				configured_plans_dir: plansDir,
				config_path: configPath,
			},
		);
	}

	// --- Plan skeleton ----------------------------------------------------
	const planTemplatePath = resolve(projectRoot, config.paths.templates.plan);
	const inlined = !existsSync(planTemplatePath);
	if (!inlined) assertReadableFile(planTemplatePath);

	// --- Render the project's planning rules ------------------------------
	// Set the override directory immediately before the synchronous render:
	// it is process-wide state.
	setTemplateOverrideDir(
		controlPlaneStatePath(
			projectRoot,
			controlPlane.stateDir,
			"templates/prompts",
		),
	);
	const templateSource = getTemplateSource(PLAN_GUIDE_TEMPLATE);
	const rendered = renderTemplate(PLAN_GUIDE_TEMPLATE, {
		prd_path: sourcePath ? displayPath(sourcePath, cwd) : SOURCE_PLACEHOLDER,
		plan_path: planPath ? displayPath(planPath, cwd) : PLAN_PATH_PLACEHOLDER,
		plan_template_path: inlined
			? INLINED_TEMPLATE_REFERENCE
			: displayPath(planTemplatePath, cwd),
	});

	const { text: rules } = stripSections(
		rendered.prompt,
		DELEGATED_ONLY_SECTIONS,
	);

	const ending = standaloneSection({
		source: sourcePath ? displayPath(sourcePath, cwd) : null,
		plan: planPath ? displayPath(planPath, cwd) : null,
		planExists: planPath !== null && existsSync(planPath),
		plansDir: displayPath(plansDir, cwd),
		inlinedTemplate: inlined ? DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE : null,
	});

	return {
		guide: "plan",
		prompt: `${rules.trimStart()}\n\n${ending}\n`,
		source_path: sourcePath,
		plan_path: planPath,
		plans_dir: plansDir,
		plan_template_path: planTemplatePath,
		plan_template_inlined: inlined,
		template_source: templateSource,
	};
}

/** A skeleton path that exists but cannot be read would strand the agent. */
function assertReadableFile(path: string): void {
	try {
		readFileSync(path, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		outputError(
			"INVALID_ARGS",
			`Configured plan template \`${path}\` is not a readable file: ${message}`,
			{ plan_template_path: path },
		);
	}
}

/**
 * `5x guide plan` — print the guide.
 *
 * The reader is an agent in a shell, so the guide is raw markdown unless JSON
 * was requested explicitly (`--json` or `FIVEX_OUTPUT_FORMAT=json`).
 */
export async function guidePlan(params: GuidePlanParams = {}): Promise<void> {
	const result = await buildPlanGuide(params);
	if (getOutputFormat() === "json" && isOutputFormatExplicit()) {
		outputSuccess(result);
		return;
	}
	process.stdout.write(result.prompt);
}
