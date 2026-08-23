/**
 * Opt-in live probe against the real `claude` CLI (Claude Code).
 *
 * Set CLAUDE_LIVE_TEST=1 and ensure `claude` is on PATH. These probes are
 * registered only in live mode, so the deterministic suite reports no skips.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const LIVE = process.env.CLAUDE_LIVE_TEST === "1";

function tmpProject(): string {
	const dir = join(
		tmpdir(),
		`5x-claude-live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function runClaude(
	claude: string,
	args: string[],
	timeoutMs: number,
	cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([claude, ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: cleanGitEnv(),
	});
	const killTimer = setTimeout(() => proc.kill(15), timeoutMs);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(killTimer);
	}
}

if (LIVE) {
	const claude = Bun.which("claude");
	if (!claude) {
		throw new Error("CLAUDE_LIVE_TEST=1 requires the `claude` CLI on PATH.");
	}

	describe("claude-code live CLI probe", () => {
		test(
			"help text advertises the production command surface",
			async () => {
				const result = await runClaude(claude, ["--help"], 25_000);
				expect(result.exitCode).toBe(0);
				const text = `${result.stdout}\n${result.stderr}`;
				for (const needle of [
					"stream-json",
					"include-partial-messages",
					"json-schema",
					"--resume",
					"--session-id",
					"--dangerously-skip-permissions",
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

		test(
			"streamed schema run emits usage and structured output",
			async () => {
				const cwd = tmpProject();
				try {
					const schema = JSON.stringify({
						type: "object",
						properties: { ok: { type: "boolean" } },
						required: ["ok"],
					});
					const result = await runClaude(
						claude,
						[
							"-p",
							'Return JSON matching the schema: {"ok": true}',
							"--session-id",
							randomUUID(),
							"--model",
							"sonnet",
							"--output-format",
							"stream-json",
							"--verbose",
							"--include-partial-messages",
							"--json-schema",
							schema,
							"--dangerously-skip-permissions",
						],
						120_000,
						cwd,
					);
					expect(result.exitCode).toBe(0);

					let sawStream = false;
					let terminal: Record<string, unknown> | undefined;
					for (const line of result.stdout.split("\n")) {
						const text = line.trim();
						if (!text) continue;
						try {
							const record = JSON.parse(text) as Record<string, unknown>;
							if (record.type === "stream_event") sawStream = true;
							if (record.type === "result" && record.is_error !== true) {
								terminal = record;
							}
						} catch {
							// Ignore non-NDJSON diagnostic lines from the external CLI.
						}
					}

					expect(sawStream).toBe(true);
					expect(terminal).toBeDefined();
					const usage = terminal?.usage as Record<string, unknown> | undefined;
					expect(usage).toBeDefined();
					expect(
						typeof usage?.input_tokens === "number" ||
							typeof usage?.input === "number",
					).toBe(true);
					expect(
						typeof usage?.output_tokens === "number" ||
							typeof usage?.output === "number",
					).toBe(true);
					expect(terminal?.structured_output).toEqual(
						expect.objectContaining({ ok: expect.anything() }),
					);
				} finally {
					rmSync(cwd, { recursive: true, force: true });
				}
			},
			{ timeout: 180000 },
		);
	});
}
