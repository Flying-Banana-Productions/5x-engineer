/**
 * Unit tests for the orphaned-prompt doctor check.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqlitePromptStore } from "../../../src/control-plane/index.js";
import type { PromptStore } from "../../../src/control-plane/store.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import {
	completeRun,
	createRunV1,
	reopenRun,
} from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { promptsCheck } from "../../../src/doctor/checks/prompts.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../../../src/doctor/types.js";

function makeTmp(): string {
	const dir = join(
		tmpdir(),
		`5x-doctor-prompts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function doctorCtx(projectRoot: string): DoctorCheckContext {
	return {
		startDir: projectRoot,
		projectRoot,
		stateDir: ".5x",
		dbPath: resolve(projectRoot, ".5x", "5x.db"),
		dbRelPath: join(".5x", "5x.db"),
	};
}

function seed(
	projectRoot: string,
	fn: (store: PromptStore, db: ReturnType<typeof getDb>) => void,
): void {
	const db = getDb(projectRoot);
	runMigrations(db);
	fn(createSqlitePromptStore(db), db);
	closeDb();
	_resetForTest();
}

function promptIdOf(finding: DoctorFinding | undefined): string | undefined {
	if (!finding?.detail || typeof finding.detail !== "object") return undefined;
	const promptId = (finding.detail as { promptId?: unknown }).promptId;
	return typeof promptId === "string" ? promptId : undefined;
}

async function applyFix(
	check: DoctorCheck,
	finding: DoctorFinding | undefined,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (!check.fix) throw new Error("expected check.fix");
	if (!finding) throw new Error("expected finding");
	return check.fix(finding, ctx);
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

describe("prompts detect", () => {
	test("missing DB returns [] and does not create a file", async () => {
		const tmp = makeTmp();
		try {
			const ctx = doctorCtx(tmp);
			expect(existsSync(ctx.dbPath)).toBe(false);
			const findings = await promptsCheck.run(ctx);
			expect(findings).toEqual([]);
			expect(existsSync(ctx.dbPath)).toBe(false);
			expect(existsSync(join(tmp, ".5x"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unreadable DB → PROMPT_DB_UNREADABLE, not thrown", async () => {
		const tmp = makeTmp();
		try {
			mkdirSync(join(tmp, ".5x"), { recursive: true });
			const ctx = doctorCtx(tmp);
			writeFileSync(ctx.dbPath, "not a sqlite database");
			const findings = await promptsCheck.run(ctx);
			expect(findings).toHaveLength(1);
			expect(findings[0]?.code).toBe("PROMPT_DB_UNREADABLE");
			expect(findings[0]?.status).toBe("fail");
			expect(findings[0]?.fixable).toBe(false);
			expect(findings[0]?.detail).toEqual(
				expect.objectContaining({ dbPath: ctx.dbPath }),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("open prompt + active run → PROMPTS_OK", async () => {
		const tmp = makeTmp();
		try {
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_active", planPath: "/plan.md" });
				store.createPrompt({
					runId: "run_active",
					kind: "choose",
					message: "Pick",
					options: ["a", "b"],
				});
			});

			const findings = await promptsCheck.run(doctorCtx(tmp));
			expect(findings).toEqual([
				expect.objectContaining({
					check: "prompts",
					status: "ok",
					code: "PROMPTS_OK",
					fixable: false,
				}),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("open prompt + completed run → PROMPT_ORPHANED fail fixable", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				const created = store.createPrompt({
					runId: "run_done",
					kind: "confirm",
					message: "Continue?",
				});
				id = created.id;
				completeRun(db, "run_done", "completed");
			});

			const findings = await promptsCheck.run(doctorCtx(tmp));
			expect(findings).toHaveLength(1);
			const orphan = findings[0];
			expect(orphan?.code).toBe("PROMPT_ORPHANED");
			expect(orphan?.status).toBe("fail");
			expect(orphan?.fixable).toBe(true);
			expect(orphan?.remediation).toBe("5x doctor --fix");
			expect(orphan?.message).toBe(
				`open prompt ${id} is orphaned; run run_done is completed`,
			);
			expect(orphan?.detail).toEqual({
				promptId: id,
				runId: "run_done",
				runStatus: "completed",
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("open prompt + aborted run → PROMPT_ORPHANED fail fixable", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_abort", planPath: "/plan.md" });
				id = store.createPrompt({
					runId: "run_abort",
					kind: "input",
					message: "Name?",
				}).id;
				completeRun(db, "run_abort", "aborted");
			});

			const findings = await promptsCheck.run(doctorCtx(tmp));
			expect(findings).toHaveLength(1);
			expect(findings[0]).toEqual(
				expect.objectContaining({
					check: "prompts",
					code: "PROMPT_ORPHANED",
					status: "fail",
					fixable: true,
					detail: {
						promptId: id,
						runId: "run_abort",
						runStatus: "aborted",
					},
				}),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("answered prompt + terminal run is not reported", async () => {
		const tmp = makeTmp();
		try {
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				const created = store.createPrompt({
					runId: "run_done",
					kind: "choose",
					message: "Pick",
					options: ["a"],
				});
				store.answerPrompt(created.id, "a", "terminal");
				completeRun(db, "run_done", "completed");
			});

			const findings = await promptsCheck.run(doctorCtx(tmp));
			expect(findings).toEqual([
				expect.objectContaining({ code: "PROMPTS_OK", status: "ok" }),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("open prompt with null run_id is not reported", async () => {
		const tmp = makeTmp();
		try {
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				completeRun(db, "run_done", "completed");
				store.createPrompt({
					kind: "input",
					message: "standalone",
				});
			});

			const findings = await promptsCheck.run(doctorCtx(tmp));
			expect(findings).toEqual([
				expect.objectContaining({ code: "PROMPTS_OK", status: "ok" }),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("prompts --fix", () => {
	test("fix() then re-run() no longer lists that promptId", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				id = store.createPrompt({
					runId: "run_done",
					kind: "choose",
					message: "Pick",
					options: ["a", "b"],
				}).id;
				completeRun(db, "run_done", "completed");
			});

			const ctx = doctorCtx(tmp);
			const findings = await promptsCheck.run(ctx);
			const orphan = findings.find((f) => f.code === "PROMPT_ORPHANED");
			expect(promptIdOf(orphan)).toBe(id);

			const result = await applyFix(promptsCheck, orphan, ctx);
			expect(result.attempted).toBe(true);
			expect(result.message).toContain(id);

			const db = getDb(tmp);
			try {
				const store = createSqlitePromptStore(db);
				const row = store.getPrompt(id);
				expect(row?.abandonedAt).not.toBeNull();
				expect(row?.abandonReason).toBe("run-terminal");
				expect(row?.answeredAt).toBeNull();
			} finally {
				closeDb();
				_resetForTest();
			}

			const again = await promptsCheck.run(ctx);
			expect(again.some((f) => promptIdOf(f) === id)).toBe(false);
			expect(again).toEqual([
				expect.objectContaining({ code: "PROMPTS_OK", status: "ok" }),
			]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("already-closed prompt is not rewritten", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				id = store.createPrompt({
					runId: "run_done",
					kind: "input",
					message: "Name?",
				}).id;
				completeRun(db, "run_done", "completed");
			});

			const ctx = doctorCtx(tmp);
			const findings = await promptsCheck.run(ctx);
			const orphan = findings.find((f) => f.code === "PROMPT_ORPHANED");

			seed(tmp, (store) => {
				store.abandonPrompt(id, "timeout");
			});

			const result = await applyFix(promptsCheck, orphan, ctx);
			expect(result.attempted).toBe(false);

			const db = getDb(tmp);
			try {
				const row = createSqlitePromptStore(db).getPrompt(id);
				expect(row?.abandonReason).toBe("timeout");
			} finally {
				closeDb();
				_resetForTest();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("does not abandon when the run is no longer terminal", async () => {
		const tmp = makeTmp();
		try {
			let id = "";
			seed(tmp, (store, db) => {
				createRunV1(db, { id: "run_done", planPath: "/plan.md" });
				id = store.createPrompt({
					runId: "run_done",
					kind: "confirm",
					message: "Continue?",
				}).id;
				completeRun(db, "run_done", "completed");
			});

			const ctx = doctorCtx(tmp);
			const findings = await promptsCheck.run(ctx);
			const orphan = findings.find((f) => f.code === "PROMPT_ORPHANED");

			seed(tmp, (_store, db) => {
				reopenRun(db, "run_done");
			});

			const result = await applyFix(promptsCheck, orphan, ctx);
			expect(result.attempted).toBe(false);

			const again = await promptsCheck.run(ctx);
			expect(again).toEqual([
				expect.objectContaining({ code: "PROMPTS_OK", status: "ok" }),
			]);

			const db = getDb(tmp);
			try {
				const row = createSqlitePromptStore(db).getPrompt(id);
				expect(row?.abandonedAt).toBeNull();
				expect(row?.answeredAt).toBeNull();
			} finally {
				closeDb();
				_resetForTest();
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("missing promptId is not attempted", async () => {
		const tmp = makeTmp();
		try {
			seed(tmp, () => {});
			const result = await applyFix(
				promptsCheck,
				{
					check: "prompts",
					status: "fail",
					code: "PROMPT_ORPHANED",
					message: "orphaned",
					fixable: true,
					detail: {},
				},
				doctorCtx(tmp),
			);
			expect(result.attempted).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("source does not import resolveDbContext", async () => {
		const source = await Bun.file(
			join(import.meta.dir, "../../../src/doctor/checks/prompts.ts"),
		).text();
		const importBlock = source
			.split("\n")
			.filter((line) => line.startsWith("import "))
			.join("\n");
		expect(importBlock).not.toContain("resolveDbContext");
	});
});
