/**
 * Run ID generation and validation.
 */

import { randomUUID } from "node:crypto";
import { outputError } from "./output.js";

/** Generate a run ID: `"run_"` + 12 hex chars from a UUID. */
export function generateRunId(): string {
	return `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Safe run_id pattern: alphanumeric start, then alphanumeric/underscore/hyphen, max 64 chars. */
export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validate that a run_id is safe for use as a filesystem path component. Throws CliError on failure. */
export function validateRunId(runId: string): void {
	if (!SAFE_RUN_ID.test(runId)) {
		outputError(
			"INVALID_ARGS",
			`--run must match ${SAFE_RUN_ID} (alphanumeric start, alphanumeric/underscore/hyphen, 1-64 chars), got: "${runId}"`,
		);
	}
}
