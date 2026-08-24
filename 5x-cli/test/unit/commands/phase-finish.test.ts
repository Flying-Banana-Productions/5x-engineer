/**
 * Unit tests for `phaseFinish` (Phase 5 composite).
 *
 * Calls the handler directly against a temp git repo + DB. Quality gates
 * are `echo ok` or `false`. Author JSON is file-based (`--input`).
 */

import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phaseFinish } from "../../../src/commands/phase.handler.js";
import { writePointer } from "../../../src/commands/run-pointer.js";
import { currentRunPath } from "../../../src/commands/run-pointer.js";
import { createRunV1, getSteps } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import * as qualityGates from "../../../src/gates/quality.js";
import { CliError } from "../../../src/output.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

interface TestCtx {
	tmp: string;
	db: Database;
	planPath: string;
	runId: string;
}

const RUN_ID = "run_phasefin001";
const AUTHOR_STEP = "author:impl";

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

	const gates = opts?.gates ?? ["echo ok"];
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
	const db = new Database(join(tmp, ".5x", "5x.db"));
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	runMigrations(db);
	createRunV1(db, { id: RUN_ID, planPath });

	return { tmp, db, planPath, runId: RUN_ID };
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

async function captureSuccess(
	fn: () => Promise<void>,
): Promise<Record<string, unknown>> {
	const lines: string[] = [];
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	const jsonLine = lines.find((l) => l.trim().startsWith("{"));
	if (!jsonLine) {
		throw new Error(`No JSON envelope captured. logs=${JSON.stringify(lines)}`);
	}
	return JSON.parse(jsonLine) as Record<string, unknown>;
}

function expectCliError(err: unknown, code: string): CliError {
	expect(err).toBeInstanceOf(CliError);
	const cli = err as CliError;
	expect(cli.code).toBe(code);
	return cli;
}

describe("phaseFinish", () => {
	test("happy path: three completed; quality:check and author step at given iteration", async () => {
		const ctx = setup();
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			const envelope = await captureSuccess(() =>
				phaseFinish({
					phase: "1",
					iteration: 2,
					step: AUTHOR_STEP,
					run: ctx.runId,
					input,
					startDir: ctx.tmp,
					env: {},
				}),
			);
			expect(envelope.ok).toBe(true);
			const data = envelope.data as Record<string, unknown>;
			const steps = data.steps as Array<Record<string, unknown>>;
			expect(steps.map((s) => s.name)).toEqual([
				"quality",
				"protocol",
				"checklist",
			]);
			expect(steps.every((s) => s.status === "completed")).toBe(true);

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
		const spy = spyOn(qualityGates, "runQualityGates");
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			const params = {
				phase: "1",
				iteration: 1,
				step: AUTHOR_STEP,
				run: ctx.runId,
				input,
				startDir: ctx.tmp,
				env: {},
			};
			await captureSuccess(() => phaseFinish(params));
			const firstCalls = spy.mock.calls.length;
			expect(firstCalls).toBeGreaterThanOrEqual(1);
			const before = getSteps(ctx.db, ctx.runId).length;

			const envelope = await captureSuccess(() => phaseFinish(params));
			expect(spy.mock.calls.length).toBe(firstCalls);
			expect(getSteps(ctx.db, ctx.runId).length).toBe(before);

			const data = envelope.data as Record<string, unknown>;
			const steps = data.steps as Array<Record<string, unknown>>;
			expect(steps.every((s) => s.status === "completed")).toBe(true);
			expect(steps[0]?.recorded).toBe(false);
			expect(steps[1]?.recorded).toBe(false);
		} finally {
			spy.mockRestore();
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
				await phaseFinish({
					phase: "1",
					iteration: 3,
					step: AUTHOR_STEP,
					run: ctx.runId,
					input,
					startDir: ctx.tmp,
					env: {},
				});
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

			writeFileSync(join(ctx.tmp, "5x.toml"), 'qualityGates = ["echo ok"]\n');
			const envelope = await captureSuccess(() =>
				phaseFinish({
					phase: "1",
					iteration: 3,
					step: AUTHOR_STEP,
					run: ctx.runId,
					input,
					startDir: ctx.tmp,
					env: {},
				}),
			);
			expect(envelope.ok).toBe(true);
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
				await phaseFinish({
					phase: "1",
					iteration: 1,
					step: AUTHOR_STEP,
					run: ctx.runId,
					input,
					startDir: ctx.tmp,
					env: {},
				});
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
		const spy = spyOn(qualityGates, "runQualityGates");
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			const params = {
				phase: "1",
				iteration: 1,
				step: AUTHOR_STEP,
				run: ctx.runId,
				input,
				startDir: ctx.tmp,
				env: {},
			};
			try {
				await phaseFinish(params);
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
			const callsAfterFail = spy.mock.calls.length;

			writeFileSync(
				ctx.planPath,
				"# Test Plan\n\n## Phase 1: Setup\n\n- [x] Do the thing\n",
			);
			await captureSuccess(() => phaseFinish(params));
			expect(spy.mock.calls.length).toBe(callsAfterFail);
			expect(
				getSteps(ctx.db, ctx.runId).some((r) => r.step_name === AUTHOR_STEP),
			).toBe(true);
		} finally {
			spy.mockRestore();
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
			const envelope = await captureSuccess(() =>
				phaseFinish({
					phase: "1",
					iteration: 1,
					step: AUTHOR_STEP,
					run: ctx.runId,
					input,
					startDir: ctx.tmp,
					env: {},
				}),
			);
			expect(envelope.ok).toBe(true);
			const steps = (envelope.data as Record<string, unknown>)
				.steps as Array<Record<string, unknown>>;
			expect(steps[1]?.status).toBe("completed");
			expect(steps[2]?.status).toBe("skipped");
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
			const params = {
				phase: "1",
				iteration: 1,
				step: AUTHOR_STEP,
				run: ctx.runId,
				input,
				startDir: ctx.tmp,
				env: {},
			};
			await captureSuccess(() => phaseFinish(params));
			const before = getSteps(ctx.db, ctx.runId).length;
			const envelope = await captureSuccess(() => phaseFinish(params));
			expect(getSteps(ctx.db, ctx.runId).length).toBe(before);
			const steps = (envelope.data as Record<string, unknown>)
				.steps as Array<Record<string, unknown>>;
			expect(steps[2]?.status).toBe("skipped");
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
			const params = {
				phase: "1",
				iteration: 1,
				step: AUTHOR_STEP,
				run: ctx.runId,
				input,
				startDir: ctx.tmp,
				env: {},
			};
			await captureSuccess(() => phaseFinish(params));
			writeFileSync(
				ctx.planPath,
				"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Undone again\n",
			);
			const envelope = await captureSuccess(() => phaseFinish(params));
			const steps = (envelope.data as Record<string, unknown>)
				.steps as Array<Record<string, unknown>>;
			expect(steps[2]?.status).toBe("completed");
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
			const envelope = await captureSuccess(() =>
				phaseFinish({
					phase: "1",
					iteration: 1,
					step: AUTHOR_STEP,
					run: ctx.runId,
					input,
					phaseChecklistValidate: false,
					startDir: ctx.tmp,
					env: {},
				}),
			);
			const steps = (envelope.data as Record<string, unknown>)
				.steps as Array<Record<string, unknown>>;
			expect(steps[2]?.status).toBe("completed");
			expect(
				getSteps(ctx.db, ctx.runId).some((r) => r.step_name === AUTHOR_STEP),
			).toBe(true);
		} finally {
			teardown(ctx);
		}
	});

	test("missing run / env / pointer: RUN_CONTEXT_REQUIRED before gates", async () => {
		const ctx = setup();
		const spy = spyOn(qualityGates, "runQualityGates");
		try {
			const input = writeAuthor(ctx, {
				result: "complete",
				commit: "abc123def",
			});
			try {
				await phaseFinish({
					phase: "1",
					iteration: 1,
					step: AUTHOR_STEP,
					input,
					startDir: ctx.tmp,
					env: {},
				});
				throw new Error("expected RUN_CONTEXT_REQUIRED");
			} catch (err) {
				expectCliError(err, "RUN_CONTEXT_REQUIRED");
			}
			expect(spy.mock.calls.length).toBe(0);
		} finally {
			spy.mockRestore();
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

			const viaFlag = await captureSuccess(() =>
				phaseFinish({
					phase: "1",
					iteration: 4,
					step: AUTHOR_STEP,
					run: ctx.runId,
					input,
					startDir: ctx.tmp,
					env: {},
				}),
			);
			const viaPointer = await captureSuccess(() =>
				phaseFinish({
					phase: "1",
					iteration: 5,
					step: AUTHOR_STEP,
					input,
					startDir: ctx.tmp,
					env: {},
				}),
			);
			expect(viaFlag.ok).toBe(true);
			expect(viaPointer.ok).toBe(true);
			expect((viaFlag.data as Record<string, unknown>).run_id).toBe(ctx.runId);
			expect((viaPointer.data as Record<string, unknown>).run_id).toBe(
				ctx.runId,
			);
		} finally {
			teardown(ctx);
		}
	});
});
