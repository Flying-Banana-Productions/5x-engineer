/**
 * ClaudeCodeProvider lifecycle and session tracking.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "../../../../packages/provider-claude-code/src/provider.js";

function streamFromString(s: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(s));
			controller.close();
		},
	});
}

const resultLine = () =>
	`${JSON.stringify({
		type: "result",
		is_error: false,
		result: "ok",
		session_id: "s",
		usage: { input_tokens: 1, output_tokens: 1 },
		duration_ms: 0,
	})}\n`;

describe("ClaudeCodeProvider", () => {
	const origSpawn = Bun.spawn;
	afterEach(() => {
		Bun.spawn = origSpawn;
	});

	test("startSession returns new id; resumeSession returns same instance", async () => {
		Bun.spawn = (() =>
			({
				stdout: streamFromString(resultLine()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			}) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;

		const p = new ClaudeCodeProvider({
			permissionMode: "dangerously-skip",
			claudeBinary: "claude",
		});
		const a = await p.startSession({
			model: "anthropic/claude-sonnet-4-6",
			workingDirectory: "/tmp/w",
		});
		const b = await p.resumeSession(a.id);
		expect(b).toBe(a);
	});

	test("resumeSession creates session with resume semantics (fork-safe)", async () => {
		const calls: string[][] = [];
		Bun.spawn = ((cmd: string[]) => {
			calls.push([...cmd]);
			return {
				stdout: streamFromString(resultLine()),
				stderr: streamFromString(""),
				exited: Promise.resolve(0),
				kill() {},
			} as ReturnType<typeof Bun.spawn>;
		}) as typeof Bun.spawn;

		const p = new ClaudeCodeProvider({
			permissionMode: "dangerously-skip",
			claudeBinary: "claude",
		});
		const s = await p.resumeSession("fixed-id", { model: "sonnet" });
		await s.run("one");
		expect(calls[0]).toContain("--resume");
		expect(calls[0]).not.toContain("--session-id");
	});

	test("close is idempotent and clears sessions", async () => {
		const p = new ClaudeCodeProvider({
			permissionMode: "dangerously-skip",
			claudeBinary: "claude",
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

			Bun.spawn = (() =>
				({
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
				}) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;

			const p = new ClaudeCodeProvider({
				permissionMode: "dangerously-skip",
				claudeBinary: "claude",
			});
			const s = await p.startSession({
				model: "sonnet",
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
