/**
 * Integration tests: Claude Code provider with a mock `claude` executable.
 *
 * Exercises dynamic import via createProvider, real Bun.spawn, and NDJSON/JSON
 * fixtures that match the provider mapper expectations.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FiveXConfig } from "../../../src/config.js";
import { createProvider } from "../../../src/providers/factory.js";
import type { AgentEvent } from "../../../src/providers/types.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-claude-mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}
}

/** Bash mock: streams NDJSON for stream-json, single JSON for json output; optional failure path. */
const MOCK_CLAUDE_SH = `#!/usr/bin/env bash
set -euo pipefail
prompt=""
session_id=""
prev=""
streaming=0
has_schema=0
for arg in "$@"; do
  if [[ "$prev" == "-p" ]]; then prompt="$arg"; fi
  if [[ "$prev" == "--session-id" ]] || [[ "$prev" == "--resume" ]]; then session_id="$arg"; fi
  if [[ "$prev" == "--output-format" && "$arg" == "stream-json" ]]; then streaming=1; fi
  if [[ "$prev" == "--json-schema" ]]; then has_schema=1; fi
  prev="$arg"
done
[[ -z "$session_id" ]] && session_id="unknown-session"

if [[ "$prompt" == "__MOCK_CLAUDE_FAIL__" ]]; then
  echo "mock claude failed" >&2
  exit 9
fi

if [[ "$streaming" -eq 1 ]]; then
  echo '{"type":"system","subtype":"init"}'
  echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}'
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_mock","name":"Read","input":{"file_path":"/tmp/x"}}]}}'
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_mock","content":"read ok"}]}}'
  if [[ "$has_schema" -eq 1 ]]; then
    echo '{"type":"result","is_error":false,"result":"final streamed","structured_output":{"mockSchema":true},"session_id":"'"$session_id"'","usage":{"input_tokens":11,"output_tokens":22},"duration_ms":50,"total_cost_usd":0.01}'
  else
    echo '{"type":"result","is_error":false,"result":"final streamed","session_id":"'"$session_id"'","usage":{"input_tokens":11,"output_tokens":22},"duration_ms":50}'
  fi
else
  if [[ "$has_schema" -eq 1 ]]; then
    echo '{"type":"result","is_error":false,"result":"sync body","structured_output":{"sync":1},"session_id":"'"$session_id"'","usage":{"input_tokens":3,"output_tokens":4},"duration_ms":99,"total_cost_usd":0.02}'
  else
    echo '{"type":"result","is_error":false,"result":"sync body","session_id":"'"$session_id"'","usage":{"input_tokens":3,"output_tokens":4},"duration_ms":99}'
  fi
fi
`;

function writeMockClaude(dir: string): string {
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	const path = join(binDir, "mock-claude");
	writeFileSync(path, MOCK_CLAUDE_SH, "utf-8");
	chmodSync(path, 0o755);
	return path;
}

function baseConfig(mockBinary: string): FiveXConfig {
	return {
		author: {
			provider: "claude-code",
			model: "anthropic/claude-sonnet-4-6",
		},
		reviewer: {
			provider: "claude-code",
			model: "anthropic/claude-sonnet-4-6",
		},
		opencode: {},
		"claude-code": {
			claudeBinary: mockBinary,
		},
	} as unknown as FiveXConfig;
}

describe("claude-code provider integration (mock claude binary)", () => {
	test(
		"factory resolves claude-code plugin and full streaming lifecycle",
		async () => {
			const tmp = makeTmpDir();
			try {
				const mockBin = writeMockClaude(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				const provider = await createProvider("author", baseConfig(mockBin));
				const session = await provider.startSession({
					model: "anthropic/claude-sonnet-4-6",
					workingDirectory: cwd,
				});

				const events: AgentEvent[] = [];
				for await (const ev of session.runStreamed("hello")) {
					events.push(ev);
				}

				await provider.close();

				const types = events.map((e) => e.type);
				expect(types).toContain("text");
				expect(types).toContain("tool_start");
				expect(types).toContain("tool_end");
				expect(types).toContain("usage");
				expect(types).toContain("done");

				const textEv = events.find((e) => e.type === "text");
				expect(textEv?.type === "text" && textEv.delta).toContain("Hello");

				const toolStart = events.find((e) => e.type === "tool_start");
				expect(toolStart?.type).toBe("tool_start");
				if (toolStart?.type === "tool_start") {
					expect(toolStart.tool).toBe("Read");
				}

				const done = events.find((e) => e.type === "done");
				expect(done?.type).toBe("done");
				if (done?.type === "done") {
					expect(done.result.text).toContain("final streamed");
					expect(done.result.sessionId).toBe(session.id);
					expect(done.result.tokens).toEqual({ in: 11, out: 22 });
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"runStreamed with outputSchema yields structured_output on done",
		async () => {
			const tmp = makeTmpDir();
			try {
				const mockBin = writeMockClaude(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				const provider = await createProvider("author", baseConfig(mockBin));
				const session = await provider.startSession({
					model: "anthropic/claude-sonnet-4-6",
					workingDirectory: cwd,
				});

				const events: AgentEvent[] = [];
				for await (const ev of session.runStreamed("x", {
					outputSchema: { type: "object" },
				})) {
					events.push(ev);
				}
				await provider.close();

				const done = events.find((e) => e.type === "done");
				expect(done?.type).toBe("done");
				if (done?.type === "done") {
					expect(done.result.structured).toEqual({ mockSchema: true });
				}
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run() returns RunResult from mock JSON",
		async () => {
			const tmp = makeTmpDir();
			try {
				const mockBin = writeMockClaude(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				const provider = await createProvider("author", baseConfig(mockBin));
				const session = await provider.startSession({
					model: "anthropic/claude-sonnet-4-6",
					workingDirectory: cwd,
				});

				const result = await session.run("prompt");
				await provider.close();

				expect(result.text).toBe("sync body");
				expect(result.tokens).toEqual({ in: 3, out: 4 });
				expect(result.durationMs).toBe(99);
				expect(result.sessionId).toBe(session.id);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run() with outputSchema extracts structured",
		async () => {
			const tmp = makeTmpDir();
			try {
				const mockBin = writeMockClaude(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				const provider = await createProvider("author", baseConfig(mockBin));
				const session = await provider.startSession({
					model: "anthropic/claude-sonnet-4-6",
					workingDirectory: cwd,
				});

				const result = await session.run("p", {
					outputSchema: { type: "object" },
				});
				await provider.close();

				expect(result.structured).toEqual({ sync: 1 });
				expect(result.costUsd).toBe(0.02);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"mock exits non-zero: run() throws; runStreamed yields terminal error",
		async () => {
			const tmp = makeTmpDir();
			try {
				const mockBin = writeMockClaude(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				const provider = await createProvider("author", baseConfig(mockBin));
				const session = await provider.startSession({
					model: "anthropic/claude-sonnet-4-6",
					workingDirectory: cwd,
				});

				await expect(session.run("__MOCK_CLAUDE_FAIL__")).rejects.toThrow(
					/exited with code 9/,
				);

				const streamEvents: AgentEvent[] = [];
				for await (const ev of session.runStreamed("__MOCK_CLAUDE_FAIL__")) {
					streamEvents.push(ev);
				}
				expect(streamEvents.some((e) => e.type === "error")).toBe(true);
				const err = streamEvents.find((e) => e.type === "error");
				expect(err?.type).toBe("error");
				if (err?.type === "error") {
					expect(err.message).toContain("without a result line");
				}

				await provider.close();
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);
});
