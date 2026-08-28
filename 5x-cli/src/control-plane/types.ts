/**
 * Control-plane prompt record types and CAS result.
 *
 * Confirm answers persist as `"true"` / `"false"` strings; handlers map to
 * `{ confirmed: boolean }`. Choose/input persist the option/text string.
 */

export type PromptKind = "choose" | "confirm" | "input";
export type AnsweredBy = "terminal" | "control-plane" | "default";
export type AbandonReason =
	| "timeout"
	| "interrupted"
	| "eof"
	| "non-interactive"
	| "run-terminal";

export interface PromptRecord {
	id: string;
	runId: string | null;
	kind: PromptKind;
	message: string;
	options: string[] | null;
	defaultValue: string | null;
	createdAt: string;
	answeredAt: string | null;
	answer: string | null;
	answeredBy: AnsweredBy | null;
	abandonedAt: string | null;
	abandonReason: AbandonReason | null;
}

export interface CreatePromptInput {
	runId?: string | null;
	kind: PromptKind;
	message: string;
	options?: string[] | null;
	defaultValue?: string | null;
	/** Tests only — production callers omit this and get `createPromptId()`. */
	id?: string;
}

export type CasResult =
	| { ok: true; prompt: PromptRecord }
	| { ok: false; prompt: PromptRecord }; // already answered or abandoned

/** Store-layer error. Handlers map codes (e.g. `PROMPT_NOT_FOUND`) later. */
export class PromptStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PromptStoreError";
		this.code = code;
	}
}
