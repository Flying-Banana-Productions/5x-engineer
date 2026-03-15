/**
 * Template management commands — commander adapter.
 *
 * Subcommands: render
 *
 * Business logic lives in template.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { collect } from "../utils/parse-args.js";
import { templateRender } from "./template.handler.js";

export function registerTemplate(parent: Command) {
	const template = parent
		.command("template")
		.summary("Prompt template operations")
		.description("Prompt template operations");

	template
		.command("render")
		.summary(
			"Render a prompt template with variable substitution (no provider invocation)",
		)
		.description(
			"Render a prompt template with variable substitution (no provider invocation)",
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
			"--session <id>",
			"Session ID — triggers continued-template selection when available",
		)
		.option(
			"-w, --workdir <path>",
			"Working directory override (explicit --workdir wins)",
		)
		.action(async (template, opts) => {
			await templateRender({
				template,
				run: opts.run,
				vars: opts.var,
				session: opts.session,
				workdir: opts.workdir,
			});
		});
}
