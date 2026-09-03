/**
 * In-memory RecordStore. Clone-on-read; `atomicAppend` is a per-run
 * transaction (mixed `runId`s throw `INVALID_ATOMIC_APPEND` before clone/swap)
 * and clones then swaps so a throw during apply or `onBeforeCommit` leaves
 * the original maps in place. Memory has no disk journal or lock.
 */

import { planSlugFromPath } from "../paths.js";
import type { RecordStore } from "./record-store.js";
import {
	type AppendOp,
	type AppendResult,
	RECORD_LINE_SCHEMA_VERSION,
	type RecordLine,
	RecordStoreError,
	type RecordStream,
	requireSingleRunAtomicAppend,
	RUN_RECORD_FORMAT_VERSION,
	type RunRecordSummary,
} from "./record-types.js";

export interface MemoryRecordStoreOptions {
	now?: () => string; // default: UTC `YYYY-MM-DD HH:MM:SS` like PromptStore
	/** Test-only: invoked after clone apply, before swap. Throw to abort commit. */
	onBeforeCommit?: () => void;
}

interface StreamState {
	lines: Map<string, RecordLine>;
	order: string[];
}

interface RunState {
	summary: RunRecordSummary;
	streams: Record<RecordStream, StreamState>;
}

function utcNow(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function isRecordStream(stream: string): stream is RecordStream {
	return stream === "steps" || stream === "decisions" || stream === "budget";
}

function emptyStream(): StreamState {
	return { lines: new Map(), order: [] };
}

function emptyStreams(): Record<RecordStream, StreamState> {
	return {
		steps: emptyStream(),
		decisions: emptyStream(),
		budget: emptyStream(),
	};
}

function cloneSummary(summary: RunRecordSummary): RunRecordSummary {
	return structuredClone(summary);
}

function cloneLine(line: RecordLine): RecordLine {
	return structuredClone(line);
}

function cloneStream(state: StreamState): StreamState {
	const lines = new Map<string, RecordLine>();
	for (const [key, line] of state.lines) {
		lines.set(key, cloneLine(line));
	}
	return { lines, order: [...state.order] };
}

function cloneRun(run: RunState): RunState {
	return {
		summary: cloneSummary(run.summary),
		streams: {
			steps: cloneStream(run.streams.steps),
			decisions: cloneStream(run.streams.decisions),
			budget: cloneStream(run.streams.budget),
		},
	};
}

function validateEnvelope(op: AppendOp): void {
	if (op.provenance === "recorded") {
		if (op.origin === null) {
			throw new RecordStoreError(
				"INVALID_ORIGIN",
				"recorded lines require a non-null origin",
			);
		}
		if (op.materializer !== undefined) {
			throw new RecordStoreError(
				"INVALID_ORIGIN",
				"recorded lines must not include materializer",
			);
		}
	}
}

function requireStream(stream: string): RecordStream {
	if (!isRecordStream(stream)) {
		throw new RecordStoreError(
			"INVALID_STREAM",
			`invalid record stream: ${stream}`,
		);
	}
	return stream;
}

function applyOp(run: RunState, op: AppendOp, now: string): AppendResult {
	const stream = requireStream(op.stream);
	validateEnvelope(op);
	const state = run.streams[stream];
	const existing = state.lines.get(op.idempotencyKey);
	if (existing) {
		return { created: false, line: cloneLine(existing) };
	}
	const line: RecordLine = {
		runId: op.runId,
		stream,
		idempotencyKey: op.idempotencyKey,
		payload: structuredClone(op.payload),
		createdAt: op.createdAt ?? now,
		schemaVersion: op.schemaVersion ?? RECORD_LINE_SCHEMA_VERSION,
		provenance: op.provenance,
		origin: structuredClone(op.origin),
	};
	if (op.materializer !== undefined) {
		line.materializer = structuredClone(op.materializer);
	}
	state.lines.set(op.idempotencyKey, line);
	state.order.push(op.idempotencyKey);
	return { created: true, line: cloneLine(line) };
}

class MemoryRecordStore implements RecordStore {
	private readonly runs = new Map<string, RunState>();
	private readonly now: () => string;
	private readonly onBeforeCommit?: () => void;

	constructor(opts?: MemoryRecordStoreOptions) {
		this.now = opts?.now ?? utcNow;
		this.onBeforeCommit = opts?.onBeforeCommit;
	}

	putRun(summary: RunRecordSummary): void {
		const existing = this.runs.get(summary.id);
		if (
			existing &&
			existing.summary.format_version > RUN_RECORD_FORMAT_VERSION
		) {
			throw new RecordStoreError(
				"UNSUPPORTED_FORMAT_VERSION",
				`run ${summary.id} has format_version ${existing.summary.format_version}; writers refuse mutation`,
			);
		}
		const cloned = cloneSummary(summary);
		if (existing) {
			cloned.creator = structuredClone(existing.summary.creator);
			existing.summary = cloned;
			return;
		}
		this.runs.set(summary.id, {
			summary: cloned,
			streams: emptyStreams(),
		});
	}

	getRun(runId: string): RunRecordSummary | null {
		const run = this.runs.get(runId);
		return run ? cloneSummary(run.summary) : null;
	}

	listRuns(filter?: { planSlug?: string }): RunRecordSummary[] {
		let rows = [...this.runs.values()].map((run) => cloneSummary(run.summary));
		if (filter?.planSlug !== undefined) {
			rows = rows.filter(
				(summary) => planSlugFromPath(summary.plan_path) === filter.planSlug,
			);
		}
		return rows;
	}

	getLine(
		runId: string,
		stream: RecordStream,
		idempotencyKey: string,
	): RecordLine | null {
		const run = this.requireRun(runId);
		const name = requireStream(stream);
		const line = run.streams[name].lines.get(idempotencyKey);
		return line ? cloneLine(line) : null;
	}

	listLines(runId: string, stream: RecordStream): RecordLine[] {
		const run = this.requireRun(runId);
		const name = requireStream(stream);
		const state = run.streams[name];
		const lines: RecordLine[] = [];
		for (const key of state.order) {
			const line = state.lines.get(key);
			if (line) lines.push(cloneLine(line));
		}
		return lines;
	}

	append(op: AppendOp): AppendResult {
		const [result] = this.atomicAppend([op]);
		if (!result) {
			throw new RecordStoreError("RUN_NOT_FOUND", `run ${op.runId} not found`);
		}
		return result;
	}

	atomicAppend(ops: AppendOp[]): AppendResult[] {
		if (ops.length === 0) return [];
		requireSingleRunAtomicAppend(ops);

		const now = this.now();
		const clones = new Map<string, RunState>();

		for (const op of ops) {
			if (clones.has(op.runId)) continue;
			const run = this.runs.get(op.runId);
			if (!run) {
				throw new RecordStoreError(
					"RUN_NOT_FOUND",
					`run ${op.runId} not found`,
				);
			}
			clones.set(op.runId, cloneRun(run));
		}

		const results: AppendResult[] = [];
		for (const op of ops) {
			const clone = clones.get(op.runId);
			if (!clone) {
				throw new RecordStoreError(
					"RUN_NOT_FOUND",
					`run ${op.runId} not found`,
				);
			}
			results.push(applyOp(clone, op, now));
		}

		this.onBeforeCommit?.();

		for (const [runId, clone] of clones) {
			this.runs.set(runId, clone);
		}
		return results;
	}

	private requireRun(runId: string): RunState {
		const run = this.runs.get(runId);
		if (!run) {
			throw new RecordStoreError("RUN_NOT_FOUND", `run ${runId} not found`);
		}
		return run;
	}
}

export function createMemoryRecordStore(
	opts?: MemoryRecordStoreOptions,
): RecordStore {
	return new MemoryRecordStore(opts);
}
