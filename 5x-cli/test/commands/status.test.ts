import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import { createRun } from "../../src/db/operations.js";
import { runMigrations } from "../../src/db/schema.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

async function runStatus(
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "status", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

describe("5x status", () => {
	test("displays plan progress for fixture with mixed completion", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-status-mixed-"));
		const fixture = join(tmp, "plan.md");
		writeFileSync(
			fixture,
			`# Test Implementation Plan

**Version:** 1.0

## Phase 1: Foundation

- [x] Completed task
- [ ] Pending task

## Phase 2: Implementation

- [x] Another completed task
- [x] All done here

Overall: 60% (3/5 tasks)
`,
		);
		try {
			const { stdout, exitCode } = await runStatus([fixture]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Test Implementation Plan");
			expect(stdout).toContain("Phase 1");
			expect(stdout).toContain("Phase 2");
			expect(stdout).toContain("Overall:");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("shows 0% for fixture with all-unchecked items", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-status-"));
		const fixture = join(tmp, "plan.md");
		writeFileSync(
			fixture,
			`# Test Plan

**Version:** 1.0

## Phase 1: Setup

- [ ] First task
- [ ] Second task

## Phase 2: Build

- [ ] Third task
`,
		);
		try {
			const { stdout, exitCode } = await runStatus([fixture]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("0%");
			expect(stdout).toContain("Phase 1");
			expect(stdout).toContain("Phase 2");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("errors on missing file", async () => {
		const { stderr, exitCode } = await runStatus(["nonexistent.md"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("not found");
	});

	test("respects config db.path and does not create DB when missing", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-status-cfg-"));
		const fixture = join(tmp, "plan.md");
		writeFileSync(
			fixture,
			`# Test Plan\n\n**Version:** 1.0\n\n## Phase 1: Setup\n\n- [ ] Task\n`,
		);
		writeFileSync(
			join(tmp, "5x.config.js"),
			`export default { db: { path: ".5x/custom.db" } };\n`,
		);

		try {
			const { stdout, exitCode } = await runStatus([fixture]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Test Plan");
			expect(existsSync(join(tmp, ".5x", "custom.db"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});

	test("uses config db.path for run state", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "5x-status-db-"));
		const fixture = join(tmp, "plan.md");
		writeFileSync(
			fixture,
			`# Test Plan\n\n**Version:** 1.0\n\n## Phase 1: Setup\n\n- [ ] Task\n`,
		);
		writeFileSync(
			join(tmp, "5x.config.js"),
			`export default { db: { path: ".5x/custom.db" } };\n`,
		);

		try {
			const db = getDb(tmp, ".5x/custom.db");
			runMigrations(db);
			const canonicalPlanPath = realpathSync(fixture);
			createRun(db, {
				id: "run1",
				planPath: canonicalPlanPath,
				command: "run",
			});

			closeDb();
			_resetForTest();

			const { stdout, exitCode, stderr } = await runStatus([fixture]);
			expect(exitCode).toBe(0);
			expect(stderr).not.toContain("Migration");
			expect(stdout).toContain("Active run: run1");
		} finally {
			rmSync(tmp, { recursive: true });
		}
	});
});
