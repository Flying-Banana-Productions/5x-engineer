/**
 * Doctor check: stale or orphaned invocation-registry rows.
 *
 * Detect opens the existing DB read-only. A running invocation whose
 * heartbeat is older than `INVOCATION_STALE_MS`, or whose `run_id` points
 * at a missing, completed, or aborted run, is `INVOCATION_STALE`.
 *
 * `--fix` re-validates the finding's predicate (UX only), then CAS-abandons
 * via `markAbandonedIfStale` so a competing heartbeat or run-reopen cannot
 * retire a live row. It opens a writable `getDb` connection and never calls
 * `resolveDbContext` (that migrates; the DB check forbids it).
 *
 * Metadata only: adapters are not called and no provider process is reaped.
 */

import { existsSync } from "node:fs";
import {
	createSqliteInvocationStore,
	INVOCATION_STALE_MS,
	type InvocationStore,
} from "../../control-plane/index.js";
import { closeDb, getDb, openDbReadOnly } from "../../db/connection.js";
import { getRunV1, type RunRowV1 } from "../../db/operations-v1.js";
import { parseRunTimestamp } from "../../db/timestamps.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../types.js";

export { INVOCATION_STALE_MS };

export const INVOCATIONS_CHECK_ID = "invocations";

type DoctorDb = ReturnType<typeof getDb>;

export type InvocationStaleReason = "heartbeat" | "run-terminal";

export interface InvocationsCheckDeps {
	createStore?: (db: DoctorDb) => InvocationStore;
}

function asRecord(detail: unknown): Record<string, unknown> {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		return {};
	}
	return detail as Record<string, unknown>;
}

function parseStaleReason(value: unknown): InvocationStaleReason | null {
	if (value === "heartbeat" || value === "run-terminal") return value;
	return null;
}

function invocationDbUnreadable(
	ctx: DoctorCheckContext,
	err: unknown,
): DoctorFinding {
	const message = err instanceof Error ? err.message : String(err);
	return {
		check: INVOCATIONS_CHECK_ID,
		status: "fail",
		code: "INVOCATION_DB_UNREADABLE",
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

function isHeartbeatStale(updatedAt: string, nowMs: number): boolean {
	const updatedMs = parseRunTimestamp(updatedAt);
	if (!Number.isFinite(updatedMs)) return false;
	return nowMs - updatedMs >= INVOCATION_STALE_MS;
}

function staleFindingMessage(
	invocationId: string,
	reason: InvocationStaleReason,
): string {
	const why =
		reason === "run-terminal"
			? "linked run is missing or terminal"
			: "heartbeat is stale";
	return (
		`invocation ${invocationId} is stale (${why}); registry metadata can be abandoned. ` +
		"The underlying provider process is not reaped."
	);
}

export function createInvocationsCheck(
	deps?: InvocationsCheckDeps,
): DoctorCheck {
	const createStore = deps?.createStore ?? createSqliteInvocationStore;

	async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
		if (!existsSync(ctx.dbPath)) return [];

		let db: ReturnType<typeof openDbReadOnly> | undefined;
		try {
			db = openDbReadOnly(ctx.projectRoot, ctx.dbRelPath);
			const store = createStore(db);
			const now = ctx.now ?? Date.now();
			const findings: DoctorFinding[] = [];

			for (const invocation of store.list({ status: "running" })) {
				const runStatus = terminalRunStatus(getRunV1(db, invocation.runId));
				const heartbeatStale = isHeartbeatStale(invocation.updatedAt, now);
				if (runStatus === null && !heartbeatStale) continue;
				const reason: InvocationStaleReason =
					runStatus !== null ? "run-terminal" : "heartbeat";
				findings.push({
					check: INVOCATIONS_CHECK_ID,
					status: "fail",
					code: "INVOCATION_STALE",
					message: staleFindingMessage(invocation.id, reason),
					remediation: "5x doctor --fix",
					fixable: true,
					detail: {
						invocationId: invocation.id,
						runId: invocation.runId,
						updatedAt: invocation.updatedAt,
						reason,
					},
				});
			}

			if (findings.length === 0) {
				return [
					{
						check: INVOCATIONS_CHECK_ID,
						status: "ok",
						code: "INVOCATIONS_OK",
						message: "no stale invocations",
						fixable: false,
					},
				];
			}
			return findings;
		} catch (err) {
			return [invocationDbUnreadable(ctx, err)];
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
		if (finding.code !== "INVOCATION_STALE") {
			return { attempted: false, message: "not a stale invocation" };
		}

		const detail = asRecord(finding.detail);
		const invocationId = String(detail.invocationId ?? "");
		const staleReason = parseStaleReason(detail.reason);
		if (!invocationId) {
			return { attempted: false, message: "missing invocationId" };
		}
		if (!staleReason) {
			return { attempted: false, message: "missing stale reason" };
		}
		if (!existsSync(ctx.dbPath)) {
			return { attempted: false, message: "database missing" };
		}

		try {
			const db = getDb(ctx.projectRoot, ctx.dbRelPath);
			const store = createStore(db);
			const record = store.get(invocationId);
			if (!record) {
				return { attempted: false, message: "invocation not found" };
			}
			if (record.status !== "running") {
				return {
					attempted: false,
					message: "invocation is no longer running",
				};
			}

			const now = ctx.now ?? Date.now();
			if (staleReason === "heartbeat") {
				if (!isHeartbeatStale(record.updatedAt, now)) {
					return {
						attempted: false,
						message: "invocation is no longer stale",
					};
				}
			} else if (terminalRunStatus(getRunV1(db, record.runId)) === null) {
				return { attempted: false, message: "run is no longer terminal" };
			}

			const result = store.markAbandonedIfStale({
				id: invocationId,
				reason: "stale-metadata",
				expectedUpdatedAt: record.updatedAt,
				staleReason,
			});
			if (!result.ok) {
				return {
					attempted: false,
					message:
						staleReason === "run-terminal"
							? "run is no longer terminal"
							: "invocation is no longer stale",
				};
			}
			return {
				attempted: true,
				message: `abandoned stale invocation ${invocationId}`,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { attempted: false, message };
		} finally {
			closeDb();
		}
	}

	return {
		id: INVOCATIONS_CHECK_ID,
		run,
		fix,
	};
}

export const invocationsCheck: DoctorCheck = createInvocationsCheck();
