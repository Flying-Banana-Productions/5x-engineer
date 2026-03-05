#!/usr/bin/env bun
import { defineCommand, runCommand } from "citty";
import { CliError } from "./output.js";
import { version } from "./version.js";

const main = defineCommand({
	meta: {
		name: "5x",
		version,
		description: "Automated author-review loop runner for the 5x workflow",
	},
	subCommands: {
		run: () => import("./commands/run-v1.js").then((m) => m.default),
		invoke: () => import("./commands/invoke.js").then((m) => m.default),
		quality: () => import("./commands/quality-v1.js").then((m) => m.default),
		plan: () => import("./commands/plan-v1.js").then((m) => m.default),
		diff: () => import("./commands/diff.js").then((m) => m.default),
		prompt: () => import("./commands/prompt.js").then((m) => m.default),
		status: () => import("./commands/status.js").then((m) => m.default),
		init: () => import("./commands/init.js").then((m) => m.default),
		worktree: () => import("./commands/worktree.js").then((m) => m.default),
	},
});

const rawArgs = process.argv.slice(2);

try {
	await runCommand(main, { rawArgs });
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
		console.log(JSON.stringify(envelope));
		process.exit(err.exitCode);
	}
	// Non-CliError — still emit a JSON envelope to keep the CLI contract stable
	const message = err instanceof Error ? err.message : String(err);
	const envelope = {
		ok: false as const,
		error: {
			code: "INTERNAL_ERROR",
			message,
		},
	};
	console.log(JSON.stringify(envelope));
	process.exit(1);
}
