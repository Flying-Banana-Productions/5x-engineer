/**
 * Unit tests for the worktrees doctor check.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
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
import { getPlan, upsertPlan } from "../../../src/db/operations.js";
import { runMigrations } from "../../../src/db/schema.js";
import { worktreesCheck } from "../../../src/doctor/checks/worktrees.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../../../src/doctor/types.js";
import { canonicalizePlanPath } from "../../../src/paths.js";

function makeTmp(): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function doctorCtx(projectRoot: string): DoctorCheckContext {
	return {
		startDir: projectRoot,
		projectRoot,
		stateDir: ".5x",
		dbPath: resolve(projectRoot, ".5x", "5x.db"),
		dbRelPath: join(".5x", "5x.db"),
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

async function applyFix(
	check: DoctorCheck,
	finding: DoctorFinding | undefined,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (!check.fix) throw new Error("expected check.fix");
	if (!finding) throw new Error("expected finding");
	return check.fix(finding, ctx);
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

describe("worktrees detect", () => {
	test("missing DB returns [] and does not create a file", async () => {
		const tmp = makeTmp();
		try {
			const ctx = doctorCtx(tmp);
			expect(existsSync(ctx.dbPath)).toBe(false);
			const findings = await worktreesCheck.run(ctx);
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
			const ctx = doctorCtx(tmp);
			writeFileSync(ctx.dbPath, "not a sqlite database");
			const findings = await worktreesCheck.run(ctx);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.code).toBe("DB_UNREADABLE");
			expect(findings[0]?.status).toBe("fail");
			expect(findings[0]?.fixable).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("dead mapping is fail + fixable; living mapping is not", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const living = join(tmp, "living-wt");
			mkdirSync(living, { recursive: true });
			const deadPlan = join(tmp, "docs", "dead.md");
			const livePlan = join(tmp, "docs", "live.md");
			const db = new Database(dbPath);
			upsertPlan(db, {
				planPath: deadPlan,
				worktreePath: join(tmp, "missing-wt"),
				branch: "5x/dead",
			});
			upsertPlan(db, {
				planPath: livePlan,
				worktreePath: living,
				branch: "5x/live",
			});
			db.close();

			const findings = await worktreesCheck.run(doctorCtx(tmp));
			const missing = findings.find(
				(f) => f.code === "WORKTREE_MAPPING_MISSING",
			);
			expect(missing?.status).toBe("fail");
			expect(missing?.fixable).toBe(true);
			expect(missing?.remediation).toContain("5x worktree detach -p");
			expect(missing?.detail).toEqual(
				expect.objectContaining({
					planPath: canonicalizePlanPath(deadPlan),
				}),
			);
			expect(
				findings.filter((f) => f.code === "WORKTREE_MAPPING_MISSING"),
			).toHaveLength(1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("healthy mappings with no orphans → WORKTREES_OK", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const living = join(tmp, "living-wt");
			mkdirSync(living, { recursive: true });
			const livePlan = join(tmp, "docs", "live.md");
			const db = new Database(dbPath);
			upsertPlan(db, {
				planPath: livePlan,
				worktreePath: living,
				branch: "5x/live",
			});
			db.close();

			const findings = await worktreesCheck.run(doctorCtx(tmp));
			expect(findings).toEqual([
				expect.objectContaining({
					code: "WORKTREES_OK",
					status: "ok",
					fixable: false,
				}),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("worktrees --fix", () => {
	test("dead mapping is cleared; orphan directory is preserved", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const orphanDir = join(tmp, ".5x", "worktrees", "orphan-left");
			mkdirSync(orphanDir, { recursive: true });
			writeFileSync(join(orphanDir, "keep-me.txt"), "untouched");

			const deadPlan = join(tmp, "docs", "dead.md");
			const db = new Database(dbPath);
			upsertPlan(db, {
				planPath: deadPlan,
				worktreePath: join(tmp, "missing-wt"),
				branch: "5x/dead",
			});
			db.close();

			const ctx = doctorCtx(tmp);
			const findings = await worktreesCheck.run(ctx);
			const missing = findings.find(
				(f) => f.code === "WORKTREE_MAPPING_MISSING",
			);
			expect(missing).toBeDefined();
			expect(findings.some((f) => f.code === "WORKTREE_ORPHAN")).toBe(true);

			const result = await applyFix(worktreesCheck, missing, ctx);
			expect(result.attempted).toBe(true);

			const after = new Database(dbPath, { readonly: true });
			try {
				const plan = getPlan(after, canonicalizePlanPath(deadPlan));
				expect(plan?.worktree_path).toBeNull();
				expect(plan?.branch).toBeNull();
			} finally {
				after.close();
			}

			expect(existsSync(orphanDir)).toBe(true);
			expect(readFileSync(join(orphanDir, "keep-me.txt"), "utf-8")).toBe(
				"untouched",
			);

			const again = await worktreesCheck.run(ctx);
			expect(
				again.some(
					(f) => f.code === "WORKTREE_MAPPING_MISSING" && f.status === "fail",
				),
			).toBe(false);
			expect(again.some((f) => f.code === "WORKTREE_ORPHAN")).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("does not clear a mapping that changed between detection and repair", async () => {
		const tmp = makeTmp();
		try {
			const dbPath = createMigratedDb(tmp);
			const deadPlan = join(tmp, "docs", "dead.md");
			const missingPath = join(tmp, "missing-wt");
			const db = new Database(dbPath);
			upsertPlan(db, {
				planPath: deadPlan,
				worktreePath: missingPath,
				branch: "5x/dead",
			});
			db.close();

			const ctx = doctorCtx(tmp);
			const findings = await worktreesCheck.run(ctx);
			const missing = findings.find(
				(f) => f.code === "WORKTREE_MAPPING_MISSING",
			);
			expect(missing?.fixable).toBe(true);

			const living = join(tmp, "repaired-wt");
			mkdirSync(living, { recursive: true });
			const repaired = new Database(dbPath);
			upsertPlan(repaired, {
				planPath: deadPlan,
				worktreePath: living,
				branch: "5x/repaired",
			});
			repaired.close();

			const result = await applyFix(worktreesCheck, missing, ctx);
			expect(result.attempted).toBe(false);

			const after = new Database(dbPath, { readonly: true });
			try {
				const plan = getPlan(after, canonicalizePlanPath(deadPlan));
				expect(plan?.worktree_path).toBe(living);
				expect(plan?.branch).toBe("5x/repaired");
			} finally {
				after.close();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("source does not import worktreeDetach, removeWorktree, resolveDbContext, or getDb", async () => {
		const source = await Bun.file(
			join(import.meta.dir, "../../../src/doctor/checks/worktrees.ts"),
		).text();
		const importBlock = source
			.split("\n")
			.filter((line) => line.startsWith("import "))
			.join("\n");
		expect(importBlock).not.toContain("worktreeDetach");
		expect(importBlock).not.toContain("removeWorktree");
		expect(importBlock).not.toContain("resolveDbContext");
		expect(importBlock).not.toContain("getDb");
	});
});
