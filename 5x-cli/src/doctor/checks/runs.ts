/**
 * Doctor check: lingering active runs.
 *
 * Report-only. Detect opens the existing DB read-only, queries every
 * `status = 'active'` row without the `listRuns` 50-row cap, and warns
 * when `updated_at` is older than 24h and the plan lock is not live.
 * Never migrates, creates, or auto-completes a run.
 */

import { existsSync } from "node:fs";
import { openDbReadOnly } from "../../db/connection.js";
import { inspectLock } from "../../lock.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
} from "../types.js";

export const RUNS_CHECK_ID = "runs";

/** Heuristic: active run whose `updated_at` is at least this old. */
export const LINGERING_RUN_AGE_MS = 24 * 60 * 60 * 1000;

interface ActiveRunRow {
	id: string;
	plan_path: string;
	updated_at: string;
}

function dbUnreadable(ctx: DoctorCheckContext, err: unknown): DoctorFinding {
	const message = err instanceof Error ? err.message : String(err);
	return {
		check: RUNS_CHECK_ID,
		status: "fail",
		code: "DB_UNREADABLE",
		message: `cannot read database at ${ctx.dbPath}: ${message}`,
		fixable: false,
		detail: { dbPath: ctx.dbPath, error: message },
	};
}

/**
 * Parse a run timestamp. SQLite `datetime('now')` stores
 * `YYYY-MM-DD HH:MM:SS` (UTC, no zone); treat that form as UTC so
 * lingering age is not skewed by the local timezone.
 */
export function parseRunTimestamp(value: string): number {
	const trimmed = value.trim();
	if (!trimmed) return Number.NaN;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
		return Date.parse(`${trimmed.replace(" ", "T")}Z`);
	}
	return Date.parse(trimmed);
}

async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
	if (!existsSync(ctx.dbPath)) return [];

	let rows: ActiveRunRow[] = [];
	let db: ReturnType<typeof openDbReadOnly> | undefined;
	try {
		db = openDbReadOnly(ctx.projectRoot, ctx.dbRelPath);
		// Dedicated SELECT — no LIMIT. `listRuns` defaults to 50 newest.
		rows = db
			.query(
				`SELECT id, plan_path, updated_at FROM runs WHERE status = 'active'`,
			)
			.all() as ActiveRunRow[];
	} catch (err) {
		return [dbUnreadable(ctx, err)];
	} finally {
		try {
			db?.close();
		} catch {
			// already closed
		}
	}

	const now = ctx.now ?? Date.now();
	const findings: DoctorFinding[] = [];

	for (const row of rows) {
		const updatedMs = parseRunTimestamp(row.updated_at);
		if (!Number.isFinite(updatedMs)) continue;
		if (now - updatedMs < LINGERING_RUN_AGE_MS) continue;

		const lock = inspectLock(ctx.projectRoot, row.plan_path, {
			stateDir: ctx.stateDir,
		});
		if (lock?.liveness === "live") continue;

		findings.push({
			check: RUNS_CHECK_ID,
			status: "warn",
			code: "RUN_LINGERING",
			message:
				`active run ${row.id} for ${row.plan_path} has not been updated since ${row.updated_at}. ` +
				"If the session crashed, abort it; reopen is the judgment fork if it is still in progress.",
			remediation: `5x run complete --run ${row.id} --status aborted`,
			fixable: false,
			detail: {
				runId: row.id,
				planPath: row.plan_path,
				updatedAt: row.updated_at,
			},
		});
	}

	if (findings.length === 0) {
		return [
			{
				check: RUNS_CHECK_ID,
				status: "ok",
				code: "RUNS_OK",
				message: "no lingering active runs",
				fixable: false,
			},
		];
	}

	return findings;
}

export const runsCheck: DoctorCheck = {
	id: RUNS_CHECK_ID,
	run,
};
