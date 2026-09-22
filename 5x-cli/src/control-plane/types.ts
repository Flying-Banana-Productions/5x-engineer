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

import type {
	FindingIdentity,
	ReviewDecisionChoice,
	ReviewGateCause,
} from "../review-governance/types.js";

export const REVIEW_GATE_PROMPT_CONTEXT_VERSION = 1 as const;

/** Structured notification metadata. The prompt answer is never authoritative. */
export interface ReviewGatePromptContext {
	type: "plan_review_gate";
	gateId: string;
	snapshotId: string;
	causes: ReviewGateCause[];
	eligibleFindings: FindingIdentity[];
	allowedChoices: ReviewDecisionChoice[];
	requiredFieldsByChoice: Record<ReviewDecisionChoice, string[]>;
}

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
	contextVersion?: number | null;
	context?: ReviewGatePromptContext | null;
}

export interface CreatePromptInput {
	runId?: string | null;
	kind: PromptKind;
	message: string;
	options?: string[] | null;
	defaultValue?: string | null;
	contextVersion?: number | null;
	context?: ReviewGatePromptContext | null;
	/** Tests only — production callers omit this and get `createPromptId()`. */
	id?: string;
}

export type CasResult =
	| { ok: true; prompt: PromptRecord }
	| { ok: false; prompt: PromptRecord }; // already answered or abandoned

/** Display-safe projection for future authenticated adapters. */
export interface RedactedPromptView {
	id: string;
	runId: string | null;
	kind: PromptKind;
	message: string;
	createdAt: string;
	answeredAt: string | null;
	abandonedAt: string | null;
	contextVersion: number | null;
	context: ReviewGatePromptContext | null;
}

export function toRedactedPromptView(prompt: PromptRecord): RedactedPromptView {
	return {
		id: prompt.id,
		runId: prompt.runId,
		kind: prompt.kind,
		message: prompt.message,
		createdAt: prompt.createdAt,
		answeredAt: prompt.answeredAt,
		abandonedAt: prompt.abandonedAt,
		contextVersion: prompt.contextVersion ?? null,
		context: prompt.context ? structuredClone(prompt.context) : null,
	};
}

/** Store-layer error. Handlers map codes (e.g. `PROMPT_NOT_FOUND`) later. */
export class PromptStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PromptStoreError";
		this.code = code;
	}
}
