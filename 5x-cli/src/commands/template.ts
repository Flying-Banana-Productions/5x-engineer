/**
 * Template management commands — commander adapter.
 *
 * Subcommands: render, list, describe
 *
 * Business logic lives in template.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { collect } from "../utils/parse-args.js";
import {
	templateDescribe,
	templateList,
	templateRender,
} from "./template.handler.js";

export function registerTemplate(parent: Command) {
	const template = parent
		.command("template")
		.summary("Prompt template operations")
		.description(
			"Inspect and render prompt templates used by agent invocations. Templates use\n" +
				"variable substitution and are resolved from the project's template directory.",
		);

	template
		.command("render")
		.summary("Render a prompt template with variable substitution")
		.description(
			"Render a prompt template, substituting variables and resolving run context.\n" +
				"Returns the fully rendered template text. Use --var for explicit variables\n" +
				"and --run for run/worktree context resolution.",
		)
		.argument(
			"<template>",
			"Template name (e.g. reviewer-plan, author-next-phase)",
		)
		.option(
			"-r, --run <id>",
			"Run ID — enables run/worktree context resolution and plan path injection",
		)
		.option(
			"--var <key=value>",
			"Template variable (key=value, repeatable)",
			collect,
			[] as string[],
		)
		.option(
			"--allow-plan-path-override",
			"Allow explicit --var plan_path override even when it mismatches run/worktree context",
		)
		.option(
			"--session <id>",
			"Session ID — triggers continued-template selection when available",
		)
		.option(
			"--new-session",
			"Force a new session (skip continued-template selection)",
		)
		.option(
			"-w, --workdir <path>",
			"Working directory override (explicit --workdir wins)",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x template render author-next-phase -r abc123\n" +
				"  $ 5x template render reviewer-plan --var plan_path=./plan.md\n" +
				"  $ 5x template render author-next-phase -r abc123 --session sess_abc",
		)
		.action(async (template, opts) => {
			await templateRender({
				template,
				run: opts.run,
				vars: opts.var,
				allowPlanPathOverride: opts.allowPlanPathOverride,
				session: opts.session,
				newSession: opts.newSession,
				workdir: opts.workdir,
			});
		});

	template
		.command("list")
		.summary("List all available prompt templates")
		.description(
			"List all bundled prompt templates with their descriptions.\n" +
				"Templates with on-disk overrides are marked accordingly.",
		)
		.action(() => {
			templateList();
		});

	template
		.command("describe")
		.summary("Show detailed metadata for a template")
		.description(
			"Display metadata for a specific prompt template including version,\n" +
				"variables, defaults, step name, and whether an on-disk override exists.",
		)
		.argument(
			"<template>",
			"Template name (e.g. reviewer-plan, author-next-phase)",
		)
		.action((name) => {
			templateDescribe(name);
		});
}
