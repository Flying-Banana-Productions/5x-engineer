/**
 * CursorAgentProvider lifecycle and session tracking.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { CursorAgentProvider } from "../../../../packages/provider-cursor-agent/src/provider.js";

function streamFromString(s: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(s));
			controller.close();
		},
	});
}

const SESSION = "chat-abc-123";

const resultLine = () =>
	`${JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "ok",
		session_id: SESSION,
		duration_ms: 0,
	})}\n`;

function streamJsonRun(): string {
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
		resultLine(),
	].join("");
}

describe("CursorAgentProvider", () => {
	const origSpawn = Bun.spawn;
	afterEach(() => {
		Bun.spawn = origSpawn;
	});

	test("startSession runs create-chat and returns session with chat id", async () => {
		const calls: string[][] = [];
		Bun.spawn = ((cmd: string[]) => {
			calls.push([...cmd]);
			if (cmd.includes("create-chat")) {
				return {
					stdout: streamFromString(`${SESSION}\n`),
					stderr: streamFromString(""),
					exited: Promise.resolve(0),
					kill() {},
				} as ReturnType<typeof Bun.spawn>;
			}
			return {
				stdout: streamFromString(streamJsonRun()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const p = new CursorAgentProvider({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		const s = await p.startSession({
			model: "gpt-5",
			workingDirectory: "/tmp/w",
		});
		expect(s.id).toBe(SESSION);
		expect(calls[0]).toEqual(["agent", "create-chat"]);
	});

	test("startSession empty stdout fails with clear error", async () => {
		Bun.spawn = (() =>
			({
				stdout: streamFromString("\n"),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			}) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;

		const p = new CursorAgentProvider({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		await expect(
			p.startSession({ model: "gpt-5", workingDirectory: "/tmp" }),
		).rejects.toThrow(/empty session ID/);
	});

	test("startSession non-zero create-chat exit fails", async () => {
		Bun.spawn = (() =>
			({
				stdout: streamFromString(""),
				stderr: streamFromString("not logged in"),
				exited: Promise.resolve(1),
				kill() {},
			}) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;

		const p = new CursorAgentProvider({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		await expect(
			p.startSession({ model: "gpt-5", workingDirectory: "/tmp" }),
		).rejects.toThrow(/create-chat exited with code 1/);
	});

	test("startSession ENOENT includes install hint", async () => {
		Bun.spawn = (() => {
			const err = new Error("spawn ENOENT") as Error & { code: string };
			err.code = "ENOENT";
			throw err;
		}) as typeof Bun.spawn;

		const p = new CursorAgentProvider({
			agentBinary: "missing-agent",
			force: true,
			trust: true,
		});
		await expect(
			p.startSession({ model: "gpt-5", workingDirectory: "/tmp" }),
		).rejects.toThrow(/Could not find Cursor Agent CLI binary/);
	});

	test("resumeSession returns same instance when tracked", async () => {
		Bun.spawn = ((cmd: string[]) => {
			if (cmd.includes("create-chat")) {
				return {
					stdout: streamFromString(`${SESSION}\n`),
					stderr: streamFromString(""),
					exited: Promise.resolve(0),
					kill() {},
				} as ReturnType<typeof Bun.spawn>;
			}
			return {
				stdout: streamFromString(streamJsonRun()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const p = new CursorAgentProvider({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		const a = await p.startSession({
			model: "gpt-5",
			workingDirectory: "/tmp/w",
		});
		const b = await p.resumeSession(a.id);
		expect(b).toBe(a);
	});

	test("resumeSession creates handle with --resume and no create-chat", async () => {
		const calls: string[][] = [];
		Bun.spawn = ((cmd: string[]) => {
			calls.push([...cmd]);
			return {
				stdout: streamFromString(streamJsonRun()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const p = new CursorAgentProvider({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		const s = await p.resumeSession("fixed-id", {
			model: "gpt-5",
			workingDirectory: "/tmp/resume",
		});
		expect(s.id).toBe("fixed-id");
		await s.run("one");
		expect(calls.some((c) => c.includes("create-chat"))).toBe(false);
		expect(calls[0]).toContain("--resume");
		expect(calls[0]).toContain("fixed-id");
	});

	test("startSession workingDirectory is cwd for run spawns", async () => {
		const spawnOpts: { cwd?: string }[] = [];
		Bun.spawn = ((cmd: string[], opts?: { cwd?: string }) => {
			spawnOpts.push({ cwd: opts?.cwd });
			if (cmd.includes("create-chat")) {
				return {
					stdout: streamFromString(`${SESSION}\n`),
					stderr: streamFromString(""),
					exited: Promise.resolve(0),
					kill() {},
				} as ReturnType<typeof Bun.spawn>;
			}
			return {
				stdout: streamFromString(streamJsonRun()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const p = new CursorAgentProvider({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		const s = await p.startSession({
			model: "gpt-5",
			workingDirectory: "/tmp/wt-cursor",
		});
		await s.run("a");
		expect(spawnOpts[0]?.cwd).toBe("/tmp/wt-cursor");
		expect(spawnOpts[1]?.cwd).toBe("/tmp/wt-cursor");
	});

	test("closed provider rejects startSession and resumeSession", async () => {
		const p = new CursorAgentProvider({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		await p.close();
		await expect(
			p.startSession({ model: "gpt-5", workingDirectory: "/tmp" }),
		).rejects.toThrow(/Provider is closed/);
		await expect(p.resumeSession("x")).rejects.toThrow(/Provider is closed/);
	});

	test("close is idempotent and clears sessions", async () => {
		const p = new CursorAgentProvider({
			agentBinary: "agent",
			force: true,
			trust: true,
		});
		await p.close();
		await p.close();
		expect(p.isClosed).toBe(true);
	});

	test(
		"close invokes kill on hung subprocess",
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
				if (cmd.includes("create-chat")) {
					return {
						stdout: streamFromString(`${SESSION}\n`),
						stderr: streamFromString(""),
						exited: Promise.resolve(0),
						kill() {},
					} as ReturnType<typeof Bun.spawn>;
				}
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

			const p = new CursorAgentProvider({
				agentBinary: "agent",
				force: true,
				trust: true,
			});
			const s = await p.startSession({
				model: "gpt-5",
				workingDirectory: "/tmp",
			});
			void s.run("x").catch(() => {});
			await new Promise((r) => setTimeout(r, 15));
			await p.close();
			expect(kills).toBeGreaterThanOrEqual(1);
		},
		{ timeout: 15000 },
	);
});
