/**
 * Unit tests for the lingering-runs doctor check.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { listRuns } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import {
	LINGERING_RUN_AGE_MS,
	parseRunTimestamp,
	runsCheck,
} from "../../../src/doctor/checks/runs.js";
import type { DoctorCheckContext } from "../../../src/doctor/types.js";
import { canonicalizePlanPath } from "../../../src/paths.js";

function makeTmp(): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-runs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function createMigratedDb(projectRoot: string): string {
	const db = getDb(projectRoot);
	runMigrations(db);
	const dbPath = resolve(projectRoot, ".5x", "5x.db");
	closeDb();
	_resetForTest();
	return dbPath;
}

function insertRun(
	db: import("bun:sqlite").Database,
	row: {
		id: string;
		planPath: string;
		status?: string;
		createdAt: string;
		updatedAt: string;
	},
): void {
	const canonical = canonicalizePlanPath(row.planPath);
	db.query(
		`INSERT INTO runs (id, plan_path, status, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5)`,
	).run(
		row.id,
		canonical,
		row.status ?? "active",
		row.createdAt,
		row.updatedAt,
	);
}

function writeLiveLock(projectRoot: string, planPath: string): void {
	const canonical = canonicalizePlanPath(planPath);
	const hash = createHash("sha256")
		.update(canonical)
		.digest("hex")
		.slice(0, 16);
	const dir = join(projectRoot, ".5x", "locks");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${hash}.lock`),
		JSON.stringify({
			pid: process.pid,
			startedAt: "2026-01-01T00:00:00.000Z",
			planPath: canonical,
		}),
	);
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

const NOW = Date.parse("2026-08-18T00:00:00.000Z");
const LINGERING_AT = new Date(NOW - LINGERING_RUN_AGE_MS).toISOString();
const FRESH_AT = new Date(NOW - 60 * 60 * 1000).toISOString();
const OLD_AT = "2020-01-01T00:00:00.000Z";

describe("parseRunTimestamp", () => {
	test("treats SQLite datetime('now') as UTC", () => {
		expect(parseRunTimestamp("2026-08-18 00:00:00")).toBe(
			Date.parse("2026-08-18T00:00:00.000Z"),
		);
	});

	test("parses ISO timestamps with Z", () => {
		expect(parseRunTimestamp("2026-08-18T00:00:00.000Z")).toBe(NOW);
	});
});

describe("runs detect", () => {
	test("missing DB returns [] and does not create a file", async () => {
		const tmp = makeTmp();
		try {
			const ctx = doctorCtx(tmp, NOW);
			expect(existsSync(ctx.dbPath)).toBe(false);
			const findings = await runsCheck.run(ctx);
			expect(findings).toEqual([]);
			expect(existsSync(ctx.dbPath)).toBe(false);
			expect(existsSync(join(tmp, ".5x"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unreadable DB → DB_UNREADABLE, not thrown", async () => {
		const tmp = makeTmp();
		try {
			mkdirSync(join(tmp, ".5x"), { recursive: true });
			const ctx = doctorCtx(tmp, NOW);
			writeFileSync(ctx.dbPath, "not a sqlite database");
			const findings = await runsCheck.run(ctx);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.code).toBe("DB_UNREADABLE");
			expect(findings[0]?.status).toBe("fail");
			expect(findings[0]?.fixable).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("fresh active run (updated_at within 24h) is not flagged", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const plan = join(tmp, "docs", "fresh.md");
			const { Database } = await import("bun:sqlite");
			const db = new Database(dbPath);
			insertRun(db, {
				id: "run_fresh",
				planPath: plan,
				createdAt: FRESH_AT,
				updatedAt: FRESH_AT,
			});
			db.close();

			const findings = await runsCheck.run(doctorCtx(tmp, NOW));
			expect(findings).toEqual([
				expect.objectContaining({
					check: "runs",
					status: "ok",
					code: "RUNS_OK",
					fixable: false,
				}),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("active run with live lock is not flagged even when old", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const plan = join(tmp, "docs", "live.md");
			const { Database } = await import("bun:sqlite");
			const db = new Database(dbPath);
			insertRun(db, {
				id: "run_live",
				planPath: plan,
				createdAt: OLD_AT,
				updatedAt: OLD_AT,
			});
			db.close();
			writeLiveLock(tmp, plan);

			const findings = await runsCheck.run(doctorCtx(tmp, NOW));
			expect(findings.some((f) => f.code === "RUN_LINGERING")).toBe(false);
			expect(findings).toEqual([
				expect.objectContaining({ code: "RUNS_OK", status: "ok" }),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("lingering active run without a live lock is warn + not fixable", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const plan = join(tmp, "docs", "stale.md");
			const { Database } = await import("bun:sqlite");
			const db = new Database(dbPath);
			insertRun(db, {
				id: "run_stale",
				planPath: plan,
				createdAt: LINGERING_AT,
				updatedAt: LINGERING_AT,
			});
			db.close();

			const findings = await runsCheck.run(doctorCtx(tmp, NOW));
			expect(findings).toHaveLength(1);
			const lingering = findings[0];
			expect(lingering?.code).toBe("RUN_LINGERING");
			expect(lingering?.status).toBe("warn");
			expect(lingering?.fixable).toBe(false);
			expect(lingering?.remediation).toBe(
				"5x run complete --run run_stale --status aborted",
			);
			expect(lingering?.message).toContain("reopen");
			expect(lingering?.detail).toEqual(
				expect.objectContaining({
					runId: "run_stale",
					planPath: canonicalizePlanPath(plan),
				}),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("completed old run is not flagged", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const plan = join(tmp, "docs", "done.md");
			const { Database } = await import("bun:sqlite");
			const db = new Database(dbPath);
			insertRun(db, {
				id: "run_done",
				planPath: plan,
				status: "completed",
				createdAt: OLD_AT,
				updatedAt: OLD_AT,
			});
			db.close();

			const findings = await runsCheck.run(doctorCtx(tmp, NOW));
			expect(findings[0]?.code).toBe("RUNS_OK");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("oldest of 51 active runs is still flagged (listRuns cap regression)", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const { Database } = await import("bun:sqlite");
			const db = new Database(dbPath);
			for (let i = 0; i < 51; i++) {
				const stamp = new Date(Date.UTC(2020, 0, 1 + i)).toISOString();
				insertRun(db, {
					id: `run-${i}`,
					planPath: join(tmp, "docs", `plan-${i}.md`),
					createdAt: stamp,
					updatedAt: stamp,
				});
			}

			const viaList = listRuns(db, { status: "active" });
			expect(viaList).toHaveLength(50);
			expect(viaList.some((r) => r.id === "run-0")).toBe(false);
			db.close();

			const findings = await runsCheck.run(doctorCtx(tmp, NOW));
			const lingering = findings.filter((f) => f.code === "RUN_LINGERING");
			expect(lingering).toHaveLength(51);
			expect(
				lingering.some(
					(f) =>
						f.detail &&
						typeof f.detail === "object" &&
						(f.detail as { runId?: string }).runId === "run-0",
				),
			).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("check has no fix function", () => {
		expect(runsCheck.fix).toBeUndefined();
	});

	test("detect path does not import getDb or resolveDbContext", () => {
		const src = readFileSync(
			join(import.meta.dir, "../../../src/doctor/checks/runs.ts"),
			"utf8",
		);
		expect(src).not.toMatch(/\bgetDb\b/);
		expect(src).not.toMatch(/\bresolveDbContext\b/);
	});
});
