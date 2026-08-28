/**
 * Unit tests for invokeAgent invocation-registry wiring.
 *
 * Injects a memory InvocationStore and sample provider. Covers completed
 * registration, cancellationSupported: false, pre-stream fault injection,
 * provider-error → failed, and provider.close() on those paths.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initScaffold } from "../../../src/commands/init.handler.js";
import {
	type InvokeAgentDeps,
	invokeAgent,
} from "../../../src/commands/invoke.handler.js";
import { createMemoryInvocationStore } from "../../../src/control-plane/index.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { createProvider } from "../../../src/providers/factory.js";
import type {
	AgentProvider,
	AgentSession,
} from "../../../src/providers/types.js";
import { generateRunId } from "../../../src/run-id.js";
import { setTemplateOverrideDir } from "../../../src/templates/loader.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

function makeProject(): { dir: string; runId: string; planPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "5x-invoke-registry-"));
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);

	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(
		planPath,
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	return { dir, runId: generateRunId(), planPath };
}

async function scaffoldWithSample(
	dir: string,
	runId: string,
	planPath: string,
): Promise<void> {
	await initScaffold({ startDir: dir });
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
	);
	const db = getDb(dir);
	createRunV1(db, { id: runId, planPath });
	closeDb();
	_resetForTest();
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
}

function wrapCloseSpy(innerCreate: typeof createProvider): {
	createProvider: typeof createProvider;
	closed: () => boolean;
} {
	let closed = false;
	const wrapped: typeof createProvider = async (role, config) => {
		const provider = await innerCreate(role, config);
		const orig = provider.close.bind(provider);
		provider.close = async () => {
			closed = true;
			await orig();
		};
		return provider;
	};
	return { createProvider: wrapped, closed: () => closed };
}

async function runInvoke(
	dir: string,
	runId: string,
	planPath: string,
	deps: InvokeAgentDeps,
): Promise<void> {
	const originalLog = console.log;
	console.log = () => {};
	try {
		await invokeAgent(
			"author",
			{
				template: "author-next-phase",
				run: runId,
				vars: [`plan_path=${planPath}`, "phase_number=1", "user_notes=test"],
				quiet: true,
				workdir: dir,
			},
			deps,
		);
	} finally {
		console.log = originalLog;
	}
}

afterEach(() => {
	closeDb();
	_resetForTest();
	setTemplateOverrideDir(null);
});

describe("invokeAgent invocation registry", () => {
	test("successful sample invoke leaves completed with cancellationSupported false", async () => {
		const { dir, runId, planPath } = makeProject();
		try {
			await scaffoldWithSample(dir, runId, planPath);
			const store = createMemoryInvocationStore();
			await runInvoke(dir, runId, planPath, { invocationStore: store });
			const rows = store.list({ runId });
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("completed");
			expect(rows[0]?.cancellationSupported).toBe(false);
			expect(rows[0]?.handle.adapter).toBe("none");
			expect(rows[0]?.handle.ref).toBeTruthy();
			expect(rows[0]?.providerName).toBe("sample");
			expect(rows[0]?.role).toBe("author");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("prepareLogPath throw after session start leaves failed and closes provider", async () => {
		const { dir, runId, planPath } = makeProject();
		try {
			await scaffoldWithSample(dir, runId, planPath);
			const store = createMemoryInvocationStore();
			const spy = wrapCloseSpy(createProvider);
			await expect(
				runInvoke(dir, runId, planPath, {
					invocationStore: store,
					createProvider: spy.createProvider,
					prepareLogPath: () => {
						throw new Error("prepareLogPath exploded");
					},
				}),
			).rejects.toThrow("prepareLogPath exploded");
			const rows = store.list({ runId });
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("failed");
			expect(rows[0]?.status).not.toBe("running");
			expect(spy.closed()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("appendSessionStart throw after session start leaves failed and closes provider", async () => {
		const { dir, runId, planPath } = makeProject();
		try {
			await scaffoldWithSample(dir, runId, planPath);
			const store = createMemoryInvocationStore();
			const spy = wrapCloseSpy(createProvider);
			await expect(
				runInvoke(dir, runId, planPath, {
					invocationStore: store,
					createProvider: spy.createProvider,
					appendSessionStart: () => {
						throw new Error("appendSessionStart exploded");
					},
				}),
			).rejects.toThrow("appendSessionStart exploded");
			const rows = store.list({ runId });
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("failed");
			expect(rows[0]?.status).not.toBe("running");
			expect(spy.closed()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("thrown provider stream error leaves failed and closes provider", async () => {
		const { dir, runId, planPath } = makeProject();
		try {
			await scaffoldWithSample(dir, runId, planPath);
			const store = createMemoryInvocationStore();
			let closed = false;
			const createThrowingProvider: typeof createProvider = async (
				role,
				config,
			) => {
				const provider = await createProvider(role, config);
				const origClose = provider.close.bind(provider);
				provider.close = async () => {
					closed = true;
					await origClose();
				};
				const origStart = provider.startSession.bind(provider);
				provider.startSession = async (opts) => {
					const session = await origStart(opts);
					const failing: AgentSession = {
						id: session.id,
						run: () => Promise.reject(new Error("provider exploded")),
						runStreamed: () => ({
							[Symbol.asyncIterator]() {
								return {
									next() {
										return Promise.reject(new Error("provider exploded"));
									},
								};
							},
						}),
					};
					return failing;
				};
				return provider;
			};
			await expect(
				runInvoke(dir, runId, planPath, {
					invocationStore: store,
					createProvider: createThrowingProvider,
				}),
			).rejects.toThrow("provider exploded");
			const rows = store.list({ runId });
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("failed");
			expect(closed).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("session-start failure does not register and still closes provider", async () => {
		const { dir, runId, planPath } = makeProject();
		try {
			await scaffoldWithSample(dir, runId, planPath);
			const store = createMemoryInvocationStore();
			let closed = false;
			const createFailingProvider: typeof createProvider = async () => {
				const provider: AgentProvider = {
					startSession: async () => {
						throw new Error("session start failed");
					},
					resumeSession: async () => {
						throw new Error("session start failed");
					},
					close: async () => {
						closed = true;
					},
				};
				return provider;
			};
			await expect(
				runInvoke(dir, runId, planPath, {
					invocationStore: store,
					createProvider: createFailingProvider,
				}),
			).rejects.toThrow("session start failed");
			expect(store.list({ runId })).toHaveLength(0);
			expect(closed).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
