/**
 * Unit tests for the locks doctor check.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { locksCheck } from "../../../src/doctor/checks/locks.js";
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
		`5x-doctor-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function canonicalLockPath(projectRoot: string, planPath: string): string {
	const canonical = canonicalizePlanPath(planPath);
	const hash = createHash("sha256")
		.update(canonical)
		.digest("hex")
		.slice(0, 16);
	return join(projectRoot, ".5x", "locks", `${hash}.lock`);
}

function writeLockFile(
	projectRoot: string,
	planPath: string,
	body: string | Record<string, unknown>,
	fileName?: string,
): string {
	const dir = join(projectRoot, ".5x", "locks");
	mkdirSync(dir, { recursive: true });
	const path = fileName
		? join(dir, fileName)
		: canonicalLockPath(projectRoot, planPath);
	const content = typeof body === "string" ? body : JSON.stringify(body);
	writeFileSync(path, content);
	return path;
}

const DEAD_PID = 99999999;
const STARTED = "2026-01-01T00:00:00.000Z";

async function applyFix(
	check: DoctorCheck,
	finding: DoctorFinding | undefined,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (!check.fix) throw new Error("expected check.fix");
	if (!finding) throw new Error("expected finding");
	return check.fix(finding, ctx);
}

describe("locks detect", () => {
	test("no locks → LOCKS_OK", async () => {
		const tmp = makeTmp();
		try {
			const findings = await locksCheck.run(doctorCtx(tmp));
			expect(findings).toEqual([
				expect.objectContaining({
					check: "locks",
					status: "ok",
					code: "LOCKS_OK",
					fixable: false,
				}),
			]);
			expect(existsSync(join(tmp, ".5x", "locks"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("classifies live, stale, and corrupt", async () => {
		const tmp = makeTmp();
		try {
			const livePlan = join(tmp, "docs", "live.md");
			const stalePlan = join(tmp, "docs", "stale.md");
			writeLockFile(tmp, livePlan, {
				pid: process.pid,
				startedAt: STARTED,
				planPath: canonicalizePlanPath(livePlan),
			});
			writeLockFile(tmp, stalePlan, {
				pid: DEAD_PID,
				startedAt: STARTED,
				planPath: canonicalizePlanPath(stalePlan),
			});
			const corruptPath = writeLockFile(
				tmp,
				"ignored",
				"{not-json",
				"leftover.lock",
			);

			const findings = await locksCheck.run(doctorCtx(tmp));
			const live = findings.find((f) => f.code === "LOCK_LIVE");
			const stale = findings.find((f) => f.code === "LOCK_STALE");
			const corrupt = findings.find((f) => f.code === "LOCK_CORRUPT");

			expect(live?.status).toBe("warn");
			expect(live?.fixable).toBe(false);
			expect(live?.remediation).toContain("--force");
			expect(live?.detail).toEqual(
				expect.objectContaining({
					planPath: canonicalizePlanPath(livePlan),
				}),
			);

			expect(stale?.status).toBe("fail");
			expect(stale?.fixable).toBe(true);
			expect(stale?.remediation).toBe(
				`5x unlock ${canonicalizePlanPath(stalePlan)}`,
			);
			expect(stale?.detail).toEqual(
				expect.objectContaining({
					planPath: canonicalizePlanPath(stalePlan),
				}),
			);

			expect(corrupt?.status).toBe("fail");
			expect(corrupt?.fixable).toBe(true);
			expect(corrupt?.remediation).toBe("5x doctor --fix");
			expect(corrupt?.detail).toEqual(
				expect.objectContaining({ lockPath: corruptPath }),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("locks --fix", () => {
	test("live lock files survive --fix", async () => {
		const tmp = makeTmp();
		try {
			const livePlan = join(tmp, "docs", "live.md");
			const livePath = writeLockFile(tmp, livePlan, {
				pid: process.pid,
				startedAt: STARTED,
				planPath: canonicalizePlanPath(livePlan),
			});

			const ctx = doctorCtx(tmp);
			const findings = await locksCheck.run(ctx);
			const live = findings.find((f) => f.code === "LOCK_LIVE");
			expect(live?.fixable).toBe(false);
			const result = await applyFix(locksCheck, live, ctx);
			expect(result.attempted).toBe(false);
			expect(existsSync(livePath)).toBe(true);
			expect(live?.status).toBe("warn");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("non-canonical corrupt file is removed via lockPath; plan-keyed unlock is not required", async () => {
		const tmp = makeTmp();
		try {
			const corruptPath = writeLockFile(tmp, "ignored", "garbage", "aaaa.lock");
			expect(existsSync(corruptPath)).toBe(true);

			const ctx = doctorCtx(tmp);
			const findings = await locksCheck.run(ctx);
			const corrupt = findings.find((f) => f.code === "LOCK_CORRUPT");
			expect(corrupt).toBeDefined();
			const result = await applyFix(locksCheck, corrupt, ctx);
			expect(result.attempted).toBe(true);
			expect(existsSync(corruptPath)).toBe(false);
			const again = await locksCheck.run(ctx);
			expect(again.some((f) => f.code === "LOCK_CORRUPT")).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("two stale locks are both removed", async () => {
		const tmp = makeTmp();
		try {
			const planA = join(tmp, "docs", "a.md");
			const planB = join(tmp, "docs", "b.md");
			const pathA = writeLockFile(tmp, planA, {
				pid: DEAD_PID,
				startedAt: STARTED,
				planPath: canonicalizePlanPath(planA),
			});
			const pathB = writeLockFile(tmp, planB, {
				pid: DEAD_PID,
				startedAt: STARTED,
				planPath: canonicalizePlanPath(planB),
			});

			const ctx = doctorCtx(tmp);
			const findings = await locksCheck.run(ctx);
			const stales = findings.filter((f) => f.code === "LOCK_STALE");
			expect(stales).toHaveLength(2);
			const attempted: boolean[] = [];
			for (const stale of stales) {
				const result = await applyFix(locksCheck, stale, ctx);
				attempted.push(result.attempted);
			}
			expect(attempted).toEqual([true, true]);
			expect(existsSync(pathA)).toBe(false);
			expect(existsSync(pathB)).toBe(false);
			const again = await locksCheck.run(ctx);
			expect(
				again.some((f) => f.code === "LOCK_STALE" && f.status === "fail"),
			).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
