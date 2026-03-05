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
	// Non-CliError — log and exit
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
