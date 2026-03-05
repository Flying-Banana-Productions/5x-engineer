#!/usr/bin/env bun
import { defineCommand, runCommand, showUsage } from "citty";
import { CliError } from "./output.js";
import { version } from "./version.js";

const main = defineCommand({
	meta: {
		name: "5x",
		version,
		description: "A toolbelt of primitives for the 5x workflow",
	},
	subCommands: {
		run: () => import("./commands/run-v1.js").then((m) => m.default),
		invoke: () => import("./commands/invoke.js").then((m) => m.default),
		quality: () => import("./commands/quality-v1.js").then((m) => m.default),
		plan: () => import("./commands/plan-v1.js").then((m) => m.default),
		diff: () => import("./commands/diff.js").then((m) => m.default),
		prompt: () => import("./commands/prompt.js").then((m) => m.default),
		init: () => import("./commands/init.js").then((m) => m.default),
		worktree: () => import("./commands/worktree.js").then((m) => m.default),
	},
});

const rawArgs = process.argv.slice(2);

// biome-ignore lint/suspicious/noExplicitAny: citty command types are loosely typed
type AnyCmd = Record<string, any>;

/** Walk rawArgs to resolve the deepest subcommand, returning [cmd, parent]. */
async function resolveSubCommand(
	cmd: AnyCmd,
	args: string[],
	parent?: AnyCmd,
): Promise<[AnyCmd, AnyCmd | undefined]> {
	const subs =
		typeof cmd.subCommands === "function"
			? await cmd.subCommands()
			: cmd.subCommands;
	if (!subs) return [cmd, parent];
	const nameIdx = args.findIndex((a: string) => !a.startsWith("-"));
	if (nameIdx === -1) return [cmd, parent];
	const name = args[nameIdx] as string;
	if (!subs[name]) return [cmd, parent];
	const entry = subs[name];
	const resolved = typeof entry === "function" ? await entry() : entry;
	const child = resolved?.default ?? resolved;
	return resolveSubCommand(child, args.slice(nameIdx + 1), cmd);
}

try {
	// Handle --help / -h and --version before runCommand (which doesn't handle them)
	if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
		const [cmd, parent] = await resolveSubCommand(main, rawArgs);
		await showUsage(
			cmd as Parameters<typeof showUsage>[0],
			parent as Parameters<typeof showUsage>[0],
		);
		process.exit(0);
	}
	if (rawArgs.length === 1 && rawArgs[0] === "--version") {
		console.log(version);
		process.exit(0);
	}
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
	// Citty CLIError (e.g. E_NO_COMMAND, E_UNKNOWN_COMMAND) — show usage
	if (err instanceof Error && err.name === "CLIError") {
		await showUsage(main);
		console.error(err.message);
		process.exit(1);
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
