/**
 * PromptStore contract. Command logic and the future dashboard depend on this
 * interface, never on `bun:sqlite`.
 */

import type {
	AbandonReason,
	AnsweredBy,
	CasResult,
	CreatePromptInput,
	PromptRecord,
} from "./types.js";

export interface PromptStore {
	createPrompt(input: CreatePromptInput): PromptRecord;
	getPrompt(id: string): PromptRecord | null;
	listOpenPrompts(runId?: string): PromptRecord[];
	/**
	 * Additive (Phase 7 backfill). Answered, non-abandoned prompts for a run.
	 * Older callers may omit this method.
	 */
	listAnsweredPrompts?(runId: string): PromptRecord[];
	/** CAS: succeed iff still open. Loser returns stored row, does not overwrite. */
	answerPrompt(id: string, answer: string, answeredBy: AnsweredBy): CasResult;
	abandonPrompt(id: string, reason: AbandonReason): CasResult;
}
