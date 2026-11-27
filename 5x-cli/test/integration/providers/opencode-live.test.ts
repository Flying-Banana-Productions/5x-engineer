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
	parseModel,
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

// ---------------------------------------------------------------------------
// Headless `question` comparison: raw observer
// ---------------------------------------------------------------------------

const QUESTION_PROMPT =
	"Before replying, you MUST call the `question` tool to ask the user to choose between option A and option B. After the tool call returns (or fails), reply with one short sentence describing what happened.";
/** Bound for the observer's `server.connected` marker. */
const OBSERVER_CONNECT_MS = 10_000;
/** Bound for the positive control's matching form. */
const CONTROL_FORM_MS = 90_000;
/** Bound for the control's terminal event after its form is cancelled. */
const CONTROL_SETTLE_MS = 15_000;
/** Bound for the deny execution's raw terminal event, from the deny prompt. */
const DENY_TERMINAL_MS = 120_000;
/** Bound for each fixture cleanup request. */
const CLEANUP_REQUEST_MS = 5_000;

type RawEvent = { type: string; data?: Record<string, unknown> };

const TERMINAL_TYPES = new Set([
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
]);

function rawSessionId(event: RawEvent): string | undefined {
	if (event.type === "form.created") {
		const form = event.data?.form as { sessionID?: unknown } | undefined;
		return typeof form?.sessionID === "string" ? form.sessionID : undefined;
	}
	const sid = event.data?.sessionID;
	return typeof sid === "string" ? sid : undefined;
}

/**
 * One raw `event.subscribe` on the test-owned server, consumed from before
 * either arm's prompt. It records every event, and records a gap when the
 * stream ends, errors, or reconnects (a second `server.connected`) before it
 * is closed by the test.
 */
class RawObserver {
	readonly events: RawEvent[] = [];
	readonly openedAt = Date.now();
	connectedAt: number | undefined;
	gap: string | undefined;
	private closing = false;
	private readonly controller = new AbortController();
	private readonly listeners = new Set<() => void>();
	private readonly consumed: Promise<void>;

	constructor(client: ReturnType<typeof OpenCode.make>) {
		const iterable = client.event.subscribe({
			signal: this.controller.signal,
		}) as AsyncIterable<RawEvent>;
		this.consumed = (async () => {
			try {
				for await (const event of iterable) {
					if (event.type === "server.connected") {
						if (this.connectedAt !== undefined && !this.gap) {
							this.gap = "a second server.connected (resubscription)";
						}
						this.connectedAt ??= Date.now();
					} else {
						this.events.push(event);
					}
					this.notify();
				}
				if (!this.closing && !this.gap) this.gap = "the raw stream ended";
			} catch (err) {
				if (!this.closing && !this.gap) {
					this.gap = `the raw stream errored: ${err instanceof Error ? err.message : String(err)}`;
				}
			} finally {
				this.notify();
			}
		})();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	/** Resolve true once `pred` holds; false on a gap or after `ms`. */
	waitFor(pred: () => boolean, ms: number): Promise<boolean> {
		return new Promise((resolve) => {
			const check = () => {
				if (pred()) return finish(true);
				if (this.gap) return finish(false);
			};
			const timer = setTimeout(() => finish(pred()), ms);
			const finish = (value: boolean) => {
				clearTimeout(timer);
				this.listeners.delete(check);
				resolve(value);
			};
			this.listeners.add(check);
			check();
		});
	}

	forSession(sessionID: string): RawEvent[] {
		return this.events.filter((e) => rawSessionId(e) === sessionID);
	}

	/** The first terminal event for `sessionID` after its first raw delivery. */
	terminalAfterDelivery(sessionID: string): RawEvent | undefined {
		const events = this.forSession(sessionID);
		const delivered = events.findIndex(
			(e) => e.type === "session.inbox.delivered",
		);
		if (delivered < 0) return undefined;
		return events.slice(delivered + 1).find((e) => TERMINAL_TYPES.has(e.type));
	}

	/** Tool names the session started, from raw `session.tool.input.started`. */
	toolNames(sessionID: string): string[] {
		return this.forSession(sessionID).flatMap((e) =>
			e.type === "session.tool.input.started" &&
			typeof e.data?.name === "string"
				? [e.data.name]
				: [],
		);
	}

	/** Raw `question` tool starts or calls for the session (calls matched by call id). */
	questionEvents(sessionID: string): RawEvent[] {
		const events = this.forSession(sessionID);
		const questionCallIds = new Set(
			events.flatMap((e) =>
				e.type === "session.tool.input.started" &&
				e.data?.name === "question" &&
				typeof e.data.id === "string"
					? [e.data.id]
					: [],
			),
		);
		return events.filter(
			(e) =>
				(e.type === "session.tool.input.started" &&
					e.data?.name === "question") ||
				(e.type === "session.tool.called" &&
					(questionCallIds.has(String(e.data?.id)) ||
						e.data?.name === "question" ||
						e.data?.tool === "question")),
		);
	}

	forms(sessionID: string): RawEvent[] {
		return this.forSession(sessionID).filter((e) => e.type === "form.created");
	}

	async close(): Promise<void> {
		this.closing = true;
		this.controller.abort();
		await Promise.race([this.consumed, Bun.sleep(CLEANUP_REQUEST_MS)]);
	}
}

function formId(event: RawEvent | undefined): string | undefined {
	const form = event?.data?.form as { id?: unknown } | undefined;
	return typeof form?.id === "string" ? form.id : undefined;
}

/** A fixture cleanup request, bounded and never throwing. */
async function boundedCleanup(
	label: string,
	fn: (signal: AbortSignal) => Promise<unknown>,
): Promise<string> {
	try {
		await fn(AbortSignal.timeout(CLEANUP_REQUEST_MS));
		return `${label}: ok`;
	} catch (err) {
		return `${label}: ${err instanceof Error ? err.message : String(err)}`;
	}
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
			"headless question comparison: the allow-only control emits a form; the denied provider turn completes with no question call or form",
			async () => {
				const authorization = `Basic ${btoa(`opencode:${password}`)}`;
				const raw = OpenCode.make({ baseUrl: url, headers: { authorization } });
				const log: string[] = [];
				const since = (t: number | undefined) =>
					t === undefined ? "never" : `+${t - observer.openedAt}ms`;
				const cleanupNotes: string[] = [];

				// Raw observer: connected before either prompt.
				const observer = new RawObserver(raw);
				let controlSessionId: string | undefined;
				let denySessionId: string | undefined;
				const previous = process.env.OPENCODE_PASSWORD;
				const previousServer = process.env.OPENCODE_SERVER_PASSWORD;
				let provider: AgentProvider | undefined;
				try {
					const connected = await observer.waitFor(
						() => observer.connectedAt !== undefined,
						OBSERVER_CONNECT_MS,
					);
					log.push(`observer connected: ${since(observer.connectedAt)}`);
					if (!connected) {
						throw new Error(
							`question comparison inconclusive: the raw observer did not connect within ${OBSERVER_CONNECT_MS}ms (${observer.gap ?? "no server.connected"})`,
						);
					}

					// Positive control: raw allow-only session, its own msg_ id.
					const control = await raw.session.create({
						title: `5x-live-question-control-${Date.now()}`,
						location: { directory: workdir },
						model: parseModel(MODEL),
						permissions: [{ action: "*", resource: "*", effect: "allow" }],
					});
					controlSessionId = control.id;
					const controlPromptId = `msg_5xctl${crypto.randomUUID().replace(/-/g, "")}`;
					await raw.session.prompt({
						sessionID: control.id,
						id: controlPromptId,
						text: QUESTION_PROMPT,
						delivery: "queue",
					});
					const controlForm = await observer.waitFor(
						() => observer.forms(control.id).length > 0,
						CONTROL_FORM_MS,
					);
					const form = observer.forms(control.id)[0];
					if (controlForm && form) {
						// Fixture cleanup only: cancel that exact form.
						const id = formId(form);
						if (id) {
							cleanupNotes.push(
								await boundedCleanup(`control form.cancel ${id}`, (signal) =>
									raw.session.form.cancel(
										{ sessionID: control.id, formID: id },
										{ signal },
									),
								),
							);
						}
						await observer.waitFor(
							() => observer.terminalAfterDelivery(control.id) !== undefined,
							CONTROL_SETTLE_MS,
						);
					}
					const controlTerminal = observer.terminalAfterDelivery(control.id);
					log.push(
						`control ${control.id}: tools=[${observer.toolNames(control.id).join(", ")}] form=${form ? `yes (${formId(form)})` : "no"} terminal=${controlTerminal ? `${controlTerminal.type}${controlTerminal.data?.reason ? ` (${String(controlTerminal.data.reason)})` : ""}` : "none seen"}`,
					);
					if (!controlForm || !form) {
						throw new Error(
							`question comparison inconclusive: the allow-only positive control emitted no form.created for session ${control.id} within ${CONTROL_FORM_MS}ms` +
								(observer.gap ? ` (observer gap: ${observer.gap})` : ""),
						);
					}

					// Deny arm: the provider's headless session on the same server.
					process.env.OPENCODE_PASSWORD = password;
					delete process.env.OPENCODE_SERVER_PASSWORD;
					provider = await createProvider("author", liveConfig(url));
					const session = await provider.startSession({
						model: MODEL,
						workingDirectory: workdir,
					});
					denySessionId = session.id;
					const denyStart = Date.now();
					const events = await collect(
						session.runStreamed(QUESTION_PROMPT, { timeout: 90 }),
					);
					const denyId = session.id;
					const denyTerminalSeen = await observer.waitFor(
						() => observer.terminalAfterDelivery(denyId) !== undefined,
						Math.max(0, denyStart + DENY_TERMINAL_MS - Date.now()),
					);
					const denyTerminal = observer.terminalAfterDelivery(denyId);
					const providerTools = events.flatMap((e) =>
						e.type === "tool_start" ? [e.tool] : [],
					);
					const providerErrors = events.flatMap((e) =>
						e.type === "error" ? [e.message] : [],
					);
					const providerQuestion = providerTools.includes("question");
					const rawQuestion = observer.questionEvents(denyId);
					const denyForms = observer.forms(denyId);
					const outcome = events.some((e) => e.type === "done")
						? "done"
						: providerErrors.length > 0
							? "error"
							: "no terminal event";
					log.push(
						`deny ${denyId}: provider tools=[${providerTools.join(", ")}] raw tools=[${observer.toolNames(denyId).join(", ")}] form=${denyForms.length > 0 ? "yes" : "no"} provider=${outcome}${providerErrors.length ? ` (${providerErrors.join("; ")})` : ""} raw terminal=${denyTerminal?.type ?? "none"}`,
					);
					log.push(
						observer.gap
							? `observer gap: ${observer.gap}`
							: `observer ended on: ${denyTerminal?.type ?? "(no deny terminal event)"} (live through it)`,
					);

					// A deny-arm form is cleanup work, and fails the case.
					for (const denyForm of denyForms) {
						const id = formId(denyForm);
						if (!id) continue;
						cleanupNotes.push(
							await boundedCleanup(`deny form.cancel ${id}`, (signal) =>
								raw.session.form.cancel(
									{ sessionID: denyId, formID: id },
									{ signal },
								),
							),
						);
					}

					if (denyForms.length > 0 || providerQuestion || rawQuestion.length) {
						throw new Error(
							`question comparison failed: the denied provider session ${denyId} showed a question (forms: ${denyForms.length}, provider question tool_start: ${providerQuestion}, raw question events: ${rawQuestion.map((e) => e.type).join(", ") || "none"})`,
						);
					}
					if (outcome !== "done" || providerErrors.length > 0) {
						throw new Error(
							`question comparison failed: the denied provider turn ended in ${outcome}${providerErrors.length ? `: ${providerErrors.join("; ")}` : ""}`,
						);
					}
					if (!denyTerminalSeen || !denyTerminal || observer.gap) {
						throw new Error(
							`question comparison inconclusive: the raw observer did not stay live through the deny execution's raw terminal event (${observer.gap ?? `no terminal event within ${DENY_TERMINAL_MS}ms`})`,
						);
					}
				} finally {
					// Bounded fixture cleanup: stop anything still running.
					if (provider) await provider.close();
					if (previous === undefined) delete process.env.OPENCODE_PASSWORD;
					else process.env.OPENCODE_PASSWORD = previous;
					if (previousServer !== undefined) {
						process.env.OPENCODE_SERVER_PASSWORD = previousServer;
					}
					for (const sid of [controlSessionId, denySessionId]) {
						if (!sid || observer.terminalAfterDelivery(sid)) continue;
						cleanupNotes.push(
							await boundedCleanup(`interrupt ${sid}`, (signal) =>
								raw.session.interrupt({ sessionID: sid }, { signal }),
							),
						);
					}
					await observer.close();
					process.stderr.write(
						`[opencode-live] question comparison (opencode ${opencodeVersion}, model ${MODEL}):\n${[...log, ...cleanupNotes.map((n) => `cleanup ${n}`)].map((l) => `  ${l}`).join("\n")}\n`,
					);
				}
			},
			{ timeout: TIMEOUT * 3 },
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
