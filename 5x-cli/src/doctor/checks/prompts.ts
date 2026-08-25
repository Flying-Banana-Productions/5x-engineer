/**
 * Doctor check: orphaned open prompts on terminal runs.
 *
 * Detect opens the existing DB read-only. An open prompt whose `run_id`
 * points at a missing, completed, or aborted run is `PROMPT_ORPHANED`.
 * Standalone open prompts (`run_id` NULL) are not this finding — process-
 * crash leftovers without a run stay until that prompt command's own
 * abandon path.
 *
 * `--fix` re-validates still-open-on-terminal-run, then CAS-abandons with
 * `run-terminal`. It opens a writable `getDb` connection and never calls
 * `resolveDbContext` (that migrates; the DB check forbids it).
 */

import { existsSync } from "node:fs";
import {
	createSqlitePromptStore,
	type PromptRecord,
} from "../../control-plane/index.js";
import { closeDb, getDb, openDbReadOnly } from "../../db/connection.js";
import { getRunV1, type RunRowV1 } from "../../db/operations-v1.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../types.js";

export const PROMPTS_CHECK_ID = "prompts";

function asRecord(detail: unknown): Record<string, unknown> {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		return {};
	}
	return detail as Record<string, unknown>;
}

function promptDbUnreadable(
	ctx: DoctorCheckContext,
	err: unknown,
): DoctorFinding {
	const message = err instanceof Error ? err.message : String(err);
	return {
		check: PROMPTS_CHECK_ID,
		status: "fail",
		code: "PROMPT_DB_UNREADABLE",
		message: `cannot read database at ${ctx.dbPath}: ${message}`,
		fixable: false,
		detail: { dbPath: ctx.dbPath, error: message },
	};
}

/** Terminal (or missing) run status, or `null` if the run is still active. */
function terminalRunStatus(run: RunRowV1 | null): string | null {
	if (run === null) return "missing";
	if (run.status === "completed" || run.status === "aborted") {
		return run.status;
	}
	return null;
}

function isOpen(prompt: PromptRecord): boolean {
	return prompt.answeredAt === null && prompt.abandonedAt === null;
}

async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
	if (!existsSync(ctx.dbPath)) return [];

	let db: ReturnType<typeof openDbReadOnly> | undefined;
	try {
		db = openDbReadOnly(ctx.projectRoot, ctx.dbRelPath);
		const store = createSqlitePromptStore(db);
		const findings: DoctorFinding[] = [];

		for (const prompt of store.listOpenPrompts()) {
			if (prompt.runId == null) continue;
			const runRow = getRunV1(db, prompt.runId);
			const runStatus = terminalRunStatus(runRow);
			if (runStatus === null) continue;
			findings.push({
				check: PROMPTS_CHECK_ID,
				status: "fail",
				code: "PROMPT_ORPHANED",
				message: `open prompt ${prompt.id} is orphaned; run ${prompt.runId} is ${runStatus}`,
				remediation: "5x doctor --fix",
				fixable: true,
				detail: {
					promptId: prompt.id,
					runId: prompt.runId,
					runStatus,
				},
			});
		}

		if (findings.length === 0) {
			return [
				{
					check: PROMPTS_CHECK_ID,
					status: "ok",
					code: "PROMPTS_OK",
					message: "no orphaned prompts",
					fixable: false,
				},
			];
		}
		return findings;
	} catch (err) {
		return [promptDbUnreadable(ctx, err)];
	} finally {
		try {
			db?.close();
		} catch {
			// already closed
		}
	}
}

async function fix(
	finding: DoctorFinding,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	if (finding.code !== "PROMPT_ORPHANED") {
		return { attempted: false, message: "not an orphaned prompt" };
	}

	const promptId = String(asRecord(finding.detail).promptId ?? "");
	if (!promptId) {
		return { attempted: false, message: "missing promptId" };
	}
	if (!existsSync(ctx.dbPath)) {
		return { attempted: false, message: "database missing" };
	}

	try {
		const db = getDb(ctx.projectRoot, ctx.dbRelPath);
		const store = createSqlitePromptStore(db);
		const prompt = store.getPrompt(promptId);
		if (!prompt) {
			return { attempted: false, message: "prompt not found" };
		}
		if (prompt.runId == null) {
			return { attempted: false, message: "prompt has no run" };
		}
		if (!isOpen(prompt)) {
			return { attempted: false, message: "prompt already closed" };
		}
		if (terminalRunStatus(getRunV1(db, prompt.runId)) === null) {
			return { attempted: false, message: "run is no longer terminal" };
		}

		const result = store.abandonPrompt(promptId, "run-terminal");
		if (!result.ok) {
			return { attempted: false, message: "prompt already closed" };
		}
		return {
			attempted: true,
			message: `abandoned orphaned prompt ${promptId}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { attempted: false, message };
	} finally {
		closeDb();
	}
}

export const promptsCheck: DoctorCheck = {
	id: PROMPTS_CHECK_ID,
	run,
	fix,
};
