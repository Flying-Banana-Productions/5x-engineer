/**
 * CursorAgentSession + NDJSON reader — Bun.spawn mocked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { MAX_PROMPT_BYTES } from "../../../../packages/provider-cursor-agent/src/prompt-guard.js";
import type { CursorAgentExecutionHost } from "../../../../packages/provider-cursor-agent/src/session.js";
import {
	CursorAgentSession,
	readNdjsonLines,
} from "../../../../packages/provider-cursor-agent/src/session.js";
import type { JSONSchema } from "../../../../src/providers/types.js";

const SESSION = "c6b62c6f-7ead-4fd6-9922-e952131177ff";

const defaultConfig = {
	agentBinary: "agent",
	force: true,
	trust: true,
};

function streamFromString(s: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(s));
			controller.close();
		},
	});
}

function mockHost(): CursorAgentExecutionHost & { tracked: number } {
	const o = {
		isClosed: false,
		tracked: 0,
		trackProcess() {
			o.tracked++;
		},
		untrackProcess() {
			o.tracked--;
		},
	};
	return o;
}

function resultLine(overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "final answer",
		session_id: SESSION,
		duration_ms: 100,
		...overrides,
	})}\n`;
}

function streamJsonRun(stdoutText: string): string {
	return [
		JSON.stringify({
			type: "assistant",
			timestamp_ms: 1,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
			},
			session_id: SESSION,
		}),
		"\n",
		stdoutText,
	].join("");
}

describe("readNdjsonLines", () => {
	test("yields parsed objects per line", async () => {
		const lines = ['{"a":1}\n', '{"b":2}\n'].join("");
		const out: Record<string, unknown>[] = [];
		for await (const obj of readNdjsonLines(streamFromString(lines))) {
			out.push(obj);
		}
		expect(out).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("skips malformed lines", async () => {
		const lines = ['{"ok":true}\n', "not-json\n", '{"x":1}\n'].join("");
		const out: Record<string, unknown>[] = [];
		for await (const obj of readNdjsonLines(streamFromString(lines))) {
			out.push(obj);
		}
		expect(out).toEqual([{ ok: true }, { x: 1 }]);
	});
});

describe("CursorAgentSession.run (mocked spawn)", () => {
	const origSpawn = Bun.spawn;
	let spawnCalls: string[][] = [];

	afterEach(() => {
		Bun.spawn = origSpawn;
		spawnCalls = [];
	});

	function installSpawnSyncExit(stdoutText: string, exitCode = 0) {
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString(stdoutText),
				stderr: streamFromString(""),
				exited: Promise.resolve(exitCode),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;
	}

	test("run() returns RunResult from mock stream-json", async () => {
		installSpawnSyncExit(streamJsonRun(resultLine()));
		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const r = await session.run("hello");
		expect(r.text).toBe("final answer");
		expect(r.sessionId).toBe(SESSION);
		expect(r.tokens).toEqual({ in: 0, out: 0 });
		expect(r.durationMs).toBe(100);
	});

	test("run() with outputSchema wraps prompt and attaches structured", async () => {
		const assistantJson = JSON.stringify({ status: "ok" });
		installSpawnSyncExit(
			streamJsonRun(
				resultLine({
					result: assistantJson,
				}),
			),
		);
		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});
		const schema: JSONSchema = {
			type: "object",
			properties: { status: { type: "string" } },
		};
		const r = await session.run("p", { outputSchema: schema });
		expect(r.structured).toEqual({ status: "ok" });
		const argv = spawnCalls[0];
		if (argv === undefined) throw new Error("expected spawn argv");
		const prompt = argv[argv.length - 1];
		expect(prompt).toContain("FINAL RESPONSE REQUIREMENTS");
		expect(prompt).toContain("p");
	});

	test("run() structured parse failure leaves structured undefined", async () => {
		installSpawnSyncExit(
			streamJsonRun(
				resultLine({
					result: "not json at all",
				}),
			),
		);
		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});
		const r = await session.run("p", { outputSchema: { type: "object" } });
		expect(r.structured).toBeUndefined();
	});

	test("run() propagates error event as throw", async () => {
		installSpawnSyncExit('{"type":"system"}\n');
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString('{"type":"system"}\n'),
				stderr: streamFromString("boom"),
				exited: Promise.resolve(1),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});
		await expect(session.run("x")).rejects.toThrow(/exited with code 1/);
	});

	test("over-limit prompt: run() throws and does not spawn", async () => {
		let spawned = false;
		Bun.spawn = (() => {
			spawned = true;
			return {} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const big = "a".repeat(MAX_PROMPT_BYTES + 1);
		await expect(session.run(big)).rejects.toThrow(
			/exceeds maximum byte length/,
		);
		expect(spawned).toBe(false);
	});

	test("run() passes --resume session id and stream-json flags", async () => {
		installSpawnSyncExit(streamJsonRun(resultLine()));
		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp/wt",
			config: defaultConfig,
			provider: host,
		});
		await session.run("hello");
		const argv = spawnCalls[0];
		expect(argv).toContain("--resume");
		expect(argv).toContain(SESSION);
		expect(argv).toContain("--output-format");
		expect(argv).toContain("stream-json");
		expect(argv).toContain("--workspace");
		expect(argv).toContain("/tmp/wt");
	});
});

describe("CursorAgentSession.runStreamed (mocked spawn)", () => {
	const origSpawn = Bun.spawn;
	let spawnCalls: string[][] = [];

	afterEach(() => {
		Bun.spawn = origSpawn;
		spawnCalls = [];
	});

	function installStreamSpawn(ndjson: string, exitCode = 0, stderr = "") {
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString(ndjson),
				stderr: streamFromString(stderr),
				exited: Promise.resolve(exitCode),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;
	}

	test("yields text, usage, done in order", async () => {
		installStreamSpawn(streamJsonRun(resultLine()));

		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const events: string[] = [];
		for await (const ev of session.runStreamed("prompt")) {
			events.push(ev.type);
		}

		expect(events).toContain("text");
		const usageIdx = events.indexOf("usage");
		const doneIdx = events.indexOf("done");
		expect(usageIdx).toBeGreaterThanOrEqual(0);
		expect(doneIdx).toBeGreaterThan(usageIdx);
	});

	test("structured success attaches to done result", async () => {
		const payload = { verdict: "pass" };
		const ndjson = streamJsonRun(
			resultLine({
				result: JSON.stringify(payload),
			}),
		);
		installStreamSpawn(ndjson);

		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		let structured: unknown;
		for await (const ev of session.runStreamed("p", {
			outputSchema: { type: "object" },
		})) {
			if (ev.type === "done") structured = ev.result.structured;
		}
		expect(structured).toEqual(payload);
	});

	test("over-limit: single error event, no spawn", async () => {
		let spawned = false;
		Bun.spawn = (() => {
			spawned = true;
			return {} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const big = "a".repeat(MAX_PROMPT_BYTES + 1);
		const out: { type: string; message?: string }[] = [];
		for await (const ev of session.runStreamed(big)) {
			out.push(ev);
		}
		expect(spawned).toBe(false);
		expect(out).toEqual([
			{
				type: "error",
				message: expect.stringContaining("exceeds maximum byte length"),
			},
		]);
	});

	test("non-zero exit yields error with stderr", async () => {
		installStreamSpawn('{"type":"system"}\n', 2, "auth required");

		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const messages: string[] = [];
		for await (const ev of session.runStreamed("x")) {
			if (ev.type === "error") messages.push(ev.message);
		}
		expect(messages.some((m) => m.includes("exited with code 2"))).toBe(true);
		expect(messages.some((m) => m.includes("auth required"))).toBe(true);
	});

	test("exit without result line yields error", async () => {
		installStreamSpawn('{"type":"system"}\n', 7, "fail");

		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const messages: string[] = [];
		for await (const ev of session.runStreamed("x")) {
			if (ev.type === "error") messages.push(ev.message);
		}
		expect(messages.some((m) => m.includes("7"))).toBe(true);
	});

	test(
		"runStreamed inactivity timeout yields error and kills subprocess",
		async () => {
			let kills = 0;
			let exitResolve!: (n: number) => void;
			const exited = new Promise<number>((r) => {
				exitResolve = r;
			});
			let streamCtrl!: ReadableStreamDefaultController<Uint8Array>;
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					streamCtrl = c;
				},
			});

			Bun.spawn = ((cmd: string[]) => {
				spawnCalls.push([...cmd]);
				return {
					stdout,
					stderr: streamFromString(""),
					exited,
					kill() {
						kills++;
						try {
							streamCtrl.close();
						} catch {
							/* ignore */
						}
						exitResolve(0);
					},
				} as ReturnType<typeof Bun.spawn>;
			}) as typeof Bun.spawn;

			const host = mockHost();
			const session = new CursorAgentSession({
				id: SESSION,
				model: "gpt-5",
				cwd: "/tmp",
				config: defaultConfig,
				provider: host,
			});

			const messages: string[] = [];
			for await (const ev of session.runStreamed("hi", { timeout: 0.1 })) {
				if (ev.type === "error") messages.push(ev.message);
			}

			expect(kills).toBeGreaterThanOrEqual(1);
			expect(
				messages.some((m) => m.includes("Agent timed out after 100ms")),
			).toBe(true);
		},
		{ timeout: 15000 },
	);

	test("runStreamed cancellation yields error event and kills subprocess", async () => {
		let kills = 0;
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString(streamJsonRun(resultLine())),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {
					kills++;
				},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const messages: string[] = [];
		for await (const ev of session.runStreamed("x", {
			signal: AbortSignal.abort(),
		})) {
			if (ev.type === "error") messages.push(ev.message);
		}

		expect(kills).toBeGreaterThanOrEqual(1);
		expect(messages.some((m) => m.includes("Agent invocation cancelled"))).toBe(
			true,
		);
	});

	test("closed provider yields error on runStreamed", async () => {
		const host: CursorAgentExecutionHost = {
			get isClosed() {
				return true;
			},
			trackProcess() {},
			untrackProcess() {},
		};
		const session = new CursorAgentSession({
			id: SESSION,
			model: "gpt-5",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		await expect(async () => {
			for await (const _ of session.runStreamed("x")) {
				// consume
			}
		}).toThrow(/Provider is closed/);
	});
});
