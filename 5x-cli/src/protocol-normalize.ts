/**
 * Shared normalization for structured protocol output.
 *
 * Maps alternative field names to canonical schema. Used by both
 * `5x protocol emit` (primary path) and `5x protocol validate`
 * (safety net for agents that don't use emit).
 *
 * Phase 3, 022-orchestration-reliability.
 */

import type { AuthorStatus, ReviewerVerdict, VerdictItem } from "./protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reviewer verdict normalization
// ---------------------------------------------------------------------------

/** Map alternative readiness values to canonical. */
const READINESS_MAP: Record<string, ReviewerVerdict["readiness"]> = {
	rejected: "not_ready",
	approved: "ready",
	conditionally_approved: "ready_with_corrections",
	// Canonical values pass through
	ready: "ready",
	ready_with_corrections: "ready_with_corrections",
	not_ready: "not_ready",
};

/** Map alternative priority/severity values to canonical. */
const PRIORITY_MAP: Record<string, VerdictItem["priority"]> = {
	critical: "P0",
	major: "P0",
	moderate: "P1",
	minor: "P2",
	// Canonical values pass through
	P0: "P0",
	P1: "P1",
	P2: "P2",
};

/**
 * Normalize a reviewer verdict from alternative field names to canonical schema.
 *
 * Mappings:
 * - Top-level: `verdict` → `readiness` (with value mapping)
 * - Top-level: `issues` → `items`
 * - Per-item: `severity` → `priority` (with value mapping)
 * - Per-item: auto-generates `id` if missing ("R1", "R2", ...)
 * - Per-item: defaults `action` to `"human_required"` if missing
 * - Passes through already-conforming input unchanged
 */
export function normalizeReviewerVerdict(input: unknown): object {
	const record = asRecord(input);
	if (!record) return input as object;

	const result: Record<string, unknown> = { ...record };

	// Map verdict → readiness
	if ("verdict" in record && !("readiness" in record)) {
		const mapped = READINESS_MAP[String(record.verdict)];
		if (mapped) {
			result.readiness = mapped;
		} else {
			result.readiness = record.verdict;
		}
		delete result.verdict;
	} else if ("readiness" in record) {
		// Normalize canonical readiness values too (e.g. typos won't map)
		const mapped = READINESS_MAP[String(record.readiness)];
		if (mapped) {
			result.readiness = mapped;
		}
	}

	// Map issues → items
	if ("issues" in record && !("items" in record)) {
		result.items = record.issues;
		delete result.issues;
	}

	// Normalize items array
	const items = result.items;
	if (Array.isArray(items)) {
		result.items = items.map((item, index) => {
			const rec = asRecord(item);
			if (!rec) return item;

			const normalized: Record<string, unknown> = { ...rec };

			// Auto-generate id if missing
			if (!normalized.id) {
				normalized.id = `R${index + 1}`;
			}

			// Default action to human_required if missing
			if (!normalized.action) {
				normalized.action = "human_required";
			}

			// Map severity → priority
			if ("severity" in rec && !("priority" in rec)) {
				const mapped = PRIORITY_MAP[String(rec.severity)];
				if (mapped) {
					normalized.priority = mapped;
				} else {
					normalized.priority = rec.severity;
				}
				delete normalized.severity;
			} else if ("priority" in rec) {
				const mapped = PRIORITY_MAP[String(rec.priority)];
				if (mapped) {
					normalized.priority = mapped;
				}
			}

			return normalized;
		});
	}

	return result;
}

// ---------------------------------------------------------------------------
// Author status normalization
// ---------------------------------------------------------------------------

/** Map alternative result/status values to canonical. */
const RESULT_MAP: Record<string, AuthorStatus["result"]> = {
	done: "complete",
	blocked: "needs_human",
	error: "failed",
	// Canonical values pass through
	complete: "complete",
	needs_human: "needs_human",
	failed: "failed",
};

/**
 * Normalize an author status from alternative field names to canonical schema.
 *
 * Mappings:
 * - `status` → `result` (with value mapping: "done" → "complete",
 *   "blocked" → "needs_human", "error" → "failed")
 * - For non-complete results, if `reason` is absent, falls back to
 *   `notes` or `summary`
 * - Passes through already-conforming input unchanged
 *
 * Replaces `normalizeLegacyAuthorStatus` from protocol.ts.
 */
export function normalizeAuthorStatus(input: unknown): object {
	const record = asRecord(input);
	if (!record) return input as object;

	// Determine if normalization is needed
	const needsStatusMapping = "status" in record && !("result" in record);

	// If input already has `result` and no `status`, it's already canonical.
	// Pass through unchanged to preserve extra fields (e.g., `phase`).
	if (!needsStatusMapping) {
		return input as object;
	}

	// Build canonical object — only include canonical AuthorStatus fields.
	// This avoids carrying over non-canonical fields like `summary` that
	// aren't part of the AuthorStatus type.
	const mapped = RESULT_MAP[String(record.status)];
	const canonicalResult: string = mapped ?? String(record.status);

	const result: Record<string, unknown> = { result: canonicalResult };

	// Copy commit if present
	if (typeof record.commit === "string") {
		result.commit = record.commit;
	}

	// Copy notes if present, or fall back to summary for complete results
	if (typeof record.notes === "string") {
		result.notes = record.notes;
	} else if (
		canonicalResult === "complete" &&
		typeof record.summary === "string"
	) {
		result.notes = record.summary;
	}

	// Determine reason: explicit, or fall back to notes/summary for non-complete
	if (typeof record.reason === "string") {
		result.reason = record.reason;
	} else if (canonicalResult !== "complete") {
		if (typeof record.notes === "string") {
			result.reason = record.notes;
		} else if (typeof record.summary === "string") {
			result.reason = record.summary;
		}
	}

	return result;
}
