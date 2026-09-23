import type { BaselineAssessment } from "./review-budget/types.js";
import { ARCHITECTURE_DELTAS, EFFORT_POINTS } from "./review-budget/types.js";
import type {
	IntroducedByPlanHunk,
	PriorFindingOutcome,
} from "./review-governance/types.js";

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

export const IMPLEMENTATION_SCOPE_CLASSES = [
	"implementation_defect",
	"plan_defect",
	"scope_expansion",
	"pre_existing",
] as const;

export type ImplementationScopeClass =
	(typeof IMPLEMENTATION_SCOPE_CLASSES)[number];

export type ReviewScopeClass = PlanReviewScopeClass | ImplementationScopeClass;

export const BOUNDARY_CHANGE_LABELS = [
	"api",
	"schema",
	"dependency",
	"subsystem",
	"architecture",
	"plan-structure",
] as const;

export type BoundaryChangeLabel = (typeof BOUNDARY_CHANGE_LABELS)[number];

export const PLAN_IMPACT_KINDS = ["text_only", "design", "budget"] as const;

export type PlanImpactKind = (typeof PLAN_IMPACT_KINDS)[number];

export interface PlanImpactLocation {
	heading: string;
	staleText: string;
}

/** Concrete text/design/budget impact. Not a string enum. */
export interface PlanImpact {
	kind: PlanImpactKind;
	locations: PlanImpactLocation[];
}

export const CREDIT_REALIZATION_KINDS = [
	"realized",
	"partial",
	"not_realized",
] as const;

export type CreditRealizationKind = (typeof CREDIT_REALIZATION_KINDS)[number];

export interface CreditRealization {
	creditClaimId: string;
	realization: CreditRealizationKind;
	realizedArchitectureDelta: number;
	evidence: string;
}

export interface NonblockingObservation {
	id: string;
	title: string;
	reason: string;
	scopeClass?: "pre_existing";
}

const PLAN_SCOPE_CLASSES = new Set<string>([
	"acceptance_required",
	"risk_reduction",
	"polish",
]);

const IMPLEMENTATION_SCOPE_CLASS_SET = new Set<string>(
	IMPLEMENTATION_SCOPE_CLASSES,
);

export function isPlanScopeClass(
	value: unknown,
): value is PlanReviewScopeClass {
	return typeof value === "string" && PLAN_SCOPE_CLASSES.has(value);
}

export function isImplementationScopeClass(
	value: unknown,
): value is ImplementationScopeClass {
	return typeof value === "string" && IMPLEMENTATION_SCOPE_CLASS_SET.has(value);
}

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
	scopeClass?: ReviewScopeClass;
	effortDelta?: number;
	architectureDelta?: number;
	coupling?: "intrinsic" | "adjacent" | "unrelated";
	estimateConfidence?: "low" | "medium" | "high";
	creditClaim?: CreditClaim;
	/** Approved ledger IDs. Required and unique for implementation_defect. */
	planWorkItemIds?: string[];
	planImpact?: PlanImpact;
	/** Explicit boundary inventory. Absent is unknown, not an empty array. */
	boundaryChanges?: BoundaryChangeLabel[];
	mechanicalExplanation?: string;
	failure?: string;
	lowestCostCorrection?: string;
	introducedBy?: IntroducedByPlanHunk;
	lateDiscovery?: "critical_safety";
	lateDiscoveryEvidence?: string;
	priorDecisionId?: string;
	newEvidence?: string;
	requiresReviewerVerification?: boolean;
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
	creditRealizations?: CreditRealization[];
	/** Ordinary pre-existing observations. Not actionable review items. */
	nonblocking?: NonblockingObservation[];
	priorFindings?: PriorFindingOutcome[];
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
	"reviewRoute",
	"normalizedReadiness",
	"gateCauses",
	"budgetTotals",
	"budgetStatus",
	"decisionOutcomes",
	"findingOutcomes",
	"governance",
] as const;

/** Reject fields whose values are derived and owned by the CLI. */
export function rejectCliOwnedBudgetFields(value: unknown): void {
	const pending: unknown[] = [value];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== "object" || visited.has(current))
			continue;
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
						enum: [
							"acceptance_required",
							"risk_reduction",
							"polish",
							...IMPLEMENTATION_SCOPE_CLASSES,
						],
						description:
							"Plan and implementation classes are a union. A contextual validator selects one domain from the admitted phase.",
					},
					effortDelta: { type: "integer", minimum: 0 },
					architectureDelta: {
						type: "integer",
						description:
							"Plan reviews are limited to the allowed magnitude set. Implementation telemetry may be any integer.",
					},
					planWorkItemIds: {
						type: "array",
						items: { type: "string" },
						description:
							"Approved work-item IDs. Required, nonempty, and unique for implementation_defect.",
					},
					planImpact: {
						type: "object",
						description:
							"Required object for plan_defect. text_only locations must be nonempty; design and budget may be empty and route to a human.",
						properties: {
							kind: { type: "string", enum: [...PLAN_IMPACT_KINDS] },
							locations: {
								type: "array",
								items: {
									type: "object",
									properties: {
										heading: { type: "string" },
										staleText: { type: "string" },
									},
									required: ["heading", "staleText"],
								},
							},
						},
						required: ["kind", "locations"],
					},
					boundaryChanges: {
						type: "array",
						items: { type: "string", enum: [...BOUNDARY_CHANGE_LABELS] },
						description:
							"Explicit boundary labels. Omit the field when impact is unknown; do not guess an empty array.",
					},
					mechanicalExplanation: { type: "string" },
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
					failure: { type: "string" },
					lowestCostCorrection: { type: "string" },
					introducedBy: {
						type: "object",
						properties: {
							commitRange: { type: "string" },
							diffHunk: { type: "string" },
							explanation: { type: "string" },
						},
						required: ["commitRange", "diffHunk", "explanation"],
					},
					lateDiscovery: { type: "string", enum: ["critical_safety"] },
					lateDiscoveryEvidence: { type: "string" },
					priorDecisionId: { type: "string" },
					newEvidence: { type: "string" },
					requiresReviewerVerification: { type: "boolean" },
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
		creditRealizations: {
			type: "array",
			description:
				"Implementation per-claim realization observations. Prohibited on plan reviews. Aggregates remain CLI-owned.",
			items: {
				type: "object",
				properties: {
					creditClaimId: { type: "string" },
					realization: {
						type: "string",
						enum: [...CREDIT_REALIZATION_KINDS],
					},
					realizedArchitectureDelta: { type: "integer" },
					evidence: { type: "string" },
				},
				required: [
					"creditClaimId",
					"realization",
					"realizedArchitectureDelta",
					"evidence",
				],
			},
		},
		nonblocking: {
			type: "array",
			description:
				"Ordinary pre-existing observations retained in Markdown and excluded from actionable items.",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					title: { type: "string" },
					reason: { type: "string" },
					scopeClass: { type: "string", enum: ["pre_existing"] },
				},
				required: ["id", "title", "reason"],
			},
		},
		priorFindings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					status: {
						type: "string",
						enum: ["addressed", "partially_addressed", "still_open"],
					},
				},
				required: ["id", "status"],
			},
		},
	},
	required: ["readiness", "items"],
} as const;

/**
 * Provider-facing reviewer schema for an active-budget plan review round.
 * `required` (initial review) demands the independent baseline estimate;
 * `prohibited` (closure review) removes it and forbids its presence;
 * `optional` (initial-review retry) keeps the generic schema. The
 * contextual budget validator remains the final authority.
 */
export function reviewerVerdictSchemaFor(
	baselineAssessment: "required" | "optional" | "prohibited",
): Record<string, unknown> {
	if (baselineAssessment === "required") {
		return {
			...ReviewerVerdictSchema,
			required: [...ReviewerVerdictSchema.required, "baselineAssessment"],
		};
	}
	if (baselineAssessment === "prohibited") {
		const { baselineAssessment: _omitted, ...properties } =
			ReviewerVerdictSchema.properties;
		return {
			...ReviewerVerdictSchema,
			description:
				"Closure review: omit baselineAssessment; it is initial-review only.",
			properties,
			not: { required: ["baselineAssessment"] },
		};
	}
	return ReviewerVerdictSchema;
}

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

function unknownKey(
	value: Record<string, unknown>,
	allowed: readonly string[],
): string | undefined {
	return Object.keys(value).find((key) => !allowed.includes(key));
}

function assertPlanImpact(
	itemId: string,
	value: unknown,
	fail: (message: string) => never,
	nonEmpty: (value: unknown) => value is string,
	objectShape: (value: unknown) => value is Record<string, unknown>,
): void {
	if (typeof value === "string") {
		fail(
			`item '${itemId}' planImpact must be an object { kind, locations }, not a string.`,
		);
	}
	if (!objectShape(value))
		fail(`item '${itemId}' planImpact must be an object.`);
	const extra = unknownKey(value, ["kind", "locations"]);
	if (extra) fail(`item '${itemId}' planImpact has unknown field '${extra}'.`);
	if (
		value.kind !== "text_only" &&
		value.kind !== "design" &&
		value.kind !== "budget"
	) {
		fail(`item '${itemId}' planImpact has invalid 'kind'.`);
	}
	if (!Array.isArray(value.locations)) {
		fail(`item '${itemId}' planImpact.locations must be an array.`);
	}
	if (value.kind === "text_only" && value.locations.length === 0) {
		fail(`item '${itemId}' text_only planImpact requires nonempty locations.`);
	}
	const seen = new Set<string>();
	for (const location of value.locations) {
		if (!objectShape(location)) {
			fail(`item '${itemId}' planImpact location must be an object.`);
		}
		const locationExtra = unknownKey(location, ["heading", "staleText"]);
		if (locationExtra) {
			fail(
				`item '${itemId}' planImpact location has unknown field '${locationExtra}'.`,
			);
		}
		if (!nonEmpty(location.heading) || !nonEmpty(location.staleText)) {
			fail(
				`item '${itemId}' planImpact location requires nonempty heading and staleText.`,
			);
		}
		const key = `${location.heading}\0${location.staleText}`;
		if (seen.has(key)) {
			fail(`item '${itemId}' planImpact has a duplicate location.`);
		}
		seen.add(key);
	}
}

function assertWorkItemIds(
	itemId: string,
	value: unknown,
	required: boolean,
	fail: (message: string) => never,
): void {
	if (value === undefined) {
		if (required) {
			fail(`item '${itemId}' requires nonempty unique planWorkItemIds.`);
		}
		return;
	}
	if (!Array.isArray(value) || value.length === 0) {
		fail(`item '${itemId}' planWorkItemIds must be a nonempty array.`);
	}
	const seen = new Set<string>();
	for (const id of value) {
		if (typeof id !== "string" || id.trim().length === 0) {
			fail(`item '${itemId}' planWorkItemIds must be nonempty strings.`);
		}
		if (seen.has(id)) {
			fail(`item '${itemId}' planWorkItemIds contains duplicate '${id}'.`);
		}
		seen.add(id);
	}
}

function assertCreditRealization(
	value: unknown,
	index: number,
	fail: (message: string) => never,
	nonEmpty: (value: unknown) => value is string,
	objectShape: (value: unknown) => value is Record<string, unknown>,
	seen: Set<string>,
): void {
	if (!objectShape(value)) {
		fail(`creditRealization at index ${index} must be an object.`);
	}
	const extra = unknownKey(value, [
		"creditClaimId",
		"realization",
		"realizedArchitectureDelta",
		"evidence",
	]);
	if (extra) {
		fail(`creditRealization at index ${index} has unknown field '${extra}'.`);
	}
	if (!nonEmpty(value.creditClaimId)) {
		fail(
			`creditRealization at index ${index} requires a non-empty 'creditClaimId'.`,
		);
	}
	if (seen.has(value.creditClaimId)) {
		fail(`creditRealization '${value.creditClaimId}' is duplicated.`);
	}
	seen.add(value.creditClaimId);
	if (
		value.realization !== "realized" &&
		value.realization !== "partial" &&
		value.realization !== "not_realized"
	) {
		fail(
			`creditRealization '${value.creditClaimId}' has invalid 'realization'.`,
		);
	}
	if (!Number.isInteger(value.realizedArchitectureDelta)) {
		fail(
			`creditRealization '${value.creditClaimId}' realizedArchitectureDelta must be an integer.`,
		);
	}
	const delta = value.realizedArchitectureDelta as number;
	if (delta > 0) {
		fail(
			`creditRealization '${value.creditClaimId}' rejects a positive realizedArchitectureDelta.`,
		);
	}
	if (value.realization === "not_realized" && delta !== 0) {
		fail(
			`creditRealization '${value.creditClaimId}' not_realized requires realizedArchitectureDelta 0.`,
		);
	}
	if (
		(value.realization === "realized" || value.realization === "partial") &&
		delta >= 0
	) {
		fail(
			`creditRealization '${value.creditClaimId}' ${value.realization} requires a negative realizedArchitectureDelta.`,
		);
	}
	if (!nonEmpty(value.evidence)) {
		fail(
			`creditRealization '${value.creditClaimId}' requires nonempty evidence.`,
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
	const objectShape = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	const coupling = (value: unknown): boolean =>
		value === "intrinsic" || value === "adjacent" || value === "unrelated";

	if (!Array.isArray(verdict.items)) fail("'items' must be an array.");

	let sawPlanItem = false;
	let sawImplementationItem = false;

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
		const implementation = isImplementationScopeClass(item.scopeClass);
		const planScoped =
			item.scopeClass === undefined || isPlanScopeClass(item.scopeClass);
		if (item.scopeClass !== undefined && !implementation && !planScoped) {
			fail(`item '${item.id}' has invalid 'scopeClass'.`);
		}
		if (implementation) sawImplementationItem = true;
		else sawPlanItem = true;
		if (implementation && item.creditClaim !== undefined) {
			fail(
				`item '${item.id}' cannot include creditClaim on an implementation review.`,
			);
		}
		if (
			!implementation &&
			(item.planImpact !== undefined ||
				item.planWorkItemIds !== undefined ||
				item.boundaryChanges !== undefined ||
				item.mechanicalExplanation !== undefined)
		) {
			fail(
				`item '${item.id}' uses implementation fields without an implementation scopeClass.`,
			);
		}
		if (implementation) {
			if (
				item.priority !== "P0" &&
				item.priority !== "P1" &&
				item.priority !== "P2"
			) {
				fail(`item '${item.id}' requires priority P0, P1, or P2.`);
			}
			if (!Number.isInteger(item.effortDelta) || (item.effortDelta ?? -1) < 0) {
				fail(`item '${item.id}' requires a nonnegative integer effortDelta.`);
			}
			if (!Number.isInteger(item.architectureDelta)) {
				fail(`item '${item.id}' requires an integer architectureDelta.`);
			}
			assertWorkItemIds(
				item.id,
				item.planWorkItemIds,
				item.scopeClass === "implementation_defect",
				fail,
			);
			if (item.scopeClass === "plan_defect") {
				if (item.planImpact === undefined) {
					fail(`item '${item.id}' plan_defect requires planImpact.`);
				}
				assertPlanImpact(item.id, item.planImpact, fail, nonEmpty, objectShape);
			} else if (item.planImpact !== undefined) {
				fail(
					`item '${item.id}' prohibits planImpact unless scopeClass is plan_defect.`,
				);
			}
			if (item.boundaryChanges !== undefined) {
				if (!Array.isArray(item.boundaryChanges)) {
					fail(`item '${item.id}' boundaryChanges must be an array.`);
				}
				for (const label of item.boundaryChanges) {
					if (!BOUNDARY_CHANGE_LABELS.includes(label as BoundaryChangeLabel)) {
						fail(`item '${item.id}' has invalid boundaryChanges label.`);
					}
				}
			}
			if (
				item.mechanicalExplanation !== undefined &&
				!nonEmpty(item.mechanicalExplanation)
			) {
				fail(`item '${item.id}' has invalid 'mechanicalExplanation'.`);
			}
			if (item.coupling !== undefined && !coupling(item.coupling)) {
				fail(`item '${item.id}' has invalid 'coupling'.`);
			}
			if (
				item.scopeClass === "pre_existing" &&
				item.lateDiscovery === "critical_safety" &&
				!nonEmpty(item.lateDiscoveryEvidence)
			) {
				fail(
					`item '${item.id}' critical pre-existing findings require lateDiscoveryEvidence.`,
				);
			}
		} else {
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
			if (
				item.architectureDelta !== undefined &&
				item.architectureDelta < 0 &&
				!item.coupling
			) {
				fail(
					`item '${item.id}' requires 'coupling' when 'architectureDelta' is negative.`,
				);
			}
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
			const claimValue: unknown = item.creditClaim;
			if (!objectShape(claimValue))
				fail(`item '${item.id}' creditClaim must be an object.`);
			const claim = claimValue as Record<string, unknown>;
			if (!nonEmpty(claim.creditClaimId))
				fail(
					`item '${item.id}' creditClaim requires a non-empty 'creditClaimId'.`,
				);
			if (!nonEmpty(claim.targetPhase))
				fail(
					`item '${item.id}' creditClaim requires a non-empty 'targetPhase'.`,
				);
			if (!nonEmpty(claim.before) || !nonEmpty(claim.after))
				fail(
					`item '${item.id}' creditClaim requires non-empty 'before' and 'after'.`,
				);
			if (
				!Number.isInteger(claim.minimalAlternativeEffortDelta) ||
				(claim.minimalAlternativeEffortDelta !== 0 &&
					!EFFORT_POINTS.includes(claim.minimalAlternativeEffortDelta as never))
			)
				fail(
					`item '${item.id}' creditClaim has invalid 'minimalAlternativeEffortDelta'.`,
				);
			if (
				!ARCHITECTURE_DELTAS.includes(
					claim.minimalAlternativeArchitectureDelta as never,
				)
			)
				fail(
					`item '${item.id}' creditClaim has invalid 'minimalAlternativeArchitectureDelta'.`,
				);
		}
		if (item.introducedBy !== undefined) {
			if (!objectShape(item.introducedBy))
				fail(`item '${item.id}' introducedBy must be an object.`);
			if (
				!nonEmpty(item.introducedBy.commitRange) ||
				!nonEmpty(item.introducedBy.diffHunk) ||
				!nonEmpty(item.introducedBy.explanation)
			)
				fail(`item '${item.id}' has incomplete 'introducedBy' evidence.`);
		}
		if (
			item.lateDiscovery !== undefined &&
			item.lateDiscovery !== "critical_safety"
		)
			fail(`item '${item.id}' has invalid 'lateDiscovery'.`);
		if (
			item.requiresReviewerVerification !== undefined &&
			typeof item.requiresReviewerVerification !== "boolean"
		)
			fail(`item '${item.id}' has invalid 'requiresReviewerVerification'.`);
		for (const field of [
			"failure",
			"lowestCostCorrection",
			"lateDiscoveryEvidence",
			"priorDecisionId",
			"newEvidence",
		] as const) {
			if (item[field] !== undefined && typeof item[field] !== "string")
				fail(`item '${item.id}' has invalid '${field}'.`);
		}
	}

	if (sawPlanItem && sawImplementationItem) {
		fail(
			"mixed plan and implementation review contracts are not allowed in one verdict.",
		);
	}
	const implementationVerdict =
		sawImplementationItem ||
		verdict.creditRealizations !== undefined ||
		verdict.nonblocking !== undefined;
	if (
		sawPlanItem &&
		(verdict.creditRealizations !== undefined ||
			verdict.nonblocking !== undefined)
	) {
		fail(
			"plan reviews prohibit creditRealizations and nonblocking observations.",
		);
	}
	if (
		implementationVerdict &&
		(verdict.baselineAssessment !== undefined ||
			verdict.creditAssessments !== undefined)
	) {
		fail(
			"implementation reviews prohibit baselineAssessment and creditAssessments.",
		);
	}
	if (verdict.creditRealizations !== undefined) {
		if (!Array.isArray(verdict.creditRealizations)) {
			fail("'creditRealizations' must be an array.");
		}
		const seenClaims = new Set<string>();
		verdict.creditRealizations.forEach((realization, index) => {
			assertCreditRealization(
				realization,
				index,
				fail,
				nonEmpty,
				objectShape,
				seenClaims,
			);
		});
	}
	if (verdict.nonblocking !== undefined) {
		if (!Array.isArray(verdict.nonblocking)) {
			fail("'nonblocking' must be an array.");
		}
		for (const observation of verdict.nonblocking) {
			if (!objectShape(observation)) {
				fail("each nonblocking observation must be an object.");
			}
			const extra = unknownKey(
				observation as unknown as Record<string, unknown>,
				["id", "title", "reason", "scopeClass"],
			);
			if (extra) fail(`nonblocking observation has unknown field '${extra}'.`);
			if (
				!nonEmpty(observation.id) ||
				!nonEmpty(observation.title) ||
				!nonEmpty(observation.reason)
			) {
				fail(
					"each nonblocking observation requires nonempty id, title, and reason.",
				);
			}
			if (
				observation.scopeClass !== undefined &&
				observation.scopeClass !== "pre_existing"
			) {
				fail("nonblocking observations must use scopeClass pre_existing.");
			}
		}
	}

	if (verdict.priorFindings !== undefined) {
		if (!Array.isArray(verdict.priorFindings))
			fail("'priorFindings' must be an array.");
		for (const outcome of verdict.priorFindings) {
			if (!objectShape(outcome) || !nonEmpty(outcome.id))
				fail("each priorFinding requires a non-empty 'id'.");
			if (
				outcome.status !== "addressed" &&
				outcome.status !== "partially_addressed" &&
				outcome.status !== "still_open"
			)
				fail(`priorFinding '${outcome.id}' has invalid 'status'.`);
		}
	}

	if (verdict.baselineAssessment !== undefined) {
		const assessmentValue: unknown = verdict.baselineAssessment;
		if (!objectShape(assessmentValue))
			fail("baselineAssessment must be an object.");
		const assessment = assessmentValue as Record<string, unknown>;
		const independentEffortEstimate = assessment.independentEffortEstimate;
		if (
			typeof independentEffortEstimate !== "number" ||
			!Number.isInteger(independentEffortEstimate) ||
			independentEffortEstimate < 0
		)
			fail("baselineAssessment has invalid 'independentEffortEstimate'.");
		if (
			assessment.confidence !== "low" &&
			assessment.confidence !== "medium" &&
			assessment.confidence !== "high"
		)
			fail("baselineAssessment has invalid 'confidence'.");
		if (!nonEmpty(assessment.reason))
			fail("baselineAssessment requires a non-empty 'reason'.");
	}

	if (verdict.creditAssessments !== undefined) {
		if (!Array.isArray(verdict.creditAssessments))
			fail("'creditAssessments' must be an array.");
		for (const assessmentValue of verdict.creditAssessments) {
			if (!objectShape(assessmentValue))
				fail("each creditAssessment must be an object.");
			const assessment = assessmentValue as unknown as Record<string, unknown>;
			if (!nonEmpty(assessment.creditClaimId))
				fail("creditAssessment requires a non-empty 'creditClaimId'.");
			if (
				assessment.eligibility !== "eligible" &&
				assessment.eligibility !== "ineligible"
			)
				fail(
					`creditAssessment '${assessment.creditClaimId}' has invalid 'eligibility'.`,
				);
			if (!coupling(assessment.coupling))
				fail(
					`creditAssessment '${assessment.creditClaimId}' has invalid 'coupling'.`,
				);
			if (!nonEmpty(assessment.reason))
				fail(
					`creditAssessment '${assessment.creditClaimId}' requires a non-empty 'reason'.`,
				);
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
