/**
 * SQLite InvocationStore. SQL and row mapping live only in this file.
 */

import type { Database } from "bun:sqlite";
import { parseRunTimestamp } from "../db/timestamps.js";
import { createInvocationId } from "./ids.js";
import type { InvocationStore } from "./invocation-store.js";
import type {
	CancellationActor,
	CancellationOutcome,
	InvocationAbandonReason,
	InvocationCasResult,
	InvocationRecord,
	InvocationStatus,
	OpaqueCancellationHandle,
	RegisterInvocationInput,
} from "./invocation-types.js";
import {
	InvocationStoreError,
	parseOpaqueCancellationHandle,
} from "./invocation-types.js";

interface InvocationSqlRow {
	id: string;
	run_id: string;
	session_id: string | null;
	role: "author" | "reviewer";
	provider_name: string;
	template_name: string | null;
	handle_json: string;
	cancellation_supported: number;
	status: InvocationStatus;
	created_at: string;
	updated_at: string;
	cancellation_requested_at: string | null;
	cancellation_requested_by: CancellationActor | null;
	cancellation_outcome: CancellationOutcome | null;
	cancellation_outcome_at: string | null;
	terminal_at: string | null;
	abandon_reason: InvocationAbandonReason | null;
}

function serializeHandle(handle: OpaqueCancellationHandle): string {
	const parsed = parseOpaqueCancellationHandle(handle);
	return JSON.stringify({ adapter: parsed.adapter, ref: parsed.ref });
}

function mapRow(row: InvocationSqlRow): InvocationRecord {
	return {
		id: row.id,
		runId: row.run_id,
		sessionId: row.session_id,
		role: row.role,
		providerName: row.provider_name,
		templateName: row.template_name,
		handle: parseOpaqueCancellationHandle(row.handle_json),
		cancellationSupported: row.cancellation_supported === 1,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		cancellationRequestedAt: row.cancellation_requested_at,
		cancellationRequestedBy: row.cancellation_requested_by,
		cancellationOutcome: row.cancellation_outcome,
		cancellationOutcomeAt: row.cancellation_outcome_at,
		terminalAt: row.terminal_at,
		abandonReason: row.abandon_reason,
	};
}

function isStale(
	updatedAt: string,
	olderThanMs: number,
	nowMs: number,
): boolean {
	const updatedMs = parseRunTimestamp(updatedAt);
	if (!Number.isFinite(updatedMs)) return false;
	return nowMs - updatedMs >= olderThanMs;
}

class SqliteInvocationStore implements InvocationStore {
	constructor(private readonly db: Database) {}

	register(input: RegisterInvocationInput): InvocationRecord {
		const id = input.id ?? createInvocationId();
		const handleJson = serializeHandle(input.handle);
		this.db
			.query(
				`INSERT INTO invocations (
					id, run_id, session_id, role, provider_name, template_name,
					handle_json, cancellation_supported, status
				) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running')`,
			)
			.run(
				id,
				input.runId,
				input.sessionId ?? null,
				input.role,
				input.providerName,
				input.templateName ?? null,
				handleJson,
				input.cancellationSupported ? 1 : 0,
			);
		return this.requireInvocation(id);
	}

	get(id: string): InvocationRecord | null {
		const row = this.db
			.query("SELECT * FROM invocations WHERE id = ?1")
			.get(id) as InvocationSqlRow | null;
		return row ? mapRow(row) : null;
	}

	list(filter?: {
		runId?: string;
		status?: InvocationStatus;
	}): InvocationRecord[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter?.runId !== undefined) {
			params.push(filter.runId);
			clauses.push(`run_id = ?${params.length}`);
		}
		if (filter?.status !== undefined) {
			params.push(filter.status);
			clauses.push(`status = ?${params.length}`);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.db
			.query(
				`SELECT * FROM invocations ${where} ORDER BY created_at ASC, id ASC`,
			)
			.all(...params) as InvocationSqlRow[];
		return rows.map(mapRow);
	}

	heartbeat(id: string): InvocationRecord {
		this.db
			.query(
				`UPDATE invocations
				 SET updated_at = datetime('now')
				 WHERE id = ?1 AND status = 'running'`,
			)
			.run(id);
		return this.requireInvocation(id);
	}

	markCancellationRequested(
		id: string,
		actor: CancellationActor,
	): InvocationCasResult {
		this.db
			.query(
				`UPDATE invocations
				 SET cancellation_requested_at = datetime('now'),
				     cancellation_requested_by = ?1,
				     updated_at = datetime('now')
				 WHERE id = ?2
				   AND status = 'running'
				   AND cancellation_supported = 1
				   AND cancellation_requested_at IS NULL`,
			)
			.run(actor, id);
		return this.casResult(id);
	}

	recordCancellationOutcome(
		id: string,
		outcome: CancellationOutcome,
	): InvocationRecord {
		this.db
			.query(
				`UPDATE invocations
				 SET cancellation_outcome = ?1,
				     cancellation_outcome_at = datetime('now'),
				     updated_at = datetime('now')
				 WHERE id = ?2`,
			)
			.run(outcome, id);
		if (this.changes() === 0) {
			throw new InvocationStoreError(
				"INVOCATION_NOT_FOUND",
				`invocation ${id} not found`,
			);
		}
		return this.requireInvocation(id);
	}

	markTerminal(
		id: string,
		status: "completed" | "failed" | "cancelled",
	): InvocationCasResult {
		this.db
			.query(
				`UPDATE invocations
				 SET status = ?1,
				     terminal_at = datetime('now'),
				     updated_at = datetime('now')
				 WHERE id = ?2 AND status = 'running'`,
			)
			.run(status, id);
		return this.casResult(id);
	}

	markAbandoned(
		id: string,
		reason: InvocationAbandonReason,
	): InvocationCasResult {
		this.db
			.query(
				`UPDATE invocations
				 SET status = 'abandoned',
				     abandon_reason = ?1,
				     terminal_at = datetime('now'),
				     updated_at = datetime('now')
				 WHERE id = ?2 AND status = 'running'`,
			)
			.run(reason, id);
		return this.casResult(id);
	}

	markAbandonedIfStale(opts: {
		id: string;
		reason: InvocationAbandonReason;
		expectedUpdatedAt: string;
		staleReason: "heartbeat" | "run-terminal";
	}): InvocationCasResult {
		if (opts.staleReason === "heartbeat") {
			this.db
				.query(
					`UPDATE invocations
					 SET status = 'abandoned',
					     abandon_reason = ?1,
					     terminal_at = datetime('now'),
					     updated_at = datetime('now')
					 WHERE id = ?2
					   AND status = 'running'
					   AND updated_at = ?3`,
				)
				.run(opts.reason, opts.id, opts.expectedUpdatedAt);
		} else {
			this.db
				.query(
					`UPDATE invocations
					 SET status = 'abandoned',
					     abandon_reason = ?1,
					     terminal_at = datetime('now'),
					     updated_at = datetime('now')
					 WHERE id = ?2
					   AND status = 'running'
					   AND NOT EXISTS (
					     SELECT 1 FROM runs r
					     WHERE r.id = invocations.run_id
					       AND r.status NOT IN ('completed', 'aborted')
					   )`,
				)
				.run(opts.reason, opts.id);
		}
		return this.casResult(opts.id);
	}

	listStale(opts: { olderThanMs: number; nowMs: number }): InvocationRecord[] {
		const rows = this.db
			.query(
				`SELECT * FROM invocations
				 WHERE status = 'running'
				 ORDER BY updated_at ASC, id ASC`,
			)
			.all() as InvocationSqlRow[];
		return rows
			.map(mapRow)
			.filter((row) => isStale(row.updatedAt, opts.olderThanMs, opts.nowMs));
	}

	private changes(): number {
		const row = this.db.query("SELECT changes() AS n").get() as {
			n: number;
		} | null;
		return row?.n ?? 0;
	}

	private casResult(id: string): InvocationCasResult {
		if (this.changes() > 0) {
			return { ok: true, invocation: this.requireInvocation(id) };
		}
		const invocation = this.get(id);
		if (!invocation) {
			throw new InvocationStoreError(
				"INVOCATION_NOT_FOUND",
				`invocation ${id} not found`,
			);
		}
		return { ok: false, invocation };
	}

	private requireInvocation(id: string): InvocationRecord {
		const invocation = this.get(id);
		if (!invocation) {
			throw new InvocationStoreError(
				"INVOCATION_NOT_FOUND",
				`invocation ${id} not found`,
			);
		}
		return invocation;
	}
}

export function createSqliteInvocationStore(db: Database): InvocationStore {
	return new SqliteInvocationStore(db);
}
