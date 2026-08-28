/**
 * Unit tests for invokeAgent invocation-registry wiring.
 *
 * Injects a memory InvocationStore and sample provider. Covers completed
 * registration, cancellationSupported: false, pre-stream fault injection,
 * provider-error → failed, and provider.close() on those paths.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initScaffold } from "../../../src/commands/init.handler.js";
import {
	type InvokeAgentDeps,
	invokeAgent,
} from "../../../src/commands/invoke.handler.js";
import {
	invokeCancel,
	invokeStatus,
} from "../../../src/commands/invoke-registry.handler.js";
import {
	createMemoryInvocationStore,
	type RegisterInvocationInput,
} from "../../../src/control-plane/index.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { CliError } from "../../../src/output.js";
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

const RUN_A = "run_aaaaaaaaaaaa";
const RUN_B = "run_bbbbbbbbbbbb";
const INV_A = "11111111-1111-4111-8111-111111111111";
const INV_B = "22222222-2222-4222-8222-222222222222";

function registerRow(
	store: ReturnType<typeof createMemoryInvocationStore>,
	overrides: Partial<RegisterInvocationInput> = {},
) {
	return store.register({
		id: INV_A,
		runId: RUN_A,
		sessionId: "sess-1",
		role: "author",
		providerName: "sample",
		templateName: "author-next-phase",
		handle: { adapter: "none", ref: "sess-1" },
		cancellationSupported: false,
		...overrides,
	});
}

async function invokeHandler(fn: () => Promise<void>): Promise<{
	ok: boolean;
	error?: CliError;
	data?: Record<string, unknown>;
}> {
	const lines: string[] = [];
	const origLog = console.log;
	console.log = (msg?: unknown) => {
		if (typeof msg === "string") lines.push(msg);
	};
	try {
		await fn();
		const parsed = JSON.parse(lines.join("\n") || "{}") as {
			ok?: boolean;
			data?: Record<string, unknown>;
		};
		return { ok: true, data: parsed.data };
	} catch (err) {
		if (err instanceof CliError) return { ok: false, error: err };
		throw err;
	} finally {
		console.log = origLog;
	}
}

describe("invokeStatus / invokeCancel handlers", () => {
	test("handler source does not import ambient run resolvers or bun:sqlite", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../../src/commands/invoke-registry.handler.ts"),
			"utf-8",
		);
		expect(source).not.toMatch(/from ["'][^"']*run-identity/);
		expect(source).not.toMatch(/from ["']bun:sqlite["']/);
		expect(source).not.toContain("requireAmbientRunId");
		expect(source).not.toContain("resolveAmbientRunId");
		expect(source).not.toMatch(/from ["'][^"']*invoke-registry-context/);
	});

	test("status without --id/--run is INVALID_ARGS even when current-run exists", async () => {
		const store = createMemoryInvocationStore();
		registerRow(store);
		const result = await invokeHandler(() =>
			invokeStatus({}, { store, runExists: () => true }),
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("INVALID_ARGS");
	});

	test("status --run lists snake_case envelopes; unknown run is RUN_NOT_FOUND", async () => {
		const store = createMemoryInvocationStore();
		registerRow(store);
		store.markTerminal(INV_A, "completed");
		const listed = await invokeHandler(() =>
			invokeStatus({ run: RUN_A }, { store, runExists: (id) => id === RUN_A }),
		);
		expect(listed.ok).toBe(true);
		const invocations = listed.data?.invocations as Record<string, unknown>[];
		expect(invocations).toHaveLength(1);
		expect(invocations[0]?.client_state).toBe("completed");
		expect(invocations[0]?.run_id).toBe(RUN_A);
		expect(invocations[0]).not.toHaveProperty("clientState");
		expect(invocations[0]).not.toHaveProperty("runId");
		expect(invocations[0]).not.toHaveProperty("handle");

		const missing = await invokeHandler(() =>
			invokeStatus(
				{ run: "run_missingxxxx" },
				{ store, runExists: (id) => id === RUN_A },
			),
		);
		expect(missing.ok).toBe(false);
		expect(missing.error?.code).toBe("RUN_NOT_FOUND");
	});

	test("status --id returns a single { invocation } envelope with snake_case keys", async () => {
		const store = createMemoryInvocationStore();
		registerRow(store);
		store.markTerminal(INV_A, "completed");
		const result = await invokeHandler(() =>
			invokeStatus({ id: INV_A }, { store, runExists: () => true }),
		);
		expect(result.ok).toBe(true);
		const invocation = result.data?.invocation as Record<string, unknown>;
		expect(invocation.client_state).toBe("completed");
		expect(invocation.run_id).toBe(RUN_A);
		expect(invocation.id).toBe(INV_A);
		expect(result.data).not.toHaveProperty("invocations");
		expect(invocation).not.toHaveProperty("clientState");
		expect(JSON.stringify(invocation)).not.toContain("clientState");
	});

	test("combined --id --run: matching run returns single invocation; mismatch and missing are NOT_FOUND", async () => {
		const store = createMemoryInvocationStore();
		registerRow(store, { id: INV_A, runId: RUN_A });
		registerRow(store, {
			id: INV_B,
			runId: RUN_B,
			handle: { adapter: "none", ref: "sess-b" },
		});
		store.markTerminal(INV_A, "completed");
		const runExists = (id: string) => id === RUN_A || id === RUN_B;

		const match = await invokeHandler(() =>
			invokeStatus({ id: INV_A, run: RUN_A }, { store, runExists }),
		);
		expect(match.ok).toBe(true);
		const invocation = match.data?.invocation as Record<string, unknown>;
		expect(invocation.id).toBe(INV_A);
		expect(invocation.run_id).toBe(RUN_A);
		expect(match.data).not.toHaveProperty("invocations");

		const mismatch = await invokeHandler(() =>
			invokeStatus({ id: INV_A, run: RUN_B }, { store, runExists }),
		);
		expect(mismatch.ok).toBe(false);
		expect(mismatch.error?.code).toBe("INVOCATION_NOT_FOUND");
		expect(mismatch.error?.message).toContain(INV_A);
		expect(mismatch.error?.message).toContain(RUN_B);
		expect(mismatch.data).toBeUndefined();

		const missing = await invokeHandler(() =>
			invokeStatus(
				{ id: "00000000-0000-4000-8000-000000000000", run: RUN_A },
				{ store, runExists },
			),
		);
		expect(missing.ok).toBe(false);
		expect(missing.error?.code).toBe("INVOCATION_NOT_FOUND");
	});

	test("cancel passes actor cli", async () => {
		const store = createMemoryInvocationStore();
		registerRow(store, {
			cancellationSupported: true,
			handle: { adapter: "missing-adapter", ref: "job-1" },
		});
		let seenActor: string | undefined;
		const result = await invokeHandler(() =>
			invokeCancel(
				{ id: INV_A },
				{
					store,
					runExists: () => true,
					requestCancellation: async (opts) => {
						seenActor = opts.actor;
						return {
							ok: true,
							view: {
								id: INV_A,
								runId: RUN_A,
								sessionId: "sess-1",
								role: "author",
								providerName: "sample",
								templateName: "author-next-phase",
								status: "running",
								clientState: "cancellation-requested",
								cancellation: {
									supported: true,
									requested: true,
									requestedBy: "cli",
									outcome: "unsupported",
								},
								createdAt: "2026-08-28 00:00:00",
								updatedAt: "2026-08-28 00:00:00",
								terminalAt: null,
							},
							adapterCalled: false,
						};
					},
				},
			),
		);
		expect(result.ok).toBe(true);
		expect(seenActor).toBe("cli");
		expect(result.data?.adapter_called).toBe(false);
		expect(result.data?.client_state).toBe("cancellation-requested");
	});

	test("cancel without injected action records requestedBy cli", async () => {
		const store = createMemoryInvocationStore();
		registerRow(store, {
			cancellationSupported: true,
			handle: { adapter: "missing-adapter", ref: "job-1" },
		});
		const result = await invokeHandler(() =>
			invokeCancel({ id: INV_A }, { store, runExists: () => true }),
		);
		expect(result.ok).toBe(true);
		expect(store.get(INV_A)?.cancellationRequestedBy).toBe("cli");
		expect(result.data?.adapter_called).toBe(false);
		expect(result.data?.client_state).toBe("cancellation-requested");
		expect(result.data).not.toHaveProperty("clientState");
	});
});
