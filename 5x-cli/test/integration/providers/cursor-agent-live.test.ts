/**
 * Opt-in live probe against the real `agent` CLI (Cursor Agent).
 *
 * Set CURSOR_AGENT_LIVE_TEST=1 and ensure `agent` is on PATH. Used to catch
 * upstream CLI flag or output contract drift without running in default CI.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const LIVE = process.env.CURSOR_AGENT_LIVE_TEST === "1";
const AGENT = Bun.which("agent") as string;

function tmpProject(): string {
	const dir = join(
		tmpdir(),
		`5x-cursor-live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("cursor-agent live CLI probe", () => {
	test.skipIf(!LIVE || !AGENT)(
		"help text advertises required flags and create-chat",
		async () => {
			const proc = Bun.spawn([AGENT, "--help"], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: cleanGitEnv(),
			});
			const code = await proc.exited;
			const out = await new Response(proc.stdout).text();
			const err = await new Response(proc.stderr).text();
			const text = `${out}\n${err}`;
			expect(code === 0 || text.length > 0).toBe(true);
			for (const needle of [
				"--output-format",
				"stream-json",
				"--resume",
				"--workspace",
				"create-chat",
			]) {
				expect(text).toContain(needle);
			}
		},
		{ timeout: 30000 },
	);

	test.skipIf(!LIVE || !AGENT)(
		"create-chat returns a non-empty session ID when authenticated",
		async () => {
			const cwd = tmpProject();
			const proc = Bun.spawn([AGENT, "create-chat"], {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: cleanGitEnv(),
			});
			const code = await proc.exited;
			const out = (await new Response(proc.stdout).text()).trim();
			await new Response(proc.stderr).text();

			try {
				rmSync(cwd, { recursive: true });
			} catch {
				/* ignore */
			}

			expect(code).toBe(0);
			expect(out.length).toBeGreaterThan(0);
		},
		{ timeout: 60000 },
	);

	test.skipIf(!LIVE || !AGENT)(
		"read-only json prompt returns result with session_id",
		async () => {
			const cwd = tmpProject();
			const argv = [
				AGENT,
				"-p",
				"Reply with exactly the word: ok",
				"--mode",
				"ask",
				"--output-format",
				"json",
				"--trust",
				"--workspace",
				cwd,
			];

			const proc = Bun.spawn(argv, {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: cleanGitEnv(),
			});

			const killTimer = setTimeout(() => {
				try {
					proc.kill(15);
				} catch {
					/* ignore */
				}
			}, 120_000);

			const exitCode = await proc.exited;
			clearTimeout(killTimer);

			const stdout = await new Response(proc.stdout).text();
			await new Response(proc.stderr).text();

			try {
				rmSync(cwd, { recursive: true });
			} catch {
				/* ignore */
			}

			expect(exitCode).toBe(0);

			let parsed: Record<string, unknown> | undefined;
			try {
				parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
			} catch {
				parsed = undefined;
			}
			expect(parsed).toBeDefined();
			expect(typeof parsed?.session_id).toBe("string");
			expect(
				(parsed?.session_id as string | undefined)?.length,
			).toBeGreaterThan(0);
			expect(parsed?.result).toBeDefined();
		},
		{ timeout: 150000 },
	);

	test.skipIf(!LIVE || !AGENT)(
		"stream-json prompt emits system init and terminal result",
		async () => {
			const cwd = tmpProject();

			const createProc = Bun.spawn([AGENT, "create-chat"], {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: cleanGitEnv(),
			});
			const createCode = await createProc.exited;
			const sessionId = (await new Response(createProc.stdout).text()).trim();
			await new Response(createProc.stderr).text();
			expect(createCode).toBe(0);
			expect(sessionId.length).toBeGreaterThan(0);

			const argv = [
				AGENT,
				"-p",
				"Reply with exactly the word: ok",
				"--output-format",
				"stream-json",
				"--stream-partial-output",
				"--trust",
				"--workspace",
				cwd,
				"--resume",
				sessionId,
			];

			const proc = Bun.spawn(argv, {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: cleanGitEnv(),
			});

			const killTimer = setTimeout(() => {
				try {
					proc.kill(15);
				} catch {
					/* ignore */
				}
			}, 120_000);

			const exitCode = await proc.exited;
			clearTimeout(killTimer);

			const stdout = await new Response(proc.stdout).text();
			await new Response(proc.stderr).text();

			try {
				rmSync(cwd, { recursive: true });
			} catch {
				/* ignore */
			}

			expect(exitCode).toBe(0);

			let sawSystemInit = false;
			let resultObj: Record<string, unknown> | undefined;
			for (const line of stdout.split("\n")) {
				const t = line.trim();
				if (!t) continue;
				let rec: Record<string, unknown>;
				try {
					rec = JSON.parse(t) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (rec.type === "system" && rec.subtype === "init") {
					sawSystemInit = true;
				}
				if (rec.type === "result" && rec.is_error !== true) {
					resultObj = rec;
				}
			}

			expect(sawSystemInit).toBe(true);
			expect(resultObj).toBeDefined();
			expect(typeof resultObj?.session_id).toBe("string");
		},
		{ timeout: 150000 },
	);
});
