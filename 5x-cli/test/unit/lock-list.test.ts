/**
 * Unit tests for lock inventory: listLocks, inspectLock, removeCorruptLock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireLock,
	inspectLock,
	isLocked,
	listLocks,
	registerLockCleanup,
	releaseLock,
	removeCorruptLock,
} from "../../src/lock.js";
import { canonicalizePlanPath } from "../../src/paths.js";

function makeTmp(): string {
	const dir = join(
		tmpdir(),
		`5x-lock-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

let tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
	tmpDirs = [];
});

function withTmp(): string {
	const dir = makeTmp();
	tmpDirs.push(dir);
	return dir;
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

describe("listLocks", () => {
	test("returns [] when lock directory is missing and does not create it", () => {
		const tmp = withTmp();
		expect(listLocks(tmp)).toEqual([]);
		expect(existsSync(join(tmp, ".5x"))).toBe(false);
		expect(existsSync(join(tmp, ".5x", "locks"))).toBe(false);
	});

	test("returns [] for an empty lock directory", () => {
		const tmp = withTmp();
		mkdirSync(join(tmp, ".5x", "locks"), { recursive: true });
		expect(listLocks(tmp)).toEqual([]);
	});

	test("classifies live, stale, and corrupt entries without mutating", () => {
		const tmp = withTmp();
		const livePlan = join(tmp, "docs", "live.md");
		const stalePlan = join(tmp, "docs", "stale.md");
		const startedAt = "2026-01-01T00:00:00.000Z";

		const livePath = writeLockFile(tmp, livePlan, {
			pid: process.pid,
			startedAt,
			planPath: canonicalizePlanPath(livePlan),
		});
		const stalePath = writeLockFile(tmp, stalePlan, {
			pid: DEAD_PID,
			startedAt,
			planPath: canonicalizePlanPath(stalePlan),
		});
		const corruptPath = writeLockFile(
			tmp,
			"ignored",
			"{not-json",
			"leftover.lock",
		);

		const before = readdirSync(join(tmp, ".5x", "locks")).sort();
		const entries = listLocks(tmp);
		const after = readdirSync(join(tmp, ".5x", "locks")).sort();

		expect(after).toEqual(before);
		expect(entries).toHaveLength(3);

		const live = entries.find((e) => e.lockPath === livePath);
		expect(live?.liveness).toBe("live");
		expect(live?.info?.pid).toBe(process.pid);
		expect(live?.info?.planPath).toBe(canonicalizePlanPath(livePlan));

		const stale = entries.find((e) => e.lockPath === stalePath);
		expect(stale?.liveness).toBe("stale");
		expect(stale?.info?.pid).toBe(DEAD_PID);

		const corrupt = entries.find((e) => e.lockPath === corruptPath);
		expect(corrupt?.liveness).toBe("corrupt");
		expect(corrupt?.info).toBeNull();
	});

	test("does not skip unparsable files (unlike isLocked)", () => {
		const tmp = withTmp();
		writeLockFile(tmp, "ignored", "garbage", "aaaa.lock");
		const entries = listLocks(tmp);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.liveness).toBe("corrupt");
	});
});

describe("inspectLock", () => {
	test("returns null when no lock is associated with the plan", () => {
		const tmp = withTmp();
		expect(inspectLock(tmp, join(tmp, "docs", "missing.md"))).toBeNull();
	});

	test("returns live/stale for parsed locks and corrupt at the canonical path", () => {
		const tmp = withTmp();
		const plan = join(tmp, "docs", "plan.md");
		acquireLock(tmp, plan);
		const live = inspectLock(tmp, plan);
		expect(live?.liveness).toBe("live");
		expect(live?.info?.pid).toBe(process.pid);

		writeLockFile(tmp, plan, {
			pid: DEAD_PID,
			startedAt: "2026-01-01T00:00:00.000Z",
			planPath: canonicalizePlanPath(plan),
		});
		expect(inspectLock(tmp, plan)?.liveness).toBe("stale");

		writeFileSync(canonicalLockPath(tmp, plan), "not-json");
		const corrupt = inspectLock(tmp, plan);
		expect(corrupt?.liveness).toBe("corrupt");
		expect(corrupt?.info).toBeNull();
	});

	test("does not surface non-canonical corrupt leftovers", () => {
		const tmp = withTmp();
		const plan = join(tmp, "docs", "plan.md");
		writeLockFile(tmp, plan, "garbage", "not-the-hash.lock");
		expect(inspectLock(tmp, plan)).toBeNull();
		expect(listLocks(tmp)).toHaveLength(1);
	});
});

describe("removeCorruptLock", () => {
	test("rejects a path outside the lock directory", () => {
		const tmp = withTmp();
		mkdirSync(join(tmp, ".5x", "locks"), { recursive: true });
		const outside = join(tmp, "evil.lock");
		writeFileSync(outside, "garbage");
		const result = removeCorruptLock(tmp, outside);
		expect(result).toEqual({ removed: false, reason: "not_in_lock_dir" });
		expect(existsSync(outside)).toBe(true);
	});

	test("rejects a nested path and a .. escape", () => {
		const tmp = withTmp();
		const nestedDir = join(tmp, ".5x", "locks", "nested");
		mkdirSync(nestedDir, { recursive: true });
		const nested = join(nestedDir, "x.lock");
		writeFileSync(nested, "garbage");
		expect(removeCorruptLock(tmp, nested)).toEqual({
			removed: false,
			reason: "not_in_lock_dir",
		});
		expect(existsSync(nested)).toBe(true);

		const escaped = join(tmp, ".5x", "locks", "..", "secrets.lock");
		writeFileSync(join(tmp, ".5x", "secrets.lock"), "garbage");
		expect(removeCorruptLock(tmp, escaped)).toEqual({
			removed: false,
			reason: "not_in_lock_dir",
		});
	});

	test("refuses a parsable live/stale lock", () => {
		const tmp = withTmp();
		const plan = join(tmp, "docs", "plan.md");
		acquireLock(tmp, plan);
		const path = canonicalLockPath(tmp, plan);
		const result = removeCorruptLock(tmp, path);
		expect(result).toEqual({ removed: false, reason: "not_corrupt" });
		expect(existsSync(path)).toBe(true);
	});

	test("removes a confirmed corrupt file", () => {
		const tmp = withTmp();
		const path = writeLockFile(tmp, "ignored", "{broken", "dead.lock");
		const result = removeCorruptLock(tmp, path);
		expect(result).toEqual({ removed: true });
		expect(existsSync(path)).toBe(false);
	});

	test("returns not_found when the path is a missing direct child", () => {
		const tmp = withTmp();
		mkdirSync(join(tmp, ".5x", "locks"), { recursive: true });
		const missing = join(tmp, ".5x", "locks", "gone.lock");
		expect(removeCorruptLock(tmp, missing)).toEqual({
			removed: false,
			reason: "not_found",
		});
	});
});

describe("registerLockCleanup", () => {
	test("SIGINT/SIGTERM do not process.exit; lock remains until exit/release", () => {
		const tmp = withTmp();
		const planPath = "/plan.md";
		acquireLock(tmp, planPath);

		const beforeSigint = process.listeners("SIGINT").length;
		const beforeSigterm = process.listeners("SIGTERM").length;
		const beforeExit = new Set(process.listeners("exit"));

		registerLockCleanup(tmp, planPath);

		expect(process.listeners("SIGINT").length).toBe(beforeSigint);
		expect(process.listeners("SIGTERM").length).toBe(beforeSigterm);
		expect(isLocked(tmp, planPath).locked).toBe(true);

		const addedExit = process
			.listeners("exit")
			.filter((listener) => !beforeExit.has(listener));
		expect(addedExit.length).toBe(1);
		for (const listener of addedExit) {
			(listener as (code?: number) => void)(0);
		}
		expect(isLocked(tmp, planPath).locked).toBe(false);

		for (const listener of addedExit) {
			(listener as (code?: number) => void)(0);
		}
		releaseLock(tmp, planPath);
		releaseLock(tmp, planPath);

		for (const listener of addedExit) {
			process.off("exit", listener as (...args: unknown[]) => void);
		}
	});
});
