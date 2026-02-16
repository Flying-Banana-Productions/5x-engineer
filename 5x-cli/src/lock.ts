import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

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
  } catch {
    return false;
  }
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
export function acquireLock(
  projectRoot: string,
  planPath: string
): LockResult {
  const path = lockPath(projectRoot, planPath);
  const dir = lockDir(projectRoot);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(path)) {
    const existing = readLockFile(path);
    if (!existing) {
      // Corrupt lock file — steal it
      writeLock(path, planPath);
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
    writeLock(path, planPath);
    return { acquired: true, existingLock: existing, stale: true };
  }

  writeLock(path, planPath);
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
  const path = lockPath(projectRoot, planPath);
  try {
    unlinkSync(path);
  } catch {
    // Already gone — fine
  }
}

/** Check if a plan is currently locked. */
export function isLocked(
  projectRoot: string,
  planPath: string
): { locked: boolean; info?: LockInfo; stale?: boolean } {
  const path = lockPath(projectRoot, planPath);

  if (!existsSync(path)) {
    return { locked: false };
  }

  const info = readLockFile(path);
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
  planPath: string
): void {
  const cleanup = () => releaseLock(projectRoot, planPath);
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
