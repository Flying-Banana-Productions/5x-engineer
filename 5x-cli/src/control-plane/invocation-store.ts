/**
 * InvocationStore contract. Command logic and the future dashboard depend on
 * this interface, never on `bun:sqlite`.
 */

import type {
	CancellationActor,
	CancellationOutcome,
	InvocationAbandonReason,
	InvocationCasResult,
	InvocationRecord,
	InvocationStatus,
	RegisterInvocationInput,
} from "./invocation-types.js";

export interface InvocationStore {
	register(input: RegisterInvocationInput): InvocationRecord;
	get(id: string): InvocationRecord | null;
	list(filter?: {
		runId?: string;
		status?: InvocationStatus;
	}): InvocationRecord[];
	heartbeat(id: string): InvocationRecord;
	/**
	 * CAS: succeed iff still running, supported, and not yet requested.
	 * Missing id → InvocationStoreError INVOCATION_NOT_FOUND.
	 */
	markCancellationRequested(
		id: string,
		actor: CancellationActor,
	): InvocationCasResult;
	recordCancellationOutcome(
		id: string,
		outcome: CancellationOutcome,
	): InvocationRecord;
	/**
	 * CAS: succeed iff still running (including cancellation-requested).
	 * Abandoned/other terminal → ok: false.
	 */
	markTerminal(
		id: string,
		status: "completed" | "failed" | "cancelled",
	): InvocationCasResult;
	/**
	 * CAS: succeed iff still running. Doctor `--fix` must not use this —
	 * it only CASes status and loses the heartbeat / run-reopen TOCTOU.
	 * Use markAbandonedIfStale.
	 */
	markAbandoned(
		id: string,
		reason: InvocationAbandonReason,
	): InvocationCasResult;
	/**
	 * CAS-abandon iff the observed liveness predicate still holds.
	 * Doctor `--fix` uses this. Never a status-only write.
	 *
	 * staleReason "heartbeat": succeed iff status = 'running'
	 *   AND updated_at = expectedUpdatedAt.
	 * staleReason "run-terminal": succeed iff status = 'running'
	 *   AND the linked run is missing, completed, or aborted
	 *   (SQLite: same UPDATE, subquery on runs; memory: getRun
	 *   callback invoked inside this method before the write).
	 * Do not AND both predicates globally — a fresh heartbeat must
	 * not block abandoning a still-terminal run, and a matching
	 * timestamp must not abandon after a run was reopened.
	 */
	markAbandonedIfStale(opts: {
		id: string;
		reason: InvocationAbandonReason;
		expectedUpdatedAt: string;
		staleReason: "heartbeat" | "run-terminal";
	}): InvocationCasResult;
	/**
	 * Non-terminal rows with updatedAt older than olderThanMs, using `nowMs`.
	 * Does not inspect PIDs.
	 */
	listStale(opts: { olderThanMs: number; nowMs: number }): InvocationRecord[];
}
