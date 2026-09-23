import { describe, expect, test } from "bun:test";
import type { ReviewerVerdict, VerdictItem } from "../../../src/protocol.js";
import {
	assertReviewerVerdict,
	rejectCliOwnedBudgetFields,
} from "../../../src/protocol.js";
import {
	IMPLEMENTATION_STATE_VERSION,
	type ImplementationTextAmendmentPayload,
} from "../../../src/review-budget/record-lines.js";
import {
	implementationReviewRound,
	resolvePlanImpactSpans,
	validateImplementationReview,
} from "../../../src/review-governance/implementation.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";

const ANCHOR = `# Plan

## Design Decisions

The approved design uses one store.

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | Bind | 2 | 0 | - | - | Required |

## Phase 2: Protocol

- [ ] Add the implementation enum

The stale wording lives here.
`;

function defect(overrides: Partial<VerdictItem> = {}): VerdictItem {
	return {
		id: "I1",
		title: "Wrong return code",
		action: "auto_fix",
		reason: "The command exits 0 after a failed write.",
		priority: "P1",
		scopeClass: "implementation_defect",
		effortDelta: 4,
		architectureDelta: -7,
		planWorkItemIds: ["W1"],
		failure: "A failed write is reported as success.",
		lowestCostCorrection: "Return the write status.",
		...overrides,
	};
}

function verdict(
	items: VerdictItem[],
	extra: Partial<ReviewerVerdict> = {},
): ReviewerVerdict {
	return {
		readiness: items.length === 0 ? "ready" : "not_ready",
		items,
		...extra,
	};
}

function certified(items: VerdictItem[], extra: Partial<ReviewerVerdict> = {}) {
	return validateImplementationReview({
		verdict: verdict(items, extra),
		phase: "2",
		mode: "enforced",
		phaseIds: ["1", "2"],
		workItemIds: ["W1", "W2"],
		creditClaimIds: ["DC0"],
		approvedPlanBytes: ANCHOR,
		approvedPlanHash: hashPlanBytes(ANCHOR),
	});
}

function textAmendment(input: {
	approvedBytes: string;
	authorizedBytes: string;
	parentLineageId?: string | null;
}): ImplementationTextAmendmentPayload {
	return {
		kind: "implementation-text-amendment",
		version: IMPLEMENTATION_STATE_VERSION,
		id: "amend-1",
		bindingId: "binding-1",
		executionRunId: "run1",
		guardId: "guard-1",
		sourceObservationId: "obs-1",
		parentLineageId: input.parentLineageId ?? null,
		beforeCommit: "a".repeat(40),
		afterCommit: "b".repeat(40),
		beforeBlobHash: hashPlanBytes(input.approvedBytes),
		afterBlobHash: hashPlanBytes(input.authorizedBytes),
		authorizedPlanBytes: input.authorizedBytes,
		createdAt: "2026-09-23T00:00:00.000Z",
	};
}

function textOnlyDefect(staleText: string): VerdictItem {
	return defect({
		scopeClass: "plan_defect",
		planWorkItemIds: undefined,
		action: "auto_fix",
		planImpact: {
			kind: "text_only",
			locations: [{ heading: "Phase 2: Protocol", staleText }],
		},
	});
}

describe("implementation review structural contract", () => {
	test("accepts arbitrary implementation telemetry and rejects plan magnitudes", () => {
		expect(() =>
			assertReviewerVerdict(verdict([defect()]), "REVIEW"),
		).not.toThrow();
		expect(() =>
			assertReviewerVerdict(
				verdict([
					{
						id: "R1",
						title: "Plan",
						action: "auto_fix",
						reason: "Reason",
						scopeClass: "acceptance_required",
						architectureDelta: 4,
					},
				]),
				"REVIEW",
			),
		).toThrow("architectureDelta");
	});

	test("rejects missing, invalid, and duplicate implementation fields", () => {
		const cases: Array<[VerdictItem, string]> = [
			[defect({ priority: undefined }), "priority"],
			[defect({ effortDelta: -1 }), "effortDelta"],
			[defect({ effortDelta: 1.5 }), "effortDelta"],
			[defect({ architectureDelta: undefined }), "architectureDelta"],
			[defect({ planWorkItemIds: undefined }), "planWorkItemIds"],
			[defect({ planWorkItemIds: ["W1", "W1"] }), "duplicate"],
			[defect({ planWorkItemIds: [" "] }), "nonempty"],
			[
				defect({
					scopeClass: "plan_defect",
					planWorkItemIds: undefined,
					planImpact: undefined,
				}),
				"planImpact",
			],
			[
				defect({
					scopeClass: "plan_defect",
					planWorkItemIds: undefined,
					planImpact: "text_only" as unknown as VerdictItem["planImpact"],
				}),
				"not a string",
			],
			[
				defect({
					scopeClass: "plan_defect",
					planWorkItemIds: undefined,
					planImpact: {
						kind: "text_only",
						locations: [],
					},
				}),
				"nonempty locations",
			],
			[
				defect({
					scopeClass: "plan_defect",
					planWorkItemIds: undefined,
					planImpact: {
						kind: "later" as "design",
						locations: [],
					},
				}),
				"kind",
			],
			[
				defect({
					scopeClass: "plan_defect",
					planWorkItemIds: undefined,
					planImpact: {
						kind: "design",
						locations: [{ heading: " ", staleText: "text" }],
					},
				}),
				"heading",
			],
			[
				defect({
					planImpact: {
						kind: "design",
						locations: [],
					},
				}),
				"prohibits planImpact",
			],
			[defect({ boundaryChanges: ["network" as "api"] }), "boundaryChanges"],
			[defect({ mechanicalExplanation: " " }), "mechanicalExplanation"],
			[
				defect({
					scopeClass: "pre_existing",
					planWorkItemIds: undefined,
					lateDiscovery: "critical_safety",
				}),
				"lateDiscoveryEvidence",
			],
		];
		for (const [item, message] of cases) {
			expect(() => assertReviewerVerdict(verdict([item]), "REVIEW")).toThrow(
				message,
			);
		}
	});

	test("round-trips a concrete PlanImpact object and rejects cross-domain fields", () => {
		const impact = {
			kind: "text_only" as const,
			locations: [
				{
					heading: "Phase 2: Protocol",
					staleText: "The stale wording lives here.",
				},
			],
		};
		expect(() =>
			assertReviewerVerdict(
				verdict([
					defect({
						scopeClass: "plan_defect",
						planWorkItemIds: undefined,
						planImpact: impact,
						introducedBy: {
							commitRange: "abc..def",
							diffHunk: "@@ -1 +1 @@",
							explanation: "The wording drifted.",
						},
						requiresReviewerVerification: false,
						priorDecisionId: "dec-1",
						newEvidence: "The heading still says the old phrase.",
					}),
				]),
				"REVIEW",
			),
		).not.toThrow();
		expect(() =>
			assertReviewerVerdict(
				verdict([
					defect({
						scopeClass: "plan_defect",
						planWorkItemIds: undefined,
						planImpact: {
							kind: "design",
							locations: [],
							note: "extra",
						} as VerdictItem["planImpact"],
					}),
				]),
				"REVIEW",
			),
		).toThrow("unknown field");
		expect(() =>
			assertReviewerVerdict(
				verdict([
					defect(),
					{
						id: "R1",
						title: "Plan item",
						action: "auto_fix",
						reason: "Reason",
						scopeClass: "polish",
					},
				]),
				"REVIEW",
			),
		).toThrow("mixed");
		expect(() =>
			assertReviewerVerdict(
				verdict([defect()], {
					baselineAssessment: {
						independentEffortEstimate: 1,
						confidence: "high",
						reason: "estimate",
					},
				}),
				"REVIEW",
			),
		).toThrow("baselineAssessment");
		expect(() =>
			assertReviewerVerdict(
				verdict([
					defect({
						creditClaim: {
							creditClaimId: "RC1",
							targetPhase: "2",
							minimalAlternativeEffortDelta: 1,
							minimalAlternativeArchitectureDelta: 0,
							before: "before",
							after: "after",
						},
					}),
				]),
				"REVIEW",
			),
		).toThrow("creditClaim");
		expect(() =>
			assertReviewerVerdict(
				{
					readiness: "ready",
					items: [],
					creditRealizations: [
						{
							creditClaimId: "DC0",
							realization: "partial",
							realizedArchitectureDelta: -1,
							evidence: "",
						},
					],
				},
				"REVIEW",
			),
		).toThrow("evidence");
		expect(() =>
			assertReviewerVerdict(
				{
					readiness: "ready",
					items: [],
					creditRealizations: [
						{
							creditClaimId: "DC0",
							realization: "not_realized",
							realizedArchitectureDelta: 0,
							evidence: "The simplification is absent.",
						},
						{
							creditClaimId: "DC0",
							realization: "realized",
							realizedArchitectureDelta: -1,
							evidence: "duplicate",
						},
					],
				},
				"REVIEW",
			),
		).toThrow("duplicated");
		expect(() =>
			rejectCliOwnedBudgetFields({
				planImpact: { kind: "design", locations: [], budget: { W: 1 } },
			}),
		).toThrow("budget");
	});
});

describe("implementation review classification", () => {
	test("authorizes a unique text span and routes design or budget impacts to a human", () => {
		const text = certified([
			defect({
				scopeClass: "plan_defect",
				planWorkItemIds: undefined,
				action: "auto_fix",
				planImpact: {
					kind: "text_only",
					locations: [
						{
							heading: "Phase 2: Protocol",
							staleText: "The stale wording lives here.",
						},
					],
				},
			}),
		]);
		expect(text.valid).toBe(true);
		expect(text.exemptionAuthorized).toBe(true);
		expect(text.governance?.route).toBe("author_revision");
		expect(text.governance?.nextAction).toBe("author_revision");
		const start = ANCHOR.indexOf("The stale wording lives here.");
		expect(text.spans[0]).toMatchObject({
			start: Buffer.byteLength(ANCHOR.slice(0, start)),
			end: Buffer.byteLength(
				ANCHOR.slice(0, start + "The stale wording lives here.".length),
			),
		});

		const design = certified([
			defect({
				id: "P1",
				title: "The bug requires a new store",
				scopeClass: "plan_defect",
				planWorkItemIds: undefined,
				action: "auto_fix",
				planImpact: { kind: "design", locations: [] },
			}),
		]);
		expect(design.governance?.route).toBe("human_gate");
		expect(design.governance?.nextAction).toBe("plan_amendment");
		expect(design.exemptionAuthorized).toBe(false);
	});

	test("human-routes missing or duplicate headings and repeated stale text", () => {
		const missing = certified([
			defect({
				scopeClass: "plan_defect",
				planWorkItemIds: undefined,
				planImpact: {
					kind: "text_only",
					locations: [{ heading: "Missing", staleText: "anything" }],
				},
			}),
		]);
		expect(missing.valid).toBe(true);
		expect(missing.exemptionAuthorized).toBe(false);
		expect(missing.governance?.route).toBe("human_gate");
		expect(missing.diagnostics.map((item) => item.code)).toContain(
			"PLAN_IMPACT_AMBIGUOUS",
		);

		const duplicated = `# Plan

## Notes

alpha

## Notes

alpha
`;
		const ambiguousHeading = validateImplementationReview({
			verdict: verdict([
				defect({
					scopeClass: "plan_defect",
					planWorkItemIds: undefined,
					planImpact: {
						kind: "text_only",
						locations: [{ heading: "Notes", staleText: "alpha" }],
					},
				}),
			]),
			phase: "2",
			mode: "enforced",
			phaseIds: ["2"],
			workItemIds: ["W1"],
			approvedPlanBytes: duplicated,
			approvedPlanHash: hashPlanBytes(duplicated),
		});
		expect(ambiguousHeading.diagnostics[0]?.message).toContain("ambiguous");

		const repeated = `# Plan

## Notes

alpha then alpha
`;
		const ambiguousText = resolvePlanImpactSpans({
			anchorText: repeated,
			locations: [{ itemId: "I1", heading: "Notes", staleText: "alpha" }],
		});
		expect(ambiguousText.status).toBe("ambiguous");
	});

	test("rejects overlapping spans and spans in protected table or structure", () => {
		const overlap = resolvePlanImpactSpans({
			anchorText: ANCHOR,
			locations: [
				{
					itemId: "I1",
					heading: "Phase 2: Protocol",
					staleText: "stale wording",
				},
				{
					itemId: "I1",
					heading: "Phase 2: Protocol",
					staleText: "wording lives",
				},
			],
		});
		expect(overlap.status).toBe("rejected");
		if (overlap.status === "rejected")
			expect(overlap.code).toBe("PLAN_IMPACT_OVERLAP");

		const checklist = certified([
			defect({
				scopeClass: "plan_defect",
				planWorkItemIds: undefined,
				planImpact: {
					kind: "text_only",
					locations: [
						{
							heading: "Phase 2: Protocol",
							staleText: "Add the implementation enum",
						},
					],
				},
			}),
		]);
		expect(checklist.valid).toBe(false);
		expect(checklist.fatalCode).toBe("PLAN_IMPACT_PROTECTED");

		const table = certified([
			defect({
				scopeClass: "plan_defect",
				planWorkItemIds: undefined,
				planImpact: {
					kind: "text_only",
					locations: [
						{ heading: "Delivery Budget", staleText: "| W1 | Bind |" },
					],
				},
			}),
		]);
		expect(table.fatalCode).toBe("PLAN_IMPACT_PROTECTED");

		const designSection = certified([
			defect({
				scopeClass: "plan_defect",
				planWorkItemIds: undefined,
				planImpact: {
					kind: "text_only",
					locations: [{ heading: "Design Decisions", staleText: "one store" }],
				},
			}),
		]);
		expect(designSection.fatalCode).toBe("PLAN_IMPACT_PROTECTED");
	});

	test("does not authorize spans without an approved anchor", () => {
		const standalone = validateImplementationReview({
			verdict: verdict([
				defect({
					scopeClass: "plan_defect",
					planWorkItemIds: undefined,
					planImpact: {
						kind: "text_only",
						locations: [
							{
								heading: "Phase 2: Protocol",
								staleText: "The stale wording lives here.",
							},
						],
					},
				}),
			]),
			phase: "2",
			mode: "advisory",
		});
		expect(standalone.valid).toBe(true);
		expect(standalone.exemptionAuthorized).toBe(false);
		expect(standalone.spans).toEqual([]);
		expect(standalone.diagnostics.map((item) => item.code)).toContain(
			"PLAN_IMPACT_NOT_AUTHORIZED",
		);
	});

	test("a malformed amendment chain does not authorize text-only spans", () => {
		const staleText = "The stale wording lives here.";
		const malformed = validateImplementationReview({
			verdict: verdict([textOnlyDefect(staleText)]),
			phase: "2",
			mode: "enforced",
			phaseIds: ["2"],
			workItemIds: ["W1"],
			approvedPlanBytes: ANCHOR,
			approvedPlanHash: hashPlanBytes(ANCHOR),
			amendments: [
				textAmendment({
					approvedBytes: ANCHOR,
					authorizedBytes: ANCHOR,
					parentLineageId: "not-the-approved-root",
				}),
			],
		});
		expect(malformed.valid).toBe(true);
		expect(malformed.exemptionAuthorized).toBe(false);
		expect(malformed.spans).toEqual([]);
		expect(malformed.governance?.route).toBe("human_gate");
		expect(malformed.governance?.nextAction).toBe("plan_amendment");
		expect(
			malformed.diagnostics.find(
				(item) => item.code === "PLAN_IMPACT_NOT_AUTHORIZED",
			)?.severity,
		).toBe("error");
		expect(malformed.diagnostics.map((item) => item.code)).not.toContain(
			"PLAN_IMPACT_AMBIGUOUS",
		);
	});

	test("a valid amendment chain authorizes stale text only in the amended anchor", () => {
		const staleText = "The stale wording lives here.";
		const approved = ANCHOR.replace(
			staleText,
			"The original wording lives here.",
		);
		expect(approved).not.toContain(staleText);
		const authorized = validateImplementationReview({
			verdict: verdict([textOnlyDefect(staleText)]),
			phase: "2",
			mode: "enforced",
			phaseIds: ["2"],
			workItemIds: ["W1"],
			approvedPlanBytes: approved,
			approvedPlanHash: hashPlanBytes(approved),
			amendments: [
				textAmendment({
					approvedBytes: approved,
					authorizedBytes: ANCHOR,
				}),
			],
		});
		expect(authorized.valid).toBe(true);
		expect(authorized.exemptionAuthorized).toBe(true);
		expect(authorized.governance?.route).toBe("author_revision");
		const start = ANCHOR.indexOf(staleText);
		expect(authorized.spans[0]).toMatchObject({
			start: Buffer.byteLength(ANCHOR.slice(0, start)),
			end: Buffer.byteLength(ANCHOR.slice(0, start + staleText.length)),
		});
	});

	test("keeps shortcut evidence explicit and classifies precedence, scope, and critical findings", () => {
		const unknownBoundary = certified([
			defect({
				priority: "P2",
				architectureDelta: 0,
				action: "auto_fix",
			}),
		]);
		expect(unknownBoundary.governance?.shortcutCandidate).toBe(false);
		expect(unknownBoundary.governance?.route).toBe("author_revision");
		expect(unknownBoundary.diagnostics.map((item) => item.code)).toContain(
			"BOUNDARY_IMPACT_UNKNOWN",
		);

		const candidate = certified([
			defect({
				priority: "P2",
				architectureDelta: 0,
				boundaryChanges: [],
				mechanicalExplanation:
					"Replace the status check with the write result.",
				requiresReviewerVerification: false,
			}),
		]);
		expect(candidate.governance?.shortcutCandidate).toBe(true);
		expect(candidate.governance?.route).toBe("author_revision");

		const precedence = certified([
			defect({
				title: "Bug needs a new API",
				boundaryChanges: ["api"],
				action: "auto_fix",
			}),
		]);
		expect(precedence.governance?.route).toBe("human_gate");
		expect(precedence.diagnostics.map((item) => item.code)).toContain(
			"SOURCE_OF_CORRECTION_PRECEDENCE",
		);
		const advisoryPrecedence = validateImplementationReview({
			verdict: verdict([
				defect({ boundaryChanges: ["api"], action: "auto_fix" }),
			]),
			phase: "2",
			mode: "advisory",
			phaseIds: ["2"],
			workItemIds: ["W1"],
		});
		expect(advisoryPrecedence.governance?.route).toBe("author_revision");
		expect(advisoryPrecedence.governance?.hypotheticalEnforcedRoute).toBe(
			"human_gate",
		);

		const expansion = certified([
			defect({
				scopeClass: "scope_expansion",
				planWorkItemIds: undefined,
				action: "auto_fix",
			}),
		]);
		expect(expansion.governance?.route).toBe("human_gate");
		expect(expansion.governance?.actionableItems).toHaveLength(1);

		const ordinary = certified([
			defect({
				scopeClass: "pre_existing",
				planWorkItemIds: undefined,
				action: "auto_fix",
			}),
		]);
		expect(ordinary.valid).toBe(false);
		expect(ordinary.governance?.actionableItems).toEqual([]);
		expect(ordinary.governance?.nonblockingMarkdown).toContain(
			"Wrong return code",
		);

		const critical = certified([
			defect({
				scopeClass: "pre_existing",
				planWorkItemIds: undefined,
				action: "auto_fix",
				lateDiscovery: "critical_safety",
				lateDiscoveryEvidence: "The credential is written to the log.",
			}),
		]);
		expect(critical.governance?.route).toBe("human_gate");
		expect(critical.diagnostics.map((item) => item.code)).toContain(
			"CRITICAL_PRE_EXISTING_REQUIRES_HUMAN",
		);
	});

	test("rejects unknown work items, unknown phases, plan-phase implementation scope, and missing enforced context", () => {
		const unknown = certified([defect({ planWorkItemIds: ["W9"] })]);
		expect(unknown.valid).toBe(false);
		expect(unknown.fatalCode).toBe("WORK_ITEM_UNKNOWN");

		const unknownPhase = validateImplementationReview({
			verdict: verdict([defect()]),
			phase: "9",
			mode: "enforced",
			phaseIds: ["2"],
			workItemIds: ["W1"],
		});
		expect(unknownPhase.fatalCode).toBe("UNKNOWN_PHASE");

		const planPhase = validateImplementationReview({
			verdict: verdict([defect()]),
			phase: "plan",
			mode: "off",
		});
		expect(planPhase.fatalCode).toBe("IMPLEMENTATION_CONTRACT_IN_PLAN_PHASE");

		const conflict = validateImplementationReview({
			verdict: verdict([defect()]),
			phase: "2",
			envelopePhase: "3",
			mode: "enforced",
			phaseIds: ["2", "3"],
			workItemIds: ["W1"],
		});
		expect(conflict.fatalCode).toBe("PHASE_CONFLICT");

		const missing = validateImplementationReview({
			verdict: verdict([defect()]),
			phase: "2",
			mode: "enforced",
		});
		expect(missing.fatalCode).toBe("IMPLEMENTATION_CONTEXT_MISSING");

		expect(implementationReviewRound(2, "session-a")).toBe(3);
		expect(implementationReviewRound(2, "session-b")).toBe(3);
	});

	test("preserves off, advisory, and enforced compatibility", () => {
		const off = validateImplementationReview({
			verdict: verdict([defect()]),
			phase: "2",
			mode: "off",
		});
		expect(off.domain).toBe("v1");
		expect(off.governance).toBeNull();

		const advisory = validateImplementationReview({
			verdict: verdict([defect()]),
			phase: "2",
			mode: "advisory",
		});
		expect(advisory.valid).toBe(true);
		expect(advisory.diagnostics.map((item) => item.code)).toContain(
			"IMPLEMENTATION_CONTEXT_MISSING",
		);
		expect(advisory.governance?.hypotheticalEnforcedRoute).toBe(
			"author_revision",
		);

		const enforced = certified([defect()]);
		expect(enforced.domain).toBe("implementation");
		expect(enforced.governance?.route).toBe("author_revision");
		expect(enforced.governance?.reviewRound).toBe(1);

		const continued = validateImplementationReview({
			verdict: verdict([]),
			phase: "phase-2",
			mode: "enforced",
			phaseIds: ["2"],
			workItemIds: [],
			priorReviewCount: 4,
			sessionId: "fresh-session",
		});
		expect(continued.domain).toBe("standalone");
		expect(implementationReviewRound(4, "fresh-session")).toBe(5);
	});

	test("rejects plan contracts in a bound implementation phase", () => {
		const bound = {
			phase: "2",
			phaseIds: ["2"],
			workItemIds: ["W1"],
		} as const;
		const polish = validateImplementationReview({
			verdict: verdict([
				defect({
					scopeClass: "polish",
					planWorkItemIds: undefined,
				}),
			]),
			mode: "enforced",
			...bound,
		});
		expect(polish.valid).toBe(false);
		expect(polish.fatalCode).toBe("PLAN_CONTRACT_IN_IMPLEMENTATION_PHASE");

		const baseline = validateImplementationReview({
			verdict: verdict([], {
				baselineAssessment: {
					independentEffortEstimate: 2,
					confidence: "high",
					reason: "The original estimate remains sound.",
				},
			}),
			mode: "advisory",
			...bound,
		});
		expect(baseline.fatalCode).toBe("PLAN_CONTRACT_IN_IMPLEMENTATION_PHASE");

		const assessments = validateImplementationReview({
			verdict: verdict([], {
				creditAssessments: [
					{
						creditClaimId: "DC0",
						eligibility: "eligible",
						coupling: "intrinsic",
						reason: "The simplification shipped.",
					},
				],
			}),
			mode: "enforced",
			...bound,
		});
		expect(assessments.fatalCode).toBe("PLAN_CONTRACT_IN_IMPLEMENTATION_PHASE");

		const claim = validateImplementationReview({
			verdict: verdict([
				defect({
					scopeClass: undefined,
					planWorkItemIds: undefined,
					creditClaim: {
						creditClaimId: "DC0",
						targetPhase: "2",
						minimalAlternativeEffortDelta: 0,
						minimalAlternativeArchitectureDelta: -1,
						before: "Two stores.",
						after: "One store.",
					},
				}),
			]),
			mode: "enforced",
			...bound,
		});
		expect(claim.fatalCode).toBe("PLAN_CONTRACT_IN_IMPLEMENTATION_PHASE");

		const off = validateImplementationReview({
			verdict: verdict([
				defect({ scopeClass: "polish", planWorkItemIds: undefined }),
			]),
			phase: "2",
			mode: "off",
		});
		expect(off.valid).toBe(true);
		expect(off.domain).toBe("v1");
		expect(off.governance).toBeNull();

		const compatible = validateImplementationReview({
			verdict: verdict([], {
				baselineAssessment: {
					independentEffortEstimate: 2,
					confidence: "high",
					reason: "The original estimate remains sound.",
				},
			}),
			phase: "2",
			mode: "enforced",
			compatibility: true,
			phaseIds: ["2"],
			workItemIds: ["W1"],
		});
		expect(compatible.domain).toBe("v1");
		expect(compatible.valid).toBe(true);

		const unbound = validateImplementationReview({
			verdict: verdict([
				defect({ scopeClass: "polish", planWorkItemIds: undefined }),
			]),
			phase: "2",
			mode: "advisory",
		});
		expect(unbound.valid).toBe(true);
		expect(unbound.domain).toBe("standalone");

		const legacy = validateImplementationReview({
			verdict: verdict([
				{
					id: "R1",
					title: "Legacy note",
					action: "auto_fix",
					reason: "No scope class was supplied.",
				},
			]),
			mode: "enforced",
			...bound,
		});
		expect(legacy.valid).toBe(true);
		expect(legacy.domain).toBe("standalone");
		expect(legacy.fatalCode).toBeUndefined();
	});

	test("standalone validation accepts an implementation verdict without a phase", () => {
		const standalone = validateImplementationReview({
			verdict: verdict([defect()]),
			mode: "advisory",
			hasRun: false,
		});
		expect(standalone.valid).toBe(true);
		expect(standalone.domain).toBe("standalone");
		expect(standalone.governance).toBeNull();
		expect(standalone.exemptionAuthorized).toBe(false);
		const missing = standalone.diagnostics.find(
			(item) => item.code === "IMPLEMENTATION_CONTEXT_MISSING",
		);
		expect(missing?.severity).toBe("info");

		const runAware = validateImplementationReview({
			verdict: verdict([defect()]),
			mode: "advisory",
			hasRun: true,
		});
		expect(runAware.valid).toBe(false);
		expect(runAware.fatalCode).toBe("UNKNOWN_PHASE");

		const omitted = validateImplementationReview({
			verdict: verdict([defect()]),
			mode: "advisory",
		});
		expect(omitted.fatalCode).toBe("UNKNOWN_PHASE");
	});
});
