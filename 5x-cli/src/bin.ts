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
import { CliError, jsonStringify, setPrettyPrint } from "./output.js";
import { createProgram } from "./program.js";

// ---------------------------------------------------------------------------
// Global --pretty / --no-pretty flags (pre-parse strip, preserved from citty)
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
	writeErr: (str) => process.stderr.write(str),
	outputError: (str, write) => write(str),
});

try {
	await program.parseAsync(process.argv);
} catch (err: unknown) {
	if (err instanceof CliError) {
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
		// Commander validation/help/version errors
		if (
			err.code === "commander.helpDisplayed" ||
			err.code === "commander.version"
		) {
			process.exit(0);
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
	const envelope = {
		ok: false as const,
		error: { code: "INTERNAL_ERROR", message },
	};
	console.log(jsonStringify(envelope));
	process.exit(1);
}
