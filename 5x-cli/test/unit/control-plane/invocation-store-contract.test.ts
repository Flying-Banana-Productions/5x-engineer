import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMemoryInvocationStore,
	createSqliteInvocationStore,
	type InvocationStore,
	InvocationStoreError,
	type RegisterInvocationInput,
} from "../../../src/control-plane/index.js";
import {
	completeRun,
	createRunV1,
	reopenRun,
} from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { parseRunTimestamp } from "../../../src/db/timestamps.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STALE_MS = 15 * 60 * 1000;

interface StoreHarness {
	store: InvocationStore;
	ensureRun: (id: string) => void;
	setRunStatus: (
		id: string,
		status: "active" | "completed" | "aborted",
	) => void;
	removeRun: (id: string) => void;
	cleanup: () => void;
	tmp?: string;
}

function incrementingNow(startIso = "2026-08-28T12:00:00.000Z"): () => string {
	let ticks = 0;
	const start = Date.parse(startIso);
	return () => {
		const ms = start + ticks * 1000;
		ticks++;
		return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
	};
}

function closeOwned(db: Database): void {
	try {
		db.close();
	} catch {
		// already closed
	}
}

function applySqlitePragmas(db: Database, wal: boolean): void {
	if (wal) db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
}

/**
 * Per-test in-memory SQLite. Avoids the process-wide getDb singleton so
 * bun test --concurrent cannot close another test's connection.
 */
function openOwnedMemoryDb(): Database {
	const db = new Database(":memory:");
	applySqlitePragmas(db, false);
	runMigrations(db);
	return db;
}

function openOwnedFileDb(tmp: string): { db: Database; dbPath: string } {
	const dir = join(tmp, ".5x");
	mkdirSync(dir, { recursive: true });
	const dbPath = join(dir, "5x.db");
	const db = new Database(dbPath);
	applySqlitePragmas(db, true);
	runMigrations(db);
	return { db, dbPath };
}

function memoryHarness(): StoreHarness {
	const runs = new Map<string, { status: string }>();
	return {
		store: createMemoryInvocationStore({
			now: incrementingNow(),
			getRun: (runId) => runs.get(runId) ?? null,
		}),
		ensureRun: (id) => {
			if (!runs.has(id)) runs.set(id, { status: "active" });
		},
		setRunStatus: (id, status) => {
			runs.set(id, { status });
		},
		removeRun: (id) => {
			runs.delete(id);
		},
		cleanup: () => {},
	};
}

function sqliteHarness(): StoreHarness {
	const db = openOwnedMemoryDb();
	return {
		store: createSqliteInvocationStore(db),
		ensureRun: (id) => {
			const existing = db
				.query("SELECT id FROM runs WHERE id = ?1")
				.get(id) as { id: string } | null;
			if (!existing) {
				createRunV1(db, { id, planPath: "/plan.md" });
			}
		},
		setRunStatus: (id, status) => {
			if (status === "active") {
				reopenRun(db, id);
			} else {
				completeRun(db, id, status);
			}
		},
		removeRun: (id) => {
			db.exec("PRAGMA foreign_keys=OFF");
			db.query("DELETE FROM runs WHERE id = ?1").run(id);
			db.exec("PRAGMA foreign_keys=ON");
		},
		cleanup: () => {
			closeOwned(db);
		},
	};
}

const backends: Array<{ name: string; setup: () => StoreHarness }> = [
	{ name: "memory", setup: memoryHarness },
	{ name: "sqlite", setup: sqliteHarness },
];

async function withHarness(
	setup: () => StoreHarness,
	fn: (harness: StoreHarness, store: InvocationStore) => void | Promise<void>,
): Promise<void> {
	const harness = setup();
	try {
		await fn(harness, harness.store);
	} finally {
		harness.cleanup();
	}
}

async function withSharedSqliteFile(
	prefix: string,
	fn: (opts: {
		store1: InvocationStore;
		store2: InvocationStore;
		db: Database;
		db2: Database;
	}) => void | Promise<void>,
): Promise<void> {
	const tmp = mkdtempSync(join(tmpdir(), prefix));
	const { db, dbPath } = openOwnedFileDb(tmp);
	const db2 = new Database(dbPath);
	applySqlitePragmas(db2, false);
	try {
		await fn({
			store1: createSqliteInvocationStore(db),
			store2: createSqliteInvocationStore(db2),
			db,
			db2,
		});
	} finally {
		closeOwned(db2);
		closeOwned(db);
		rmSync(tmp, { recursive: true, force: true });
	}
}

function registerInput(
	runId: string,
	overrides: Partial<RegisterInvocationInput> = {},
): RegisterInvocationInput {
	return {
		runId,
		sessionId: "sess-1",
		role: "author",
		providerName: "sample",
		templateName: "author-next-phase",
		handle: { adapter: "test-remote", ref: "job-abc" },
		cancellationSupported: true,
		...overrides,
	};
}

function registerRunning(
	harness: StoreHarness,
	overrides: Partial<RegisterInvocationInput> = {},
): ReturnType<InvocationStore["register"]> {
	const runId = overrides.runId ?? "run_aaa";
	harness.ensureRun(runId);
	return harness.store.register(registerInput(runId, overrides));
}

async function heartbeatUntilBumped(
	store: InvocationStore,
	id: string,
	previous: string,
): Promise<string> {
	const start = Date.now();
	let last = store.heartbeat(id);
	if (last.updatedAt !== previous) return last.updatedAt;
	while (Date.now() - start < 2500) {
		await Bun.sleep(50);
		last = store.heartbeat(id);
		if (last.updatedAt !== previous) return last.updatedAt;
	}
	throw new Error(`updatedAt did not change from ${previous}`);
}

function expectNotFound(fn: () => unknown): void {
	expect(fn).toThrow(InvocationStoreError);
	try {
		fn();
	} catch (err) {
		expect(err).toBeInstanceOf(InvocationStoreError);
		expect((err as InvocationStoreError).code).toBe("INVOCATION_NOT_FOUND");
	}
}

for (const backend of backends) {
	describe(`InvocationStore contract (${backend.name})`, () => {
		test("register then get round-trips UUID, runId, handle, cancellationSupported, running, null cancel fields", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const created = registerRunning(harness);

				expect(created.id).toMatch(UUID_RE);
				expect(created.runId).toBe("run_aaa");
				expect(created.sessionId).toBe("sess-1");
				expect(created.role).toBe("author");
				expect(created.providerName).toBe("sample");
				expect(created.templateName).toBe("author-next-phase");
				expect(created.handle).toEqual({
					adapter: "test-remote",
					ref: "job-abc",
				});
				expect(created.handle).not.toHaveProperty("pid");
				expect(JSON.stringify(created.handle)).not.toContain("pid");
				expect(created.cancellationSupported).toBe(true);
				expect(created.status).toBe("running");
				expect(created.cancellationRequestedAt).toBeNull();
				expect(created.cancellationRequestedBy).toBeNull();
				expect(created.cancellationOutcome).toBeNull();
				expect(created.cancellationOutcomeAt).toBeNull();
				expect(created.terminalAt).toBeNull();
				expect(created.abandonReason).toBeNull();
				expect(created.createdAt.length).toBeGreaterThan(0);
				expect(created.updatedAt.length).toBeGreaterThan(0);

				const loaded = store.get(created.id);
				expect(loaded).not.toBeNull();
				expect(loaded).toEqual(created);
			});
		});

		test("register rejects handle missing adapter or ref", async () => {
			await withHarness(backend.setup, (harness, store) => {
				harness.ensureRun("run_aaa");
				expect(() =>
					store.register(
						registerInput("run_aaa", {
							handle: { adapter: "", ref: "job-1" },
						}),
					),
				).toThrow(InvocationStoreError);
				expect(() =>
					store.register(
						registerInput("run_aaa", {
							handle: { adapter: "test-remote", ref: "" },
						}),
					),
				).toThrow(InvocationStoreError);
			});
		});

		test("list({ runId }) filters; other runs excluded", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const a = registerRunning(harness, { runId: "run_aaa" });
				const b = registerRunning(harness, {
					runId: "run_bbb",
					handle: { adapter: "test-remote", ref: "job-bbb" },
				});

				const onlyA = store.list({ runId: "run_aaa" });
				expect(onlyA.map((r) => r.id)).toEqual([a.id]);
				expect(onlyA.some((r) => r.id === b.id)).toBe(false);

				const onlyB = store.list({ runId: "run_bbb" });
				expect(onlyB.map((r) => r.id)).toEqual([b.id]);

				const running = store.list({ status: "running" });
				expect(running.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
			});
		});

		test("heartbeat bumps updatedAt while running; no-op after terminal", async () => {
			await withHarness(backend.setup, async (harness, store) => {
				const created = registerRunning(harness);
				const bumped = await heartbeatUntilBumped(
					store,
					created.id,
					created.updatedAt,
				);
				expect(bumped).not.toBe(created.updatedAt);
				expect(store.get(created.id)?.status).toBe("running");

				const completed = store.markTerminal(created.id, "completed");
				expect(completed.ok).toBe(true);
				const afterTerminal = store.heartbeat(created.id);
				expect(afterTerminal.status).toBe("completed");
				expect(afterTerminal.updatedAt).toBe(completed.invocation.updatedAt);
				expect(afterTerminal.terminalAt).toBe(completed.invocation.terminalAt);
			});
		});

		test("second markCancellationRequested returns ok:false with the winner's requestedBy", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const created = registerRunning(harness);
				const first = store.markCancellationRequested(created.id, "cli");
				expect(first.ok).toBe(true);
				expect(first.invocation.cancellationRequestedBy).toBe("cli");
				expect(first.invocation.cancellationRequestedAt).not.toBeNull();

				const second = store.markCancellationRequested(
					created.id,
					"control-plane",
				);
				expect(second.ok).toBe(false);
				expect(second.invocation.cancellationRequestedBy).toBe("cli");
				expect(second.invocation.cancellationRequestedAt).toBe(
					first.invocation.cancellationRequestedAt,
				);
			});
		});

		test("request against cancellationSupported:false is CAS miss; requested_at stays null", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const created = registerRunning(harness, {
					cancellationSupported: false,
				});
				const result = store.markCancellationRequested(created.id, "cli");
				expect(result.ok).toBe(false);
				expect(result.invocation.cancellationRequestedAt).toBeNull();
				expect(result.invocation.cancellationRequestedBy).toBeNull();
				expect(result.invocation.cancellationSupported).toBe(false);
				expect(store.get(created.id)?.cancellationRequestedAt).toBeNull();
			});
		});

		test("markTerminal('completed') then markTerminal('failed') → second ok:false, status stays completed", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const created = registerRunning(harness);
				const first = store.markTerminal(created.id, "completed");
				expect(first.ok).toBe(true);
				expect(first.invocation.status).toBe("completed");
				expect(first.invocation.terminalAt).not.toBeNull();

				const second = store.markTerminal(created.id, "failed");
				expect(second.ok).toBe(false);
				expect(second.invocation.status).toBe("completed");
				expect(store.get(created.id)?.status).toBe("completed");
			});
		});

		test("markAbandoned on running succeeds; on completed fails", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const running = registerRunning(harness);
				const abandoned = store.markAbandoned(running.id, "stale-metadata");
				expect(abandoned.ok).toBe(true);
				expect(abandoned.invocation.status).toBe("abandoned");
				expect(abandoned.invocation.abandonReason).toBe("stale-metadata");
				expect(abandoned.invocation.terminalAt).not.toBeNull();

				const toComplete = registerRunning(harness, {
					runId: "run_bbb",
					handle: { adapter: "test-remote", ref: "job-2" },
				});
				expect(store.markTerminal(toComplete.id, "completed").ok).toBe(true);
				const afterComplete = store.markAbandoned(
					toComplete.id,
					"stale-metadata",
				);
				expect(afterComplete.ok).toBe(false);
				expect(afterComplete.invocation.status).toBe("completed");
				expect(afterComplete.invocation.abandonReason).toBeNull();
			});
		});

		test("markAbandonedIfStale heartbeat: matching expectedUpdatedAt succeeds; mismatched timestamp stays running", async () => {
			await withHarness(backend.setup, async (harness, store) => {
				const match = registerRunning(harness);
				const hit = store.markAbandonedIfStale({
					id: match.id,
					reason: "stale-metadata",
					expectedUpdatedAt: match.updatedAt,
					staleReason: "heartbeat",
				});
				expect(hit.ok).toBe(true);
				expect(hit.invocation.status).toBe("abandoned");

				const live = registerRunning(harness, {
					runId: "run_bbb",
					handle: { adapter: "test-remote", ref: "job-live" },
				});
				const observed = live.updatedAt;
				await heartbeatUntilBumped(store, live.id, observed);
				const miss = store.markAbandonedIfStale({
					id: live.id,
					reason: "stale-metadata",
					expectedUpdatedAt: observed,
					staleReason: "heartbeat",
				});
				expect(miss.ok).toBe(false);
				expect(miss.invocation.status).toBe("running");
				expect(store.get(live.id)?.status).toBe("running");
			});
		});

		test("markAbandonedIfStale run-terminal: aborted/completed/missing succeed; active stays running", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const aborted = registerRunning(harness, { runId: "run_aborted" });
				harness.setRunStatus("run_aborted", "aborted");
				const abortCas = store.markAbandonedIfStale({
					id: aborted.id,
					reason: "stale-metadata",
					expectedUpdatedAt: aborted.updatedAt,
					staleReason: "run-terminal",
				});
				expect(abortCas.ok).toBe(true);
				expect(abortCas.invocation.status).toBe("abandoned");

				const completed = registerRunning(harness, {
					runId: "run_completed",
					handle: { adapter: "test-remote", ref: "job-completed" },
				});
				harness.setRunStatus("run_completed", "completed");
				const completeCas = store.markAbandonedIfStale({
					id: completed.id,
					reason: "stale-metadata",
					expectedUpdatedAt: completed.updatedAt,
					staleReason: "run-terminal",
				});
				expect(completeCas.ok).toBe(true);
				expect(completeCas.invocation.status).toBe("abandoned");

				const missing = registerRunning(harness, {
					runId: "run_missing",
					handle: { adapter: "test-remote", ref: "job-missing" },
				});
				harness.removeRun("run_missing");
				const missingCas = store.markAbandonedIfStale({
					id: missing.id,
					reason: "stale-metadata",
					expectedUpdatedAt: missing.updatedAt,
					staleReason: "run-terminal",
				});
				expect(missingCas.ok).toBe(true);
				expect(missingCas.invocation.status).toBe("abandoned");

				const active = registerRunning(harness, {
					runId: "run_active",
					handle: { adapter: "test-remote", ref: "job-active" },
				});
				harness.setRunStatus("run_active", "active");
				const activeCas = store.markAbandonedIfStale({
					id: active.id,
					reason: "stale-metadata",
					expectedUpdatedAt: active.updatedAt,
					staleReason: "run-terminal",
				});
				expect(activeCas.ok).toBe(false);
				expect(activeCas.invocation.status).toBe("running");
				expect(store.get(active.id)?.status).toBe("running");
			});
		});

		test("two-writer heartbeat: competing heartbeat then markAbandonedIfStale does not abandon", async () => {
			await withHarness(backend.setup, async (harness, store) => {
				const created = registerRunning(harness);
				const observed = created.updatedAt;
				await heartbeatUntilBumped(store, created.id, observed);
				const cas = store.markAbandonedIfStale({
					id: created.id,
					reason: "stale-metadata",
					expectedUpdatedAt: observed,
					staleReason: "heartbeat",
				});
				expect(cas.ok).toBe(false);
				expect(cas.invocation.status).toBe("running");
				expect(store.get(created.id)?.status).toBe("running");
			});
		});

		test("two-writer run reopen: competing reopen then markAbandonedIfStale does not abandon", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const created = registerRunning(harness, { runId: "run_reopen" });
				harness.setRunStatus("run_reopen", "aborted");
				harness.setRunStatus("run_reopen", "active");
				const cas = store.markAbandonedIfStale({
					id: created.id,
					reason: "stale-metadata",
					expectedUpdatedAt: created.updatedAt,
					staleReason: "run-terminal",
				});
				expect(cas.ok).toBe(false);
				expect(cas.invocation.status).toBe("running");
				expect(store.get(created.id)?.status).toBe("running");
			});
		});

		test("listStale with injected nowMs: fresh excluded; old included; completed excluded", async () => {
			await withHarness(backend.setup, (harness, store) => {
				const fresh = registerRunning(harness);
				const old = registerRunning(harness, {
					runId: "run_bbb",
					handle: { adapter: "test-remote", ref: "job-old" },
				});
				const done = registerRunning(harness, {
					runId: "run_ccc",
					handle: { adapter: "test-remote", ref: "job-done" },
				});
				expect(store.markTerminal(done.id, "completed").ok).toBe(true);

				const freshMs = parseRunTimestamp(fresh.updatedAt);
				expect(
					store
						.listStale({ olderThanMs: STALE_MS, nowMs: freshMs + 1000 })
						.map((r) => r.id),
				).toEqual([]);

				const oldMs = parseRunTimestamp(old.updatedAt);
				const stale = store.listStale({
					olderThanMs: STALE_MS,
					nowMs: oldMs + STALE_MS,
				});
				expect(stale.map((r) => r.id).sort()).toEqual(
					[fresh.id, old.id].sort(),
				);
				expect(stale.some((r) => r.id === done.id)).toBe(false);
			});
		});

		test("missing id throws INVOCATION_NOT_FOUND", async () => {
			await withHarness(backend.setup, (_harness, store) => {
				expect(store.get("missing")).toBeNull();
				expectNotFound(() => store.heartbeat("missing"));
				expectNotFound(() => store.markCancellationRequested("missing", "cli"));
				expectNotFound(() =>
					store.recordCancellationOutcome("missing", "failed"),
				);
				expectNotFound(() => store.markTerminal("missing", "failed"));
				expectNotFound(() => store.markAbandoned("missing", "stale-metadata"));
				expectNotFound(() =>
					store.markAbandonedIfStale({
						id: "missing",
						reason: "stale-metadata",
						expectedUpdatedAt: "2026-08-28 12:00:00",
						staleReason: "heartbeat",
					}),
				);
			});
		});
	});
}

describe("SqliteInvocationStore shared-file CAS", () => {
	test("two connections: exactly one markCancellationRequested winner", async () => {
		await withSharedSqliteFile(
			"5x-invocation-cas-",
			async ({ store1, store2, db }) => {
				createRunV1(db, { id: "run_aaa", planPath: "/plan.md" });
				const created = store1.register(registerInput("run_aaa"));

				const [a, b] = await Promise.all([
					Promise.resolve(store1.markCancellationRequested(created.id, "cli")),
					Promise.resolve(
						store2.markCancellationRequested(created.id, "control-plane"),
					),
				]);

				expect([a, b].filter((r) => r.ok)).toHaveLength(1);
				expect([a, b].filter((r) => !r.ok)).toHaveLength(1);
				expect(a.invocation.cancellationRequestedBy).toBe(
					b.invocation.cancellationRequestedBy,
				);
				const winner = [a, b].find((r) => r.ok);
				expect(
					winner?.invocation.cancellationRequestedBy === "cli" ||
						winner?.invocation.cancellationRequestedBy === "control-plane",
				).toBe(true);
				expect(store1.get(created.id)?.cancellationRequestedBy).toBe(
					store2.get(created.id)?.cancellationRequestedBy,
				);
			},
		);
	});

	test("two-writer heartbeat: second connection bumps updated_at; first CAS loses", async () => {
		await withSharedSqliteFile(
			"5x-invocation-hb-cas-",
			async ({ store1, store2, db }) => {
				createRunV1(db, { id: "run_aaa", planPath: "/plan.md" });
				const created = store1.register(registerInput("run_aaa"));
				const observed = created.updatedAt;
				await heartbeatUntilBumped(store2, created.id, observed);

				const cas = store1.markAbandonedIfStale({
					id: created.id,
					reason: "stale-metadata",
					expectedUpdatedAt: observed,
					staleReason: "heartbeat",
				});
				expect(cas.ok).toBe(false);
				expect(cas.invocation.status).toBe("running");
				expect(store1.get(created.id)?.status).toBe("running");
				expect(store2.get(created.id)?.status).toBe("running");
			},
		);
	});

	test("two-writer run reopen: second connection reopens run; first CAS loses", async () => {
		await withSharedSqliteFile(
			"5x-invocation-reopen-cas-",
			({ store1, db, db2 }) => {
				createRunV1(db, { id: "run_aaa", planPath: "/plan.md" });
				const created = store1.register(registerInput("run_aaa"));
				completeRun(db, "run_aaa", "aborted");
				reopenRun(db2, "run_aaa");

				const cas = store1.markAbandonedIfStale({
					id: created.id,
					reason: "stale-metadata",
					expectedUpdatedAt: created.updatedAt,
					staleReason: "run-terminal",
				});
				expect(cas.ok).toBe(false);
				expect(cas.invocation.status).toBe("running");
				expect(store1.get(created.id)?.status).toBe("running");
			},
		);
	});
});
