/**
 * Tests for the run execution context resolver.
 *
 * Uses in-memory SQLite databases — no git repos or worktrees needed.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunExecutionContext } from "../../../src/commands/run-context.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/schema.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmp: string;
let db: Database;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "5x-run-ctx-"));
	db = getDb(tmp);
	runMigrations(db);
});

afterEach(() => {
	closeDb();
	_resetForTest();
	rmSync(tmp, { recursive: true, force: true });
});

function createRun(planPath: string, runId = "run_test123456"): void {
	db.query("INSERT INTO runs (id, plan_path) VALUES (?1, ?2)").run(
		runId,
		planPath,
	);
}

function createPlan(
	planPath: string,
	worktreePath: string | null = null,
): void {
	db.query("INSERT INTO plans (plan_path, worktree_path) VALUES (?1, ?2)").run(
		planPath,
		worktreePath,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveRunExecutionContext", () => {
	test("run not found returns RUN_NOT_FOUND error", () => {
		const result = resolveRunExecutionContext(db, "run_nonexistent", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_NOT_FOUND");
		}
	});

	test("plan path outside control-plane root returns PLAN_PATH_INVALID", () => {
		const outsidePath = "/some/external/path/plan.md";
		createRun(outsidePath);

		const result = resolveRunExecutionContext(db, "run_test123456", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PLAN_PATH_INVALID");
			expect(result.error.detail?.path).toBe(outsidePath);
			expect(result.error.detail?.remediation).toBeTruthy();
		}
	});

	test("no worktree mapping: effectiveWorkingDirectory = controlPlaneRoot", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");
		createRun(planPath);

		const result = resolveRunExecutionContext(db, "run_test123456", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.context.effectiveWorkingDirectory).toBe(tmp);
			expect(result.context.effectivePlanPath).toBe(planPath);
			expect(result.context.mappedWorktreePath).toBeNull();
		}
	});

	test("worktree mapped and accessible: effectiveWorkingDirectory = worktree", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		const wtPath = mkdtempSync(join(tmpdir(), "5x-wt-"));
		try {
			// Create the plan file in the worktree too
			mkdirSync(join(wtPath, "docs"), { recursive: true });
			writeFileSync(join(wtPath, "docs", "plan.md"), "# Plan WT\n");

			createPlan(planPath, wtPath);
			createRun(planPath);

			const result = resolveRunExecutionContext(db, "run_test123456", {
				controlPlaneRoot: tmp,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.context.effectiveWorkingDirectory).toBe(wtPath);
				expect(result.context.mappedWorktreePath).toBe(wtPath);
				expect(result.context.effectivePlanPath).toBe(
					join(wtPath, "docs", "plan.md"),
				);
				expect(result.context.planPathInWorktreeExists).toBe(true);
			}
		} finally {
			rmSync(wtPath, { recursive: true, force: true });
		}
	});

	test("worktree mapped but plan file missing in worktree: still resolves to worktree path", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		const wtPath = mkdtempSync(join(tmpdir(), "5x-wt-noplan-"));
		try {
			// Do NOT create plan file in the worktree
			createPlan(planPath, wtPath);
			createRun(planPath);

			const result = resolveRunExecutionContext(db, "run_test123456", {
				controlPlaneRoot: tmp,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.context.effectiveWorkingDirectory).toBe(wtPath);
				// Always resolves to worktree path so new files are created there
				expect(result.context.effectivePlanPath).toBe(
					join(wtPath, "docs", "plan.md"),
				);
				expect(result.context.planPathInWorktreeExists).toBe(false);
			}
		} finally {
			rmSync(wtPath, { recursive: true, force: true });
		}
	});

	test("worktree mapped but missing on disk: WORKTREE_MISSING error", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		const missingWtPath = join(tmpdir(), `5x-missing-wt-${Date.now()}`);
		createPlan(planPath, missingWtPath);
		createRun(planPath);

		const result = resolveRunExecutionContext(db, "run_test123456", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("WORKTREE_MISSING");
			expect(result.error.detail?.path).toBe(missingWtPath);
			expect(result.error.detail?.remediation).toBeTruthy();
		}
	});

	test("WORKTREE_MISSING error includes expected path and remediation guidance text", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		const missingWtPath = join(tmpdir(), `5x-wt-msg-${Date.now()}`);
		createPlan(planPath, missingWtPath);
		createRun(planPath);

		const result = resolveRunExecutionContext(db, "run_test123456", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("WORKTREE_MISSING");
			// Error detail must include the actual missing path
			expect(result.error.detail?.path).toBe(missingWtPath);
			// Remediation must mention re-attach or remove
			const remediation = result.error.detail?.remediation as string;
			expect(remediation).toBeTruthy();
			expect(
				remediation.includes("re-attach") ||
					remediation.includes("remove") ||
					remediation.includes("Re-attach") ||
					remediation.includes("Remove"),
			).toBe(true);
			// Error message should be descriptive
			expect(result.error.message).toBeTruthy();
		}
	});

	test("explicit workdir overrides worktree mapping", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		const wtPath = mkdtempSync(join(tmpdir(), "5x-wt-override-"));
		const explicitDir = mkdtempSync(join(tmpdir(), "5x-explicit-"));
		try {
			createPlan(planPath, wtPath);
			createRun(planPath);

			const result = resolveRunExecutionContext(db, "run_test123456", {
				controlPlaneRoot: tmp,
				explicitWorkdir: explicitDir,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				// Explicit workdir wins over mapped worktree
				expect(result.context.effectiveWorkingDirectory).toBe(explicitDir);
				// Plan path is still the root plan path (no worktree re-rooting)
				expect(result.context.effectivePlanPath).toBe(planPath);
			}
		} finally {
			rmSync(wtPath, { recursive: true, force: true });
			rmSync(explicitDir, { recursive: true, force: true });
		}
	});

	test("run with plan_path in plan table but no worktree: works normally", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		// Plan exists in DB but has no worktree mapping
		createPlan(planPath, null);
		createRun(planPath);

		const result = resolveRunExecutionContext(db, "run_test123456", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.context.effectiveWorkingDirectory).toBe(tmp);
			expect(result.context.mappedWorktreePath).toBeNull();
		}
	});

	test("run with no plan entry in plans table: works normally", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		// Only create run, no plan entry
		createRun(planPath);

		const result = resolveRunExecutionContext(db, "run_test123456", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.context.effectiveWorkingDirectory).toBe(tmp);
			expect(result.context.mappedWorktreePath).toBeNull();
		}
	});
});
