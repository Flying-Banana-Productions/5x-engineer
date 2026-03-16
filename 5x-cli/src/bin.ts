#!/usr/bin/env bun
import { CommanderError } from "@commander-js/extra-typings";
import { registerDiff } from "./commands/diff.js";
import { registerHarness } from "./commands/harness.js";
import { registerInit } from "./commands/init.js";
import { registerInvoke } from "./commands/invoke.js";
import { registerPlan } from "./commands/plan-v1.js";
import { registerPrompt } from "./commands/prompt.js";
import { registerProtocol } from "./commands/protocol.js";
import { registerQuality } from "./commands/quality-v1.js";
import { registerRun } from "./commands/run-v1.js";
import { registerSkills } from "./commands/skills.js";
import { registerTemplate } from "./commands/template.js";
import { registerUpgrade } from "./commands/upgrade.js";
import { registerWorktree } from "./commands/worktree.js";
import {
	CliError,
	getOutputFormat,
	jsonStringify,
	setOutputFormat,
	setPrettyPrint,
} from "./output.js";
import { createProgram } from "./program.js";

// ---------------------------------------------------------------------------
// Global --pretty / --no-pretty flags (pre-parse argv strip)
// Accepted anywhere in argv. Last flag wins. Applied before commander parses
// so that formatting is active even for parse-error JSON envelopes.
// ---------------------------------------------------------------------------
{
	const indices: { idx: number; pretty: boolean }[] = [];
	for (let i = process.argv.length - 1; i >= 0; i--) {
		if (process.argv[i] === "--pretty") {
			indices.push({ idx: i, pretty: true });
		} else if (process.argv[i] === "--no-pretty") {
			indices.push({ idx: i, pretty: false });
		}
	}
	if (indices.length > 0) {
		const last = indices.reduce((a, b) => (a.idx > b.idx ? a : b));
		setPrettyPrint(last.pretty);
		for (const { idx } of indices.sort((a, b) => b.idx - a.idx)) {
			process.argv.splice(idx, 1);
		}
	}
}

// ---------------------------------------------------------------------------
// Global --text / --json flags (pre-parse argv strip)
// Accepted anywhere in argv. Last flag wins. Sets output format before
// commander parses. --text produces human-readable output; --json (default)
// produces JSON envelopes.
// ---------------------------------------------------------------------------
{
	// 1. Environment variable sets the baseline (lowest priority)
	const envFormat = process.env.FIVEX_OUTPUT_FORMAT;
	if (envFormat === "text" || envFormat === "json") {
		setOutputFormat(envFormat);
	}

	// 2. CLI flags override env (highest priority, last flag wins)
	const indices: { idx: number; format: "text" | "json" }[] = [];
	for (let i = process.argv.length - 1; i >= 0; i--) {
		if (process.argv[i] === "--text") {
			indices.push({ idx: i, format: "text" });
		} else if (process.argv[i] === "--json") {
			indices.push({ idx: i, format: "json" });
		}
	}
	if (indices.length > 0) {
		const last = indices.reduce((a, b) => (a.idx > b.idx ? a : b));
		setOutputFormat(last.format);
		for (const { idx } of indices.sort((a, b) => b.idx - a.idx)) {
			process.argv.splice(idx, 1);
		}
	}
}

const program = createProgram();

// Register all commands eagerly
registerRun(program);
registerInvoke(program);
registerQuality(program);
registerPlan(program);
registerDiff(program);
registerPrompt(program);
registerInit(program);
registerHarness(program);
registerTemplate(program);
registerProtocol(program);
registerSkills(program);
registerUpgrade(program);
registerWorktree(program);

// Configure output routing
program.configureOutput({
	writeOut: (str) => process.stdout.write(str),
	writeErr: (str) => {
		// In text mode, suppress Commander's built-in error/help output.
		// Our catch block will write the clean "Error: <message>" to stderr.
		if (getOutputFormat() === "text") return;
		process.stderr.write(str);
	},
	outputError: (str, write) => {
		// In text mode, suppress Commander's error formatting.
		if (getOutputFormat() === "text") return;
		write(str);
	},
});

try {
	await program.parseAsync(process.argv);
} catch (err: unknown) {
	if (err instanceof CliError) {
		if (getOutputFormat() === "text") {
			console.error(`Error: ${err.message}`);
			process.exit(err.exitCode);
		}
		const envelope = {
			ok: false as const,
			error: {
				code: err.code,
				message: err.message,
				...(err.detail !== undefined ? { detail: err.detail } : {}),
			},
		};
		console.log(jsonStringify(envelope));
		process.exit(err.exitCode);
	}
	if (err instanceof CommanderError) {
		// Commander help/version errors — these are not real errors.
		// commander.helpDisplayed = explicit --help (routed through writeOut)
		// commander.help          = automatic help on no-args (routed through writeErr)
		// commander.version       = explicit -V/--version (routed through writeOut)
		if (
			err.code === "commander.helpDisplayed" ||
			err.code === "commander.help" ||
			err.code === "commander.version"
		) {
			// commander.help routes output through writeErr, which text mode
			// suppresses. Re-emit help via writeOut so it reaches stdout.
			if (err.code === "commander.help" && getOutputFormat() === "text") {
				program.outputHelp();
			}
			process.exit(0);
		}
		if (getOutputFormat() === "text") {
			console.error(`Error: ${err.message}`);
			process.exit(1);
		}
		// Map Commander error codes to PRD-specified envelope codes:
		//   commander.unknownCommand  → UNKNOWN_COMMAND
		//   commander.unknownOption   → UNKNOWN_OPTION
		//   all other parse errors    → INVALID_ARGS
		const code =
			err.code === "commander.unknownCommand"
				? "UNKNOWN_COMMAND"
				: err.code === "commander.unknownOption"
					? "UNKNOWN_OPTION"
					: "INVALID_ARGS";
		const envelope = {
			ok: false as const,
			error: {
				code,
				message: err.message,
			},
		};
		console.log(jsonStringify(envelope));
		process.exit(1);
	}
	// Non-CliError — still emit JSON envelope
	const message = err instanceof Error ? err.message : String(err);
	if (getOutputFormat() === "text") {
		console.error(`Error: ${message}`);
		process.exit(1);
	}
	const envelope = {
		ok: false as const,
		error: { code: "INTERNAL_ERROR", message },
	};
	console.log(jsonStringify(envelope));
	process.exit(1);
}
