import { describe, expect, test } from "bun:test";
import type { ReviewerVerdict } from "../../../src/protocol.js";
import { validateClosureReview } from "../../../src/review-governance/closure.js";
import { canonicalFindingFingerprint } from "../../../src/review-governance/fingerprint.js";
import type {
	GovernanceReviewerVerdict,
	PersistedFinding,
	ReviewDecision,
} from "../../../src/review-governance/types.js";

const identity = {
	title: "Preserve writes",
	scopeClass: "acceptance_required" as const,
	failure: "A retry can corrupt stored data.",
	lowestCostCorrection: "Make the write idempotent.",
};
const prior: PersistedFinding = {
	findingId: "P1.1",
	fingerprint: canonicalFindingFingerprint(identity),
	...identity,
	status: "still_open",
};

function item(overrides: Record<string, unknown> = {}) {
	return {
		id: "P1.1",
		title: identity.title,
		action: "auto_fix" as const,
		reason: "The failure remains possible.",
		scopeClass: identity.scopeClass,
		effortDelta: 1,
		architectureDelta: 0,
		estimateConfidence: "high" as const,
		failure: identity.failure,
		lowestCostCorrection: identity.lowestCostCorrection,
		...overrides,
	};
}

function validate(
	verdict: GovernanceReviewerVerdict,
	overrides: Partial<Parameters<typeof validateClosureReview>[0]> = {},
) {
	return validateClosureReview({
		reviewKind: "closure",
		mode: "enforced",
		verdict,
		priorFindings: [prior],
		priorDecisions: [],
		...overrides,
	});
}

describe("validateClosureReview", () => {
	test("requires complete initial material findings and an independent baseline", () => {
		const valid = validateClosureReview({
			reviewKind: "initial",
			mode: "enforced",
			verdict: {
				readiness: "not_ready",
				items: [item()],
				baselineAssessment: {
					independentEffortEstimate: 5,
					confidence: "high",
					reason: "The work crosses two persistence paths.",
				},
			} as GovernanceReviewerVerdict,
			priorFindings: [],
			priorDecisions: [],
		});
		expect(valid.valid).toBe(true);

		const invalid = validateClosureReview({
			reviewKind: "initial",
			mode: "enforced",
			verdict: {
				readiness: "not_ready",
				items: [item({ failure: "Completeness", lowestCostCorrection: "" })],
			} as GovernanceReviewerVerdict,
			priorFindings: [],
			priorDecisions: [],
		});
		expect(invalid.accepted).toBe(false);
		expect(invalid.diagnostics.map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"INITIAL_BASELINE_ASSESSMENT_REQUIRED",
				"INITIAL_ITEM_FIELDS_REQUIRED",
				"INITIAL_ITEM_FAILURE_NOT_MATERIAL",
			]),
		);
	});

	test("requires exactly one outcome and keeps only partial/open findings in items", () => {
		expect(
			validate({
				readiness: "not_ready",
				priorFindings: [{ id: "P1.1", status: "partially_addressed" }],
				items: [item({ effortDelta: 1 })],
			}).valid,
		).toBe(true);

		const addressed = validate({
			readiness: "ready",
			priorFindings: [{ id: "P1.1", status: "addressed" }],
			items: [],
		});
		expect(addressed.valid).toBe(true);
		expect(addressed.findingOutcomes).toEqual([
			{
				findingId: "P1.1",
				fingerprint: prior.fingerprint,
				status: "addressed",
			},
		]);

		const malformed = validate({
			readiness: "not_ready",
			priorFindings: [
				{ id: "P1.1", status: "addressed" },
				{ id: "P1.1", status: "still_open" },
				{ id: "unknown", status: "addressed" },
			],
			items: [item(), item()],
		});
		expect(malformed.diagnostics.map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"PRIOR_FINDING_DUPLICATE",
				"PRIOR_FINDING_UNKNOWN",
				"PRIOR_FINDING_ITEM_DUPLICATE",
			]),
		);
	});

	test("tracks a same-ID fingerprint change as informational changed evidence", () => {
		const changedCorrection = "Add the idempotency key only to the retry path.";
		const result = validate({
			readiness: "not_ready",
			priorFindings: [{ id: "P1.1", status: "partially_addressed" }],
			items: [item({ lowestCostCorrection: changedCorrection })],
		});
		expect(result.valid).toBe(true);
		expect(result.accepted).toBe(true);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "PRIOR_FINDING_FINGERPRINT_CHANGED",
				severity: "info",
			}),
		);
		expect(result.findingOutcomes).toEqual([
			{
				findingId: prior.findingId,
				fingerprint: canonicalFindingFingerprint({
					...identity,
					lowestCostCorrection: changedCorrection,
				}),
				status: "partially_addressed",
			},
		]);
	});

	test("reports missing and unexpectedly retained prior-finding items", () => {
		const missing = validate({
			readiness: "not_ready",
			priorFindings: [{ id: "P1.1", status: "still_open" }],
			items: [],
		});
		expect(missing.diagnostics).toContainEqual(
			expect.objectContaining({ code: "PRIOR_FINDING_ITEM_MISSING" }),
		);

		const unexpected = validate({
			readiness: "ready",
			priorFindings: [{ id: "P1.1", status: "addressed" }],
			items: [item()],
		});
		expect(unexpected.diagnostics).toContainEqual(
			expect.objectContaining({ code: "PRIOR_FINDING_ITEM_UNEXPECTED" }),
		);
	});

	test("rejects an ordinary missed issue and accepts structured introduced evidence", () => {
		const base = {
			readiness: "not_ready" as const,
			priorFindings: [{ id: "P1.1", status: "addressed" as const }],
		};
		const missed = validate({ ...base, items: [item({ id: "P1.2" })] });
		expect(missed.diagnostics).toContainEqual(
			expect.objectContaining({ code: "NEW_FINDING_EVIDENCE_REQUIRED" }),
		);

		const introduced = validate({
			...base,
			items: [
				item({
					id: "P1.2",
					introducedBy: {
						commitRange: "abc..def",
						diffHunk: "@@ -1 +1 @@\n-old\n+new",
						explanation: "The new branch drops failed writes.",
					},
				}),
			],
		});
		expect(introduced.valid).toBe(true);
	});

	test("requires complete identity and hunk evidence on new closure blockers", () => {
		const result = validate({
			readiness: "not_ready",
			priorFindings: [{ id: "P1.1", status: "addressed" }],
			items: [
				{
					id: "P1.2",
					title: "New blocker",
					action: "auto_fix",
					reason: "Introduced by the revision.",
					introducedBy: {
						commitRange: "",
						diffHunk: "",
						explanation: "",
					},
				},
			],
		});
		expect(result.diagnostics.map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"INITIAL_ITEM_FIELDS_REQUIRED",
				"INITIAL_ITEM_FAILURE_NOT_MATERIAL",
				"INTRODUCED_HUNK_EVIDENCE_INCOMPLETE",
			]),
		);
	});

	test("rejects conflicting introduced and critical evidence", () => {
		const result = validate({
			readiness: "not_ready",
			priorFindings: [{ id: "P1.1", status: "addressed" }],
			items: [
				item({
					id: "P0.2",
					introducedBy: {
						commitRange: "abc..def",
						diffHunk: "@@ -1 +1 @@",
						explanation: "Changed behavior.",
					},
					lateDiscovery: "critical_safety",
					lateDiscoveryEvidence: "A correctness failure corrupts data.",
				}),
			],
		});
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "INTRODUCED_AND_CRITICAL_CONFLICT" }),
		);
	});

	test("allows only concrete critical-safety exceptions", () => {
		const verdict: GovernanceReviewerVerdict = {
			readiness: "not_ready",
			priorFindings: [{ id: "P1.1", status: "addressed" }],
			items: [
				item({
					id: "P0.2",
					lateDiscovery: "critical_safety",
					lateDiscoveryEvidence:
						"An unauthenticated request causes permanent user data loss.",
					failure: "Missing authorization causes data loss.",
					scopeClass: "risk_reduction",
				}),
			],
		};
		expect(validate(verdict).valid).toBe(true);
		const weak = validate({
			...verdict,
			items: [item({ id: "P0.2", lateDiscovery: "critical_safety" })],
		});
		expect(weak.diagnostics).toContainEqual(
			expect.objectContaining({ code: "CRITICAL_SAFETY_EVIDENCE_REQUIRED" }),
		);

		const contentless = validate({
			...verdict,
			items: [
				item({
					id: "P0.2",
					lateDiscovery: "critical_safety",
					lateDiscoveryEvidence: "See the failure above.",
					failure: "A correctness failure corrupts data.",
				}),
			],
		});
		expect(contentless.diagnostics).toContainEqual(
			expect.objectContaining({ code: "CRITICAL_SAFETY_EVIDENCE_REQUIRED" }),
		);

		const wrongScope = validate({
			...verdict,
			items: [
				item({
					id: "P0.2",
					lateDiscovery: "critical_safety",
					lateDiscoveryEvidence: "A correctness failure corrupts data.",
					scopeClass: "polish",
				}),
			],
		});
		expect(wrongScope.diagnostics).toContainEqual(
			expect.objectContaining({ code: "CRITICAL_SAFETY_SCOPE_INVALID" }),
		);
	});

	test("requires an active matching risk decision and materially new evidence", () => {
		const decision: ReviewDecision = {
			decisionId: "decision-1",
			choice: "defer_accept_risk",
			findingRefs: [
				{
					findingId: prior.findingId,
					fingerprint: prior.fingerprint,
					scopeClass: prior.scopeClass,
				},
			],
			rationale: "Risk is isolated to an offline tool.",
			evidence: ["No network callers exist."],
		};
		const reraised: GovernanceReviewerVerdict = {
			readiness: "not_ready",
			items: [
				item({
					priorDecisionId: "decision-1",
					newEvidence: "A new public API now invokes this write path.",
				}),
			],
		};
		expect(validate(reraised, { priorDecisions: [decision] }).valid).toBe(true);

		const stale = validate(
			{
				...reraised,
				items: [item({ priorDecisionId: "missing", newEvidence: "New." })],
			},
			{ priorDecisions: [decision] },
		);
		expect(stale.diagnostics).toContainEqual(
			expect.objectContaining({ code: "PRIOR_DECISION_STALE" }),
		);

		const changed = validate(
			{
				...reraised,
				items: [
					item({
						priorDecisionId: "decision-1",
						newEvidence: "A new caller exists.",
						failure: "A different failure deletes all data.",
					}),
				],
			},
			{ priorDecisions: [decision] },
		);
		expect(changed.diagnostics).toContainEqual(
			expect.objectContaining({ code: "PRIOR_DECISION_FINDING_MISMATCH" }),
		);

		const repeatedEvidence = validate(
			{
				...reraised,
				items: [
					item({
						priorDecisionId: "decision-1",
						newEvidence: " risk is isolated to an OFFLINE tool. ",
					}),
				],
			},
			{ priorDecisions: [decision] },
		);
		expect(repeatedEvidence.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "PRIOR_DECISION_NEW_EVIDENCE_REQUIRED",
			}),
		);
	});

	test("treats inactive, superseded, and non-risk decisions as stale", () => {
		const decision = (overrides: Partial<ReviewDecision>): ReviewDecision => ({
			decisionId: "decision-1",
			choice: "defer_accept_risk",
			findingRefs: [
				{
					findingId: prior.findingId,
					fingerprint: prior.fingerprint,
					scopeClass: prior.scopeClass,
				},
			],
			...overrides,
		});
		const verdict: GovernanceReviewerVerdict = {
			readiness: "not_ready",
			items: [
				item({
					priorDecisionId: "decision-1",
					newEvidence: "A new public caller invokes the path.",
				}),
			],
		};
		const cases: ReviewDecision[][] = [
			[decision({ active: false })],
			[
				decision({}),
				decision({
					decisionId: "decision-2",
					choice: "retain_baseline",
					findingRefs: [],
					supersedesDecisionId: "decision-1",
				}),
			],
			[decision({ choice: "increase_budget" })],
		];
		for (const priorDecisions of cases) {
			const result = validate(verdict, { priorDecisions });
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ code: "PRIOR_DECISION_STALE" }),
			);
		}
	});

	test("keeps violations as non-rejecting diagnostics in advisory mode", () => {
		const result = validate(
			{ readiness: "ready", items: [] },
			{ mode: "advisory" },
		);
		expect(result.valid).toBe(false);
		expect(result.accepted).toBe(true);
		expect(result.diagnostics[0]?.code).toBe("PRIOR_FINDING_OMITTED");
	});

	test("accepts the public ReviewerVerdict signature without command dependencies", () => {
		const plain: ReviewerVerdict = { readiness: "ready", items: [] };
		expect(
			validateClosureReview({
				reviewKind: "initial",
				mode: "advisory",
				verdict: plain,
				priorFindings: [],
				priorDecisions: [],
			}).accepted,
		).toBe(true);
	});
});
