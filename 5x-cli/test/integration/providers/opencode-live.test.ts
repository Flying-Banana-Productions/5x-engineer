/**
 * Opt-in live test of the bundled OpenCode provider against a real local
 * OpenCode 2.x.
 *
 * Set FIVEX_OPENCODE_LIVE=1. The tests are registered only in live mode, so
 * the deterministic suite runs none of them. When opted in, missing
 * prerequisites are failures, not skips: an `opencode` that is not on PATH,
 * an unparseable `opencode --version`, or a version below
 * MIN_OPENCODE_VERSION fails the prerequisite test.
 *
 * Model: FIVEX_OPENCODE_LIVE_MODEL (default opencode/deepseek-v4.1-flash-free).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import type { FiveXConfig } from "../../../src/config.js";
import { createProvider } from "../../../src/providers/factory.js";
import {
	compareVersions,
	MIN_OPENCODE_VERSION,
	OpenCodeProvider,
	parseOpenCodeVersion,
	parseServeListenUrl,
} from "../../../src/providers/opencode.js";
import type {
	AgentEvent,
	AgentProvider,
	RunResult,
} from "../../../src/providers/types.js";

const LIVE = process.env.FIVEX_OPENCODE_LIVE === "1";
const MODEL =
	process.env.FIVEX_OPENCODE_LIVE_MODEL ?? "opencode/deepseek-v4.1-flash-free";
const TOKEN = "fivex-live-token-7f3a";
const TIMEOUT = 120_000;

const AUTHOR_STATUS_SCHEMA = {
	type: "object",
	properties: {
		result: { type: "string", enum: ["complete", "needs_human", "failed"] },
		commit: { type: "string" },
		reason: { type: "string" },
	},
	required: ["result"],
};

async function collect(
	iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

function doneResult(events: AgentEvent[]): RunResult | undefined {
	const done = events.find((e) => e.type === "done");
	return done?.type === "done" ? done.result : undefined;
}

function liveConfig(url?: string): FiveXConfig {
	return {
		author: { provider: "opencode", model: MODEL },
		reviewer: { provider: "opencode", model: MODEL },
		opencode: url ? { url } : {},
	} as unknown as FiveXConfig;
}

/** `opencode serve` children of this test process. */
function childServePids(): number[] {
	const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="], {
		stdin: "ignore",
	}).stdout.toString();
	return out
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(
			([, ppid, ...cmd]) =>
				Number(ppid) === process.pid &&
				cmd.join(" ").includes("opencode serve"),
		)
		.map(([pid]) => Number(pid));
}

/** Shared streaming + structured checks for a provider. */
async function exerciseProvider(provider: AgentProvider, workdir: string) {
	const session = await provider.startSession({
		model: MODEL,
		workingDirectory: workdir,
	});
	const events = await collect(
		session.runStreamed(
			"Use the shell tool to run exactly `cat hello.txt` in the working directory, then reply with one short sentence that includes the file's contents verbatim.",
			{ timeout: 90 },
		),
	);
	const errors = events.filter((e) => e.type === "error");
	expect(errors).toEqual([]);
	const types = events.map((e) => e.type);
	const toolStart = events.find(
		(e) => e.type === "tool_start" && e.tool === "shell",
	);
	expect(toolStart).toBeDefined();
	expect(types).toContain("tool_end");
	expect(types).toContain("text");
	expect(types).toContain("usage");
	expect(types.at(-1)).toBe("done");

	const usage = events.find((e) => e.type === "usage");
	const result = doneResult(events);
	expect(result?.text).toContain(TOKEN);
	// Usage comes from the turn window, so 2.x assistant entries carry tokens.
	expect(result?.tokens.in).toBeGreaterThan(0);
	expect(result?.tokens.out).toBeGreaterThan(0);
	if (usage?.type === "usage") {
		expect(usage.tokens.in).toBeGreaterThan(0);
		expect(usage.tokens.out).toBeGreaterThan(0);
	}

	const structuredSession = await provider.startSession({
		model: MODEL,
		workingDirectory: workdir,
	});
	const structured = await structuredSession.run(
		"Reply that the task is complete. There is no commit; use the commit value `none`.",
		{ outputSchema: AUTHOR_STATUS_SCHEMA, timeout: 90 },
	);
	expect(structured.structured).toBeObject();
	expect(typeof (structured.structured as Record<string, unknown>).result).toBe(
		"string",
	);
}

if (LIVE) {
	let opencodeVersion = "(unknown)";
	let workdir = "";

	beforeAll(() => {
		workdir = mkdtempSync(join(tmpdir(), "5x-opencode-live-"));
		writeFileSync(join(workdir, "hello.txt"), `${TOKEN}\n`);
	});

	afterAll(() => {
		if (workdir) rmSync(workdir, { recursive: true, force: true });
	});

	describe("opencode live: prerequisites", () => {
		test.serial("opencode is on PATH at a supported version", () => {
			const bin = Bun.which("opencode");
			if (!bin) {
				throw new Error(
					`FIVEX_OPENCODE_LIVE=1 requires opencode ≥ ${MIN_OPENCODE_VERSION} on PATH (found: not installed)`,
				);
			}
			const out = Bun.spawnSync([bin, "--version"], { stdin: "ignore" });
			const raw = out.stdout.toString().trim();
			const parsed = parseOpenCodeVersion(raw.replace(/^opencode\s+/i, ""));
			if (!parsed) {
				throw new Error(
					`FIVEX_OPENCODE_LIVE=1: unparseable \`opencode --version\` output "${raw}" (required ≥ ${MIN_OPENCODE_VERSION})`,
				);
			}
			// biome-ignore lint/style/noNonNullAssertion: constant is valid
			const min = parseOpenCodeVersion(MIN_OPENCODE_VERSION)!;
			if (compareVersions(parsed, min) < 0) {
				throw new Error(
					`FIVEX_OPENCODE_LIVE=1: found opencode ${parsed.join(".")}, required ≥ ${MIN_OPENCODE_VERSION}`,
				);
			}
			opencodeVersion = parsed.join(".");
			process.stderr.write(
				`[opencode-live] opencode --version: ${raw} (MIN_OPENCODE_VERSION ${MIN_OPENCODE_VERSION}, model ${MODEL})\n`,
			);
		});
	});

	describe("opencode live: managed mode", () => {
		test.serial(
			"streams a shell tool turn, returns structured output, and leaves no server after close()",
			async () => {
				const provider = await createProvider("author", liveConfig());
				expect(childServePids().length).toBeGreaterThan(0);
				try {
					await exerciseProvider(provider, workdir);
				} finally {
					await provider.close();
				}
				expect(childServePids()).toEqual([]);
			},
			{ timeout: TIMEOUT * 2 },
		);

		test.serial(
			"question deny-or-cancel: a headless turn never waits on an interactive question",
			async () => {
				const provider = await createProvider("author", liveConfig());
				try {
					const session = await provider.startSession({
						model: MODEL,
						workingDirectory: workdir,
					});
					const events = await collect(
						session.runStreamed(
							"Before replying, you MUST call the `question` tool to ask the user to choose between option A and option B. After the tool call returns (or fails), reply with one short sentence describing what happened.",
							{ timeout: 90 },
						),
					);
					const questionStart = events.find(
						(e) => e.type === "tool_start" && e.tool === "question",
					);
					const deniedEnd = events.find(
						(e) => e.type === "tool_end" && e.tool === "question" && e.error,
					);
					// No form.cancel fallback exists: the headless `question` deny
					// stops forms on OpenCode 2.4.2, so only the deny path can pass.
					const path = deniedEnd ? "denied tool_end" : "inconclusive";
					const toolNames = events.flatMap((e) =>
						e.type === "tool_start" ? [e.tool] : [],
					);
					process.stderr.write(
						`[opencode-live] question case path: ${path} (question tool_start: ${questionStart ? "yes" : "no"}; tools: ${toolNames.join(", ") || "none"}; settled: ${events.some((e) => e.type === "done" || e.type === "error")})\n`,
					);
					expect(
						events.some((e) => e.type === "done" || e.type === "error"),
					).toBe(true);
					if (path === "inconclusive") {
						throw new Error(
							"question deny-or-cancel case is inconclusive: the turn showed neither a `question` tool call ending in a denied tool_end nor a cancelled form " +
								`(tools called: ${toolNames.join(", ") || "none"})`,
						);
					}
				} finally {
					await provider.close();
				}
			},
			{ timeout: TIMEOUT },
		);
	});

	describe("opencode live: authenticated external mode", () => {
		const password = crypto.randomUUID();
		let server: ReturnType<typeof Bun.spawn> | undefined;
		let url = "";

		beforeAll(async () => {
			server = Bun.spawn(
				["opencode", "serve", "--hostname=127.0.0.1", "--port=0"],
				{
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, OPENCODE_PASSWORD: password },
				},
			);
			const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			const deadline = Date.now() + 15_000;
			while (!url && Date.now() < deadline) {
				const { value, done } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				url = parseServeListenUrl(buffered) ?? "";
			}
			reader.releaseLock();
			void (server.stdout as ReadableStream<Uint8Array>).pipeTo(
				new WritableStream(),
			);
			void (server.stderr as ReadableStream<Uint8Array>).pipeTo(
				new WritableStream(),
			);
			if (!url) throw new Error("test-owned opencode serve did not start");
		});

		afterAll(async () => {
			server?.kill();
			await server?.exited;
		});

		test.serial(
			"authenticates with OPENCODE_PASSWORD, streams, returns structured output, and leaves the server running after close()",
			async () => {
				const previous = process.env.OPENCODE_PASSWORD;
				const previousServer = process.env.OPENCODE_SERVER_PASSWORD;
				let provider: AgentProvider | undefined;
				try {
					process.env.OPENCODE_PASSWORD = password;
					delete process.env.OPENCODE_SERVER_PASSWORD;
					provider = await createProvider("author", liveConfig(url));
					expect(provider).toBeInstanceOf(OpenCodeProvider);
					await exerciseProvider(provider, workdir);
				} finally {
					await provider?.close();
					if (previous === undefined) delete process.env.OPENCODE_PASSWORD;
					else process.env.OPENCODE_PASSWORD = previous;
					if (previousServer !== undefined) {
						process.env.OPENCODE_SERVER_PASSWORD = previousServer;
					}
				}

				// The test-owned server survives the provider's close().
				expect(server?.exitCode).toBeNull();
				const client = OpenCode.make({
					baseUrl: url,
					headers: {
						authorization: `Basic ${btoa(`opencode:${password}`)}`,
					},
				});
				const info = await client.server.info();
				expect(info.version).toBe(opencodeVersion);
			},
			{ timeout: TIMEOUT * 2 },
		);

		test.serial(
			"without the password, createProvider fails with the password error",
			async () => {
				const previous = process.env.OPENCODE_PASSWORD;
				const previousServer = process.env.OPENCODE_SERVER_PASSWORD;
				try {
					delete process.env.OPENCODE_PASSWORD;
					delete process.env.OPENCODE_SERVER_PASSWORD;
					await expect(
						createProvider("author", liveConfig(url)),
					).rejects.toThrow(
						"the OpenCode server requires a password — set OPENCODE_PASSWORD",
					);
				} finally {
					if (previous !== undefined) process.env.OPENCODE_PASSWORD = previous;
					if (previousServer !== undefined) {
						process.env.OPENCODE_SERVER_PASSWORD = previousServer;
					}
				}
			},
			{ timeout: TIMEOUT },
		);
	});
}
