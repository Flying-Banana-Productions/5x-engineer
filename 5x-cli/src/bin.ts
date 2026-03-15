#!/usr/bin/env bun
import { defineCommand, runCommand, showUsage } from "citty";
import { CliError, jsonStringify, setPrettyPrint } from "./output.js";
import { version } from "./version.js";

// ---------------------------------------------------------------------------
// Global --pretty / --no-pretty flags (parsed before citty sees the args)
// Last flag wins when both are present — preserves standard CLI precedence.
// ---------------------------------------------------------------------------
{
	// Collect indices of all --pretty / --no-pretty flags (there may be dupes)
	const indices: { idx: number; pretty: boolean }[] = [];
	for (let i = process.argv.length - 1; i >= 0; i--) {
		if (process.argv[i] === "--pretty") {
			indices.push({ idx: i, pretty: true });
		} else if (process.argv[i] === "--no-pretty") {
			indices.push({ idx: i, pretty: false });
		}
	}
	if (indices.length > 0) {
		// Apply the flag with the highest original argv index (last wins)
		const last = indices.reduce((a, b) => (a.idx > b.idx ? a : b));
		setPrettyPrint(last.pretty);
		// Remove all flag occurrences from argv (reverse-sorted to keep indices valid)
		for (const { idx } of indices.sort((a, b) => b.idx - a.idx)) {
			process.argv.splice(idx, 1);
		}
	}
}

// Support shorthand: `5x run init --worktree <path>`.
// Normalize to: `5x run init --worktree --worktree-path <path>` so citty can parse.
{
	const args = process.argv;
	const runIdx = args.indexOf("run");
	if (runIdx !== -1 && args[runIdx + 1] === "init") {
		for (let i = runIdx + 2; i < args.length; i += 1) {
			if (args[i] !== "--worktree") continue;
			const next = args[i + 1];
			if (!next || next.startsWith("-")) continue;
			args.splice(i + 1, 0, "--worktree-path");
			i += 1;
		}
	}
}

const main = defineCommand({
	meta: {
		name: "5x",
		version,
		description: "A toolbelt of primitives for the 5x workflow",
	},
	// Phase 3 replaces these lazy imports with commander registerX() calls.
	// The adapter files no longer export citty default commands (Phase 2
	// rewrote them to commander), so these lines are dead code until the
	// Phase 3 bin.ts rewrite.
	subCommands: {
		// @ts-expect-error Phase 3 replaces with registerRun()
		run: () => import("./commands/run-v1.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerInvoke()
		invoke: () => import("./commands/invoke.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerQuality()
		quality: () => import("./commands/quality-v1.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerPlan()
		plan: () => import("./commands/plan-v1.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerDiff()
		diff: () => import("./commands/diff.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerPrompt()
		prompt: () => import("./commands/prompt.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerInit()
		init: () => import("./commands/init.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerHarness()
		harness: () => import("./commands/harness.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerTemplate()
		template: () => import("./commands/template.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerProtocol()
		protocol: () => import("./commands/protocol.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerSkills()
		skills: () => import("./commands/skills.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerUpgrade()
		upgrade: () => import("./commands/upgrade.js").then((m) => m.default),
		// @ts-expect-error Phase 3 replaces with registerWorktree()
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
		console.log(jsonStringify(envelope));
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
	console.log(jsonStringify(envelope));
	process.exit(1);
}
