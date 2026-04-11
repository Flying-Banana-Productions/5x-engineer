/**
 * Prompt size is passed on the command line (`-p`). Enforce a byte budget before
 * spawn so failures are deterministic and we never rely on shell/OS argv limits alone.
 *
 * Size is measured in UTF-8 bytes (not JavaScript string length).
 */
export const MAX_PROMPT_BYTES = 256 * 1024;

const encoder = new TextEncoder();

export function getPromptBytes(prompt: string): number {
	return encoder.encode(prompt).length;
}

export interface PromptOverLimitPayload {
	actualBytes: number;
	maxBytes: number;
}

/** Stable message body for throws and `AgentEvent.error` (includes JSON-serializable payload). */
export function formatPromptOverLimitMessage(
	payload: PromptOverLimitPayload,
): string {
	return `Prompt exceeds maximum byte length (${payload.actualBytes} bytes, max ${payload.maxBytes} bytes)`;
}

export type PromptGuardResult =
	| { ok: true; bytes: number }
	| { ok: false; error: PromptOverLimitPayload };

/**
 * Returns `{ ok: false, error }` when `prompt` is larger than `MAX_PROMPT_BYTES`
 * (or than `maxBytes` when provided).
 */
export function guardPromptSize(
	prompt: string,
	maxBytes: number = MAX_PROMPT_BYTES,
): PromptGuardResult {
	const bytes = getPromptBytes(prompt);
	if (bytes > maxBytes) {
		return {
			ok: false,
			error: { actualBytes: bytes, maxBytes },
		};
	}
	return { ok: true, bytes };
}
