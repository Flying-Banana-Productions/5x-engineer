/**
 * Unit tests for the OpenCode 2.x provider.
 *
 * The turn loop runs against a structural fake `OpenCodeClient` whose
 * `event.subscribe` yields scripted events and whose methods record calls.
 * Construction and version-gate cases use the real client with a fake
 * `fetch`, and managed-server cases use a fake spawn. No network, no
 * subprocesses, no process-wide env mutation.
 *
 * Timing bounds are scaled down through the provider's internal seam:
 * the 10 s admission/reconciliation bounds are 150 ms here.
 */

import { describe, expect, test } from "bun:test";
import type { OpenCodeClient } from "@opencode/client";
import {
	AgentCancellationError,
	AgentTimeoutError,
	type ManagedChildProcess,
	type ManagedServer,
	type ManagedSpawnOptions,
	MIN_OPENCODE_VERSION,
	OpenCodeProvider,
	type OpenCodeTimings,
	parseModel,
	parseServeListenUrl,
	startManagedServer,
	turnWakeDelay,
} from "../../../src/providers/opencode.js";
import type {
	AgentEvent,
	AgentSession,
	RunResult,
} from "../../../src/providers/types.js";

// ---------------------------------------------------------------------------
// Fake OpenCode server (structural client)
// ---------------------------------------------------------------------------

type Entry = Record<string, unknown> & { id: string; type: string };
type Call = { m: string; input?: Record<string, unknown> };

const SID = "ses_test";
const OTHER = "ses_other";

const T: Partial<OpenCodeTimings> = {
	connectMs: 300,
	requestMs: 300,
	admissionMs: 150,
	pollMs: 10,
	reconcileMs: 150,
	cleanupRequestMs: 100,
	cleanupTotalMs: 500,
	maxPollFailures: 3,
};

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class Sub implements AsyncIterable<unknown> {
	private queue: unknown[] = [];
	private waiter: (() => void) | undefined;
	ended = false;

	constructor(signal: AbortSignal | undefined, connect: boolean) {
		if (connect) this.queue.push({ type: "server.connected", data: {} });
		signal?.addEventListener("abort", () => this.end(), { once: true });
	}

	push(event: unknown): void {
		if (this.ended) return;
		this.queue.push(event);
		this.wake();
	}

	end(): void {
		this.ended = true;
		this.wake();
	}

	private wake(): void {
		const w = this.waiter;
		this.waiter = undefined;
		w?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift();
				continue;
			}
			if (this.ended) return;
			await new Promise<void>((r) => {
				this.waiter = r;
			});
		}
	}
}

interface TurnScript {
	text?: string;
	reasoning?: string;
	tokens?: { input: number; output: number } | null;
	cost?: number | null;
	outcome?: "succeeded" | "failed" | "interrupted";
	error?: string;
	tools?: boolean;
}

class FakeOpenCode {
	calls: Call[] = [];
	transcript: Entry[] = [];
	inbox: Array<{ id: string; type: "user" }> = [];
	running = false;
	subs: Sub[] = [];
	connectStreams = true;
	pageSize = 100;
	/** Entries `session.context` returns; defaults to the transcript. */
	contextView: (() => Entry[]) | undefined;
	/** Per-call transcript reads hook (count of context reads so far). */
	onContextRead: ((n: number) => void) | undefined;
	contextReads = 0;
	/** Delay, in ms, before the n-th (1-based) `message.list` page returns. */
	listDelay: ((n: number) => number) | undefined;
	listReads = 0;
	scripts: TurnScript[] = [];
	/** Override for `session.prompt`. */
	onPrompt: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
	onCancel: ((input: Record<string, unknown>) => void) | undefined;
	hang = new Set<string>();
	activeOverride: (() => Record<string, unknown>) | undefined;
	sessionInfo: Record<string, unknown> = {
		id: SID,
		location: { directory: "/work" },
		tokens: {
			input: 999999,
			output: 999999,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
		cost: 1234,
		outcome: "succeeded",
		time: { created: 0, updated: 0 },
	};
	private seq = 0;

	nextId(prefix: string): string {
		this.seq += 1;
		return `${prefix}_${String(this.seq).padStart(4, "0")}`;
	}

	emit(type: string, data: Record<string, unknown>): void {
		const event = { id: this.nextId("evt"), created: Date.now(), type, data };
		for (const sub of this.subs) sub.push(event);
	}

	endStreams(): void {
		for (const sub of this.subs) sub.end();
	}

	count(m: string): number {
		return this.calls.filter((c) => c.m === m).length;
	}

	// --- scripted server behavior ------------------------------------------

	enqueue(id: string, sessionID = SID): void {
		if (sessionID === SID) this.inbox.push({ id, type: "user" });
		this.emit("session.inbox.enqueued", { sessionID, inboxID: id, item: {} });
	}

	deliver(id: string, sessionID = SID): void {
		if (sessionID === SID) {
			this.inbox = this.inbox.filter((i) => i.id !== id);
			this.transcript.push({
				id,
				type: "user",
				text: "prompt",
				time: { created: 0 },
			});
			this.running = true;
		}
		this.emit("session.execution.started", { sessionID });
		this.emit("session.inbox.delivered", { sessionID, inboxID: id });
	}

	assistant(script: TurnScript): void {
		const text = script.text ?? "reply";
		if (script.tools) {
			this.emit("session.tool.input.started", {
				sessionID: SID,
				id: "call_1",
				name: "shell",
			});
			this.emit("session.tool.called", {
				sessionID: SID,
				id: "call_1",
				input: { command: "cat hello.txt" },
			});
			this.emit("session.tool.success", {
				sessionID: SID,
				id: "call_1",
				content: [{ type: "text", text: "hello" }],
			});
		}
		if (script.reasoning) {
			this.emit("session.reasoning.delta", {
				sessionID: SID,
				delta: script.reasoning,
			});
		}
		this.emit("session.text.delta", { sessionID: SID, delta: text });
		const entry: Entry = {
			id: this.nextId("msg_asst"),
			type: "assistant",
			content: [{ type: "text", text }],
			time: { created: 0 },
		};
		if (script.tokens !== null) {
			entry.tokens = {
				...(script.tokens ?? { input: 10, output: 5 }),
				reasoning: 0,
				cache: { read: 0, write: 0 },
			};
		}
		if (script.cost !== null) entry.cost = script.cost ?? 0.01;
		this.transcript.push(entry);
	}

	finish(
		outcome: TurnScript["outcome"] = "succeeded",
		error?: string,
		opts?: { emit?: boolean },
	): void {
		this.transcript.push({
			id: this.nextId("msg_idle"),
			type: "idle",
			outcome,
			...(error && { error: { type: "x", message: error } }),
			time: { created: 0 },
		});
		this.running = false;
		if (opts?.emit === false) return;
		this.emit(`session.execution.${outcome}`, {
			sessionID: SID,
			...(error && { error: { type: "x", message: error } }),
			...(outcome === "interrupted" && { reason: "user" }),
		});
	}

	/** Default turn: enqueue, deliver, reply, settle. */
	async standardTurn(id: string): Promise<void> {
		const script = this.scripts.shift() ?? {};
		this.enqueue(id);
		await tick();
		this.deliver(id);
		await tick();
		if (script.outcome !== "failed") this.assistant(script);
		await tick();
		this.finish(script.outcome ?? "succeeded", script.error);
	}

	// --- client -------------------------------------------------------------

	private async call<T>(
		m: string,
		input: Record<string, unknown> | undefined,
		fn: () => T | Promise<T>,
	): Promise<T> {
		this.calls.push({ m, ...(input !== undefined && { input }) });
		if (this.hang.has(m)) await new Promise(() => {});
		return await fn();
	}

	client(): OpenCodeClient {
		const self = this;
		const client = {
			server: {
				info: () =>
					self.call("server.info", undefined, () => ({ version: "2.4.2" })),
			},
			event: {
				subscribe(opts?: { signal?: AbortSignal; types?: string[] }) {
					self.calls.push({
						m: "event.subscribe",
						input: { types: opts?.types },
					});
					const sub = new Sub(opts?.signal, self.connectStreams);
					self.subs.push(sub);
					return sub;
				},
			},
			session: {
				create: (input: Record<string, unknown>) =>
					self.call("session.create", input, () => ({
						...self.sessionInfo,
						id: SID,
					})),
				get: (input: Record<string, unknown>) =>
					self.call("session.get", input, () => {
						if (input.sessionID !== SID) {
							throw Object.assign(new Error("Session not found"), {
								_tag: "SessionNotFoundError",
								sessionID: input.sessionID,
							});
						}
						return self.sessionInfo;
					}),
				switchModel: (input: Record<string, unknown>) =>
					self.call("session.switchModel", input, () => undefined),
				active: () =>
					self.call("session.active", undefined, () =>
						self.activeOverride
							? self.activeOverride()
							: self.running
								? { [SID]: { type: "running" } }
								: {},
					),
				prompt: (input: Record<string, unknown>) =>
					self.call("session.prompt", input, async () => {
						if (self.onPrompt) return self.onPrompt(input);
						const id = input.id as string;
						void self.standardTurn(id);
						return { id, sessionID: SID, type: "user" };
					}),
				context: (input: Record<string, unknown>) =>
					self.call("session.context", input, () => {
						self.contextReads += 1;
						self.onContextRead?.(self.contextReads);
						return [
							...(self.contextView ? self.contextView() : self.transcript),
						];
					}),
				inbox: {
					list: (input: Record<string, unknown>) =>
						self.call("session.inbox.list", input, () => [...self.inbox]),
					cancel: (input: Record<string, unknown>) =>
						self.call("session.inbox.cancel", input, () => {
							if (self.onCancel) return self.onCancel(input);
							const before = self.inbox.length;
							self.inbox = self.inbox.filter((i) => i.id !== input.inboxID);
							if (self.inbox.length !== before) {
								self.emit("session.inbox.cancelled", {
									sessionID: SID,
									inboxID: input.inboxID,
								});
							}
						}),
				},
				interrupt: (input: Record<string, unknown>) =>
					self.call("session.interrupt", input, () => ({
						interrupted: self.running,
					})),
				form: {
					cancel: (input: Record<string, unknown>) =>
						self.call("session.form.cancel", input, () => undefined),
				},
			},
			message: {
				list: (input: Record<string, unknown>) =>
					self.call("message.list", input, async () => {
						self.listReads += 1;
						const delay = self.listDelay?.(self.listReads) ?? 0;
						if (delay > 0) await tick(delay);
						const start = input.cursor ? Number(input.cursor) : 0;
						const limit = Math.min(Number(input.limit ?? 100), self.pageSize);
						const data = self.transcript.slice(start, start + limit);
						const next =
							start + limit < self.transcript.length
								? String(start + limit)
								: null;
						return { data, cursor: { next } };
					}),
			},
		};
		return client as unknown as OpenCodeClient;
	}
}

function fakeServer(): ManagedServer & { closed: number } {
	const server = {
		url: "http://127.0.0.1:9",
		password: "pw",
		closed: 0,
		stderrTail: () => "",
		close: async () => {
			server.closed += 1;
		},
	};
	return server;
}

async function setup(opts?: {
	managed?: boolean;
	fake?: FakeOpenCode;
	timings?: Partial<OpenCodeTimings>;
}): Promise<{
	fake: FakeOpenCode;
	provider: OpenCodeProvider;
	session: AgentSession;
}> {
	const fake = opts?.fake ?? new FakeOpenCode();
	const provider = new OpenCodeProvider(
		fake.client(),
		opts?.managed ? fakeServer() : null,
		undefined,
		{ timings: { ...T, ...opts?.timings } },
	);
	const session = await provider.startSession({
		model: "",
		workingDirectory: "/work",
	});
	fake.calls = [];
	return { fake, provider, session };
}

async function collect(
	iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const ev of iterable) events.push(ev);
	return events;
}

function doneResult(events: AgentEvent[]): RunResult | undefined {
	const done = events.find((e) => e.type === "done");
	return done?.type === "done" ? done.result : undefined;
}

function errorMessages(events: AgentEvent[]): string[] {
	return events.flatMap((e) => (e.type === "error" ? [e.message] : []));
}

/** Wait until `pred` holds, polling, up to `ms`. */
async function until(pred: () => boolean, ms = 1000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("until: timed out");
		await tick(2);
	}
}

/** The request id the turn sent on its first `session.prompt`. */
function promptIds(fake: FakeOpenCode): string[] {
	return fake.calls
		.filter((c) => c.m === "session.prompt")
		.map((c) => c.input?.id as string);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseServeListenUrl", () => {
	test("parses the 2.x listen line", () => {
		expect(
			parseServeListenUrl("server listening on http://127.0.0.1:4096\n"),
		).toBe("http://127.0.0.1:4096");
		expect(
			parseServeListenUrl("Server listening on http://127.0.0.1:51234\nmore\n"),
		).toBe("http://127.0.0.1:51234");
	});

	test("a partial chunk is not parsed until its line completes", () => {
		expect(parseServeListenUrl("Server listening on http://127.0.0.1:40")).toBe(
			undefined,
		);
		expect(
			parseServeListenUrl("Server listening on http://127.0.0.1:4096\n"),
		).toBe("http://127.0.0.1:4096");
	});

	test("noise yields undefined", () => {
		expect(parseServeListenUrl("")).toBeUndefined();
		expect(parseServeListenUrl("booting...\nloading config\n")).toBeUndefined();
	});
});

describe("parseModel", () => {
	test("provider/model", () => {
		expect(parseModel("anthropic/claude-sonnet-4-6")).toEqual({
			providerID: "anthropic",
			id: "claude-sonnet-4-6",
		});
		expect(parseModel("openrouter/meta/llama-3")).toEqual({
			providerID: "openrouter",
			id: "meta/llama-3",
		});
	});

	test("provider/model#variant", () => {
		expect(parseModel("anthropic/claude-opus-4#high")).toEqual({
			providerID: "anthropic",
			id: "claude-opus-4",
			variant: "high",
		});
	});

	test("invalid input throws", () => {
		for (const bad of ["no-slash", "/model", "provider/", "p/m#"]) {
			expect(() => parseModel(bad)).toThrow("Invalid model format");
		}
	});
});

// ---------------------------------------------------------------------------
// Managed server
// ---------------------------------------------------------------------------

interface FakeChild extends ManagedChildProcess {
	killed: Array<string | number | undefined>;
	pulls: { stdout: number; stderr: number };
}

function fakeChild(opts: {
	stdout?: string[];
	stderr?: string[];
	exitWithoutListening?: number;
	floodAfterListen?: { chunks: number; size: number };
}): FakeChild {
	const enc = new TextEncoder();
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((r) => {
		resolveExit = r;
	});
	const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const pulls = { stdout: 0, stderr: 0 };

	const makeStream = (
		name: "stdout" | "stderr",
		initial: string[],
	): ReadableStream<Uint8Array> => {
		let sent = 0;
		return new ReadableStream<Uint8Array>(
			{
				start(c) {
					controllers.push(c);
					for (const chunk of initial) c.enqueue(enc.encode(chunk));
				},
				pull(c) {
					const flood = opts.floodAfterListen;
					if (!flood || sent >= flood.chunks) return;
					sent += 1;
					pulls[name] += 1;
					c.enqueue(new Uint8Array(flood.size).fill(120));
				},
			},
			{ highWaterMark: 1 },
		);
	};

	const exit = (code: number) => {
		for (const c of controllers) {
			try {
				c.close();
			} catch {
				// already closed
			}
		}
		resolveExit(code);
	};

	const child: FakeChild = {
		stdout: makeStream("stdout", opts.stdout ?? []),
		stderr: makeStream("stderr", opts.stderr ?? []),
		exited,
		killed: [],
		pulls,
		kill(signal) {
			child.killed.push(signal);
			exit(143);
		},
	};
	if (opts.exitWithoutListening !== undefined) {
		const code = opts.exitWithoutListening;
		setTimeout(() => exit(code), 5);
	}
	return child;
}

function recordingSpawn(child: FakeChild): {
	spawn: (cmd: string[], opts: ManagedSpawnOptions) => ManagedChildProcess;
	calls: Array<{ cmd: string[]; opts: ManagedSpawnOptions }>;
} {
	const calls: Array<{ cmd: string[]; opts: ManagedSpawnOptions }> = [];
	return {
		calls,
		spawn: (cmd, opts) => {
			calls.push({ cmd, opts });
			return child;
		},
	};
}

describe("managed server", () => {
	test("spawn argv, env, and pipe options; client authenticates with the password", async () => {
		const child = fakeChild({
			stdout: ["Server listening on http://127.0.0.1:4555\n"],
		});
		const { spawn, calls } = recordingSpawn(child);
		const requests: Request[] = [];
		const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(input, init));
			return Response.json({
				version: MIN_OPENCODE_VERSION,
				pid: 1,
				urls: [],
				paths: { tmp: "/" },
			});
		}) as typeof fetch;

		const provider = await OpenCodeProvider.createManaged({
			spawn,
			fetch: fetchFn,
		});
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.cmd).toEqual([
			"opencode",
			"serve",
			"--hostname=127.0.0.1",
			"--port=0",
		]);
		expect(call?.cmd).not.toContain("--service");
		expect(call?.opts.stdin).toBe("ignore");
		expect(call?.opts.stdout).toBe("pipe");
		expect(call?.opts.stderr).toBe("pipe");
		const password = call?.opts.env.OPENCODE_PASSWORD;
		expect(password).toMatch(/^[0-9a-f-]{36}$/);
		expect(provider.serverUrl).toBe("http://127.0.0.1:4555");

		await provider.verify();
		expect(requests[0]?.url).toBe("http://127.0.0.1:4555/api/info");
		expect(requests[0]?.headers.get("authorization")).toBe(
			`Basic ${btoa(`opencode:${password}`)}`,
		);
		await provider.close();
	});

	test("a spawn that exits before the listen line reports stderr", async () => {
		const child = fakeChild({
			stderr: ["error: unknown command serve\n"],
			exitWithoutListening: 1,
		});
		const { spawn } = recordingSpawn(child);
		await expect(OpenCodeProvider.createManaged({ spawn })).rejects.toThrow(
			/exited before listening \(exit code 1\) — check that opencode 2\.x is installed and on PATH\. stderr: error: unknown command serve/,
		);
	});

	test("a spawn that never prints the listen line times out, kills the process, and leaves no child", async () => {
		const child = fakeChild({ stdout: ["booting\n"] });
		const { spawn } = recordingSpawn(child);
		const started = Date.now();
		await expect(
			OpenCodeProvider.createManaged({ spawn, startupTimeoutMs: 100 }),
		).rejects.toThrow(
			/Timeout waiting for OpenCode server to start after 100ms/,
		);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(child.killed.length).toBeGreaterThan(0);
		expect(await child.exited).toBe(143);
	});

	test("stdout and stderr keep draining after the listen line; the stderr tail stays bounded", async () => {
		const child = fakeChild({
			stdout: ["Server listening on http://127.0.0.1:4556\n"],
			floodAfterListen: { chunks: 64, size: 64 * 1024 },
		});
		const { spawn } = recordingSpawn(child);
		const server = await startManagedServer({ spawn });
		await until(
			() => child.pulls.stdout >= 64 && child.pulls.stderr >= 64,
			3000,
		);
		expect(server.stderrTail().length).toBeLessThanOrEqual(8 * 1024);
		await server.close();
	});

	test("close() is idempotent and kills the managed process", async () => {
		const child = fakeChild({
			stdout: ["Server listening on http://127.0.0.1:4557\n"],
		});
		const { spawn } = recordingSpawn(child);
		const provider = await OpenCodeProvider.createManaged({ spawn });
		await provider.close();
		await provider.close();
		expect(child.killed).toEqual(["SIGTERM"]);
		expect(await child.exited).toBe(143);
	});
});

// ---------------------------------------------------------------------------
// External construction, auth, and the version gate (real client, fake fetch)
// ---------------------------------------------------------------------------

function fetchReturning(
	respond: (req: Request) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: Request[] } {
	const requests: Request[] = [];
	return {
		requests,
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input, init);
			requests.push(req);
			return respond(req);
		}) as typeof fetch,
	};
}

const infoOk = (version: string) => () =>
	Response.json({ version, pid: 1, urls: [], paths: { tmp: "/" } });

describe("external provider", () => {
	test("construction sends no request and keeps the base URL", () => {
		const f = fetchReturning(infoOk("2.4.2"));
		const provider = OpenCodeProvider.createExternal("http://10.0.0.5:4096", {
			fetch: f.fetch,
			env: {},
		});
		expect(f.requests).toHaveLength(0);
		expect(provider.serverUrl).toBe("http://10.0.0.5:4096");
	});

	test("auth header from OPENCODE_PASSWORD", async () => {
		const f = fetchReturning(infoOk("2.4.2"));
		const provider = OpenCodeProvider.createExternal("http://h:1", {
			fetch: f.fetch,
			env: { OPENCODE_PASSWORD: "p1", OPENCODE_SERVER_PASSWORD: "p2" },
		});
		await provider.verify();
		expect(f.requests[0]?.headers.get("authorization")).toBe(
			`Basic ${btoa("opencode:p1")}`,
		);
	});

	test("auth header from OPENCODE_SERVER_PASSWORD", async () => {
		const f = fetchReturning(infoOk("2.4.2"));
		const provider = OpenCodeProvider.createExternal("http://h:1", {
			fetch: f.fetch,
			env: { OPENCODE_SERVER_PASSWORD: "p2" },
		});
		await provider.verify();
		expect(f.requests[0]?.headers.get("authorization")).toBe(
			`Basic ${btoa("opencode:p2")}`,
		);
	});

	test("no password, no auth header", async () => {
		const f = fetchReturning(infoOk("2.4.2"));
		const provider = OpenCodeProvider.createExternal("http://h:1", {
			fetch: f.fetch,
			env: {},
		});
		await provider.verify();
		expect(f.requests[0]?.headers.get("authorization")).toBeNull();
	});

	test("close() never stops an external server (no request, no error)", async () => {
		const f = fetchReturning(infoOk("2.4.2"));
		const provider = OpenCodeProvider.createExternal("http://h:1", {
			fetch: f.fetch,
			env: {},
		});
		await provider.close();
		await provider.close();
		expect(f.requests).toHaveLength(0);
	});
});

describe("version gate", () => {
	const gate = (respond: (req: Request) => Response) =>
		OpenCodeProvider.createExternal("http://h:1", {
			fetch: fetchReturning(respond).fetch,
			env: {},
		}).verify();

	test("ok at and above the minimum (prerelease suffix ignored)", async () => {
		await gate(infoOk(MIN_OPENCODE_VERSION));
		await gate(infoOk("2.5.0"));
		await gate(infoOk("3.0.0-beta.1"));
	});

	test("old 2.x names the minimum and `opencode upgrade`", async () => {
		await expect(gate(infoOk("2.3.2"))).rejects.toThrow(
			`5x 2.x requires OpenCode ≥ ${MIN_OPENCODE_VERSION} (found 2.3.2) — run \`opencode upgrade\``,
		);
	});

	test("a 1.x-style failure names the minimum and `opencode upgrade --major`", async () => {
		const expected = `5x 2.x requires OpenCode ≥ ${MIN_OPENCODE_VERSION} (found 1.x) — run \`opencode upgrade --major\``;
		// 1.x has no /api/info route.
		await expect(
			gate(() => new Response("Not Found", { status: 404 })),
		).rejects.toThrow(expected);
		// Or serves its web UI's HTML for the unknown path.
		await expect(
			gate(
				() =>
					new Response("<html></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			),
		).rejects.toThrow(expected);
		// A server reporting a 1.x version.
		await expect(gate(infoOk("1.2.6"))).rejects.toThrow(expected);
	});

	test("an unavailable endpoint or undecodable reply is a health-check failure, not 1.x", async () => {
		for (const respond of [
			// Upstream outage behind the URL.
			() => new Response("Service Unavailable", { status: 503 }),
			// A JSON content type with a body that does not decode.
			() =>
				new Response("not json", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		]) {
			const err = await gate(respond).catch((e: Error) => e);
			expect((err as Error).message).toStartWith(
				"OpenCode server health check failed at http://h:1 — ",
			);
			expect((err as Error).message).not.toContain("1.x");
			expect((err as Error).message).not.toContain("upgrade");
		}
		const outage = await gate(
			() => new Response("Service Unavailable", { status: 503 }),
		).catch((e: Error) => e);
		expect((outage as Error).message).toContain("503");
	});

	test("unauthorized maps to the password error", async () => {
		await expect(
			gate(() =>
				Response.json(
					{ _tag: "UnauthorizedError", message: "Unauthorized" },
					{ status: 401 },
				),
			),
		).rejects.toThrow(
			"the OpenCode server requires a password — set OPENCODE_PASSWORD",
		);
	});
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("sessions", () => {
	test("startSession sends location, model, and the headless permissions", async () => {
		const fake = new FakeOpenCode();
		const provider = new OpenCodeProvider(fake.client(), null, undefined, {
			timings: T,
		});
		await provider.startSession({
			model: "anthropic/claude-opus-4#high",
			workingDirectory: "/repo",
		});
		const create = fake.calls.find((c) => c.m === "session.create");
		expect(create?.input).toMatchObject({
			location: { directory: "/repo" },
			model: { providerID: "anthropic", id: "claude-opus-4", variant: "high" },
			permissions: [
				{ action: "*", resource: "*", effect: "allow" },
				{ action: "question", resource: "*", effect: "deny" },
			],
		});
	});

	test("resumeSession reads the directory and calls switchModel only on override", async () => {
		const fake = new FakeOpenCode();
		const provider = new OpenCodeProvider(fake.client(), null, "a/default", {
			timings: T,
		});
		const resumed = (await provider.resumeSession(SID)) as AgentSession & {
			directory?: string;
		};
		expect(resumed.id).toBe(SID);
		expect(resumed.directory).toBe("/work");
		expect(fake.count("session.switchModel")).toBe(0);

		await provider.resumeSession(SID, { model: "openai/gpt-5#low" });
		expect(
			fake.calls.find((c) => c.m === "session.switchModel")?.input,
		).toEqual({
			sessionID: SID,
			model: { providerID: "openai", id: "gpt-5", variant: "low" },
		});
	});

	test("resumeSession on an unknown id reports session not found", async () => {
		const fake = new FakeOpenCode();
		const provider = new OpenCodeProvider(fake.client(), null, undefined, {
			timings: T,
		});
		await expect(provider.resumeSession("ses_missing")).rejects.toThrow(
			'Failed to resume session "ses_missing": session not found',
		);
	});
});

// ---------------------------------------------------------------------------
// Streamed turns
// ---------------------------------------------------------------------------

describe("streamed turn", () => {
	test("text, reasoning, and tool events in order, ending on execution.succeeded", async () => {
		const { fake, session } = await setup();
		fake.scripts.push({ text: "the answer", reasoning: "hmm", tools: true });
		const events = await collect(session.runStreamed("do it"));
		expect(events.map((e) => e.type)).toEqual([
			"tool_start",
			"tool_end",
			"reasoning",
			"text",
			"usage",
			"done",
		]);
		expect(events[0]).toEqual({
			type: "tool_start",
			tool: "shell",
			input_summary: "cat hello.txt",
		});
		const result = doneResult(events);
		expect(result?.text).toBe("the answer");
		expect(result?.tokens).toEqual({ in: 10, out: 5 });
		expect(result?.costUsd).toBeCloseTo(0.01);
		expect(result?.sessionId).toBe(SID);
	});

	test("session.prompt carries a msg_5x id and delivery: queue; summary and corrective turns use new ids", async () => {
		const { fake, session } = await setup();
		fake.scripts.push(
			{ text: "worked" },
			{ text: "not json" },
			{ text: '{"result":"complete","commit":"abc"}' },
		);
		const result = await session.run("go", {
			outputSchema: { type: "object", properties: { result: {}, commit: {} } },
		});
		expect(result.structured).toEqual({ result: "complete", commit: "abc" });
		const prompts = fake.calls.filter((c) => c.m === "session.prompt");
		expect(prompts).toHaveLength(3);
		for (const p of prompts) {
			expect(p.input?.id).toMatch(/^msg_5x[0-9a-f]{32}$/);
			expect(p.input?.delivery).toBe("queue");
			expect(p.input?.sessionID).toBe(SID);
		}
		expect(new Set(prompts.map((p) => p.input?.id)).size).toBe(3);
	});

	test("subscription types include ownership and content events", async () => {
		const { fake, session } = await setup();
		await session.run("go");
		const types = fake.calls.find((c) => c.m === "event.subscribe")?.input
			?.types as string[];
		for (const t of [
			"session.text.delta",
			"session.reasoning.delta",
			"session.tool.input.started",
			"session.tool.called",
			"session.tool.success",
			"session.tool.failed",
			"session.step.failed",
			"session.execution.succeeded",
			"session.execution.failed",
			"session.execution.interrupted",
			"session.inbox.enqueued",
			"session.inbox.delivered",
			"session.inbox.cancelled",
			"form.created",
			"permission.asked",
		]) {
			expect(types).toContain(t);
		}
	});

	test("execution.failed produces an error", async () => {
		const { fake, session } = await setup();
		fake.scripts.push({ outcome: "failed", error: "model exploded" });
		const events = await collect(session.runStreamed("go"));
		expect(errorMessages(events)).toEqual(["model exploded"]);
		expect(doneResult(events)).toBeUndefined();
		await expect(
			(async () => {
				fake.scripts.push({ outcome: "failed", error: "model exploded" });
				return session.run("go");
			})(),
		).rejects.toThrow("model exploded");
	});

	test("step.failed produces an error event", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				await tick();
				fake.emit("session.step.failed", {
					sessionID: SID,
					error: { type: "x", message: "step broke" },
				});
				fake.finish("failed", "execution broke");
			})();
			return { id };
		};
		const events = await collect(session.runStreamed("go"));
		expect(errorMessages(events)).toEqual(["step broke", "execution broke"]);
	});

	test("an unexpected permission.asked is reported as an error event", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				fake.emit("permission.asked", {
					sessionID: SID,
					id: "per_1",
					action: "edit",
					resources: ["x"],
				});
				fake.assistant({});
				fake.finish();
			})();
			return { id };
		};
		const events = await collect(session.runStreamed("go"));
		expect(errorMessages(events)[0]).toContain("asked for permission (edit)");
	});

	test("events for a foreign session yield nothing, do not reset the timeout, and do not end the turn", async () => {
		const { fake, session } = await setup();
		let stop = false;
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				while (!stop) {
					fake.emit("session.text.delta", {
						sessionID: OTHER,
						delta: "foreign",
					});
					fake.emit("session.execution.succeeded", { sessionID: OTHER });
					fake.emit("form.created", {
						form: { id: "frm_1", sessionID: OTHER, title: "Q", fields: [] },
					});
					await tick(20);
				}
			})();
			return { id };
		};
		const started = Date.now();
		const events = await collect(session.runStreamed("go", { timeout: 0.2 }));
		stop = true;
		expect(Date.now() - started).toBeLessThan(1500);
		expect(events.filter((e) => e.type === "text")).toHaveLength(0);
		expect(errorMessages(events)[0]).toStartWith("Agent timed out after 200ms");
		expect(fake.count("session.form.cancel")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Prompt ownership
// ---------------------------------------------------------------------------

describe("prompt ownership", () => {
	test("a running session fails with the busy error and sends no prompt", async () => {
		const { fake, session } = await setup();
		fake.running = true;
		await expect(session.run("go")).rejects.toThrow(
			`OpenCode session ${SID} is busy (running or has queued input); 5x cannot attribute a turn on it`,
		);
		expect(fake.count("session.prompt")).toBe(0);
	});

	test("a session with queued input fails with the busy error and sends no prompt", async () => {
		const { fake, session } = await setup();
		fake.inbox.push({ id: "msg_foreign", type: "user" });
		await expect(session.run("go")).rejects.toThrow("is busy");
		expect(fake.count("session.prompt")).toBe(0);
	});

	test("a second concurrent turn on the same session fails busy before any request", async () => {
		const { fake, session } = await setup();
		let release: () => void = () => {};
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			fake.enqueue(id);
			void new Promise<void>((r) => {
				release = r;
			}).then(() => {
				fake.deliver(id);
				fake.assistant({});
				fake.finish();
			});
			return { id };
		};
		const first = session.run("one");
		await until(() => fake.count("session.prompt") === 1);
		const before = fake.calls.length;
		await expect(session.run("two")).rejects.toThrow("is busy");
		expect(fake.calls.length).toBe(before);
		release();
		await first;
	});

	test("a previous same-session terminal before delivery never settles the turn", async () => {
		const { fake, provider } = await setup({ managed: true });
		const session = await provider.resumeSession(SID);
		fake.calls = [];
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				await tick();
				// An earlier execution's end arrives before our delivery.
				fake.transcript.push({
					id: "msg_old_asst",
					type: "assistant",
					content: [{ type: "text", text: "OLD" }],
					tokens: { input: 1, output: 1 },
					cost: 0,
				});
				fake.emit("session.execution.succeeded", { sessionID: SID });
			})();
			return { id };
		};
		const events = await collect(session.runStreamed("go"));
		expect(doneResult(events)).toBeUndefined();
		expect(errorMessages(events)[0]).toBe(
			`OpenCode session ${SID} received other input during this turn; the result is ambiguous`,
		);
		const cancel = fake.calls.find((c) => c.m === "session.inbox.cancel");
		expect(cancel?.input?.inboxID).toBe(promptIds(fake)[0]);
		expect(fake.count("session.interrupt")).toBe(0);
		expect(JSON.stringify(events)).not.toContain("OLD");
	});

	test("a foreign delivery into the turn's execution is ambiguous: no interrupt, no summary", async () => {
		const { fake, session } = await setup({ managed: true });
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				fake.emit("session.text.delta", { sessionID: SID, delta: "ours" });
				fake.emit("session.inbox.delivered", {
					sessionID: SID,
					inboxID: "msg_foreign",
				});
				fake.emit("session.text.delta", { sessionID: SID, delta: "theirs" });
				fake.assistant({});
				fake.finish();
			})();
			return { id };
		};
		const events = await collect(
			session.runStreamed("go", { outputSchema: { type: "object" } }),
		);
		expect(events.filter((e) => e.type === "text")).toEqual([
			{ type: "text", delta: "ours" },
		]);
		expect(errorMessages(events)[0]).toContain("the result is ambiguous");
		expect(fake.count("session.interrupt")).toBe(0);
		expect(fake.count("session.prompt")).toBe(1);
	});

	test("overlap buffered before our own delivery during lost-admission polling: no mixed content, no summary, exact-id cleanup", async () => {
		for (const managed of [false, true]) {
			const { fake, session } = await setup({ managed });
			let id = "";
			fake.onPrompt = async (input) => {
				id = input.id as string;
				throw new TypeError("fetch failed"); // lost admission reply
			};
			// While the reconciliation poll reads the transcript, the stream
			// buffers a foreign enqueue and delivery, then ours, mixed content,
			// and terminal success.
			fake.onContextRead = (n) => {
				if (n !== 2) return;
				fake.emit("session.inbox.enqueued", {
					sessionID: SID,
					inboxID: "msg_foreign",
					item: {},
				});
				fake.emit("session.inbox.delivered", {
					sessionID: SID,
					inboxID: "msg_foreign",
				});
				fake.emit("session.inbox.enqueued", {
					sessionID: SID,
					inboxID: id,
					item: {},
				});
				fake.emit("session.inbox.delivered", { sessionID: SID, inboxID: id });
				fake.emit("session.reasoning.delta", {
					sessionID: SID,
					delta: "MIXED-REASONING",
				});
				fake.emit("session.text.delta", { sessionID: SID, delta: "MIXED" });
				fake.emit("session.execution.succeeded", { sessionID: SID });
			};
			const events = await collect(
				session.runStreamed("go", { outputSchema: { type: "object" } }),
			);
			expect(events.map((e) => e.type)).toEqual(["error"]);
			expect(JSON.stringify(events)).not.toContain("MIXED");
			expect(doneResult(events)).toBeUndefined();
			expect(errorMessages(events)[0]).toStartWith(
				`OpenCode session ${SID} received other input during this turn; the result is ambiguous`,
			);
			// No summary turn, and the prompt was never resent.
			expect(promptIds(fake)).toEqual([id]);
			// Cleanup acted only on the owned inbox id.
			const cancels = fake.calls.filter((c) => c.m === "session.inbox.cancel");
			expect(cancels.length).toBeGreaterThan(0);
			expect(cancels.every((c) => c.input?.inboxID === id)).toBe(true);
			// Our item was delivered: only a managed private server is interrupted.
			expect(fake.count("session.interrupt")).toBe(managed ? 1 : 0);
			if (!managed) {
				expect(errorMessages(events)[0]).toContain(
					`the OpenCode execution on session ${SID} was left running on the external server`,
				);
			}
		}
	});

	test("a foreign enqueue while pending cancels the turn's own item and fails ambiguous", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				await tick();
				fake.enqueue("msg_foreign");
			})();
			return { id };
		};
		await expect(session.run("go")).rejects.toThrow("the result is ambiguous");
		const cancels = fake.calls.filter((c) => c.m === "session.inbox.cancel");
		expect(cancels.map((c) => c.input?.inboxID)).toEqual([promptIds(fake)[0]]);
		expect(fake.inbox.map((i) => i.id)).toEqual(["msg_foreign"]);
	});

	test("an unrequested inbox.cancelled for the turn's id fails as cancelled by another client", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				await tick();
				fake.inbox = [];
				fake.emit("session.inbox.cancelled", { sessionID: SID, inboxID: id });
			})();
			return { id };
		};
		await expect(session.run("go")).rejects.toThrow(
			/^OpenCode prompt msg_5x[0-9a-f]+ was cancelled by another client$/,
		);
	});
});

// ---------------------------------------------------------------------------
// Polling fallback
// ---------------------------------------------------------------------------

/** Prompt behavior: deliver, drop the stream, then run `after` on the transcript. */
function dropAfterDelivery(
	fake: FakeOpenCode,
	after: (id: string) => Promise<void> | void,
): void {
	fake.onPrompt = async (input) => {
		const id = input.id as string;
		void (async () => {
			fake.enqueue(id);
			fake.deliver(id);
			await tick();
			fake.endStreams();
			await tick(30);
			await after(id);
		})();
		return { id };
	};
}

describe("polling fallback", () => {
	test("succeeded returns text and usage", async () => {
		const { fake, session } = await setup();
		dropAfterDelivery(fake, () => {
			fake.assistant({
				text: "polled reply",
				tokens: { input: 7, output: 3 },
				cost: 0.5,
			});
			fake.finish("succeeded", undefined, { emit: false });
		});
		const result = await session.run("go");
		expect(result.text).toBe("polled reply");
		expect(result.tokens).toEqual({ in: 7, out: 3 });
		expect(result.costUsd).toBe(0.5);
	});

	test("failed produces the same error as the streamed execution.failed", async () => {
		const streamed = await setup();
		streamed.fake.scripts.push({ outcome: "failed", error: "boom" });
		const streamedErr = await streamed.session
			.run("go")
			.catch((e: Error) => e.message);

		const { fake, session } = await setup();
		dropAfterDelivery(fake, () =>
			fake.finish("failed", "boom", { emit: false }),
		);
		const polledErr = await session.run("go").catch((e: Error) => e.message);
		expect(polledErr).toBe(streamedErr);
		expect(polledErr).toBe("boom");
	});

	test("a foreign interrupted outcome produces an error", async () => {
		const { fake, session } = await setup();
		dropAfterDelivery(fake, () =>
			fake.finish("interrupted", undefined, { emit: false }),
		);
		await expect(session.run("go")).rejects.toThrow(
			`OpenCode execution on session ${SID} was interrupted`,
		);
	});

	test("interrupted by our own cancel or timeout raises the typed errors", async () => {
		const a = await setup({ managed: true });
		dropAfterDelivery(a.fake, () => {});
		const controller = new AbortController();
		const p = a.session.run("go", { signal: controller.signal });
		await until(
			() => a.fake.subs.every((s) => s.ended) && a.fake.contextReads > 1,
		);
		controller.abort();
		await expect(p).rejects.toBeInstanceOf(AgentCancellationError);

		const b = await setup({ managed: true });
		dropAfterDelivery(b.fake, () => {});
		await expect(b.session.run("go", { timeout: 0.15 })).rejects.toBeInstanceOf(
			AgentTimeoutError,
		);
	});

	test("only succeeded sends a structured summary prompt", async () => {
		for (const outcome of ["failed", "interrupted"] as const) {
			const { fake, session } = await setup();
			dropAfterDelivery(fake, () => fake.finish(outcome, "x", { emit: false }));
			await expect(
				session.run("go", { outputSchema: { type: "object" } }),
			).rejects.toThrow();
			expect(fake.count("session.prompt")).toBe(1);
		}
		const { fake, session } = await setup();
		fake.scripts.push({}, { text: '{"ok":true}' });
		dropAfterDelivery(fake, () => {
			fake.assistant({ text: "done" });
			fake.finish("succeeded", undefined, { emit: false });
			fake.onPrompt = undefined;
			fake.scripts = [{ text: '{"ok":true}' }];
		});
		const result = await session.run("go", {
			outputSchema: { type: "object" },
		});
		expect(result.structured).toEqual({ ok: true });
		expect(fake.count("session.prompt")).toBe(2);
	});

	test("SSE drop before any assistant message: an idle failed entry settles promptly with its error", async () => {
		for (const [outcome, expected] of [
			["failed", "provider unreachable"],
			["interrupted", "was interrupted"],
		] as const) {
			const { fake, session } = await setup();
			dropAfterDelivery(fake, () =>
				fake.finish(
					outcome,
					outcome === "failed" ? "provider unreachable" : undefined,
					{ emit: false },
				),
			);
			const started = Date.now();
			const err = await session
				.run("go", { timeout: 5, outputSchema: { type: "object" } })
				.catch((e: Error) => e);
			expect(String((err as Error).message)).toContain(expected);
			expect(Date.now() - started).toBeLessThan(1500);
			expect(fake.count("session.prompt")).toBe(1);
		}
	});

	test("stale prior state: an earlier idle entry never settles the turn", async () => {
		const { fake, session } = await setup();
		fake.transcript.push(
			{ id: "msg_prev", type: "user", text: "old" },
			{
				id: "msg_prev_a",
				type: "assistant",
				content: [{ type: "text", text: "OLD" }],
				tokens: { input: 1, output: 1 },
				cost: 0,
			},
			{ id: "msg_prev_idle", type: "idle", outcome: "succeeded" },
		);
		fake.sessionInfo.outcome = "succeeded";
		let finished = false;
		dropAfterDelivery(fake, async () => {
			await tick(80);
			fake.assistant({ text: "NEW" });
			fake.finish("succeeded", undefined, { emit: false });
			finished = true;
		});
		const result = await session.run("go");
		expect(finished).toBe(true);
		expect(result.text).toBe("NEW");
	});

	test("remote clock skew does not matter: no timestamp is compared", async () => {
		for (const skew of [6 * 3600_000, -6 * 3600_000]) {
			const { fake, session } = await setup();
			fake.transcript.push({
				id: "msg_prev_idle",
				type: "idle",
				outcome: "succeeded",
				time: { created: Date.now() + skew },
			});
			let finished = false;
			dropAfterDelivery(fake, async () => {
				await tick(40);
				fake.assistant({ text: "skewed" });
				const idle = {
					id: "msg_idle_skew",
					type: "idle",
					outcome: "succeeded",
					time: { created: Date.now() + skew },
				};
				fake.transcript.push(idle);
				fake.running = false;
				finished = true;
			});
			const result = await session.run("go");
			expect(finished).toBe(true);
			expect(result.text).toBe("skewed");
		}
	});

	test("polling ownership: a queued request keeps polling; another user entry before the idle is ambiguous", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				await tick();
				fake.endStreams();
				await tick(60); // stays in the inbox for several polls
				fake.deliver(id);
				fake.assistant({});
				fake.transcript.push({ id: "msg_foreign", type: "user", text: "hi" });
				fake.finish("succeeded", undefined, { emit: false });
			})();
			return { id };
		};
		await expect(session.run("go")).rejects.toThrow("the result is ambiguous");
	});

	test("delivery between reads stays unknown, then returns the delivered result", async () => {
		const { fake, session } = await setup();
		let requestId = "";
		fake.onPrompt = async (input) => {
			requestId = input.id as string;
			void (async () => {
				fake.enqueue(requestId);
				await tick();
				fake.endStreams();
			})();
			return { id: requestId };
		};
		// Poll 1 sees the item queued. On poll 2 delivery removes it from the
		// inbox between the inbox read and the transcript read, so poll 2 sees it
		// in neither (unknown). Poll 3's transcript read holds it.
		let sawUnknownPoll = false;
		fake.onContextRead = () => {
			if (!fake.subs.every((s) => s.ended)) return;
			const inboxReads = fake.count("session.inbox.list");
			const delivered = fake.transcript.some((e) => e.id === requestId);
			if (inboxReads === 2 && fake.inbox.length > 0) {
				fake.inbox = [];
			} else if (inboxReads === 3 && !delivered) {
				sawUnknownPoll = true;
			} else if (inboxReads >= 4 && !delivered) {
				fake.transcript.push({ id: requestId, type: "user", text: "p" });
				fake.assistant({ text: "delivered late" });
				fake.transcript.push({
					id: "msg_idle_x",
					type: "idle",
					outcome: "succeeded",
				});
			}
		};
		const result = await session.run("go");
		expect(sawUnknownPoll).toBe(true);
		expect(result.text).toBe("delivered late");
		expect(fake.count("session.inbox.cancel")).toBe(0);
		// Each poll reads the inbox before the transcript.
		const order = fake.calls
			.filter((c) => c.m === "session.inbox.list" || c.m === "session.context")
			.map((c) => c.m);
		const firstPoll = order.indexOf("session.inbox.list", 1);
		expect(order[firstPoll + 1]).toBe("session.context");
	});

	test("unknown beyond the bound fails closed with the unknown-outcome error", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				await tick();
				fake.endStreams();
				await tick(20);
				fake.inbox = []; // left the inbox, never reaches the transcript
			})();
			return { id };
		};
		const err = await session.run("go").catch((e: Error) => e);
		expect((err as Error).message).toMatch(
			/^OpenCode prompt msg_5x[0-9a-f]+ left the inbox of session ses_test but is not in its transcript; its outcome is unknown$/,
		);
		expect((err as Error).message).not.toContain("another client");
	});

	test("inactivity timeout and cancel while polling a delivered running turn", async () => {
		for (const managed of [true, false]) {
			const t = await setup({ managed });
			dropAfterDelivery(t.fake, () => {});
			const err = await t.session.run("go", { timeout: 0.15 }).catch((e) => e);
			expect(err).toBeInstanceOf(AgentTimeoutError);
			expect(t.fake.count("session.interrupt")).toBe(managed ? 1 : 0);
			expect((err as Error).message).toStartWith("Agent timed out after 150ms");
			if (!managed) {
				expect((err as Error).message).toContain(
					`the OpenCode execution on session ${SID} was left running on the external server`,
				);
			}

			const c = await setup({ managed });
			dropAfterDelivery(c.fake, () => {});
			const controller = new AbortController();
			const p = c.session.run("go", { signal: controller.signal });
			await until(
				() => c.fake.subs.every((s) => s.ended) && c.fake.contextReads > 1,
			);
			controller.abort();
			const cerr = await p.catch((e) => e);
			expect(cerr).toBeInstanceOf(AgentCancellationError);
			expect(c.fake.count("session.interrupt")).toBe(managed ? 1 : 0);
		}
	});

	test("a hung page read while polling is cut at the inactivity deadline, not the request bound", async () => {
		const { fake, session } = await setup({ timings: { requestMs: 2_000 } });
		fake.contextView = () => []; // forces the durable message.list path
		fake.hang.add("message.list");
		dropAfterDelivery(fake, () => {});
		const start = Date.now();
		const err = await session.run("go", { timeout: 0.15 }).catch((e) => e);
		const elapsed = Date.now() - start;
		expect(err).toBeInstanceOf(AgentTimeoutError);
		expect((err as Error).message).toStartWith("Agent timed out after 150ms");
		expect(fake.count("message.list")).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(1_000);
	});

	test("polling request failures surface as an error", async () => {
		const { fake, session } = await setup();
		dropAfterDelivery(fake, () => {
			fake.hang.add("session.context");
		});
		await expect(session.run("go")).rejects.toThrow(
			`OpenCode polling failed for session ${SID}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Turn window: text and usage
// ---------------------------------------------------------------------------

describe("turn window", () => {
	test("text uses only assistant entries after the prompt id", async () => {
		const { fake, session } = await setup();
		fake.transcript.push(
			{ id: "msg_prev", type: "user", text: "old" },
			{
				id: "msg_prev_a",
				type: "assistant",
				content: [{ type: "text", text: "OLD REPLY" }],
				tokens: { input: 100, output: 100 },
				cost: 9,
			},
			{ id: "msg_prev_idle", type: "idle", outcome: "succeeded" },
		);
		fake.scripts.push({ text: "new reply" });
		const result = await session.run("go");
		expect(result.text).toBe("new reply");
		expect(result.tokens).toEqual({ in: 10, out: 5 });
	});

	test("compaction removed the prompt from context: text comes from message.list", async () => {
		const { fake, session } = await setup();
		fake.scripts.push({ text: "from durable list" });
		fake.contextView = () => {
			const idx = fake.transcript.findIndex((e) => e.type === "idle");
			// Context after compaction: only a compaction summary.
			return idx >= 0
				? [
						{
							id: "msg_cmp",
							type: "compaction",
							status: "running",
							summary: "s",
						} as Entry,
					]
				: fake.transcript;
		};
		const result = await session.run("go");
		expect(result.text).toBe("from durable list");
		expect(fake.count("message.list")).toBeGreaterThan(0);
	});

	test("a reply spanning more than one message.list page is concatenated in order", async () => {
		const { fake, session } = await setup();
		fake.pageSize = 2;
		fake.contextView = () => [];
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				fake.assistant({ text: "one" });
				fake.assistant({ text: "two" });
				fake.assistant({ text: "three" });
				fake.finish();
			})();
			return { id };
		};
		const result = await session.run("go");
		expect(result.text).toBe("one\ntwo\nthree");
		expect(result.tokens).toEqual({ in: 30, out: 15 });
	});

	test("message.list pagination stops at the page holding the closing idle entry", async () => {
		const { fake, session } = await setup();
		fake.pageSize = 2;
		fake.contextView = () => [];
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				fake.assistant({ text: "ours" });
				fake.finish();
				// A long later history that the window never needs.
				for (let i = 0; i < 10; i++) {
					fake.transcript.push({ id: `msg_later_${i}`, type: "user" });
				}
			})();
			return { id };
		};
		const result = await session.run("go");
		expect(result.text).toBe("ours");
		// [prompt, assistant], [idle, later_0]: no page after the boundary.
		expect(fake.count("message.list")).toBe(2);
	});

	test("a delayed page in the window read is bounded by the reconciliation limit", async () => {
		const { fake, session } = await setup({
			timings: { requestMs: 2_000, reconcileMs: 150 },
		});
		fake.pageSize = 1;
		fake.contextView = () => [];
		fake.listDelay = (n) => (n === 2 ? 1_000 : 0);
		const start = Date.now();
		const err = await session.run("go").catch((e: Error) => e);
		const elapsed = Date.now() - start;
		expect((err as Error).message).toMatch(
			/^OpenCode turn window for prompt msg_5x[0-9a-f]+ on session ses_test could not be read within 150ms/,
		);
		expect(elapsed).toBeLessThan(700);
	});

	test("prompt missing from context and every page raises the missing-boundary error", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				fake.assistant({ text: "SHOULD NOT LEAK" });
				fake.finish();
				fake.transcript = fake.transcript.filter((e) => e.id !== id);
			})();
			return { id };
		};
		const err = await session.run("go").catch((e: Error) => e);
		expect((err as Error).message).toMatch(
			/^OpenCode turn reply not found: prompt msg_5x[0-9a-f]+ is missing from session ses_test$/,
		);
	});

	test("usage sums assistant and completed compaction entries in the window, never session.get", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				fake.assistant({
					text: "a",
					tokens: { input: 10, output: 1 },
					cost: 0.1,
				});
				fake.transcript.push({
					id: "msg_cmp",
					type: "compaction",
					status: "completed",
					reason: "auto",
					summary: "s",
					tokens: {
						input: 100,
						output: 20,
						reasoning: 0,
						cache: { read: 0, write: 0 },
					},
					cost: 0.2,
				});
				fake.assistant({
					text: "b",
					tokens: { input: 5, output: 2 },
					cost: 0.3,
				});
				fake.finish();
			})();
			return { id };
		};
		const result = await session.run("go");
		expect(result.tokens).toEqual({ in: 115, out: 23 });
		expect(result.costUsd).toBeCloseTo(0.6);
		expect(fake.count("session.get")).toBe(0);
	});

	test("a new execution after the terminal event does not leak into text or usage", async () => {
		for (const lateIdle of [false, true]) {
			const { fake, session } = await setup();
			fake.onPrompt = async (input) => {
				const id = input.id as string;
				void (async () => {
					fake.enqueue(id);
					fake.deliver(id);
					fake.assistant({
						text: "mine",
						tokens: { input: 3, output: 2 },
						cost: 0.1,
					});
					if (!lateIdle) fake.finish();
					else {
						fake.emit("session.execution.succeeded", { sessionID: SID });
						fake.running = false;
					}
					(fake.sessionInfo.tokens as { input: number }).input = 5_000_000;
					// Another client's execution, after ours.
					if (!lateIdle) {
						fake.transcript.push(
							{ id: "msg_foreign", type: "user", text: "x" },
							{
								id: "msg_foreign_a",
								type: "assistant",
								content: [{ type: "text", text: "FOREIGN" }],
								tokens: { input: 999, output: 999 },
								cost: 9,
							},
							{ id: "msg_foreign_idle", type: "idle", outcome: "succeeded" },
						);
					}
				})();
				return { id };
			};
			if (lateIdle) {
				// The closing idle entry becomes readable only on the second read.
				fake.onContextRead = (n) => {
					if (
						n >= 3 &&
						!fake.transcript.some((e) => e.id === "msg_late_idle")
					) {
						fake.transcript.push({
							id: "msg_late_idle",
							type: "idle",
							outcome: "succeeded",
						});
					}
				};
			}
			const result = await session.run("go");
			expect(result.text).toBe("mine");
			expect(result.tokens).toEqual({ in: 3, out: 2 });
			expect(result.costUsd).toBeCloseTo(0.1);
		}
	});

	test("attribution fails closed: missing tokens fail; missing cost leaves costUsd undefined", async () => {
		const a = await setup();
		a.fake.scripts.push({ tokens: null });
		await expect(a.session.run("go")).rejects.toThrow(
			/^OpenCode usage for prompt msg_5x[0-9a-f]+ on session ses_test cannot be attributed to its turn$/,
		);
		expect(a.fake.count("session.get")).toBe(0);

		const b = await setup();
		b.fake.scripts.push({ cost: null });
		const result = await b.session.run("go");
		expect(result.costUsd).toBeUndefined();
		expect(result.tokens).toEqual({ in: 10, out: 5 });
		expect(b.fake.count("session.get")).toBe(0);
	});

	test("a window with no readable closing idle entry raises the no-end error", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				fake.enqueue(id);
				fake.deliver(id);
				fake.assistant({});
				fake.emit("session.execution.succeeded", { sessionID: SID });
			})();
			return { id };
		};
		const err = await session.run("go").catch((e: Error) => e);
		expect((err as Error).message).toMatch(
			/^OpenCode turn window for prompt msg_5x[0-9a-f]+ on session ses_test has no end$/,
		);
	});
});

// ---------------------------------------------------------------------------
// Timeout, cancellation, and owned cleanup
// ---------------------------------------------------------------------------

/** Prompt behavior: deliver and keep running (no terminal). */
function deliverAndRun(fake: FakeOpenCode): void {
	fake.onPrompt = async (input) => {
		const id = input.id as string;
		void (async () => {
			fake.enqueue(id);
			fake.deliver(id);
			fake.emit("session.text.delta", { sessionID: SID, delta: "working" });
		})();
		return { id };
	};
}

describe("timeout and cancellation on a delivered turn", () => {
	test("inactivity timeout: managed interrupts once; external never does and notes left-running", async () => {
		for (const managed of [true, false]) {
			const { fake, session } = await setup({ managed });
			deliverAndRun(fake);
			const events = await collect(session.runStreamed("go", { timeout: 0.1 }));
			const message = errorMessages(events).at(-1) ?? "";
			expect(message).toStartWith("Agent timed out after 100ms");
			expect(fake.count("session.interrupt")).toBe(managed ? 1 : 0);
			expect(fake.count("session.inbox.cancel")).toBe(0);
			expect(message.includes("left running on the external server")).toBe(
				!managed,
			);
			await expect(
				(async () => {
					const t = await setup({ managed });
					deliverAndRun(t.fake);
					return t.session.run("go", { timeout: 0.1 });
				})(),
			).rejects.toBeInstanceOf(AgentTimeoutError);
		}
	});

	test("caller cancellation: managed interrupts once; external never does", async () => {
		for (const managed of [true, false]) {
			const { fake, session } = await setup({ managed });
			deliverAndRun(fake);
			const controller = new AbortController();
			const p = session.run("go", { signal: controller.signal });
			await until(() => fake.transcript.length > 0);
			await tick(10);
			controller.abort();
			const err = await p.catch((e) => e);
			expect(err).toBeInstanceOf(AgentCancellationError);
			expect((err as Error).message).toStartWith("Agent invocation cancelled");
			expect(fake.count("session.interrupt")).toBe(managed ? 1 : 0);
			if (managed) {
				expect(
					fake.calls.find((c) => c.m === "session.interrupt")?.input,
				).toEqual({ sessionID: SID });
			}
		}
	});
});

describe("owned cancellation", () => {
	test("a signal aborted before the turn sends no request at all", async () => {
		const { fake, session } = await setup({ managed: true });
		const controller = new AbortController();
		controller.abort();
		await expect(
			session.run("go", { signal: controller.signal }),
		).rejects.toBeInstanceOf(AgentCancellationError);
		expect(fake.calls).toHaveLength(0);
	});

	test("cancel of a known queued item cancels that inbox id and never interrupts", async () => {
		const { fake, session } = await setup({ managed: true });
		fake.onPrompt = async (input) => {
			fake.enqueue(input.id as string);
			return { id: input.id };
		};
		const controller = new AbortController();
		const p = session.run("go", { signal: controller.signal });
		await until(() => fake.inbox.length === 1);
		await tick(10);
		controller.abort();
		const err = await p.catch((e) => e);
		expect(err).toBeInstanceOf(AgentCancellationError);
		expect((err as Error).message).toBe("Agent invocation cancelled");
		const cancels = fake.calls.filter((c) => c.m === "session.inbox.cancel");
		expect(cancels.map((c) => c.input)).toEqual([
			{ sessionID: SID, inboxID: promptIds(fake)[0] },
		]);
		expect(fake.count("session.interrupt")).toBe(0);
	});

	test("cancel while admission is in flight (delayed or lost acknowledgment) cancels by the same id", async () => {
		for (const lost of [false, true]) {
			const { fake, session } = await setup({ managed: true });
			fake.onPrompt = async (input) => {
				const id = input.id as string;
				await tick(30);
				fake.enqueue(id); // the server enqueued it
				if (lost) throw new TypeError("fetch failed"); // reply lost
				await new Promise(() => {}); // acknowledgment delayed indefinitely
			};
			const controller = new AbortController();
			const p = session.run("go", { signal: controller.signal });
			await until(() => fake.count("session.prompt") === 1);
			controller.abort();
			const err = await p.catch((e) => e);
			expect(err).toBeInstanceOf(AgentCancellationError);
			expect(fake.count("session.prompt")).toBe(1);
			const cancelIds = fake.calls
				.filter((c) => c.m === "session.inbox.cancel")
				.map((c) => c.input?.inboxID);
			expect(cancelIds.length).toBeGreaterThan(0);
			expect(new Set(cancelIds)).toEqual(new Set([promptIds(fake)[0]]));
			expect(fake.inbox).toHaveLength(0);
			expect((err as Error).message).toBe("Agent invocation cancelled");
		}
	});

	test("cancel before a late enqueue re-cancels by the same id and resolves removed", async () => {
		const { fake, session } = await setup();
		let id = "";
		fake.onPrompt = async (input) => {
			id = input.id as string;
			await new Promise(() => {}); // in flight
		};
		const controller = new AbortController();
		const p = session.run("go", { signal: controller.signal });
		await until(() => fake.count("session.prompt") === 1);
		// The first cancel finds nothing; then the late request is enqueued.
		let cancels = 0;
		fake.onCancel = (input) => {
			cancels += 1;
			if (cancels === 1) {
				setTimeout(() => fake.enqueue(id), 20);
				return;
			}
			fake.inbox = fake.inbox.filter((i) => i.id !== input.inboxID);
			fake.emit("session.inbox.cancelled", {
				sessionID: SID,
				inboxID: input.inboxID,
			});
		};
		controller.abort();
		const err = await p.catch((e) => e);
		expect(err).toBeInstanceOf(AgentCancellationError);
		expect((err as Error).message).toBe("Agent invocation cancelled");
		expect(cancels).toBeGreaterThanOrEqual(2);
		expect(fake.count("session.prompt")).toBe(1);
		expect(fake.inbox).toHaveLength(0);
	});

	test("a late enqueue after the reconciliation bound is reported unresolved, never removed", async () => {
		for (const managed of [false, true]) {
			const { fake, session } = await setup({ managed });
			fake.onPrompt = async () => {
				await new Promise(() => {});
			};
			fake.onCancel = () => {}; // acknowledges, nothing to remove
			const controller = new AbortController();
			const p = session.run("go", { signal: controller.signal });
			await until(() => fake.count("session.prompt") === 1);
			controller.abort();
			const err = await p.catch((e) => e);
			expect(err).toBeInstanceOf(AgentCancellationError);
			const message = (err as Error).message;
			expect(message).toStartWith(
				"Agent invocation cancelled; OpenCode prompt msg_5x",
			);
			expect(message).toContain(`may still be queued or run on session ${SID}`);
			expect(message.includes("private OpenCode server is stopped")).toBe(
				managed,
			);
			expect(fake.count("session.interrupt")).toBe(0);
		}
	});

	test("a lost admission reply without cancellation is reconciled from evidence, never resent", async () => {
		// Evidence within the bound: the turn proceeds.
		const a = await setup();
		a.fake.onPrompt = async (input) => {
			const id = input.id as string;
			setTimeout(() => void a.fake.standardTurn(id), 40);
			throw new TypeError("fetch failed");
		};
		const result = await a.session.run("go");
		expect(result.text).toBe("reply");
		expect(a.fake.count("session.prompt")).toBe(1);

		// No evidence within the bound: unresolved admission.
		const b = await setup();
		b.fake.onPrompt = async () => {
			throw new TypeError("fetch failed");
		};
		b.fake.onCancel = () => {};
		const err = await b.session.run("go").catch((e: Error) => e);
		expect((err as Error).message).toMatch(
			/^OpenCode prompt msg_5x[0-9a-f]+ admission is unresolved on session ses_test; it may still be queued or run/,
		);
		expect(b.fake.count("session.prompt")).toBe(1);
	});

	test("a lost admission reply on a turn that keeps running past the admission bound still settles on its own result", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async (input) => {
			const id = input.id as string;
			void (async () => {
				await tick(20);
				fake.enqueue(id);
				fake.deliver(id);
				// Runs well past the 150 ms admission bound before replying.
				await tick(400);
				fake.assistant({ text: "late reply" });
				fake.finish();
			})();
			throw new TypeError("fetch failed");
		};
		const result = await session.run("go");
		expect(result.text).toBe("late reply");
		expect(fake.count("session.prompt")).toBe(1);
		expect(fake.count("session.inbox.cancel")).toBe(0);
	});

	test("the wake schedule includes the admission deadline only while admission is unresolved", () => {
		const now = 1_000;
		const base = { pollMs: 500, admissionDeadline: now - 50 };
		// Resolved admission: an expired admission deadline is ignored.
		expect(turnWakeDelay(now, { ...base, admissionUnresolved: false })).toBe(
			500,
		);
		// Unresolved: the expired deadline needs an immediate wake.
		expect(turnWakeDelay(now, { ...base, admissionUnresolved: true })).toBe(0);
		expect(
			turnWakeDelay(now, {
				pollMs: 500,
				admissionDeadline: now + 80,
				admissionUnresolved: true,
			}),
		).toBe(80);
		// Poll schedule and inactivity deadline still apply.
		expect(
			turnWakeDelay(now, {
				pollMs: 500,
				nextPollAt: now + 30,
				inactivityDeadline: now + 60,
				admissionUnresolved: false,
			}),
		).toBe(30);
		expect(
			turnWakeDelay(now, {
				pollMs: 500,
				inactivityDeadline: now + 60,
				admissionUnresolved: false,
			}),
		).toBe(60);
	});

	test("a declared prompt rejection fails the turn at once", async () => {
		const { fake, session } = await setup();
		fake.onPrompt = async () => {
			throw Object.assign(new Error("Model not found"), {
				_tag: "ModelNotFoundError",
			});
		};
		await expect(session.run("go")).rejects.toThrow(
			`OpenCode rejected the prompt on session ${SID}: Model not found`,
		);
		expect(fake.count("session.inbox.cancel")).toBe(0);
	});

	test("cancel racing delivery: managed interrupts once; external notes left-running", async () => {
		for (const managed of [true, false]) {
			const { fake, session } = await setup({ managed });
			let id = "";
			fake.onPrompt = async (input) => {
				id = input.id as string;
				fake.enqueue(id);
				return { id };
			};
			const controller = new AbortController();
			const p = session.run("go", { signal: controller.signal });
			await until(() => fake.inbox.length === 1);
			await tick(10);
			// Delivery wins the race; the stream does not report it in time.
			fake.endStreams();
			fake.onCancel = () => {
				fake.inbox = [];
				fake.transcript.push({ id, type: "user", text: "p" });
				fake.running = true;
			};
			controller.abort();
			const err = await p.catch((e) => e);
			expect(err).toBeInstanceOf(AgentCancellationError);
			expect(fake.count("session.interrupt")).toBe(managed ? 1 : 0);
			expect(
				(err as Error).message.includes("left running on the external server"),
			).toBe(!managed);
		}
	});

	test("replacement execution between an activity check and the interrupt: no interrupt decision reads session.active()", async () => {
		for (const managed of [true, false]) {
			const { fake, session } = await setup({ managed });
			deliverAndRun(fake);
			const controller = new AbortController();
			const p = session.run("go", { signal: controller.signal });
			await until(() => fake.transcript.length > 0);
			// Our execution ends and a foreign prompt starts a new one.
			fake.activeOverride = () => ({ [SID]: { type: "running" } });
			fake.transcript.push({ id: "msg_foreign", type: "user", text: "x" });
			const activeBefore = fake.count("session.active");
			controller.abort();
			const err = await p.catch((e) => e);
			expect(err).toBeInstanceOf(AgentCancellationError);
			expect(fake.count("session.active")).toBe(activeBefore);
			const interrupts = fake.calls.filter((c) => c.m === "session.interrupt");
			expect(interrupts.map((c) => c.input)).toEqual(
				managed ? [{ sessionID: SID }] : [],
			);
		}
	});

	test("timeout or cancel on an overlapped delivered turn: managed interrupts once, external never", async () => {
		for (const managed of [true, false]) {
			const { fake, session } = await setup({ managed });
			fake.onPrompt = async (input) => {
				const id = input.id as string;
				void (async () => {
					fake.enqueue(id);
					fake.deliver(id);
					fake.emit("session.inbox.delivered", {
						sessionID: SID,
						inboxID: "msg_foreign",
					});
				})();
				return { id };
			};
			const err = await session.run("go", { timeout: 0.1 }).catch((e) => e);
			expect(err).toBeInstanceOf(AgentTimeoutError);
			expect(fake.count("session.interrupt")).toBe(managed ? 1 : 0);
		}
	});

	test("cleanup requests that hang are abandoned at their bound; the typed error is raised without a terminal event", async () => {
		const { fake, session } = await setup({ managed: true });
		fake.onPrompt = async (input) => {
			fake.enqueue(input.id as string);
			return { id: input.id };
		};
		const controller = new AbortController();
		const p = session.run("go", { signal: controller.signal });
		await until(() => fake.inbox.length === 1);
		await tick(10);
		fake.hang.add("session.inbox.cancel");
		fake.hang.add("session.inbox.list");
		fake.hang.add("session.context");
		fake.hang.add("message.list");
		fake.hang.add("session.interrupt");
		const started = Date.now();
		controller.abort();
		const err = await p.catch((e) => e);
		expect(err).toBeInstanceOf(AgentCancellationError);
		expect(Date.now() - started).toBeLessThan(1500);
		expect((err as Error).message).toContain("may still be queued or run");
	});
});

// ---------------------------------------------------------------------------
// Structured output and run()
// ---------------------------------------------------------------------------

describe("structured output", () => {
	const schema = {
		type: "object",
		properties: { result: { type: "string" }, commit: { type: "string" } },
	};

	test("success on the first summary turn", async () => {
		const { fake, session } = await setup();
		fake.scripts.push(
			{ text: "work done", tokens: { input: 10, output: 5 }, cost: 0.1 },
			{
				text: 'Sure:\n{"result":"complete","commit":"abc"}',
				tokens: { input: 2, output: 1 },
				cost: 0.2,
			},
		);
		const events = await collect(
			session.runStreamed("go", { outputSchema: schema }),
		);
		const result = doneResult(events);
		expect(result?.structured).toEqual({ result: "complete", commit: "abc" });
		expect(result?.text).toBe("work done");
		expect(result?.tokens).toEqual({ in: 12, out: 6 });
		expect(result?.costUsd).toBeCloseTo(0.3);
		// The summary turn is not streamed.
		expect(events.filter((e) => e.type === "text")).toEqual([
			{ type: "text", delta: "work done" },
		]);
		const summaryPrompt = fake.calls.filter((c) => c.m === "session.prompt")[1]
			?.input?.text as string;
		expect(summaryPrompt).toContain(
			"If result is complete, you MUST include the commit hash.",
		);
		expect(summaryPrompt).toContain(
			"Your final message must be exactly one JSON object and nothing else.",
		);
	});

	test("success after one corrective turn", async () => {
		const { fake, session } = await setup();
		fake.scripts.push(
			{ text: "work" },
			{ text: "no json here" },
			{ text: '{"result":"failed"}' },
		);
		const result = await session.run("go", { outputSchema: schema });
		expect(result.structured).toEqual({ result: "failed" });
		expect(fake.count("session.prompt")).toBe(3);
	});

	test("failure after two corrective turns", async () => {
		const { fake, session } = await setup();
		fake.scripts.push(
			{ text: "work" },
			{ text: "a" },
			{ text: "b" },
			{ text: "c" },
		);
		await expect(session.run("go", { outputSchema: schema })).rejects.toThrow(
			"Agent did not return structured output — expected JSON schema response.",
		);
		expect(fake.count("session.prompt")).toBe(4);
	});

	test("costUsd is undefined if any turn's cost is undefined", async () => {
		const { fake, session } = await setup();
		fake.scripts.push(
			{ text: "work", cost: 0.1 },
			{ text: '{"result":"complete"}', cost: null },
		);
		const result = await session.run("go", { outputSchema: schema });
		expect(result.costUsd).toBeUndefined();
	});
});

describe("run()", () => {
	test("run() equals the done result of runStreamed()", async () => {
		const a = await setup();
		a.fake.scripts.push({
			text: "same",
			tokens: { input: 4, output: 2 },
			cost: 0.4,
		});
		const streamed = doneResult(await collect(a.session.runStreamed("go")));

		const b = await setup();
		b.fake.scripts.push({
			text: "same",
			tokens: { input: 4, output: 2 },
			cost: 0.4,
		});
		const ran = await b.session.run("go");

		expect({ ...ran, durationMs: 0 }).toEqual({
			...(streamed as RunResult),
			durationMs: 0,
		});
	});

	test("the in-flight guard is released after each turn", async () => {
		const { session } = await setup();
		await session.run("one");
		await session.run("two");
	});
});
