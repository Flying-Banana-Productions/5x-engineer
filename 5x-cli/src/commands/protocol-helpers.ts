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

	/**
	 * Optional cleanup callback invoked before outputError (e.g. to close
	 * a provider). Not awaited — callers that need async cleanup should
	 * wrap this function.
	 */
	onError?: () => void;
}

/**
 * Validate a structured output value against the author or reviewer protocol.
 *
 * On validation failure, calls `outputError()` (which exits the process via
 * CliError). On success, returns the validated structured object.
 */
export function validateStructuredOutput(
	structured: unknown,
	role: ValidateRole,
	opts: ValidateOptions,
): AuthorStatus | ReviewerVerdict {
	// Check for StructuredOutputError BEFORE the object guard — real error
	// payloads are typically objects and would fall through to assert* otherwise.
	if (isStructuredOutputError(structured)) {
		opts.onError?.();
		outputError(
			"INVALID_STRUCTURED_OUTPUT",
			role === "author"
				? "Agent returned a structured output error"
				: "Input contains a structured output error",
			{ raw: structured },
		);
	}

	if (!structured || typeof structured !== "object") {
		opts.onError?.();
		outputError(
			"INVALID_STRUCTURED_OUTPUT",
			`${role === "author" ? "Agent did not return" : "Input is not"} a valid structured object for ${role}`,
			{ raw: structured ?? null },
		);
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
		opts.onError?.();
		const message = err instanceof Error ? err.message : String(err);
		outputError("INVALID_STRUCTURED_OUTPUT", message, { raw: structured });
	}

	return structured as AuthorStatus | ReviewerVerdict;
}
