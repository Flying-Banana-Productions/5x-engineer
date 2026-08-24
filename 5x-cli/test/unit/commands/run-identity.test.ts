/**
 * Tests for the ambient run-identity resolver.
 *
 * Uses in-memory SQLite + temp directories. Checkout roots are injected
 * so this file stays off git and safe under `--concurrent`.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneResult } from "../../../src/commands/control-plane.js";
import {
	listActiveRunsForCheckout,
	resolveAmbientRunId,
} from "../../../src/commands/run-identity.js";
import {
	CURRENT_RUN_FILENAME,
	currentRunPath,
	writePointer,
} from "../../../src/commands/run-pointer.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { upsertPlan } from "../../../src/db/operations.js";
import { completeRun, createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";

const RUN_FLAG = "run_flagaaaa01";
const RUN_ENV = "run_envaaaaa02";
const RUN_WT_A = "run_wtaaaaaa03";
const RUN_WT_B = "run_wtbbbbbb04";
const RUN_PTR = "run_pointera05";
const RUN_ELSE = "run_elseaaaa06";
const RUN_PIPE = "run_pipeaaaa07";
const RUN_TERM = "run_terminal08";
const RUN_UNKNOWN = "run_unknowaa09";

let tmp: string;
let db: Database;
let wtA: string;
let wtB: string;
let planA: string;
let planB: string;
let planElse: string;
let extraDirs: string[];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "5x-run-id-"));
	wtA = join(tmp, "wt-a");
	wtB = join(tmp, "wt-b");
	mkdirSync(wtA);
	mkdirSync(wtB);
	mkdirSync(join(tmp, "docs"), { recursive: true });
	planA = join(tmp, "docs", "plan-a.md");
	planB = join(tmp, "docs", "plan-b.md");
	planElse = join(tmp, "docs", "plan-else.md");
	extraDirs = [];
	db = getDb(tmp);
	runMigrations(db);
});

afterEach(() => {
	closeDb();
	_resetForTest();
	rmSync(tmp, { recursive: true, force: true });
	for (const dir of extraDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function cp(stateDir = ".5x"): ControlPlaneResult {
	return { controlPlaneRoot: tmp, stateDir, mode: "managed" };
}

function seedRun(
	runId: string,
	planPath: string,
	worktreePath?: string | null,
): void {
	if (worktreePath === undefined) {
		upsertPlan(db, { planPath });
	} else {
		upsertPlan(db, {
			planPath,
			worktreePath: worktreePath === null ? "" : worktreePath,
		});
	}
	createRunV1(db, { id: runId, planPath });
}

function resolve(
	overrides: Partial<Parameters<typeof resolveAmbientRunId>[0]> & {
		required: boolean;
	},
) {
	return resolveAmbientRunId({
		db,
		controlPlane: cp(),
		env: {},
		...overrides,
	});
}

describe("resolveAmbientRunId precedence", () => {
	test("--run wins over FIVEX_RUN, worktree mapping, and pointer", () => {
		seedRun(RUN_ENV, planA, wtA);
		seedRun(RUN_WT_A, planB, wtA);
		seedRun(RUN_FLAG, planElse);
		writePointer(currentRunPath(tmp, ".5x"), RUN_PTR);
		seedRun(RUN_PTR, join(tmp, "docs", "plan-ptr.md"));

		const result = resolve({
			required: true,
			explicitRun: RUN_FLAG,
			env: { FIVEX_RUN: RUN_ENV },
			checkoutRoot: wtA,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_FLAG);
			expect(result.source).toBe("flag");
		}
	});

	test("FIVEX_RUN wins over worktree mapping and pointer", () => {
		seedRun(RUN_ENV, planElse);
		seedRun(RUN_WT_A, planA, wtA);
		writePointer(currentRunPath(tmp, ".5x"), RUN_WT_A);

		const result = resolve({
			required: true,
			env: { FIVEX_RUN: RUN_ENV },
			checkoutRoot: wtA,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_ENV);
			expect(result.source).toBe("environment");
		}
	});

	test("unique active mapping to injected checkout root → source worktree", () => {
		seedRun(RUN_WT_A, planA, wtA);
		writePointer(currentRunPath(tmp, ".5x"), RUN_ELSE);
		seedRun(RUN_ELSE, planElse, wtB);

		const result = resolve({
			required: true,
			checkoutRoot: wtA,
			startDir: join(wtA, "src", "nested"),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_WT_A);
			expect(result.source).toBe("worktree");
		}
	});

	test("two active runs mapped to the same path → AMBIGUOUS; pointer not consulted", () => {
		seedRun(RUN_WT_A, planA, wtA);
		seedRun(RUN_WT_B, planB, wtA);
		seedRun(RUN_PTR, planElse);
		writePointer(currentRunPath(tmp, ".5x"), RUN_PTR);

		const result = resolve({ required: true, checkoutRoot: wtA });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_CONTEXT_AMBIGUOUS");
			expect(result.error.detail?.candidates).toEqual([RUN_WT_A, RUN_WT_B]);
			expect(result.error.detail?.remediation).toContain("--run");
			expect(result.error.detail?.remediation).toContain("FIVEX_RUN");
		}
	});

	test("pipe id used only when 1–4 produced none", () => {
		seedRun(RUN_PIPE, planElse);

		const result = resolve({
			required: true,
			pipeRunId: RUN_PIPE,
			checkoutRoot: tmp,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_PIPE);
			expect(result.source).toBe("pipe");
		}
	});

	test("pipe id is not used when a compatible pointer exists", () => {
		seedRun(RUN_PTR, planElse);
		seedRun(RUN_PIPE, planA);
		writePointer(currentRunPath(tmp, ".5x"), RUN_PTR);

		const result = resolve({
			required: true,
			pipeRunId: RUN_PIPE,
			checkoutRoot: tmp,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_PTR);
			expect(result.source).toBe("pointer");
		}
	});
});

describe("resolveAmbientRunId pointer compatibility", () => {
	test("linked checkout with zero mappings + pointer to a run mapped elsewhere → INCOMPATIBLE", () => {
		seedRun(RUN_ELSE, planElse, wtB);
		writePointer(currentRunPath(tmp, ".5x"), RUN_ELSE);

		const result = resolve({ required: true, checkoutRoot: wtA });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_POINTER_INCOMPATIBLE");
			expect(result.error.detail?.run_id).toBe(RUN_ELSE);
			expect(result.error.detail?.path).toBe(currentRunPath(tmp, ".5x"));
			expect(result.error.detail?.remediation).toBeTruthy();
		}
	});

	test("linked checkout with zero mappings + pointer to the unique run mapped here → pointer", () => {
		seedRun(RUN_PTR, planA, wtA);
		writePointer(currentRunPath(tmp, ".5x"), RUN_PTR);

		const mapped = resolve({ required: true, checkoutRoot: wtA });
		expect(mapped.ok).toBe(true);
		if (mapped.ok) {
			expect(mapped.runId).toBe(RUN_PTR);
			expect(mapped.source).toBe("worktree");
		}

		completeRun(db, RUN_PTR, "completed");
		seedRun(RUN_ELSE, planElse);
		writePointer(currentRunPath(tmp, ".5x"), RUN_ELSE);
		const result = resolve({ required: true, checkoutRoot: wtA });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_ELSE);
			expect(result.source).toBe("pointer");
		}
	});

	test("non-linked checkout uses pointer even if that run maps to another path", () => {
		seedRun(RUN_ELSE, planElse, wtB);
		writePointer(currentRunPath(tmp, ".5x"), RUN_ELSE);

		const result = resolve({ required: true, checkoutRoot: tmp });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_ELSE);
			expect(result.source).toBe("pointer");
		}
	});
});

describe("resolveAmbientRunId missing identity", () => {
	test("required: false and no signals → none", () => {
		const result = resolve({ required: false, checkoutRoot: tmp });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBeUndefined();
			expect(result.source).toBe("none");
		}
	});

	test("required: true and no signals → RUN_CONTEXT_REQUIRED", () => {
		const result = resolve({ required: true, checkoutRoot: tmp });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_CONTEXT_REQUIRED");
			const remediation = result.error.detail?.remediation ?? "";
			expect(remediation).toContain("--run");
			expect(remediation).toContain("FIVEX_RUN");
			expect(remediation).toContain("worktree");
			expect(remediation).toContain(".5x/current-run");
		}
	});
});

describe("resolveAmbientRunId canonical matching", () => {
	test("symlink worktree path stored in DB matches real checkout root", () => {
		const realWt = join(tmp, "wt-real");
		const linkWt = join(tmp, "wt-link");
		mkdirSync(realWt);
		symlinkSync(realWt, linkWt);
		seedRun(RUN_WT_A, planA, linkWt);

		const result = resolve({ required: true, checkoutRoot: realWt });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_WT_A);
			expect(result.source).toBe("worktree");
		}
	});

	test("nested startDir matches toplevel mapping when checkoutRoot is toplevel", () => {
		const nested = join(wtA, "src", "nested");
		mkdirSync(nested, { recursive: true });
		seedRun(RUN_WT_A, planA, wtA);

		const result = resolve({
			required: true,
			checkoutRoot: wtA,
			startDir: nested,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_WT_A);
			expect(result.source).toBe("worktree");
		}
	});
});

describe("resolveAmbientRunId error cases", () => {
	test("FIVEX_RUN unknown id → RUN_ENV_INVALID, no fallback", () => {
		seedRun(RUN_PTR, planElse);
		writePointer(currentRunPath(tmp, ".5x"), RUN_PTR);

		const result = resolve({
			required: true,
			env: { FIVEX_RUN: RUN_UNKNOWN },
			checkoutRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_ENV_INVALID");
			expect(result.error.detail?.run_id).toBe(RUN_UNKNOWN);
		}
	});

	test("FIVEX_RUN invalid format → RUN_ENV_INVALID, no fallback", () => {
		seedRun(RUN_PTR, planElse);
		writePointer(currentRunPath(tmp, ".5x"), RUN_PTR);

		const result = resolve({
			required: true,
			env: { FIVEX_RUN: "!!!not-a-run-id" },
			checkoutRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_ENV_INVALID");
		}
	});

	test("terminal run in mapping is ignored; pointer to that run → STALE", () => {
		seedRun(RUN_TERM, planA, wtA);
		completeRun(db, RUN_TERM, "completed");
		writePointer(currentRunPath(tmp, ".5x"), RUN_TERM);

		expect(listActiveRunsForCheckout(db, wtA)).toEqual([]);

		const result = resolve({ required: true, checkoutRoot: wtA });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_POINTER_STALE");
			expect(result.error.detail?.run_id).toBe(RUN_TERM);
		}
	});

	test("pointer to a missing run → STALE", () => {
		writePointer(currentRunPath(tmp, ".5x"), RUN_UNKNOWN);

		const result = resolve({ required: true, checkoutRoot: tmp });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_POINTER_STALE");
		}
	});

	test("empty pointer file → RUN_POINTER_INVALID", () => {
		const path = currentRunPath(tmp, ".5x");
		mkdirSync(join(tmp, ".5x"), { recursive: true });
		writeFileSync(path, "\n", "utf-8");

		const result = resolve({ required: true, checkoutRoot: tmp });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("RUN_POINTER_INVALID");
			expect(result.error.detail?.path).toBe(path);
		}
	});

	test("FIVEX_RUN of a completed run is still valid", () => {
		seedRun(RUN_ENV, planElse);
		completeRun(db, RUN_ENV, "completed");

		const result = resolve({
			required: true,
			env: { FIVEX_RUN: RUN_ENV },
			checkoutRoot: tmp,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_ENV);
			expect(result.source).toBe("environment");
		}
	});
});

describe("resolveAmbientRunId absolute stateDir pointer", () => {
	test("pointer via currentRunPath(absStateDir) is source pointer and not under controlPlaneRoot", () => {
		const absStateDir = mkdtempSync(join(tmpdir(), "5x-abs-state-"));
		extraDirs.push(absStateDir);
		seedRun(RUN_PTR, planElse);
		const pointerFile = currentRunPath(tmp, absStateDir);
		writePointer(pointerFile, RUN_PTR);

		expect(pointerFile).toBe(join(absStateDir, CURRENT_RUN_FILENAME));
		expect(existsSync(pointerFile)).toBe(true);
		const shadow = join(tmp, absStateDir, CURRENT_RUN_FILENAME);
		expect(shadow).not.toBe(pointerFile);
		expect(existsSync(shadow)).toBe(false);

		const result = resolve({
			required: true,
			checkoutRoot: tmp,
			controlPlane: cp(absStateDir),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.runId).toBe(RUN_PTR);
			expect(result.source).toBe("pointer");
		}
	});
});
