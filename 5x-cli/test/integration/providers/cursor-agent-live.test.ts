/**
 * Opt-in live probe against the real `agent` CLI (Cursor Agent).
 *
 * Set CURSOR_AGENT_LIVE_TEST=1 and ensure `agent` is on PATH. These probes are
 * registered only in live mode, so the deterministic suite reports no skips.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const LIVE = process.env.CURSOR_AGENT_LIVE_TEST === "1";

function tmpProject(): string {
	const dir = join(
		tmpdir(),
		`5x-cursor-live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function runAgent(
	agent: string,
	args: string[],
	timeoutMs: number,
	cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([agent, ...args], {
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
	const agent = Bun.which("agent");
	if (!agent) {
		throw new Error(
			"CURSOR_AGENT_LIVE_TEST=1 requires the `agent` CLI on PATH.",
		);
	}

	describe("cursor-agent live CLI probe", () => {
		test(
			"help text advertises the production command surface",
			async () => {
				const result = await runAgent(agent, ["--help"], 25_000);
				expect(result.exitCode).toBe(0);
				const text = `${result.stdout}\n${result.stderr}`;
				for (const needle of [
					"--output-format",
					"stream-json",
					"--stream-partial-output",
					"--resume",
					"--workspace",
					"--force",
					"--trust",
					"create-chat",
				]) {
					expect(text).toContain(needle);
				}
			},
			{ timeout: 30000 },
		);

		test(
			"stream-json session emits initialization and a terminal result",
			async () => {
				const cwd = tmpProject();
				try {
					const created = await runAgent(agent, ["create-chat"], 55_000, cwd);
					const sessionId = created.stdout.trim();
					expect(created.exitCode).toBe(0);
					expect(sessionId.length).toBeGreaterThan(0);

					const result = await runAgent(
						agent,
						[
							"-p",
							"--output-format",
							"stream-json",
							"--stream-partial-output",
							"--resume",
							sessionId,
							"--workspace",
							cwd,
							"--force",
							"--trust",
							"Reply with exactly the word: ok",
						],
						120_000,
						cwd,
					);
					expect(result.exitCode).toBe(0);

					let sawSystemInit = false;
					let terminal: Record<string, unknown> | undefined;
					for (const line of result.stdout.split("\n")) {
						const text = line.trim();
						if (!text) continue;
						try {
							const record = JSON.parse(text) as Record<string, unknown>;
							if (record.type === "system" && record.subtype === "init") {
								sawSystemInit = true;
							}
							if (record.type === "result" && record.is_error !== true) {
								terminal = record;
							}
						} catch {
							// Ignore non-NDJSON diagnostic lines from the external CLI.
						}
					}

					expect(sawSystemInit).toBe(true);
					expect(terminal).toBeDefined();
					expect(terminal?.session_id).toBe(sessionId);
				} finally {
					rmSync(cwd, { recursive: true, force: true });
				}
			},
			{ timeout: 180000 },
		);
	});
}
