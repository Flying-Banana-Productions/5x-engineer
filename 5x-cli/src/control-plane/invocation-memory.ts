/**
 * In-memory InvocationStore. Single-threaded compare-and-set is enough for
 * tests. `getRun` is invoked inside `markAbandonedIfStale` so run-terminal
 * CAS does not reopen a TOCTOU.
 */

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
	RegisterInvocationInput,
} from "./invocation-types.js";
import {
	InvocationStoreError,
	parseOpaqueCancellationHandle,
} from "./invocation-types.js";

export interface MemoryInvocationStoreOptions {
	now?: () => string;
	getRun?: (runId: string) => { status: string } | null;
}

function utcNow(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function cloneRecord(record: InvocationRecord): InvocationRecord {
	return {
		...record,
		handle: { ...record.handle },
	};
}

function isRunTerminal(run: { status: string } | null): boolean {
	if (run === null) return true;
	return run.status === "completed" || run.status === "aborted";
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

class MemoryInvocationStore implements InvocationStore {
	private readonly records = new Map<string, InvocationRecord>();
	private readonly now: () => string;
	private readonly getRun?: (runId: string) => { status: string } | null;

	constructor(opts?: MemoryInvocationStoreOptions) {
		this.now = opts?.now ?? utcNow;
		this.getRun = opts?.getRun;
	}

	register(input: RegisterInvocationInput): InvocationRecord {
		const handle = parseOpaqueCancellationHandle(input.handle);
		const id = input.id ?? createInvocationId();
		if (this.records.has(id)) {
			throw new InvocationStoreError(
				"INVOCATION_ALREADY_EXISTS",
				`invocation ${id} already exists`,
			);
		}
		const ts = this.now();
		const record: InvocationRecord = {
			id,
			runId: input.runId,
			sessionId: input.sessionId ?? null,
			role: input.role,
			providerName: input.providerName,
			templateName: input.templateName ?? null,
			handle: { adapter: handle.adapter, ref: handle.ref },
			cancellationSupported: input.cancellationSupported,
			status: "running",
			createdAt: ts,
			updatedAt: ts,
			cancellationRequestedAt: null,
			cancellationRequestedBy: null,
			cancellationOutcome: null,
			cancellationOutcomeAt: null,
			terminalAt: null,
			abandonReason: null,
		};
		this.records.set(id, record);
		return cloneRecord(record);
	}

	get(id: string): InvocationRecord | null {
		const record = this.records.get(id);
		return record ? cloneRecord(record) : null;
	}

	list(filter?: {
		runId?: string;
		status?: InvocationStatus;
	}): InvocationRecord[] {
		let rows = [...this.records.values()];
		if (filter?.runId !== undefined) {
			rows = rows.filter((row) => row.runId === filter.runId);
		}
		if (filter?.status !== undefined) {
			rows = rows.filter((row) => row.status === filter.status);
		}
		rows.sort((a, b) => {
			if (a.createdAt < b.createdAt) return -1;
			if (a.createdAt > b.createdAt) return 1;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		return rows.map(cloneRecord);
	}

	heartbeat(id: string): InvocationRecord {
		const current = this.requireInvocation(id);
		if (current.status !== "running") {
			return cloneRecord(current);
		}
		current.updatedAt = this.now();
		return cloneRecord(current);
	}

	markCancellationRequested(
		id: string,
		actor: CancellationActor,
	): InvocationCasResult {
		const current = this.requireInvocation(id);
		if (
			current.status !== "running" ||
			!current.cancellationSupported ||
			current.cancellationRequestedAt !== null
		) {
			return { ok: false, invocation: cloneRecord(current) };
		}
		const ts = this.now();
		current.cancellationRequestedAt = ts;
		current.cancellationRequestedBy = actor;
		current.updatedAt = ts;
		return { ok: true, invocation: cloneRecord(current) };
	}

	recordCancellationOutcome(
		id: string,
		outcome: CancellationOutcome,
	): InvocationRecord {
		const current = this.requireInvocation(id);
		const ts = this.now();
		current.cancellationOutcome = outcome;
		current.cancellationOutcomeAt = ts;
		current.updatedAt = ts;
		return cloneRecord(current);
	}

	markTerminal(
		id: string,
		status: "completed" | "failed" | "cancelled",
	): InvocationCasResult {
		const current = this.requireInvocation(id);
		if (current.status !== "running") {
			return { ok: false, invocation: cloneRecord(current) };
		}
		const ts = this.now();
		current.status = status;
		current.terminalAt = ts;
		current.updatedAt = ts;
		return { ok: true, invocation: cloneRecord(current) };
	}

	markAbandoned(
		id: string,
		reason: InvocationAbandonReason,
	): InvocationCasResult {
		const current = this.requireInvocation(id);
		if (current.status !== "running") {
			return { ok: false, invocation: cloneRecord(current) };
		}
		const ts = this.now();
		current.status = "abandoned";
		current.abandonReason = reason;
		current.terminalAt = ts;
		current.updatedAt = ts;
		return { ok: true, invocation: cloneRecord(current) };
	}

	markAbandonedIfStale(opts: {
		id: string;
		reason: InvocationAbandonReason;
		expectedUpdatedAt: string;
		staleReason: "heartbeat" | "run-terminal";
	}): InvocationCasResult {
		const current = this.requireInvocation(opts.id);
		if (current.status !== "running") {
			return { ok: false, invocation: cloneRecord(current) };
		}
		if (opts.staleReason === "heartbeat") {
			if (current.updatedAt !== opts.expectedUpdatedAt) {
				return { ok: false, invocation: cloneRecord(current) };
			}
		} else {
			const run = this.getRun?.(current.runId) ?? null;
			if (!isRunTerminal(run)) {
				return { ok: false, invocation: cloneRecord(current) };
			}
		}
		const ts = this.now();
		current.status = "abandoned";
		current.abandonReason = opts.reason;
		current.terminalAt = ts;
		current.updatedAt = ts;
		return { ok: true, invocation: cloneRecord(current) };
	}

	listStale(opts: { olderThanMs: number; nowMs: number }): InvocationRecord[] {
		return [...this.records.values()]
			.filter(
				(row) =>
					row.status === "running" &&
					isStale(row.updatedAt, opts.olderThanMs, opts.nowMs),
			)
			.sort((a, b) => {
				if (a.updatedAt < b.updatedAt) return -1;
				if (a.updatedAt > b.updatedAt) return 1;
				return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
			})
			.map(cloneRecord);
	}

	private requireInvocation(id: string): InvocationRecord {
		const record = this.records.get(id);
		if (!record) {
			throw new InvocationStoreError(
				"INVOCATION_NOT_FOUND",
				`invocation ${id} not found`,
			);
		}
		return record;
	}
}

export function createMemoryInvocationStore(
	opts?: MemoryInvocationStoreOptions,
): InvocationStore {
	return new MemoryInvocationStore(opts);
}
