/**
 * Shared structured-output validation helpers.
 *
 * Extracted from invoke.handler.ts and protocol.handler.ts (Phase 1,
 * 014-harness-native-subagent) so both paths share one validation
 * contract.
 *
 * Framework-independent: no citty imports.
 */

import { outputError } from "../output.js";
import {
	type AuthorStatus,
	assertAuthorStatus,
	assertReviewerVerdict,
	isStructuredOutputError,
	type ReviewerVerdict,
} from "../protocol.js";

export type ValidateRole = "author" | "reviewer";

export interface ValidateOptions {
	/**
	 * For author validation: whether a commit hash is required when
	 * result === "complete". Defaults to true.
	 */
	requireCommit?: boolean;

	/**
	 * Context label for assertion error messages (e.g. "invoke author",
	 * "protocol validate author").
	 */
	context: string;
}

// ---------------------------------------------------------------------------
// Result type — allows callers to perform async cleanup before exiting
// ---------------------------------------------------------------------------

export type ValidationResult =
	| { ok: true; value: AuthorStatus | ReviewerVerdict }
	| { ok: false; code: string; message: string; detail?: unknown };

/**
 * Validate a structured output value against the author or reviewer protocol.
 *
 * Returns a discriminated result so callers can perform async cleanup (e.g.
 * awaiting `provider.close()`) before emitting error output. This avoids
 * the previous pattern where `outputError()` threw immediately, preventing
 * async cleanup callbacks from completing.
 */
export function validateStructuredOutput(
	structured: unknown,
	role: ValidateRole,
	opts: ValidateOptions,
): ValidationResult {
	// Check for StructuredOutputError BEFORE the object guard — real error
	// payloads are typically objects and would fall through to assert* otherwise.
	if (isStructuredOutputError(structured)) {
		return {
			ok: false,
			code: "INVALID_STRUCTURED_OUTPUT",
			message:
				role === "author"
					? "Agent returned a structured output error"
					: "Input contains a structured output error",
			detail: { raw: structured },
		};
	}

	if (!structured || typeof structured !== "object") {
		return {
			ok: false,
			code: "INVALID_STRUCTURED_OUTPUT",
			message: `${role === "author" ? "Agent did not return" : "Input is not"} a valid structured object for ${role}`,
			detail: { raw: structured ?? null },
		};
	}

	try {
		if (role === "author") {
			const requireCommit = opts.requireCommit !== false;
			assertAuthorStatus(structured as AuthorStatus, opts.context, {
				requireCommit,
			});
		} else {
			assertReviewerVerdict(structured as ReviewerVerdict, opts.context);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			code: "INVALID_STRUCTURED_OUTPUT",
			message,
			detail: { raw: structured },
		};
	}

	return { ok: true, value: structured as AuthorStatus | ReviewerVerdict };
}

/**
 * Convenience wrapper: validate structured output and emit `outputError()`
 * on failure. Use this in callers that have no async cleanup to perform
 * (e.g. `protocol.handler.ts`). Callers that need async cleanup before
 * exiting (e.g. `invoke.handler.ts` with provider.close()) should use
 * `validateStructuredOutput()` directly and handle the failure branch.
 */
export function validateStructuredOutputOrThrow(
	structured: unknown,
	role: ValidateRole,
	opts: ValidateOptions,
): AuthorStatus | ReviewerVerdict {
	const result = validateStructuredOutput(structured, role, opts);
	if (!result.ok) {
		outputError(result.code, result.message, result.detail);
	}
	return result.value;
}
