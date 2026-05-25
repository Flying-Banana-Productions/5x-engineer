/**
 * Integration tests: Cursor Agent provider with a mock `agent` executable on PATH.
 *
 * Exercises dynamic import via createProvider, real Bun.spawn, and stream-json
 * NDJSON fixtures aligned with the Cursor Agent event mapper.
 */

import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FiveXConfig } from "../../../src/config.js";
import { AuthorStatusSchema } from "../../../src/protocol.js";
import { createProvider } from "../../../src/providers/factory.js";
import type { AgentEvent } from "../../../src/providers/types.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const MOCK_SESSION = "mock-cursor-session-001";
/** Escaped JSON text emitted by the mock for AuthorStatus structured-output tests. */
const MOCK_AUTHOR_STATUS_JSON =
	'{\\"result\\":\\"complete\\",\\"commit\\":\\"abc123def\\",\\"notes\\":\\"mock author done\\"}';

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-cursor-mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/** Emit bash `${...}` expansion without TypeScript template interpolation. */
function bash(exp: string): string {
	return `\${${exp}}`;
}

/** Bash mock: create-chat, stream-json NDJSON runs, optional trace file via MOCK_AGENT_TRACE. */
const MOCK_AGENT_SH = `#!/usr/bin/env bash
set -euo pipefail

trace() {
  if [[ -n "${bash("MOCK_AGENT_TRACE:-")}" ]]; then
    echo "$*" >> "${bash("MOCK_AGENT_TRACE")}"
  fi
}

trace "INVOCATION args=$*"
trace "CURSOR_API_KEY=${bash("CURSOR_API_KEY:-")}"
trace "CURSOR_AUTH_TOKEN=${bash("CURSOR_AUTH_TOKEN:-")}"

if [[ "$1" == "create-chat" ]]; then
  if [[ "${bash("MOCK_CREATE_CHAT_FAIL:-")}" == "1" ]]; then
    echo "mock create-chat auth failure" >&2
    exit 7
  fi
  echo "${MOCK_SESSION}"
  exit 0
fi

prompt=""
session_id=""
prev=""
streaming=0
has_schema=0
for arg in "$@"; do
  if [[ "$prev" == "--resume" ]]; then session_id="$arg"; fi
  if [[ "$prev" == "--output-format" && "$arg" == "stream-json" ]]; then streaming=1; fi
  prev="$arg"
done
prompt="${bash("!#")}"
if [[ "$prompt" == *"FINAL RESPONSE REQUIREMENTS"* ]]; then has_schema=1; fi
[[ -z "$session_id" ]] && session_id="unknown-session"

if [[ "$prompt" == "__MOCK_CURSOR_FAIL__" ]]; then
  echo "mock cursor agent failed" >&2
  exit 9
fi

if [[ "$prompt" == "__MOCK_CURSOR_DELAY__" ]]; then
  sleep 3
fi

if [[ "$streaming" -eq 1 ]]; then
  echo '{"type":"system","subtype":"init","session_id":"'"$session_id"'","model":"mock-model"}'
  echo '{"type":"assistant","timestamp_ms":1,"message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"'"$session_id"'"}'
  echo '{"type":"tool_call","subtype":"started","call_id":"toolu_read","tool_call":{"readToolCall":{"args":{"path":"README.md"}}},"session_id":"'"$session_id"'"}'
  echo '{"type":"tool_call","subtype":"completed","call_id":"toolu_read","tool_call":{"readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"# Mock"}}}},"session_id":"'"$session_id"'"}'
  if [[ "$has_schema" -eq 1 ]]; then
    echo '{"type":"assistant","timestamp_ms":2,"message":{"role":"assistant","content":[{"type":"text","text":"${MOCK_AUTHOR_STATUS_JSON}"}]},"session_id":"'"$session_id"'"}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"${MOCK_AUTHOR_STATUS_JSON}","session_id":"'"$session_id"'","duration_ms":50}'
  else
    echo '{"type":"result","subtype":"success","is_error":false,"result":"final streamed","session_id":"'"$session_id"'","duration_ms":50}'
  fi
else
  echo '{"type":"result","subtype":"success","is_error":false,"result":"sync body","session_id":"'"$session_id"'","duration_ms":99}'
fi
`;

function writeMockAgent(dir: string): { binDir: string; agentPath: string } {
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	const agentPath = join(binDir, "agent");
	writeFileSync(agentPath, MOCK_AGENT_SH, "utf-8");
	chmodSync(agentPath, 0o755);
	return { binDir, agentPath };
}

function withMockPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
	const prevPath = process.env.PATH;
	process.env.PATH = `${binDir}:${prevPath ?? ""}`;
	return fn().finally(() => {
		if (prevPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = prevPath;
		}
	});
}

function baseConfig(overrides: Record<string, unknown> = {}): FiveXConfig {
	return {
		author: {
			provider: "cursor-agent",
			model: "gpt-5",
		},
		reviewer: {
			provider: "cursor-agent",
			model: "gpt-5",
		},
		opencode: {},
		"cursor-agent": {
			agentBinary: "agent",
			...overrides,
		},
	} as unknown as FiveXConfig;
}

describe("cursor-agent provider integration (mock agent binary)", () => {
	test(
		"factory resolves cursor-agent plugin and full streaming lifecycle",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { binDir } = writeMockAgent(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				await withMockPath(binDir, async () => {
					const mod = await import("@5x-ai/provider-cursor-agent");
					expect(mod.default.name).toBe("cursor-agent");

					const provider = await createProvider("author", baseConfig());
					const session = await provider.startSession({
						model: "gpt-5",
						workingDirectory: cwd,
					});

					expect(session.id).toBe(MOCK_SESSION);

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
						expect(toolStart.tool).toBe("read");
					}

					const done = events.find((e) => e.type === "done");
					expect(done?.type).toBe("done");
					if (done?.type === "done") {
						expect(done.result.text).toContain("final streamed");
						expect(done.result.sessionId).toBe(session.id);
						expect(done.result.tokens).toEqual({ in: 0, out: 0 });
					}
				});
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"runStreamed with AuthorStatus outputSchema extracts structured from final assistant JSON",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { binDir } = writeMockAgent(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				await withMockPath(binDir, async () => {
					const provider = await createProvider("author", baseConfig());
					const session = await provider.startSession({
						model: "gpt-5",
						workingDirectory: cwd,
					});

					const events: AgentEvent[] = [];
					for await (const ev of session.runStreamed("implement phase", {
						outputSchema: AuthorStatusSchema,
					})) {
						events.push(ev);
					}
					await provider.close();

					const done = events.find((e) => e.type === "done");
					expect(done?.type).toBe("done");
					if (done?.type === "done") {
						expect(done.result.structured).toEqual({
							result: "complete",
							commit: "abc123def",
							notes: "mock author done",
						});
					}
				});
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"resumeSession(existingId) passes --resume without create-chat",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { binDir } = writeMockAgent(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });
				const tracePath = join(tmp, "trace.log");
				process.env.MOCK_AGENT_TRACE = tracePath;

				await withMockPath(binDir, async () => {
					const provider = await createProvider("author", baseConfig());
					const session = await provider.resumeSession("existing-resume-id", {
						model: "gpt-5",
						workingDirectory: cwd,
					});
					expect(session.id).toBe("existing-resume-id");

					for await (const _ev of session.runStreamed("continue")) {
						/* drain */
					}
					await provider.close();
				});

				const trace = readFileSync(tracePath, "utf-8");
				expect(trace).toContain("--resume");
				expect(trace).toContain("existing-resume-id");
				expect(trace).not.toContain("create-chat");
			} finally {
				delete process.env.MOCK_AGENT_TRACE;
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"configured apiKey is forwarded via CURSOR_API_KEY env, not argv",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { binDir } = writeMockAgent(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });
				const tracePath = join(tmp, "trace.log");
				const secret = "cursor-test-api-key-secret";
				process.env.MOCK_AGENT_TRACE = tracePath;

				await withMockPath(binDir, async () => {
					const provider = await createProvider(
						"author",
						baseConfig({ apiKey: secret }),
					);
					const session = await provider.startSession({
						model: "gpt-5",
						workingDirectory: cwd,
					});
					await session.run("hello");
					await provider.close();
				});

				const trace = readFileSync(tracePath, "utf-8");
				expect(trace).toContain(`CURSOR_API_KEY=${secret}`);
				const invocationLines = trace
					.split("\n")
					.filter((line) => line.startsWith("INVOCATION args="));
				for (const line of invocationLines) {
					expect(line).not.toContain(secret);
				}
			} finally {
				delete process.env.MOCK_AGENT_TRACE;
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
				const { binDir } = writeMockAgent(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				await withMockPath(binDir, async () => {
					const provider = await createProvider("author", baseConfig());
					const session = await provider.startSession({
						model: "gpt-5",
						workingDirectory: cwd,
					});

					await expect(session.run("__MOCK_CURSOR_FAIL__")).rejects.toThrow(
						/exited with code 9/,
					);

					const streamEvents: AgentEvent[] = [];
					for await (const ev of session.runStreamed("__MOCK_CURSOR_FAIL__")) {
						streamEvents.push(ev);
					}
					expect(streamEvents.some((e) => e.type === "error")).toBe(true);

					await provider.close();
				});
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"binary not found surfaces install hint",
		async () => {
			const tmp = makeTmpDir();
			try {
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				const provider = await createProvider(
					"author",
					baseConfig({ agentBinary: "missing-cursor-agent-xyz" }),
				);
				await expect(
					provider.startSession({
						model: "gpt-5",
						workingDirectory: cwd,
					}),
				).rejects.toThrow(/Could not find Cursor Agent CLI binary/);
				await provider.close();
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"create-chat auth failure surfaces clear error message",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { binDir } = writeMockAgent(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });
				process.env.MOCK_CREATE_CHAT_FAIL = "1";

				await withMockPath(binDir, async () => {
					const provider = await createProvider("author", baseConfig());
					await expect(
						provider.startSession({
							model: "gpt-5",
							workingDirectory: cwd,
						}),
					).rejects.toThrow(/create-chat exited with code 7/);
					await provider.close();
				});
			} finally {
				delete process.env.MOCK_CREATE_CHAT_FAIL;
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run() returns RunResult from mock stream-json",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { binDir } = writeMockAgent(tmp);
				const cwd = join(tmp, "proj");
				mkdirSync(cwd, { recursive: true });

				await withMockPath(binDir, async () => {
					const provider = await createProvider("author", baseConfig());
					const session = await provider.startSession({
						model: "gpt-5",
						workingDirectory: cwd,
					});

					const result = await session.run("prompt");
					await provider.close();

					expect(result.text).toContain("final streamed");
					expect(result.tokens).toEqual({ in: 0, out: 0 });
					expect(result.durationMs).toBe(50);
					expect(result.sessionId).toBe(session.id);
				});
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"direct spawn helper uses stdin ignore and cleanGitEnv",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { binDir, agentPath } = writeMockAgent(tmp);
				const proc = Bun.spawn([agentPath, "create-chat"], {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...cleanGitEnv(),
						PATH: `${binDir}:${process.env.PATH ?? ""}`,
					},
				});
				const code = await proc.exited;
				const out = await new Response(proc.stdout).text();
				expect(code).toBe(0);
				expect(out.trim()).toBe(MOCK_SESSION);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});
