/**
 * Unit tests for `phaseFinishCore` (Phase 5 composite).
 *
 * Calls the core directly against a temp git repo + injected DB so tests
 * stay off the process-wide `getDb` singleton and `--concurrent` safe.
 * Quality gates append to `.gate-ran` so resume can assert they were not
 * re-invoked without monkey-patching `console` or `runQualityGates`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DbContext } from "../../../src/commands/context.js";
import { phaseFinishCore } from "../../../src/commands/phase.handler.js";
import {
	currentRunPath,
	writePointer,
} from "../../../src/commands/run-pointer.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import { upsertPlan } from "../../../src/db/operations.js";
import { createRunV1, getSteps } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { CliError } from "../../../src/output.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

interface TestCtx {
	tmp: string;
	db: Database;
	dbContext: DbContext;
	planPath: string;
	runId: string;
}

const RUN_ID = "run_phasefin001";
const AUTHOR_STEP = "author:impl";
const GATE_LOG = ".gate-ran";
const PASSING_GATE = `echo ran >> ${GATE_LOG} && echo ok`;

function setup(opts?: {
	gates?: string[];
	checklistChecked?: boolean;
}): TestCtx {
	const tmp = mkdtempSync(join(tmpdir(), "5x-phase-finish-"));
	Bun.spawnSync(["git", "init"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	mkdirSync(join(tmp, "docs"), { recursive: true });
	const checked = opts?.checklistChecked !== false ? "x" : " ";
	const planPath = join(tmp, "docs", "plan.md");
	writeFileSync(
		planPath,
		`# Test Plan\n\n## Phase 1: Setup\n\n- [${checked}] Do the thing\n`,
	);

	const gates = opts?.gates ?? [PASSING_GATE];
	writeFileSync(
		join(tmp, "5x.toml"),
		`qualityGates = [${gates.map((g) => `"${g}"`).join(", ")}]\n`,
	);
	writeFileSync(join(tmp, ".gitignore"), ".5x/\n5x.toml.local\n");
	writeFileSync(join(tmp, "README.md"), "# test\n");

	Bun.spawnSync(["git", "add", "-A"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	mkdirSync(join(tmp, ".5x"), { recursive: true });
	const db = new Database(resolve(tmp, ".5x", "5x.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);
	createRunV1(db, { id: RUN_ID, planPath });

	const dbContext: DbContext = {
		projectRoot: tmp,
		config: FiveXConfigSchema.parse({}),
		db,
		controlPlane: {
			controlPlaneRoot: tmp,
			stateDir: ".5x",
			mode: "isolated",
		},
	};

	return { tmp, db, dbContext, planPath, runId: RUN_ID };
}

function teardown(ctx: TestCtx): void {
	try {
		ctx.db.close();
	} catch {
		// already closed
	}
	try {
		rmSync(ctx.tmp, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

function writeAuthor(
	ctx: TestCtx,
	payload: unknown,
	filename = "author.json",
): string {
	const p = join(ctx.tmp, filename);
	writeFileSync(p, JSON.stringify(payload));
	return p;
}

function gateRunCount(ctx: TestCtx): number {
	const log = join(ctx.tmp, GATE_LOG);
	if (!existsSync(log)) return 0;
	const text = readFileSync(log, "utf-8").trim();
	if (!text) return 0;
	return text.split("\n").length;
}

function expectCliError(err: unknown, code: string): CliError {
	expect(err).toBeInstanceOf(CliError);
	const cli = err as CliError;
	expect(cli.code).toBe(code);
	return cli;
}

function finishParams(
	ctx: TestCtx,
	overrides: Partial<Parameters<typeof phaseFinishCore>[0]> = {},
) {
	return {
		phase: "1",
		iteration: 1,
		step: AUTHOR_STEP,
		run: ctx.runId,
		startDir: ctx.tmp,
		env: {},
		dbContext: ctx.dbContext,
		...overrides,
	};
}

describe("phaseFinish", () => {
	test("happy path: three completed; quality:check and author step at given iteration", async () => {
		const ctx = setup();
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			const data = await phaseFinishCore(
				finishParams(ctx, { iteration: 2, input }),
			);
			expect(data.steps.map((s) => s.name)).toEqual([
				"quality",
				"protocol",
				"checklist",
			]);
			expect(data.steps.every((s) => s.status === "completed")).toBe(true);

			const rows = getSteps(ctx.db, ctx.runId);
			expect(rows.map((r) => r.step_name).sort()).toEqual(
				[AUTHOR_STEP, "quality:check"].sort(),
			);
			for (const row of rows) {
				expect(row.phase).toBe("1");
				expect(row.iteration).toBe(2);
			}
		} finally {
			teardown(ctx);
		}
	});

	test("rerun same keys: no extra rows; recorded false; quality core not re-invoked", async () => {
		const ctx = setup();
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			const params = finishParams(ctx, { input });
			await phaseFinishCore(params);
			expect(gateRunCount(ctx)).toBeGreaterThanOrEqual(1);
			const firstGates = gateRunCount(ctx);
			const before = getSteps(ctx.db, ctx.runId).length;

			const data = await phaseFinishCore(params);
			expect(gateRunCount(ctx)).toBe(firstGates);
			expect(getSteps(ctx.db, ctx.runId).length).toBe(before);
			expect(data.steps.every((s) => s.status === "completed")).toBe(true);
			expect(data.steps[0]?.recorded).toBe(false);
			expect(data.steps[1]?.recorded).toBe(false);
		} finally {
			teardown(ctx);
		}
	});

	test("quality fail: QUALITY_FAILED, no quality:check row; rerun after fix records at same iteration", async () => {
		const ctx = setup({ gates: ["false"] });
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			try {
				await phaseFinishCore(finishParams(ctx, { iteration: 3, input }));
				throw new Error("expected QUALITY_FAILED");
			} catch (err) {
				const cli = expectCliError(err, "QUALITY_FAILED");
				const detail = cli.detail as Record<string, unknown>;
				expect(detail.failing_step).toBe("quality");
				const steps = detail.steps as Array<Record<string, unknown>>;
				expect(steps[0]?.status).toBe("failed");
				expect(steps[1]?.status).toBe("skipped");
				expect(steps[2]?.status).toBe("skipped");
			}
			expect(getSteps(ctx.db, ctx.runId)).toEqual([]);

			writeFileSync(
				join(ctx.tmp, "5x.toml"),
				`qualityGates = ["${PASSING_GATE}"]\n`,
			);
			const data = await phaseFinishCore(
				finishParams(ctx, { iteration: 3, input }),
			);
			expect(data.steps.every((s) => s.status === "completed")).toBe(true);
			const rows = getSteps(ctx.db, ctx.runId);
			expect(rows.some((r) => r.step_name === "quality:check")).toBe(true);
			expect(rows.every((r) => r.iteration === 3)).toBe(true);
		} finally {
			teardown(ctx);
		}
	});

	test("invalid author JSON: protocol failed; checklist skipped; no author step row", async () => {
		const ctx = setup();
		try {
			const input = writeAuthor(ctx, { nope: true });
			try {
				await phaseFinishCore(finishParams(ctx, { input }));
				throw new Error("expected protocol failure");
			} catch (err) {
				const cli = err as CliError;
				expect(cli).toBeInstanceOf(CliError);
				const detail = cli.detail as Record<string, unknown>;
				expect(detail.failing_step).toBe("protocol");
				const steps = detail.steps as Array<Record<string, unknown>>;
				expect(steps[0]?.status).toBe("completed");
				expect(steps[1]?.status).toBe("failed");
				expect(steps[2]?.status).toBe("skipped");
			}
			const rows = getSteps(ctx.db, ctx.runId);
			expect(rows.map((r) => r.step_name)).toEqual(["quality:check"]);
		} finally {
			teardown(ctx);
		}
	});

	test("incomplete checklist with author complete: PHASE_CHECKLIST_INCOMPLETE; quality recorded; no author record; rerun skips quality", async () => {
		const ctx = setup({ checklistChecked: false });
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			const params = finishParams(ctx, { input });
			try {
				await phaseFinishCore(params);
				throw new Error("expected PHASE_CHECKLIST_INCOMPLETE");
			} catch (err) {
				const cli = expectCliError(err, "PHASE_CHECKLIST_INCOMPLETE");
				expect(cli.exitCode).toBe(8);
				const detail = cli.detail as Record<string, unknown>;
				expect(detail.failing_step).toBe("checklist");
			}
			expect(getSteps(ctx.db, ctx.runId).map((r) => r.step_name)).toEqual([
				"quality:check",
			]);
			const callsAfterFail = gateRunCount(ctx);

			writeFileSync(
				ctx.planPath,
				"# Test Plan\n\n## Phase 1: Setup\n\n- [x] Do the thing\n",
			);
			await phaseFinishCore(params);
			expect(gateRunCount(ctx)).toBe(callsAfterFail);
			expect(
				getSteps(ctx.db, ctx.runId).some((r) => r.step_name === AUTHOR_STEP),
			).toBe(true);
		} finally {
			teardown(ctx);
		}
	});

	test("fresh needs_human: protocol completed; checklist skipped; author recorded; exit 0", async () => {
		const ctx = setup({ checklistChecked: false });
		try {
			const input = writeAuthor(ctx, {
				result: "needs_human",
				reason: "Need a design decision",
			});
			const data = await phaseFinishCore(finishParams(ctx, { input }));
			expect(data.steps[1]?.status).toBe("completed");
			expect(data.steps[2]?.status).toBe("skipped");
			const author = getSteps(ctx.db, ctx.runId).find(
				(r) => r.step_name === AUTHOR_STEP,
			);
			expect(author).toBeDefined();
			expect(JSON.parse(author?.result_json ?? "{}").result).toBe(
				"needs_human",
			);
		} finally {
			teardown(ctx);
		}
	});

	test("resumed needs_human: checklist skipped; no extra row; checklist not re-evaluated", async () => {
		const ctx = setup({ checklistChecked: false });
		try {
			const input = writeAuthor(ctx, {
				result: "needs_human",
				reason: "Need a design decision",
			});
			const params = finishParams(ctx, { input });
			await phaseFinishCore(params);
			const before = getSteps(ctx.db, ctx.runId).length;
			const data = await phaseFinishCore(params);
			expect(getSteps(ctx.db, ctx.runId).length).toBe(before);
			expect(data.steps[2]?.status).toBe("skipped");
		} finally {
			teardown(ctx);
		}
	});

	test("resumed complete author: checklist completed without re-evaluating", async () => {
		const ctx = setup({ checklistChecked: true });
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			const params = finishParams(ctx, { input });
			await phaseFinishCore(params);
			writeFileSync(
				ctx.planPath,
				"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Undone again\n",
			);
			const data = await phaseFinishCore(params);
			expect(data.steps[2]?.status).toBe("completed");
		} finally {
			teardown(ctx);
		}
	});

	test("--no-phase-checklist-validate: checklist completed without reading plan checkboxes", async () => {
		const ctx = setup({ checklistChecked: false });
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			const data = await phaseFinishCore(
				finishParams(ctx, { input, phaseChecklistValidate: false }),
			);
			expect(data.steps[2]?.status).toBe("completed");
			expect(
				getSteps(ctx.db, ctx.runId).some((r) => r.step_name === AUTHOR_STEP),
			).toBe(true);
		} finally {
			teardown(ctx);
		}
	});

	test("missing run / env / pointer: RUN_CONTEXT_REQUIRED before gates", async () => {
		const ctx = setup();
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			try {
				await phaseFinishCore(finishParams(ctx, { input, run: undefined }));
				throw new Error("expected RUN_CONTEXT_REQUIRED");
			} catch (err) {
				expectCliError(err, "RUN_CONTEXT_REQUIRED");
			}
			expect(gateRunCount(ctx)).toBe(0);
		} finally {
			teardown(ctx);
		}
	});

	test("explicit --run matches ambient pointer", async () => {
		const ctx = setup();
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			writePointer(currentRunPath(ctx.tmp, ".5x"), ctx.runId);

			const viaFlag = await phaseFinishCore(
				finishParams(ctx, { iteration: 4, input }),
			);
			const viaPointer = await phaseFinishCore(
				finishParams(ctx, { iteration: 5, input, run: undefined }),
			);
			expect(viaFlag.run_id).toBe(ctx.runId);
			expect(viaPointer.run_id).toBe(ctx.runId);
		} finally {
			teardown(ctx);
		}
	});

	test("quality executes in mapped worktree, not startDir", async () => {
		const ctx = setup();
		try {
			const wt = join(ctx.tmp, "linked-wt");
			mkdirSync(wt, { recursive: true });
			upsertPlan(ctx.db, {
				planPath: ctx.planPath,
				worktreePath: wt,
			});
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			await phaseFinishCore(
				finishParams(ctx, { input, phaseChecklistValidate: false }),
			);
			expect(existsSync(join(wt, GATE_LOG))).toBe(true);
			expect(existsSync(join(ctx.tmp, GATE_LOG))).toBe(false);
		} finally {
			teardown(ctx);
		}
	});

	test("author payload phase different from --phase: PHASE_MISMATCH; quality recorded; no author row", async () => {
		const ctx = setup();
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
				phase: "2",
			});
			try {
				await phaseFinishCore(finishParams(ctx, { input }));
				throw new Error("expected PHASE_MISMATCH");
			} catch (err) {
				const cli = expectCliError(err, "PHASE_MISMATCH");
				const detail = cli.detail as Record<string, unknown>;
				expect(detail.failing_step).toBe("protocol");
				const steps = detail.steps as Array<Record<string, unknown>>;
				expect(steps[0]?.status).toBe("completed");
				expect(steps[1]?.status).toBe("failed");
				expect(steps[2]?.status).toBe("skipped");
			}
			expect(getSteps(ctx.db, ctx.runId).map((r) => r.step_name)).toEqual([
				"quality:check",
			]);
		} finally {
			teardown(ctx);
		}
	});

	test("author payload phase matching --phase records successfully", async () => {
		const ctx = setup();
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
				phase: "1",
			});
			const data = await phaseFinishCore(finishParams(ctx, { input }));
			expect(data.steps.every((s) => s.status === "completed")).toBe(true);
			expect(
				getSteps(ctx.db, ctx.runId).some((r) => r.step_name === AUTHOR_STEP),
			).toBe(true);
		} finally {
			teardown(ctx);
		}
	});
});
