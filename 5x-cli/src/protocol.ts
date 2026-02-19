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
