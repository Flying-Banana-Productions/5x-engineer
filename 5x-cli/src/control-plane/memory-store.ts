/**
 * In-memory PromptStore. Single-threaded compare-and-set is enough for tests
 * and as the injected "test control-plane writer."
 */

import { createPromptId } from "./ids.js";
import type { PromptStore } from "./store.js";
import type {
	AbandonReason,
	AnsweredBy,
	CasResult,
	CreatePromptInput,
	PromptRecord,
} from "./types.js";
import { PromptStoreError } from "./types.js";

function utcNow(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function cloneRecord(record: PromptRecord): PromptRecord {
	return {
		...record,
		options: record.options ? [...record.options] : null,
	};
}

function isOpen(record: PromptRecord): boolean {
	return record.answeredAt === null && record.abandonedAt === null;
}

class MemoryPromptStore implements PromptStore {
	private readonly records = new Map<string, PromptRecord>();

	createPrompt(input: CreatePromptInput): PromptRecord {
		const id = input.id ?? createPromptId();
		if (this.records.has(id)) {
			throw new PromptStoreError(
				"PROMPT_ALREADY_EXISTS",
				`prompt ${id} already exists`,
			);
		}
		const record: PromptRecord = {
			id,
			runId: input.runId ?? null,
			kind: input.kind,
			message: input.message,
			options: input.options ? [...input.options] : (input.options ?? null),
			defaultValue: input.defaultValue ?? null,
			createdAt: utcNow(),
			answeredAt: null,
			answer: null,
			answeredBy: null,
			abandonedAt: null,
			abandonReason: null,
		};
		this.records.set(id, record);
		return cloneRecord(record);
	}

	getPrompt(id: string): PromptRecord | null {
		const record = this.records.get(id);
		return record ? cloneRecord(record) : null;
	}

	listOpenPrompts(runId?: string): PromptRecord[] {
		const open = [...this.records.values()].filter(isOpen);
		const filtered =
			runId === undefined ? open : open.filter((row) => row.runId === runId);
		filtered.sort((a, b) =>
			a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
		);
		return filtered.map(cloneRecord);
	}

	answerPrompt(id: string, answer: string, answeredBy: AnsweredBy): CasResult {
		const current = this.requirePrompt(id);
		if (!isOpen(current)) {
			return { ok: false, prompt: cloneRecord(current) };
		}
		current.answeredAt = utcNow();
		current.answer = answer;
		current.answeredBy = answeredBy;
		return { ok: true, prompt: cloneRecord(current) };
	}

	abandonPrompt(id: string, reason: AbandonReason): CasResult {
		const current = this.requirePrompt(id);
		if (!isOpen(current)) {
			return { ok: false, prompt: cloneRecord(current) };
		}
		current.abandonedAt = utcNow();
		current.abandonReason = reason;
		return { ok: true, prompt: cloneRecord(current) };
	}

	private requirePrompt(id: string): PromptRecord {
		const record = this.records.get(id);
		if (!record) {
			throw new PromptStoreError("PROMPT_NOT_FOUND", `prompt ${id} not found`);
		}
		return record;
	}
}

export function createMemoryPromptStore(): PromptStore {
	return new MemoryPromptStore();
}
