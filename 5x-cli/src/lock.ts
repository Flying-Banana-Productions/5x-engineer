import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

/**
 * Lock directory options. When `stateDir` is provided, locks are created
 * under `<projectRoot>/<stateDir>/locks` instead of `<projectRoot>/.5x/locks`.
 * This allows callers to anchor locks to `controlPlaneRoot/stateDir` (Phase 3c).
 */
export interface LockDirOpts {
	stateDir?: string;
}

function lockDir(projectRoot: string, opts?: LockDirOpts): string {
	const sd = opts?.stateDir ?? ".5x";
	return join(projectRoot, sd, "locks");
}

function lockPath(
	projectRoot: string,
	planPath: string,
	opts?: LockDirOpts,
): string {
	const hash = createHash("sha256").update(planPath).digest("hex").slice(0, 16);
	return join(lockDir(projectRoot, opts), `${hash}.lock`);
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
	opts?: LockDirOpts,
): { path: string; info: LockInfo | null } | null {
	const canonicalPath = lockPath(projectRoot, canonicalPlanPath, opts);
	if (existsSync(canonicalPath)) {
		return { path: canonicalPath, info: readLockFile(canonicalPath) };
	}

	const dir = lockDir(projectRoot, opts);
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
 *
 * @param projectRoot - Base directory (typically controlPlaneRoot)
 * @param planPath - Plan path to lock
 * @param opts - Optional: `stateDir` to anchor locks under a custom state directory
 */
export function acquireLock(
	projectRoot: string,
	planPath: string,
	opts?: LockDirOpts,
): LockResult {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const canonicalPath = lockPath(projectRoot, canonicalPlanPath, opts);
	const dir = lockDir(projectRoot, opts);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const existingLock = findExistingLock(projectRoot, canonicalPlanPath, opts);
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

export interface ReleaseLockResult {
	released: boolean;
	reason?: "not_locked" | "not_owner" | "released" | "stale_released";
}

/**
 * Release a plan lock. Ownership-safe: only removes the lock when
 * the lock is owned by the current process OR the owning PID is dead (stale).
 * Returns whether the lock was actually released.
 *
 * Use `forceReleaseLock()` if you need to remove a lock regardless of owner.
 *
 * @param projectRoot - Base directory (typically controlPlaneRoot)
 * @param planPath - Plan path whose lock to release
 * @param opts - Optional: `stateDir` to anchor locks under a custom state directory
 */
export function releaseLock(
	projectRoot: string,
	planPath: string,
	opts?: LockDirOpts,
): ReleaseLockResult {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const canonicalPath = lockPath(projectRoot, canonicalPlanPath, opts);
	const existing = findExistingLock(projectRoot, canonicalPlanPath, opts);

	if (!existing) {
		return { released: true, reason: "not_locked" };
	}

	const info = existing.info;

	// Corrupt lock file — safe to remove
	if (!info) {
		removeLockFiles(canonicalPath, existing.path);
		return { released: true, reason: "stale_released" };
	}

	// Owned by current process — safe to release
	if (info.pid === process.pid) {
		removeLockFiles(canonicalPath, existing.path);
		return { released: true, reason: "released" };
	}

	// Owned by a dead process — stale, safe to release
	if (!isPidAlive(info.pid)) {
		removeLockFiles(canonicalPath, existing.path);
		return { released: true, reason: "stale_released" };
	}

	// Owned by another live process — refuse to release
	return { released: false, reason: "not_owner" };
}

/**
 * Force-release a plan lock regardless of ownership.
 * Use sparingly — this bypasses the ownership safety check.
 *
 * @param projectRoot - Base directory (typically controlPlaneRoot)
 * @param planPath - Plan path whose lock to force-release
 * @param opts - Optional: `stateDir` to anchor locks under a custom state directory
 */
export function forceReleaseLock(
	projectRoot: string,
	planPath: string,
	opts?: LockDirOpts,
): void {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const canonicalPath = lockPath(projectRoot, canonicalPlanPath, opts);
	const existing = findExistingLock(projectRoot, canonicalPlanPath, opts);
	removeLockFiles(canonicalPath, existing?.path);
}

function removeLockFiles(canonicalPath: string, existingPath?: string): void {
	try {
		unlinkSync(canonicalPath);
	} catch {
		// Already gone — fine
	}
	if (existingPath && existingPath !== canonicalPath) {
		try {
			unlinkSync(existingPath);
		} catch {}
	}
}

/**
 * Check if a plan is currently locked.
 *
 * @param projectRoot - Base directory (typically controlPlaneRoot)
 * @param planPath - Plan path to check
 * @param opts - Optional: `stateDir` to anchor locks under a custom state directory
 */
export function isLocked(
	projectRoot: string,
	planPath: string,
	opts?: LockDirOpts,
): { locked: boolean; info?: LockInfo; stale?: boolean } {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const existing = findExistingLock(projectRoot, canonicalPlanPath, opts);
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

export type LockLiveness = "live" | "stale" | "corrupt";

export interface LockEntry {
	/** Absolute path to the `.lock` file. */
	lockPath: string;
	/** Present when the file parsed; omitted/null when corrupt. */
	info: LockInfo | null;
	liveness: LockLiveness;
}

function classifyLock(lockFilePath: string, info: LockInfo | null): LockEntry {
	const absolute = resolve(lockFilePath);
	if (!info) {
		return { lockPath: absolute, info: null, liveness: "corrupt" };
	}
	return {
		lockPath: absolute,
		info,
		liveness: isPidAlive(info.pid) ? "live" : "stale",
	};
}

/**
 * List every lock file under the project's lock directory. Never mutates.
 * Missing or empty lock directories return `[]` — the directory is not created.
 */
export function listLocks(
	projectRoot: string,
	opts?: LockDirOpts,
): LockEntry[] {
	const dir = lockDir(projectRoot, opts);
	if (!existsSync(dir)) return [];

	const entries: LockEntry[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".lock")) continue;
		const p = join(dir, name);
		entries.push(classifyLock(p, readLockFile(p)));
	}
	entries.sort((a, b) => a.lockPath.localeCompare(b.lockPath));
	return entries;
}

/**
 * Plan-keyed lock inspector. Returns `null` when no file is associated with
 * the plan. Canonical-path corrupt files are visible here; non-canonical
 * unparsable leftovers are not (use `listLocks`).
 */
export function inspectLock(
	projectRoot: string,
	planPath: string,
	opts?: LockDirOpts,
): LockEntry | null {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const existing = findExistingLock(projectRoot, canonicalPlanPath, opts);
	if (!existing) return null;
	return classifyLock(existing.path, existing.info);
}

export type RemoveCorruptLockResult =
	| { removed: true }
	| {
			removed: false;
			reason: "not_found" | "not_in_lock_dir" | "not_corrupt" | "unlink_failed";
	  };

/**
 * True when `candidate` is a direct child of `dir` after resolve/realpath.
 * Rejects `..` escapes and nested subdirectories.
 *
 * When `candidate` does not exist, its parent is realpath'd so macOS
 * `/var` → `/private/var` does not false-reject a missing lock-dir child.
 */
function isDirectChildOfLockDir(candidate: string, dir: string): boolean {
	let resolvedDir = resolve(dir);
	let resolvedCandidate = resolve(candidate);
	try {
		if (existsSync(resolvedDir)) {
			resolvedDir = realpathSync(resolvedDir);
		}
		if (existsSync(resolvedCandidate)) {
			resolvedCandidate = realpathSync(resolvedCandidate);
		} else {
			const parent = dirname(resolvedCandidate);
			if (existsSync(parent)) {
				resolvedCandidate = join(
					realpathSync(parent),
					basename(resolvedCandidate),
				);
			}
		}
	} catch {
		return false;
	}
	return dirname(resolvedCandidate) === resolvedDir;
}

/**
 * Remove one corrupt lock file by exact path.
 * Confined to lockDir(projectRoot, opts); re-validates corrupt before unlink.
 * Never resolves by plan_path — corrupt entries may have none.
 */
export function removeCorruptLock(
	projectRoot: string,
	lockPath: string,
	opts?: LockDirOpts,
): RemoveCorruptLockResult {
	const dir = lockDir(projectRoot, opts);
	const absolute = resolve(lockPath);
	if (!isDirectChildOfLockDir(absolute, dir)) {
		return { removed: false, reason: "not_in_lock_dir" };
	}
	if (!existsSync(absolute)) {
		return { removed: false, reason: "not_found" };
	}
	const info = readLockFile(absolute);
	if (info) {
		return { removed: false, reason: "not_corrupt" };
	}
	try {
		unlinkSync(absolute);
		return { removed: true };
	} catch {
		return { removed: false, reason: "unlink_failed" };
	}
}

/**
 * Register a process `exit` handler that releases the lock.
 *
 * SIGINT/SIGTERM are owned by `cli-lifecycle.ts`; this helper must not
 * call `process.exit`. Lock release is idempotent and independent of
 * DB close — both run on `exit`, never on the signal itself.
 *
 * @param projectRoot - Base directory (typically controlPlaneRoot)
 * @param planPath - Plan path whose lock to clean up
 * @param opts - Optional: `stateDir` to anchor locks under a custom state directory
 */
export function registerLockCleanup(
	projectRoot: string,
	planPath: string,
	opts?: LockDirOpts,
): void {
	const canonicalPlanPath = canonicalizePlanPath(planPath);
	const cleanup = () => releaseLock(projectRoot, canonicalPlanPath, opts);
	process.on("exit", cleanup);
}
