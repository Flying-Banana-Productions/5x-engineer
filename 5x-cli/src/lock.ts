import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalizePlanPath } from "./paths.js";

export interface LockInfo {
	pid: number;
	startedAt: string; // ISO 8601
	planPath: string;
}

export interface LockResult {
	acquired: boolean;
	existingLock?: LockInfo;
	stale?: boolean;
}

function lockDir(projectRoot: string): string {
	return join(projectRoot, ".5x", "locks");
}

function lockPath(projectRoot: string, planPath: string): string {
	const hash = createHash("sha256").update(planPath).digest("hex").slice(0, 16);
	return join(lockDir(projectRoot), `${hash}.lock`);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code?: string }).code === "EPERM"
		) {
			return true;
		}
		return false;
	}
}

function findExistingLock(
	projectRoot: string,
	canonicalPlanPath: string,
): { path: string; info: LockInfo | null } | null {
	const canonicalPath = lockPath(projectRoot, canonicalPlanPath);
	if (existsSync(canonicalPath)) {
		return { path: canonicalPath, info: readLockFile(canonicalPath) };
	}

	const dir = lockDir(projectRoot);
	if (!existsSync(dir)) return null;

	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".lock")) continue;
		const p = join(dir, entry);
		const info = readLockFile(p);
		if (!info) continue;
		if (canonicalizePlanPath(info.planPath) === canonicalPlanPath) {
			return { path: p, info };
		}
	}

	return null;
}

function readLockFile(path: string): LockInfo | null {
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.startedAt !== "string" ||
			typeof parsed.planPath !== "string"
		) {
			return null;
		}
		return parsed as unknown as LockInfo;
	} catch {
		return null;
	}
}

/**
 * Attempt to acquire a plan-level lock. If a lock exists for a dead process,
 * it is treated as stale and stolen. Returns whether the lock was acquired
 * and details about any existing lock.
 */
export function acquireLock(projectRoot: string, planPath: string): LockResult {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const canonicalPath = lockPath(projectRoot, canonicalPlanPath);
	const dir = lockDir(projectRoot);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const existingLock = findExistingLock(projectRoot, canonicalPlanPath);
	if (existingLock) {
		const existing = existingLock.info;
		if (!existing) {
			// Corrupt lock file — steal it
			writeLock(canonicalPath, canonicalPlanPath);
			if (existingLock.path !== canonicalPath) {
				try {
					unlinkSync(existingLock.path);
				} catch {}
			}
			return { acquired: true, stale: true };
		}

		if (existing.pid === process.pid) {
			// Re-entrant — same process
			return { acquired: true };
		}

		if (isPidAlive(existing.pid)) {
			return { acquired: false, existingLock: existing, stale: false };
		}

		// Stale lock — process is dead, steal it
		writeLock(canonicalPath, canonicalPlanPath);
		if (existingLock.path !== canonicalPath) {
			try {
				unlinkSync(existingLock.path);
			} catch {}
		}
		return { acquired: true, existingLock: existing, stale: true };
	}

	writeLock(canonicalPath, canonicalPlanPath);
	return { acquired: true };
}

function writeLock(path: string, planPath: string): void {
	const info: LockInfo = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		planPath,
	};
	writeFileSync(path, JSON.stringify(info, null, 2));
}

/** Release a plan lock. Idempotent — no-op if lock doesn't exist. */
export function releaseLock(projectRoot: string, planPath: string): void {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const canonicalPath = lockPath(projectRoot, canonicalPlanPath);
	const existing = findExistingLock(projectRoot, canonicalPlanPath);
	try {
		unlinkSync(canonicalPath);
	} catch {
		// Already gone — fine
	}

	if (existing && existing.path !== canonicalPath) {
		try {
			unlinkSync(existing.path);
		} catch {}
	}
}

/** Check if a plan is currently locked. */
export function isLocked(
	projectRoot: string,
	planPath: string,
): { locked: boolean; info?: LockInfo; stale?: boolean } {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const existing = findExistingLock(projectRoot, canonicalPlanPath);
	if (!existing) return { locked: false };

	const info = existing.info;
	if (!info) {
		return { locked: false }; // corrupt file
	}

	if (!isPidAlive(info.pid)) {
		return { locked: true, info, stale: true };
	}

	return { locked: true, info, stale: false };
}

/**
 * Register process exit handlers that release the lock on exit,
 * SIGINT, and SIGTERM.
 */
export function registerLockCleanup(
	projectRoot: string,
	planPath: string,
): void {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const cleanup = () => releaseLock(projectRoot, canonicalPlanPath);
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(143);
	});
}
