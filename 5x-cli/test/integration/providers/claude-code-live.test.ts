/**
 * Opt-in live probe against the real `claude` CLI (Claude Code).
 *
 * Set CLAUDE_LIVE_TEST=1 and ensure `claude` is on PATH. Used to catch upstream
 * CLI flag or output contract drift without running in default CI.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIVE = process.env.CLAUDE_LIVE_TEST === "1";
const CLAUDE = Bun.which("claude");

function tmpProject(): string {
	const dir = join(
		tmpdir(),
		`5x-claude-live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("claude-code live CLI probe", () => {
	test.skipIf(!LIVE || !CLAUDE)(
		"help text advertises required flags",
		async () => {
			const proc = Bun.spawn([CLAUDE!, "--help"], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await proc.exited;
			const out = await new Response(proc.stdout).text();
			const err = await new Response(proc.stderr).text();
			const text = `${out}\n${err}`;
			expect(code === 0 || text.length > 0).toBe(true);
			for (const needle of [
				"stream-json",
				"include-partial-messages",
				"json-schema",
				"--resume",
				"--session-id",
				"--effort",
				"--add-dir",
				"--fallback-model",
				"--disallowed-tools",
			]) {
				expect(text).toContain(needle);
			}
		},
		{ timeout: 30000 },
	);

	test.skipIf(!LIVE || !CLAUDE)(
		"stream-json run emits stream_event and terminal result with usage",
		async () => {
			const cwd = tmpProject();
			const sid = randomUUID();
			const argv = [
				CLAUDE!,
				"-p",
				"Reply with exactly the word: ok",
				"--session-id",
				sid,
				"--model",
				"sonnet",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--dangerously-skip-permissions",
			];

			const proc = Bun.spawn(argv, {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
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

			let sawStream = false;
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
				if (rec.type === "stream_event") sawStream = true;
				if (rec.type === "result" && rec.is_error !== true) resultObj = rec;
			}

			expect(sawStream).toBe(true);
			expect(resultObj).toBeDefined();
			const usage = resultObj?.usage as Record<string, unknown> | undefined;
			expect(usage).toBeDefined();
			const inn =
				typeof usage?.input_tokens === "number"
					? usage.input_tokens
					: typeof usage?.input === "number"
						? usage.input
						: undefined;
			const outt =
				typeof usage?.output_tokens === "number"
					? usage.output_tokens
					: typeof usage?.output === "number"
						? usage.output
						: undefined;
			expect(typeof inn).toBe("number");
			expect(typeof outt).toBe("number");
		},
		{ timeout: 150000 },
	);

	test.skipIf(!LIVE || !CLAUDE)(
		"json-schema run exposes structured_output on success",
		async () => {
			const cwd = tmpProject();
			const sid = randomUUID();
			const schema = JSON.stringify({
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
			});
			const argv = [
				CLAUDE!,
				"-p",
				'Return JSON matching the schema: {"ok": true}',
				"--session-id",
				sid,
				"--model",
				"sonnet",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--json-schema",
				schema,
				"--dangerously-skip-permissions",
			];

			const proc = Bun.spawn(argv, {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
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

			try {
				rmSync(cwd, { recursive: true });
			} catch {
				/* ignore */
			}

			expect(exitCode).toBe(0);

			let structured: unknown;
			for (const line of stdout.split("\n")) {
				const t = line.trim();
				if (!t) continue;
				let rec: Record<string, unknown>;
				try {
					rec = JSON.parse(t) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (rec.type === "result" && rec.is_error !== true) {
					if ("structured_output" in rec) {
						structured = rec.structured_output;
						break;
					}
				}
			}

			expect(structured).toBeDefined();
			expect(structured).toEqual(
				expect.objectContaining({ ok: expect.anything() }),
			);
		},
		{ timeout: 150000 },
	);
});
