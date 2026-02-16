import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, isLocked, releaseLock } from "../src/lock.js";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "5x-lock-"));
}

let tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true });
		} catch {}
	}
	tmpDirs = [];
});

function withTmp(): string {
	const dir = makeTmp();
	tmpDirs.push(dir);
	return dir;
}

describe("acquireLock", () => {
	test("acquires lock on fresh directory", () => {
		const tmp = withTmp();
		const result = acquireLock(tmp, "/plan.md");
		expect(result.acquired).toBe(true);
		expect(result.stale).toBeUndefined();
	});

	test("creates .5x/locks directory", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md");
		expect(existsSync(join(tmp, ".5x", "locks"))).toBe(true);
	});

	test("re-entrant — same process can re-acquire", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md");
		const result = acquireLock(tmp, "/plan.md");
		expect(result.acquired).toBe(true);
	});

	test("detects stale lock from dead PID", () => {
		const tmp = withTmp();
		// Write a lock file with a PID that definitely doesn't exist
		const locksDir = join(tmp, ".5x", "locks");
		const { mkdirSync } = require("node:fs");
		mkdirSync(locksDir, { recursive: true });

		// Use createHash to compute the same lock path
		const { createHash } = require("node:crypto");
		const hash = createHash("sha256")
			.update("/plan.md")
			.digest("hex")
			.slice(0, 16);
		const lockFile = join(locksDir, `${hash}.lock`);

		writeFileSync(
			lockFile,
			JSON.stringify({
				pid: 99999999, // almost certainly not running
				startedAt: new Date().toISOString(),
				planPath: "/plan.md",
			}),
		);

		const result = acquireLock(tmp, "/plan.md");
		expect(result.acquired).toBe(true);
		expect(result.stale).toBe(true);
		expect(result.existingLock).toBeDefined();
		const existing = result.existingLock;
		if (!existing) throw new Error("Expected existingLock");
		expect(existing.pid).toBe(99999999);
	});

	test("fails when another live process holds the lock", () => {
		const tmp = withTmp();
		// Simulate a lock held by a different PID that is alive.
		// We use a long-running subprocess so we have a live PID we can signal.
		const child = Bun.spawn(["sleep", "60"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const childPid = child.pid;

		try {
			const locksDir = join(tmp, ".5x", "locks");
			const { mkdirSync } = require("node:fs");
			mkdirSync(locksDir, { recursive: true });

			const { createHash } = require("node:crypto");
			const hash = createHash("sha256")
				.update("/other-plan.md")
				.digest("hex")
				.slice(0, 16);
			const lockFile = join(locksDir, `${hash}.lock`);

			writeFileSync(
				lockFile,
				JSON.stringify({
					pid: childPid,
					startedAt: new Date().toISOString(),
					planPath: "/other-plan.md",
				}),
			);

			const result = acquireLock(tmp, "/other-plan.md");
			expect(result.acquired).toBe(false);
			expect(result.stale).toBe(false);
			const existing = result.existingLock;
			if (!existing) throw new Error("Expected existingLock");
			expect(existing.pid).toBe(childPid);
		} finally {
			child.kill();
		}
	});

	test("treats EPERM pid liveness as alive", () => {
		const tmp = withTmp();
		const locksDir = join(tmp, ".5x", "locks");
		const { mkdirSync } = require("node:fs");
		mkdirSync(locksDir, { recursive: true });

		const { createHash } = require("node:crypto");
		const hash = createHash("sha256")
			.update("/plan.md")
			.digest("hex")
			.slice(0, 16);
		const lockFile = join(locksDir, `${hash}.lock`);

		writeFileSync(
			lockFile,
			JSON.stringify({
				pid: 12345,
				startedAt: new Date().toISOString(),
				planPath: "/plan.md",
			}),
		);

		const originalKill = process.kill;
		try {
			// Simulate a live process owned by another user
			// (process.kill(pid, 0) throws EPERM)
			(process as unknown as { kill: (...args: unknown[]) => unknown }).kill =
				() => {
					const err = new Error("EPERM") as Error & { code?: string };
					err.code = "EPERM";
					throw err;
				};

			const result = acquireLock(tmp, "/plan.md");
			expect(result.acquired).toBe(false);
			expect(result.stale).toBe(false);
		} finally {
			(process as unknown as { kill: typeof process.kill }).kill = originalKill;
		}
	});

	test("different plan paths get different locks", () => {
		const tmp = withTmp();
		const r1 = acquireLock(tmp, "/plan-a.md");
		const r2 = acquireLock(tmp, "/plan-b.md");
		expect(r1.acquired).toBe(true);
		expect(r2.acquired).toBe(true);
	});
});

describe("releaseLock", () => {
	test("removes lock file", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md");
		expect(isLocked(tmp, "/plan.md").locked).toBe(true);
		releaseLock(tmp, "/plan.md");
		expect(isLocked(tmp, "/plan.md").locked).toBe(false);
	});

	test("is idempotent", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md");
		releaseLock(tmp, "/plan.md");
		releaseLock(tmp, "/plan.md"); // should not throw
		expect(isLocked(tmp, "/plan.md").locked).toBe(false);
	});
});

describe("isLocked", () => {
	test("returns false for no lock", () => {
		const tmp = withTmp();
		const result = isLocked(tmp, "/plan.md");
		expect(result.locked).toBe(false);
	});

	test("returns true with info for active lock", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md");
		const result = isLocked(tmp, "/plan.md");
		expect(result.locked).toBe(true);
		expect(result.info).toBeDefined();
		const info = result.info;
		if (!info) throw new Error("Expected lock info");
		expect(info.pid).toBe(process.pid);
		expect(info.planPath).toBe("/plan.md");
		expect(result.stale).toBe(false);
	});

	test("detects stale lock", () => {
		const tmp = withTmp();
		const locksDir = join(tmp, ".5x", "locks");
		const { mkdirSync } = require("node:fs");
		mkdirSync(locksDir, { recursive: true });

		const { createHash } = require("node:crypto");
		const hash = createHash("sha256")
			.update("/plan.md")
			.digest("hex")
			.slice(0, 16);
		writeFileSync(
			join(locksDir, `${hash}.lock`),
			JSON.stringify({
				pid: 99999999,
				startedAt: new Date().toISOString(),
				planPath: "/plan.md",
			}),
		);

		const result = isLocked(tmp, "/plan.md");
		expect(result.locked).toBe(true);
		expect(result.stale).toBe(true);
	});
});
