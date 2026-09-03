/**
 * RecordStore contract. Command logic depends on this interface, never on a
 * working-tree path or `bun:sqlite` (`207` §3). A future `refs/5x/*`
 * implementation can swap the factory without changing callers.
 *
 * Do not add `gitShow` / `commit` / `fetch` to this interface.
 */

import type {
	AppendOp,
	AppendResult,
	RecordLine,
	RecordStream,
	RunRecordSummary,
} from "./record-types.js";

export interface RecordStore {
	putRun(summary: RunRecordSummary): void;
	getRun(runId: string): RunRecordSummary | null;
	listRuns(filter?: { planSlug?: string }): RunRecordSummary[];

	getLine(
		runId: string,
		stream: RecordStream,
		idempotencyKey: string,
	): RecordLine | null;
	/** Insertion order. Equal createdAt must not reorder. */
	listLines(runId: string, stream: RecordStream): RecordLine[];

	append(op: AppendOp): AppendResult;
	/**
	 * All-or-nothing. Per-op duplicates return created: false and add no line.
	 * A throw leaves the store identical to before the call.
	 */
	atomicAppend(ops: AppendOp[]): AppendResult[];
}
