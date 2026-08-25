/**
 * Prompt ID generation. Prompt ids are RFC 4122 UUIDs, not run_ + 12 hex.
 */

import { randomUUID } from "node:crypto";

/** Generate a prompt ID (RFC 4122 UUID). */
export function createPromptId(): string {
	return randomUUID();
}
