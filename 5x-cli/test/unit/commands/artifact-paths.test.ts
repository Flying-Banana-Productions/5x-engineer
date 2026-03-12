/**
 * Tests for Phase 3c artifact path re-anchoring.
 *
 * Verifies that artifact paths (locks, worktrees, debug, logs) resolve
 * under `controlPlaneRoot/stateDir` when various modules are invoked
 * with a `stateDir` parameter, rather than hardcoded under `.5x/`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugTraceLogger } from "../../../src/debug/trace.js";
import { acquireLock, isLocked, releaseLock } from "../../../src/lock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function withTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "5x-artifacts-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true });
		} catch {}
	}
	tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Lock directory re-anchoring
// ---------------------------------------------------------------------------

describe("lock artifact paths", () => {
	test("acquireLock creates locks under default .5x/locks", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md");
		expect(existsSync(join(tmp, ".5x", "locks"))).toBe(true);
	});

	test("acquireLock creates locks under custom stateDir/locks", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md", { stateDir: "custom-state" });
		expect(existsSync(join(tmp, "custom-state", "locks"))).toBe(true);
		// Should NOT create .5x/locks
		expect(existsSync(join(tmp, ".5x", "locks"))).toBe(false);
	});

	test("releaseLock uses custom stateDir", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md", { stateDir: "custom-state" });
		expect(isLocked(tmp, "/plan.md", { stateDir: "custom-state" }).locked).toBe(
			true,
		);

		const result = releaseLock(tmp, "/plan.md", { stateDir: "custom-state" });
		expect(result.released).toBe(true);
		expect(result.reason).toBe("released");
		expect(isLocked(tmp, "/plan.md", { stateDir: "custom-state" }).locked).toBe(
			false,
		);
	});

	test("lock with different stateDir does not conflict with default", () => {
		const tmp = withTmp();
		acquireLock(tmp, "/plan.md"); // default .5x
		acquireLock(tmp, "/plan.md", { stateDir: "alt" }); // custom

		expect(isLocked(tmp, "/plan.md").locked).toBe(true);
		expect(isLocked(tmp, "/plan.md", { stateDir: "alt" }).locked).toBe(true);

		// Release only the default one
		releaseLock(tmp, "/plan.md");
		expect(isLocked(tmp, "/plan.md").locked).toBe(false);
		// Custom should still be locked
		expect(isLocked(tmp, "/plan.md", { stateDir: "alt" }).locked).toBe(true);

		releaseLock(tmp, "/plan.md", { stateDir: "alt" });
	});

	test("isLocked uses custom stateDir", () => {
		const tmp = withTmp();
		// Lock with custom stateDir
		acquireLock(tmp, "/plan.md", { stateDir: "my-state" });

		// Check with matching stateDir — should be locked
		expect(isLocked(tmp, "/plan.md", { stateDir: "my-state" }).locked).toBe(
			true,
		);

		// Check with default stateDir — should NOT be locked
		expect(isLocked(tmp, "/plan.md").locked).toBe(false);

		releaseLock(tmp, "/plan.md", { stateDir: "my-state" });
	});
});

// ---------------------------------------------------------------------------
// Debug trace re-anchoring
// ---------------------------------------------------------------------------

describe("debug trace artifact paths", () => {
	test("creates debug dir under default .5x/debug", () => {
		const tmp = withTmp();
		const logger = createDebugTraceLogger({
			enabled: true,
			projectRoot: tmp,
			command: "test",
		});

		expect(logger.enabled).toBe(true);
		expect(existsSync(join(tmp, ".5x", "debug"))).toBe(true);
		expect(logger.filePath).toBeDefined();
		expect(logger.filePath?.startsWith(join(tmp, ".5x", "debug"))).toBe(true);
	});

	test("creates debug dir under custom stateDir/debug", () => {
		const tmp = withTmp();
		const logger = createDebugTraceLogger({
			enabled: true,
			projectRoot: tmp,
			command: "test",
			stateDir: "custom-state",
		});

		expect(logger.enabled).toBe(true);
		expect(existsSync(join(tmp, "custom-state", "debug"))).toBe(true);
		expect(
			logger.filePath?.startsWith(join(tmp, "custom-state", "debug")),
		).toBe(true);
		// Should NOT create .5x/debug
		expect(existsSync(join(tmp, ".5x", "debug"))).toBe(false);
	});

	test("disabled logger does not create debug dir", () => {
		const tmp = withTmp();
		const logger = createDebugTraceLogger({
			enabled: false,
			projectRoot: tmp,
			command: "test",
			stateDir: "custom-state",
		});

		expect(logger.enabled).toBe(false);
		expect(logger.filePath).toBeUndefined();
		expect(existsSync(join(tmp, "custom-state", "debug"))).toBe(false);
	});

	test("trace writes to custom stateDir", () => {
		const tmp = withTmp();
		const logger = createDebugTraceLogger({
			enabled: true,
			projectRoot: tmp,
			command: "test",
			stateDir: "my-state",
		});

		logger.trace("test_event", { foo: "bar" });

		// Verify file was written
		expect(logger.filePath).toBeDefined();
		expect(existsSync(logger.filePath as string)).toBe(true);
	});
});
