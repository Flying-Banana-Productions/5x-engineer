/**
 * Run ID and log sequence generation.
 */

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";

/** Generate a run ID: `"run_"` + 12 hex chars from a UUID. */
export function generateRunId(): string {
	return `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Generate the next log sequence number for agent invocations within a run.
 *
 * Scans existing `agent-NNN.ndjson` files in `logDir` and returns the next
 * zero-padded sequence string (e.g. `"001"`, `"002"`).
 */
export function nextLogSequence(logDir: string): string {
	let maxSeq = 0;
	try {
		const entries = readdirSync(logDir);
		for (const entry of entries) {
			const match = entry.match(/^agent-(\d+)\.ndjson$/);
			if (match?.[1]) {
				const seq = Number.parseInt(match[1], 10);
				if (seq > maxSeq) {
					maxSeq = seq;
				}
			}
		}
	} catch {
		// Directory doesn't exist yet — start at 001
	}
	return String(maxSeq + 1).padStart(3, "0");
}
