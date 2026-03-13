export type LegacyAuthorStatus = {
	status: "done" | "failed" | "needs_human";
	commit?: string;
	reason?: string;
	notes?: string;
	summary?: string;
};

export type AuthorStatus = {
	result: "complete" | "needs_human" | "failed";
	commit?: string;
	reason?: string;
	notes?: string;
};

export type VerdictItem = {
	id: string;
	title: string;
	action: "auto_fix" | "human_required";
	reason: string;
	priority?: "P0" | "P1" | "P2";
};

export type ReviewerVerdict = {
	readiness: "ready" | "ready_with_corrections" | "not_ready";
	items: VerdictItem[];
	summary?: string;
};

export const AuthorStatusSchema = {
	type: "object",
	properties: {
		result: {
			type: "string",
			enum: ["complete", "needs_human", "failed"],
			description: "Outcome of the author's work",
		},
		commit: {
			type: "string",
			description:
				"Git commit hash if result is 'complete' for phase execution. Omit otherwise.",
		},
		reason: {
			type: "string",
			description:
				"Required if result is 'needs_human' or 'failed'. Brief explanation.",
		},
		notes: {
			type: "string",
			description: "Optional notes for the reviewer about what was done.",
		},
	},
	required: ["result"],
} as const;

export const ReviewerVerdictSchema = {
	type: "object",
	properties: {
		readiness: {
			type: "string",
			enum: ["ready", "ready_with_corrections", "not_ready"],
			description: "Overall readiness assessment",
		},
		items: {
			type: "array",
			description: "Review items. Empty array if readiness is 'ready'.",
			items: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description: "Short unique identifier, e.g. 'P0.1'",
					},
					title: { type: "string", description: "One-line description" },
					action: {
						type: "string",
						enum: ["auto_fix", "human_required"],
						description:
							"auto_fix: mechanical, author can resolve. human_required: needs judgment.",
					},
					reason: {
						type: "string",
						description: "Why this item needs attention",
					},
					priority: {
						type: "string",
						enum: ["P0", "P1", "P2"],
						description: "P0: blocking. P1: important. P2: nice-to-have.",
					},
				},
				required: ["id", "title", "action", "reason"],
			},
		},
		summary: {
			type: "string",
			description: "Optional 1-3 sentence overall assessment.",
		},
	},
	required: ["readiness", "items"],
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	return value as Record<string, unknown>;
}

export function isStructuredOutputError(result: unknown): boolean {
	const root = asRecord(result);
	if (!root) return false;

	const data = asRecord(root.data);
	const info = asRecord(data?.info);
	const error = asRecord(info?.error ?? root.error);
	if (!error) return false;

	const name = error.name;
	if (name === "StructuredOutputError") return true;

	const message = error.message;
	return (
		typeof message === "string" &&
		message.toLowerCase().includes("structured output")
	);
}

export function assertAuthorStatus(
	status: AuthorStatus,
	context: string,
	opts?: { requireCommit?: boolean },
): void {
	if (status.result === "complete" && opts?.requireCommit && !status.commit) {
		throw new Error(
			`[${context}] AuthorStatus invariant violation: result is 'complete' but 'commit' is missing. ` +
				"Phase execution requires a commit hash. Escalating.",
		);
	}

	if (status.result !== "complete" && !status.reason) {
		throw new Error(
			`[${context}] AuthorStatus invariant violation: result is '${status.result}' but 'reason' is missing. ` +
				"Required for needs_human/failed results. Escalating.",
		);
	}
}

export function assertReviewerVerdict(
	verdict: ReviewerVerdict,
	context: string,
): void {
	if (verdict.readiness !== "ready" && verdict.items.length === 0) {
		throw new Error(
			`[${context}] ReviewerVerdict invariant violation: readiness is '${verdict.readiness}' but 'items' is empty. ` +
				"Review items are required for non-ready verdicts. Escalating.",
		);
	}

	for (const item of verdict.items) {
		if (!item.action) {
			throw new Error(
				`[${context}] ReviewerVerdict invariant violation: item '${item.id}' is missing 'action'. ` +
					"Each item must have action: 'auto_fix' | 'human_required'. Escalating.",
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Legacy author status normalization (Phase 3, 016-review-artifacts)
// ---------------------------------------------------------------------------

/**
 * Detects and normalizes legacy native author payloads that use `status`
 * instead of canonical `result`. This provides backward compatibility for
 * native subagent outputs while the public protocol remains strict.
 *
 * Mappings:
 * - `status: "done"` → `result: "complete"`
 * - `status: "failed"` → `result: "failed"`
 * - `status: "needs_human"` → `result: "needs_human"`
 *
 * For non-complete results, if `reason` is absent, it falls back to `notes`
 * or `summary` (in that order) to satisfy the invariant checks.
 *
 * @param value The raw structured output value (may be legacy or canonical)
 * @returns Normalized canonical AuthorStatus object, or the original value
 *          if it doesn't appear to be a legacy payload.
 */
export function normalizeLegacyAuthorStatus(
	value: unknown,
): AuthorStatus | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;

	// Only normalize if we see a legacy `status` field without `result`
	if (!("status" in record) || "result" in record) {
		return null;
	}

	const status = record.status;
	if (status !== "done" && status !== "failed" && status !== "needs_human") {
		return null;
	}

	// Map legacy status to canonical result
	const result: AuthorStatus["result"] =
		status === "done" ? "complete" : status;

	// Build normalized object
	const normalized: AuthorStatus = {
		result,
	};

	// Copy commit if present (applies to complete results)
	if (typeof record.commit === "string") {
		normalized.commit = record.commit;
	}

	// Copy notes if present, or fall back to summary for complete results
	if (typeof record.notes === "string") {
		normalized.notes = record.notes;
	} else if (result === "complete" && typeof record.summary === "string") {
		// For complete results, summary becomes notes if notes is absent
		normalized.notes = record.summary;
	}

	// Determine reason: use explicit reason, or fall back to notes/summary
	// for non-complete results when reason is missing
	let reason: string | undefined;
	if (typeof record.reason === "string") {
		reason = record.reason;
	} else if (result !== "complete") {
		// For non-complete, fall back to notes or summary
		if (typeof record.notes === "string") {
			reason = record.notes;
		} else if (typeof record.summary === "string") {
			reason = record.summary;
		}
	}

	if (reason) {
		normalized.reason = reason;
	}

	return normalized;
}
