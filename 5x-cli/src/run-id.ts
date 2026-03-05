/**
 * Run ID generation.
 */

import { randomUUID } from "node:crypto";

/** Generate a run ID: `"run_"` + 12 hex chars from a UUID. */
export function generateRunId(): string {
	return `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
