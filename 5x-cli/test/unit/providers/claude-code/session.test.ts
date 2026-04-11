/**
 * ClaudeCodeSession + NDJSON reader — Bun.spawn mocked.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { MAX_PROMPT_BYTES } from "../../../../packages/provider-claude-code/src/prompt-guard.js";
import type { ClaudeCodeExecutionHost } from "../../../../packages/provider-claude-code/src/session.js";
import {
	ClaudeCodeSession,
	readNdjsonLines,
} from "../../../../packages/provider-claude-code/src/session.js";
import type { JSONSchema } from "../../../../src/providers/types.js";

const defaultConfig = {
	permissionMode: "dangerously-skip" as const,
	claudeBinary: "claude",
};

function streamFromString(s: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(s));
			controller.close();
		},
	});
}

function mockHost(): ClaudeCodeExecutionHost & { tracked: number } {
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

function resultJson(overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		type: "result",
		is_error: false,
		result: "final",
		session_id: "sess-mock",
		usage: { input_tokens: 10, output_tokens: 20 },
		duration_ms: 100,
		...overrides,
	})}\n`;
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

describe("ClaudeCodeSession.run (mocked spawn)", () => {
	const origSpawn = Bun.spawn;
	let spawnCalls: string[][] = [];

	afterEach(() => {
		Bun.spawn = origSpawn;
		spawnCalls = [];
	});

	/** Spawn mock where exited resolves after microtask (stdout already fully readable). */
	function installSpawnSyncExit(stdoutText: string, exitCode = 0) {
		Bun.spawn = ((cmd: string[], _opts?: object) => {
			spawnCalls.push([...cmd]);
			const exited = Promise.resolve(exitCode);
			return {
				stdout: streamFromString(stdoutText),
				stderr: streamFromString(""),
				exited,
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;
	}

	test("run() returns RunResult from mock JSON", async () => {
		installSpawnSyncExit(resultJson());
		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "sess-mock",
			firstInvocationMode: "session-id",
			model: "sonnet",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const r = await session.run("hello");
		expect(r.text).toBe("final");
		expect(r.sessionId).toBe("sess-mock");
		expect(r.tokens).toEqual({ in: 10, out: 20 });
		expect(r.durationMs).toBe(100);
	});

	test("run() with outputSchema passes --json-schema", async () => {
		installSpawnSyncExit(resultJson({ structured_output: { a: 1 } }));
		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "s1",
			firstInvocationMode: "session-id",
			model: "sonnet",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});
		const schema: JSONSchema = { type: "object" };
		await session.run("p", { outputSchema: schema });
		const argv = spawnCalls[0];
		if (argv === undefined) throw new Error("expected spawn argv");
		const i = argv.indexOf("--json-schema");
		expect(i).toBeGreaterThanOrEqual(0);
		const schemaArg = argv[i + 1];
		if (schemaArg === undefined) {
			throw new Error("expected serialized schema after --json-schema");
		}
		expect(JSON.parse(schemaArg)).toEqual(schema);
	});

	test("over-limit prompt: run() throws and does not spawn", async () => {
		let spawned = false;
		Bun.spawn = (() => {
			spawned = true;
			return {} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "s1",
			firstInvocationMode: "session-id",
			model: "sonnet",
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

	test(
		"run() wall-clock timeout throws AgentTimeoutError",
		async () => {
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
			const session = new ClaudeCodeSession({
				id: "s1",
				firstInvocationMode: "session-id",
				model: "sonnet",
				cwd: "/tmp",
				config: defaultConfig,
				provider: host,
			});

			await expect(session.run("hi", { timeout: 1 })).rejects.toThrow(
				/Agent timed out after 1000ms/,
			);
		},
		{ timeout: 15000 },
	);

	test("run() cancellation throws AgentCancellationError", async () => {
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString(resultJson()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "s2",
			firstInvocationMode: "session-id",
			model: "sonnet",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});
		await expect(
			session.run("x", { signal: AbortSignal.abort() }),
		).rejects.toThrow(/Agent invocation cancelled/);
	});
});

describe("ClaudeCodeSession.runStreamed (mocked spawn)", () => {
	const origSpawn = Bun.spawn;
	let spawnCalls: string[][] = [];

	afterEach(() => {
		Bun.spawn = origSpawn;
		spawnCalls = [];
	});

	function installStreamSpawn(ndjson: string) {
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString(ndjson),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;
	}

	test("yields text, usage, done in order", async () => {
		const ndjson = [
			JSON.stringify({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "Hi" },
				},
			}),
			"\n",
			resultJson({ session_id: "sid-1" }),
		].join("");
		installStreamSpawn(ndjson);

		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "sid-1",
			firstInvocationMode: "session-id",
			model: "sonnet",
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

	test("over-limit: single error event, no spawn", async () => {
		let spawned = false;
		Bun.spawn = (() => {
			spawned = true;
			return {} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "s1",
			firstInvocationMode: "session-id",
			model: "sonnet",
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

	test("startSession path: first run session-id, second run resume", async () => {
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString(resultJson()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "uuid-1",
			firstInvocationMode: "session-id",
			model: "sonnet",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		await session.run("a");
		expect(spawnCalls[0]).toContain("--session-id");
		expect(spawnCalls[0]).not.toContain("--resume");

		await session.run("b");
		expect(spawnCalls[1]).toContain("--resume");
		expect(spawnCalls[1]).not.toContain("--session-id");
	});

	test("resumeSession path: first run uses --resume", async () => {
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString(resultJson()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "existing",
			firstInvocationMode: "resume",
			model: "sonnet",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		await session.run("only");
		expect(spawnCalls[0]).toContain("--resume");
		expect(spawnCalls[0]).not.toContain("--session-id");
	});

	test("exit without result line yields error", async () => {
		Bun.spawn = ((cmd: string[]) => {
			spawnCalls.push([...cmd]);
			return {
				stdout: streamFromString('{"type":"system"}\n'),
				stderr: streamFromString(""),
				exited: Promise.resolve(7),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const host = mockHost();
		const session = new ClaudeCodeSession({
			id: "s1",
			firstInvocationMode: "session-id",
			model: "sonnet",
			cwd: "/tmp",
			config: defaultConfig,
			provider: host,
		});

		const messages: string[] = [];
		for await (const ev of session.runStreamed("x")) {
			if (ev.type === "error") messages.push(ev.message);
		}
		expect(messages.some((m) => m.includes("without a result line"))).toBe(
			true,
		);
		expect(messages.some((m) => m.includes("7"))).toBe(true);
	});
});
