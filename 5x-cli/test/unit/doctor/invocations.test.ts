/**
 * Unit tests for the stale-invocation doctor check.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	_resetCancellationAdaptersForTest,
	createSqliteInvocationStore,
	createTestRemoteAdapter,
	type InvocationStore,
	registerCancellationAdapter,
} from "../../../src/control-plane/index.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import {
	completeRun,
	createRunV1,
	reopenRun,
} from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { parseRunTimestamp } from "../../../src/db/timestamps.js";
import {
	createInvocationsCheck,
	INVOCATION_STALE_MS,
	invocationsCheck,
} from "../../../src/doctor/checks/invocations.js";
import { findingKey } from "../../../src/doctor/registry.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../../../src/doctor/types.js";

function makeTmp(): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-invocations-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function doctorCtx(projectRoot: string, now?: number): DoctorCheckContext {
	return {
		startDir: projectRoot,
		projectRoot,
		stateDir: ".5x",
		dbPath: resolve(projectRoot, ".5x", "5x.db"),
		dbRelPath: join(".5x", "5x.db"),
		now,
	};
}

function registerInput(runId: string, overrides: Record<string, unknown> = {}) {
	return {
		runId,
		sessionId: "sess-1",
		role: "author" as const,
		providerName: "sample",
		templateName: "author",
		handle: { adapter: "none", ref: "sess-1" },
		cancellationSupported: false,
		...overrides,
	};
}

function seed(
	projectRoot: string,
	fn: (store: InvocationStore, db: ReturnType<typeof getDb>) => void,
): void {
	const db = getDb(projectRoot);
	runMigrations(db);
	fn(createSqliteInvocationStore(db), db);
	closeDb();
	_resetForTest();
}

function backdateUpdatedAt(
	projectRoot: string,
	id: string,
	msAgo: number,
): string {
	const stamp = new Date(Date.now() - msAgo)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);
	const db = getDb(projectRoot);
	db.query("UPDATE invocations SET updated_at = ?1 WHERE id = ?2").run(
		stamp,
		id,
	);
	closeDb();
	_resetForTest();
	return stamp;
}

function invocationIdOf(
	finding: DoctorFinding | undefined,
): string | undefined {
	if (!finding?.detail || typeof finding.detail !== "object") return undefined;
	const invocationId = (finding.detail as { invocationId?: unknown })
		.invocationId;
	return typeof invocationId === "string" ? invocationId : undefined;
}

function reasonOf(finding: DoctorFinding | undefined): string | undefined {
	if (!finding?.detail || typeof finding.detail !== "object") return undefined;
	const reason = (finding.detail as { reason?: unknown }).reason;
	return typeof reason === "string" ? reason : undefined;
}

async function applyFix(
	check: DoctorCheck,
	finding: DoctorFinding | undefined,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (!check.fix) throw new Error("expected check.fix");
	if (!finding) throw new Error("expected finding");
	return check.fix(finding, ctx);
}

function wrapStore(
	inner: InvocationStore,
	beforeAbandon: (store: InvocationStore) => void,
): InvocationStore {
	return {
		register: (input) => inner.register(input),
		get: (id) => inner.get(id),
		list: (filter) => inner.list(filter),
		heartbeat: (id) => inner.heartbeat(id),
		markCancellationRequested: (id, actor) =>
			inner.markCancellationRequested(id, actor),
		recordCancellationOutcome: (id, outcome) =>
			inner.recordCancellationOutcome(id, outcome),
		markTerminal: (id, status) => inner.markTerminal(id, status),
		markAbandoned: (id, reason) => inner.markAbandoned(id, reason),
		markAbandonedIfStale: (opts) => {
			beforeAbandon(inner);
			return inner.markAbandonedIfStale(opts);
		},
		listStale: (opts) => inner.listStale(opts),
	};
}

afterEach(() => {
	closeDb();
	_resetForTest();
	_resetCancellationAdaptersForTest();
});

describe("invocations detect", () => {
	test("missing DB returns [] and does not create a file", async () => {
		const tmp = makeTmp();
		try {
			const ctx = doctorCtx(tmp);
			expect(existsSync(ctx.dbPath)).toBe(false);
			const findings = await invocationsCheck.run(ctx);
			expect(findings).toEqual([]);
			expect(existsSync(ctx.dbPath)).toBe(false);
			expect(existsSync(join(tmp, ".5x"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unreadable DB → INVOCATION_DB_UNREADABLE, not thrown", async () => {
		const tmp = makeTmp();
		try {
			mkdirSync(join(tmp, ".5x"), { recursive: true });
			const ctx = doctorCtx(tmp);
			writeFileSync(ctx.dbPath, "not a sqlite database");
			const findings = await invocationsCheck.run(ctx);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.code).toBe("INVOCATION_DB_UNREADABLE");
			expect(findings[0]?.status).toBe("fail");
			expect(findings[0]?.fixable).toBe(false);
			expect(findings[0]?.detail).toEqual(
				expect.objectContaining({ dbPath: ctx.dbPath }),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("heartbeat-fresh running + active run → INVOCATIONS_OK", async () => {
		const tmp = makeTmp();
		try {
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_active", planPath: "/plan.md" });
				store.register(registerInput("run_active"));
			});

			const findings = await invocationsCheck.run(doctorCtx(tmp));
			expect(findings).toEqual([
				expect.objectContaining({
					check: "invocations",
					status: "ok",
					code: "INVOCATIONS_OK",
					fixable: false,
				}),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("running + updated_at 16 minutes before ctx.now → heartbeat", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			let updatedAt = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_live", planPath: "/plan.md" });
				id = store.register(registerInput("run_live")).id;
			});
			updatedAt = backdateUpdatedAt(tmp, id, 16 * 60 * 1000);

			const now = Date.now();
			const findings = await invocationsCheck.run(doctorCtx(tmp, now));
			expect(findings).toHaveLength(1);
			const stale = findings[0];
			expect(stale?.code).toBe("INVOCATION_STALE");
			expect(stale?.status).toBe("fail");
			expect(stale?.fixable).toBe(true);
			expect(stale?.remediation).toBe("5x doctor --fix");
			expect(stale?.message).toMatch(/not reaped/i);
			expect(reasonOf(stale)).toBe("heartbeat");
			expect(stale?.detail).toEqual({
				invocationId: id,
				runId: "run_live",
				updatedAt,
				reason: "heartbeat",
			});
			expect(now - parseRunTimestamp(updatedAt)).toBeGreaterThan(
				INVOCATION_STALE_MS,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("running + fresh heartbeat + run aborted → run-terminal", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_abort", planPath: "/plan.md" });
				id = store.register(registerInput("run_abort")).id;
				completeRun(db, "run_abort", "aborted");
			});

			const findings = await invocationsCheck.run(doctorCtx(tmp));
			expect(findings).toHaveLength(1);
			expect(findings[0]).toEqual(
				expect.objectContaining({
					check: "invocations",
					code: "INVOCATION_STALE",
					status: "fail",
					fixable: true,
					detail: expect.objectContaining({
						invocationId: id,
						runId: "run_abort",
						reason: "run-terminal",
					}),
				}),
			);
			expect(findings[0]?.message).toMatch(/not reaped/i);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("both predicates match → reason run-terminal", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				id = store.register(registerInput("run_done")).id;
				completeRun(db, "run_done", "completed");
			});
			backdateUpdatedAt(tmp, id, 16 * 60 * 1000);

			const findings = await invocationsCheck.run(doctorCtx(tmp));
			expect(findings).toHaveLength(1);
			expect(reasonOf(findings[0])).toBe("run-terminal");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("completed invocations are never flagged", async () => {
		const tmp = makeTmp();
		try {
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				const created = store.register(registerInput("run_done"));
				store.markTerminal(created.id, "completed");
				completeRun(db, "run_done", "completed");
			});

			const findings = await invocationsCheck.run(doctorCtx(tmp));
			expect(findings).toEqual([
				expect.objectContaining({ code: "INVOCATIONS_OK", status: "ok" }),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("invocations --fix", () => {
	test("abandons a still-stale heartbeat row; re-detect ok", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_live", planPath: "/plan.md" });
				id = store.register(registerInput("run_live")).id;
			});
			backdateUpdatedAt(tmp, id, 16 * 60 * 1000);

			const ctx = doctorCtx(tmp);
			const findings = await invocationsCheck.run(ctx);
			const stale = findings.find((f) => f.code === "INVOCATION_STALE");
			expect(invocationIdOf(stale)).toBe(id);
			expect(reasonOf(stale)).toBe("heartbeat");

			const result = await applyFix(invocationsCheck, stale, ctx);
			expect(result.attempted).toBe(true);
			expect(result.message).toContain(id);

			const db = getDb(tmp);
			try {
				const row = createSqliteInvocationStore(db).get(id);
				expect(row?.status).toBe("abandoned");
				expect(row?.abandonReason).toBe("stale-metadata");
			} finally {
				closeDb();
				_resetForTest();
			}

			const again = await invocationsCheck.run(ctx);
			expect(again).toEqual([
				expect.objectContaining({ code: "INVOCATIONS_OK", status: "ok" }),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("abandons a still-terminal-run row; re-detect ok", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				id = store.register(registerInput("run_done")).id;
				completeRun(db, "run_done", "completed");
			});

			const ctx = doctorCtx(tmp);
			const findings = await invocationsCheck.run(ctx);
			const stale = findings.find((f) => f.code === "INVOCATION_STALE");
			expect(reasonOf(stale)).toBe("run-terminal");

			const result = await applyFix(invocationsCheck, stale, ctx);
			expect(result.attempted).toBe(true);

			const db = getDb(tmp);
			try {
				const row = createSqliteInvocationStore(db).get(id);
				expect(row?.status).toBe("abandoned");
				expect(row?.abandonReason).toBe("stale-metadata");
			} finally {
				closeDb();
				_resetForTest();
			}

			const again = await invocationsCheck.run(ctx);
			expect(again).toEqual([
				expect.objectContaining({ code: "INVOCATIONS_OK", status: "ok" }),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("--fix does not call a registered test adapter", async () => {
		const tmp = makeTmp();
		try {
			const adapter = createTestRemoteAdapter();
			registerCancellationAdapter(adapter);
			const job = adapter.allocateJob();
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_live", planPath: "/plan.md" });
				id = store.register(
					registerInput("run_live", {
						handle: job.handle,
						cancellationSupported: true,
					}),
				).id;
			});
			backdateUpdatedAt(tmp, id, 16 * 60 * 1000);

			const ctx = doctorCtx(tmp);
			const findings = await invocationsCheck.run(ctx);
			const result = await applyFix(invocationsCheck, findings[0], ctx);
			expect(result.attempted).toBe(true);
			expect(adapter.cancelCalls).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("finding message matches /not reaped/i", async () => {
		const tmp = makeTmp();
		try {
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_live", planPath: "/plan.md" });
				store.register(registerInput("run_live"));
				completeRun(db, "run_live", "aborted");
			});
			const findings = await invocationsCheck.run(doctorCtx(tmp));
			expect(findings[0]?.message).toMatch(/not reaped/i);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("two-writer heartbeat: wrap heartbeats before abandon; row stays running", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_live", planPath: "/plan.md" });
				id = store.register(registerInput("run_live")).id;
			});
			backdateUpdatedAt(tmp, id, 16 * 60 * 1000);

			const check = createInvocationsCheck({
				createStore: (db) =>
					wrapStore(createSqliteInvocationStore(db), (inner) => {
						inner.heartbeat(id);
					}),
			});
			const ctx = doctorCtx(tmp);
			const findings = await check.run(ctx);
			expect(reasonOf(findings[0])).toBe("heartbeat");

			const result = await applyFix(check, findings[0], ctx);
			expect(result.attempted).toBe(false);

			const db = getDb(tmp);
			try {
				const row = createSqliteInvocationStore(db).get(id);
				expect(row?.status).toBe("running");
			} finally {
				closeDb();
				_resetForTest();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("detect → heartbeat → --fix does not abandon", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_live", planPath: "/plan.md" });
				id = store.register(registerInput("run_live")).id;
			});
			backdateUpdatedAt(tmp, id, 16 * 60 * 1000);

			const ctx = doctorCtx(tmp);
			const findings = await invocationsCheck.run(ctx);
			expect(findings[0]?.code).toBe("INVOCATION_STALE");

			seed(tmp, (store) => {
				store.heartbeat(id);
			});

			const result = await applyFix(invocationsCheck, findings[0], ctx);
			expect(result.attempted).toBe(false);
			expect(result.message).toBe("invocation is no longer stale");

			const db = getDb(tmp);
			try {
				expect(createSqliteInvocationStore(db).get(id)?.status).toBe("running");
			} finally {
				closeDb();
				_resetForTest();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("two-writer run reopen: wrap reopens before abandon; row stays running", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				id = store.register(registerInput("run_done")).id;
				completeRun(db, "run_done", "aborted");
			});

			const check = createInvocationsCheck({
				createStore: (db) =>
					wrapStore(createSqliteInvocationStore(db), () => {
						reopenRun(db, "run_done");
					}),
			});
			const ctx = doctorCtx(tmp);
			const findings = await check.run(ctx);
			expect(reasonOf(findings[0])).toBe("run-terminal");

			const result = await applyFix(check, findings[0], ctx);
			expect(result.attempted).toBe(false);

			const db = getDb(tmp);
			try {
				expect(createSqliteInvocationStore(db).get(id)?.status).toBe("running");
			} finally {
				closeDb();
				_resetForTest();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("detect → reopen → --fix does not abandon", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				id = store.register(registerInput("run_done")).id;
				completeRun(db, "run_done", "aborted");
			});

			const ctx = doctorCtx(tmp);
			const findings = await invocationsCheck.run(ctx);
			expect(reasonOf(findings[0])).toBe("run-terminal");

			seed(tmp, (_store, db) => {
				reopenRun(db, "run_done");
			});

			const result = await applyFix(invocationsCheck, findings[0], ctx);
			expect(result.attempted).toBe(false);
			expect(result.message).toBe("run is no longer terminal");

			const db = getDb(tmp);
			try {
				expect(createSqliteInvocationStore(db).get(id)?.status).toBe("running");
			} finally {
				closeDb();
				_resetForTest();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("already-terminal invocation is not rewritten", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_live", planPath: "/plan.md" });
				id = store.register(registerInput("run_live")).id;
			});
			backdateUpdatedAt(tmp, id, 16 * 60 * 1000);

			const ctx = doctorCtx(tmp);
			const findings = await invocationsCheck.run(ctx);
			const stale = findings.find((f) => f.code === "INVOCATION_STALE");

			seed(tmp, (store) => {
				store.markTerminal(id, "completed");
			});

			const result = await applyFix(invocationsCheck, stale, ctx);
			expect(result.attempted).toBe(false);

			const db = getDb(tmp);
			try {
				expect(createSqliteInvocationStore(db).get(id)?.status).toBe(
					"completed",
				);
			} finally {
				closeDb();
				_resetForTest();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("missing invocationId is not attempted", async () => {
		const tmp = makeTmp();
		try {
			seed(tmp, () => {});
			const result = await applyFix(
				invocationsCheck,
				{
					check: "invocations",
					status: "fail",
					code: "INVOCATION_STALE",
					message: "stale",
					fixable: true,
					detail: { reason: "heartbeat" },
				},
				doctorCtx(tmp),
			);
			expect(result.attempted).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("source calls markAbandonedIfStale, not markAbandoned(, and never process.kill", async () => {
		const source = await Bun.file(
			join(import.meta.dir, "../../../src/doctor/checks/invocations.ts"),
		).text();
		expect(source).toContain("markAbandonedIfStale");
		expect(source).not.toContain("markAbandoned(");
		expect(source).not.toContain("process.kill");
		expect(source).not.toContain("getCancellationAdapter");
		expect(source).not.toContain("adapter.cancel");
		const importBlock = source
			.split("\n")
			.filter((line) => line.startsWith("import "))
			.join("\n");
		expect(importBlock).not.toContain("resolveDbContext");
	});
});

describe("invocations findingKey", () => {
	test("throws when fixable INVOCATION_STALE is missing invocationId", () => {
		expect(() =>
			findingKey({
				check: "invocations",
				code: "INVOCATION_STALE",
				status: "fail",
				fixable: true,
				message: "stale",
				detail: { runId: "run_1" },
			}),
		).toThrow(/empty identity/);
	});
});
