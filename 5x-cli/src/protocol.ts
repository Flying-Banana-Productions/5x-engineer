import type { BaselineAssessment } from "./review-budget/types.js";
import {
	ARCHITECTURE_DELTAS,
	EFFORT_POINTS,
} from "./review-budget/types.js";

export type { BaselineAssessment };

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

export type PlanReviewScopeClass =
	| "acceptance_required"
	| "risk_reduction"
	| "polish";

export interface CreditClaim {
	creditClaimId: string;
	targetPhase: string;
	minimalAlternativeEffortDelta: number;
	minimalAlternativeArchitectureDelta: number;
	before: string;
	after: string;
}

export type VerdictItem = {
	id: string;
	title: string;
	action: "auto_fix" | "human_required";
	reason: string;
	priority?: "P0" | "P1" | "P2";
	scopeClass?: PlanReviewScopeClass;
	effortDelta?: number;
	architectureDelta?: number;
	coupling?: "intrinsic" | "adjacent" | "unrelated";
	estimateConfidence?: "low" | "medium" | "high";
	creditClaim?: CreditClaim;
};

export interface CreditAssessment {
	creditClaimId: string;
	eligibility: "eligible" | "ineligible";
	coupling: "intrinsic" | "adjacent" | "unrelated";
	reason: string;
}

export type ReviewerVerdict = {
	readiness: "ready" | "ready_with_corrections" | "not_ready";
	items: VerdictItem[];
	summary?: string;
	baselineAssessment?: BaselineAssessment;
	creditAssessments?: CreditAssessment[];
};

export const CLI_OWNED_VERDICT_KEYS = [
	"budget",
	"budgetBand",
	"budgetAlerts",
	"requiresHuman",
	"B0",
	"B",
	"W",
	"R",
	"S",
	"N",
	"D",
	"E",
	"A",
	"P",
	"projectedEffort",
	"baselineDirection",
] as const;

/** Reject fields whose values are derived and owned by the CLI. */
export function rejectCliOwnedBudgetFields(value: unknown): void {
	const pending: unknown[] = [value];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== "object" || visited.has(current)) continue;
		visited.add(current);
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		const record = current as Record<string, unknown>;
		const key = CLI_OWNED_VERDICT_KEYS.find((candidate) =>
			Object.hasOwn(record, candidate),
		);
		if (key) {
			throw new Error(
				`Reviewer verdict must not provide CLI-derived budget field '${key}'.`,
			);
		}
		pending.push(...Object.values(record));
	}
}

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
					scopeClass: {
						type: "string",
						enum: ["acceptance_required", "risk_reduction", "polish"],
					},
					effortDelta: { type: "integer", minimum: 0 },
					architectureDelta: {
						type: "integer",
						enum: [...ARCHITECTURE_DELTAS],
					},
					coupling: {
						type: "string",
						enum: ["intrinsic", "adjacent", "unrelated"],
					},
					estimateConfidence: {
						type: "string",
						enum: ["low", "medium", "high"],
					},
					creditClaim: {
						type: "object",
						properties: {
							creditClaimId: { type: "string" },
							targetPhase: { type: "string" },
							minimalAlternativeEffortDelta: {
								type: "integer",
								enum: [0, ...EFFORT_POINTS],
							},
							minimalAlternativeArchitectureDelta: {
								type: "integer",
								enum: [...ARCHITECTURE_DELTAS],
							},
							before: { type: "string" },
							after: { type: "string" },
						},
						required: [
							"creditClaimId",
							"targetPhase",
							"minimalAlternativeEffortDelta",
							"minimalAlternativeArchitectureDelta",
							"before",
							"after",
						],
					},
				},
				required: ["id", "title", "action", "reason"],
			},
		},
		summary: {
			type: "string",
			description: "Optional 1-3 sentence overall assessment.",
		},
		baselineAssessment: {
			type: "object",
			properties: {
				independentEffortEstimate: { type: "integer", minimum: 0 },
				confidence: { type: "string", enum: ["low", "medium", "high"] },
				reason: { type: "string" },
			},
			required: ["independentEffortEstimate", "confidence", "reason"],
		},
		creditAssessments: {
			type: "array",
			items: {
				type: "object",
				properties: {
					creditClaimId: { type: "string" },
					eligibility: {
						type: "string",
						enum: ["eligible", "ineligible"],
					},
					coupling: {
						type: "string",
						enum: ["intrinsic", "adjacent", "unrelated"],
					},
					reason: { type: "string" },
				},
				required: ["creditClaimId", "eligibility", "coupling", "reason"],
			},
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

export interface ReviewerVerdictAssertionResult {
	warnings: string[];
}

/**
 * Assert reviewer verdict invariants.
 *
 * Empty items with non-ready readiness is relaxed from hard error to
 * warning — the verdict is still valid and the orchestrator routes it
 * to escalation. Missing item actions remain hard errors.
 */
export function assertReviewerVerdict(
	verdict: ReviewerVerdict,
	context: string,
): ReviewerVerdictAssertionResult {
	const warnings: string[] = [];
	const fail = (message: string): never => {
		throw new Error(
			`[${context}] ReviewerVerdict invariant violation: ${message}`,
		);
	};
	const nonEmpty = (value: unknown): value is string =>
		typeof value === "string" && value.trim().length > 0;
	const coupling = (value: unknown): boolean =>
		value === "intrinsic" || value === "adjacent" || value === "unrelated";

	if (!Array.isArray(verdict.items)) fail("'items' must be an array.");

	if (verdict.readiness !== "ready" && verdict.items.length === 0) {
		warnings.push(
			`[${context}] ReviewerVerdict warning: readiness is '${verdict.readiness}' but 'items' is empty. ` +
				"The orchestrator will escalate to the human.",
		);
	}

	for (const item of verdict.items) {
		if (!item.action) {
			throw new Error(
				`[${context}] ReviewerVerdict invariant violation: item '${item.id}' is missing 'action'. ` +
					"Each item must have action: 'auto_fix' | 'human_required'. Escalating.",
			);
		}
		if (
			item.scopeClass !== undefined &&
			item.scopeClass !== "acceptance_required" &&
			item.scopeClass !== "risk_reduction" &&
			item.scopeClass !== "polish"
		) {
			fail(`item '${item.id}' has invalid 'scopeClass'.`);
		}
		if (
			item.effortDelta !== undefined &&
			(!Number.isInteger(item.effortDelta) || item.effortDelta < 0)
		) {
			fail(`item '${item.id}' has invalid 'effortDelta'.`);
		}
		if (
			item.architectureDelta !== undefined &&
			!ARCHITECTURE_DELTAS.includes(item.architectureDelta as never)
		) {
			fail(`item '${item.id}' has invalid 'architectureDelta'.`);
		}
		if (item.coupling !== undefined && !coupling(item.coupling)) {
			fail(`item '${item.id}' has invalid 'coupling'.`);
		}
		if (item.architectureDelta !== undefined && item.architectureDelta < 0 && !item.coupling) {
			fail(`item '${item.id}' requires 'coupling' when 'architectureDelta' is negative.`);
		}
		if (
			item.estimateConfidence !== undefined &&
			item.estimateConfidence !== "low" &&
			item.estimateConfidence !== "medium" &&
			item.estimateConfidence !== "high"
		) {
			fail(`item '${item.id}' has invalid 'estimateConfidence'.`);
		}
		if (item.creditClaim !== undefined) {
			const claim = item.creditClaim;
			if (!nonEmpty(claim.creditClaimId)) fail(`item '${item.id}' creditClaim requires a non-empty 'creditClaimId'.`);
			if (!nonEmpty(claim.targetPhase)) fail(`item '${item.id}' creditClaim requires a non-empty 'targetPhase'.`);
			if (!nonEmpty(claim.before) || !nonEmpty(claim.after)) fail(`item '${item.id}' creditClaim requires non-empty 'before' and 'after'.`);
			if (!Number.isInteger(claim.minimalAlternativeEffortDelta) || (claim.minimalAlternativeEffortDelta !== 0 && !EFFORT_POINTS.includes(claim.minimalAlternativeEffortDelta as never))) fail(`item '${item.id}' creditClaim has invalid 'minimalAlternativeEffortDelta'.`);
			if (!ARCHITECTURE_DELTAS.includes(claim.minimalAlternativeArchitectureDelta as never)) fail(`item '${item.id}' creditClaim has invalid 'minimalAlternativeArchitectureDelta'.`);
		}
	}

	if (verdict.baselineAssessment !== undefined) {
		const assessment = verdict.baselineAssessment;
		if (!Number.isInteger(assessment.independentEffortEstimate) || assessment.independentEffortEstimate < 0) fail("baselineAssessment has invalid 'independentEffortEstimate'.");
		if (assessment.confidence !== "low" && assessment.confidence !== "medium" && assessment.confidence !== "high") fail("baselineAssessment has invalid 'confidence'.");
		if (!nonEmpty(assessment.reason)) fail("baselineAssessment requires a non-empty 'reason'.");
	}

	if (verdict.creditAssessments !== undefined) {
		if (!Array.isArray(verdict.creditAssessments)) fail("'creditAssessments' must be an array.");
		for (const assessment of verdict.creditAssessments) {
			if (!nonEmpty(assessment.creditClaimId)) fail("creditAssessment requires a non-empty 'creditClaimId'.");
			if (assessment.eligibility !== "eligible" && assessment.eligibility !== "ineligible") fail(`creditAssessment '${assessment.creditClaimId}' has invalid 'eligibility'.`);
			if (!coupling(assessment.coupling)) fail(`creditAssessment '${assessment.creditClaimId}' has invalid 'coupling'.`);
			if (!nonEmpty(assessment.reason)) fail(`creditAssessment '${assessment.creditClaimId}' requires a non-empty 'reason'.`);
		}
	}

	return { warnings };
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
