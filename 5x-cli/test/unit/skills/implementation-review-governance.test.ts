import { describe, expect, test } from "bun:test";
import { getDefaultSkillRaw } from "../../../src/harnesses/opencode/skills/loader.js";
import type { ImplementationBindingPayload } from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	appendPlanReviewPromptContext,
	buildImplementationReviewPromptContext,
	formatImplementationAuthorContext,
	formatImplementationReviewerContext,
	type ImplementationReviewPromptContext,
} from "../../../src/review-governance/context.js";
import { renderSkillByName } from "../../../src/skills/loader.js";
import { createRenderContext } from "../../../src/skills/renderer.js";
import { renderTemplate } from "../../../src/templates/loader.js";
import { makeBudgetContext } from "../commands/review-budget-test-helpers.js";

const contexts = [
	createRenderContext(true),
	createRenderContext(false),
	createRenderContext(false, true, false),
	createRenderContext(false, false, true),
];

const promptContext: ImplementationReviewPromptContext = {
	reviewKind: "closure",
	mode: "enforced",
	bindingId: "binding-1",
	sourceRunId: "source-run",
	sourceSnapshotId: "snap-1",
	approvedPlanCommit: "a".repeat(40),
	phaseId: "1",
	phaseHeading: "Phase 1",
	approvedWorkItemIds: ["W1"],
	phaseScope: ["1: Phase 1", "W1: Work"],
	reviewContextId: "ctx-1",
	fullDiffRetrieval: "git diff aaa..bbb -- .",
	requiredOutcomeIds: ["I1"],
	dueClaims: [
		{
			creditClaimId: "DC1",
			phaseId: "1",
			approvedArchitectureDelta: -2,
			effectiveMagnitude: 1,
			after: "one store",
			waiverDecisionId: "decision-waive",
		},
	],
	deferredOrAcceptedRisks: [
		{
			decisionId: "decision-risk",
			title: "Imported latency risk",
			rationale: "Accepted for this phase.",
			approvedScope: ["W1"],
			source: "imported",
		},
	],
	debtWaivers: [
		{
			decisionId: "decision-waive",
			creditClaimId: "DC1",
			approvedMagnitude: 1,
			originalMagnitude: 2,
		},
	],
	authorRoute: "author_revision",
	authorNextAction: "author_revision",
	finalCorrection: false,
	eligibleItemId: null,
	actionableFindings: [
		{
			id: "I1",
			title: "Missing guard",
			scopeClass: "implementation_defect",
			priority: "P2",
			action: "auto_fix",
			reason: "Restore the existing check.",
			planWorkItemIds: ["W1"],
		},
	],
	textGuard: {
		id: "guard-1",
		spans: [{ heading: "Phase 1", staleText: "old sentence" }],
	},
};

function binding(): ImplementationBindingPayload {
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: "run1",
		sourceRunId: "source-run",
		sourceSnapshotId: "snap-1",
		sourceBaselineId: "base-1",
		approvedPlanCommit: "c".repeat(40),
		approvedPlanHash: "sha256:plan",
		approvedPlanBytes: "# Plan\n",
		b0: 8,
		governingB: 8,
		mode: "enforced",
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger: {
			estimateConfidence: "high",
			workItems: [
				{
					id: "W1",
					title: "Bind execution",
					effort: 2,
					architectureDelta: -2,
					debtClaim: {
						debtClaimId: "DC1",
						coupling: "intrinsic",
						targetPhase: "1",
						minimalAlternativeEffortDelta: 0,
						minimalAlternativeArchitectureDelta: -1,
						before: "two stores",
						after: "one binding",
					},
					addresses: ["P1.1"],
					rationale: "Required",
					line: 1,
				},
			],
			surface: {
				subsystems: 1,
				productionFiles: 1,
				persistentOrExternalBoundaries: 0,
			},
		},
		effectiveDecisions: [
			{
				kind: "plan-review-governance",
				version: 1,
				decisionId: "11111111-1111-4111-8111-111111111111",
				gateId: "gate-1",
				snapshotId: "snap-1",
				choice: "defer_accept_risk",
				decisionIntentHash: `sha256:${"ab".repeat(32)}`,
				findingRefs: [{ findingId: "P1.1", fingerprint: "sha256:risk" }],
				rationale: "Imported accepted risk.",
				evidence: ["Operator note"],
				approvedScope: { retained: ["W1"], removed: [] },
				createdAt: "2026-01-01 00:00:00",
			},
		],
		phaseMap: [{ id: "1", heading: "Phase 1" }],
		debtTargets: [{ claimId: "DC1", sourceLabel: "phase-1", phaseId: "1" }],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-01-01 00:00:00",
	};
}

describe("implementation review skill branches", () => {
	test("renders governance routes for all four role-mode combinations", () => {
		for (const context of contexts) {
			const content = renderSkillByName("5x-phase-execution", context).content;
			expect(content).toContain("`complete`");
			expect(content).toContain("`author_revision`");
			expect(content).toContain("`final_corrections`");
			expect(content).toContain("`human_gate`");
			expect(content).toContain(".data.result.governance.route");
			expect(content).toContain("5x review corrections finish");
			expect(content).toContain("5x review decide --gate");
			expect(content).toContain("5x review implementation bind");
			expect(content).toContain("pre_author_commit");
			expect(content).toContain("IMPLEMENTATION_APPROVAL_REQUIRED");
			expect(content).toContain("Never continue that failure as v1");
			expect(content).toContain("harness_freshness");
			expect(content).toContain("Delegation mode precedence");
			expect(content).toContain("maxReviewIterations");
			expect(content).toContain("--new-session");
			expect(content).toContain("--continue-native");
			expect(content).not.toContain("baselineAssessment");
			expect(content).not.toContain("projectedEffort");
		}
	});

	test("loads current skill content rather than an installed copy", () => {
		const loaded = getDefaultSkillRaw("5x-phase-execution");
		const rendered = renderSkillByName(
			"5x-phase-execution",
			createRenderContext(true),
		).content;
		expect(loaded).toContain("5x review corrections finish");
		expect(loaded).toContain("task_id=");
		expect(rendered).toContain("[[NATIVE_CONTINUE_PARAM]]");
		expect(loaded).not.toContain("[[NATIVE_CONTINUE_PARAM]]");
	});
});

describe("implementation prompt context", () => {
	test("keeps native and invoke governance bytes identical", () => {
		const governance = formatImplementationReviewerContext(promptContext);
		const author = formatImplementationAuthorContext(promptContext);
		const diff = "\n## Implementation Diff\n\nrange\n";
		const native = appendPlanReviewPromptContext({
			prompt: `native template${diff}`,
			governanceAppend: governance,
		});
		const invoke = appendPlanReviewPromptContext({
			prompt: `native template${diff}`,
			governanceAppend: governance,
		});
		expect(native).toBe(invoke);
		expect(native).toContain("Binding: binding-1");
		expect(native).toContain("Source run: source-run");
		expect(native).toContain("Approved work-item IDs: W1");
		expect(native).toContain("Full diff retrieval: `git diff aaa..bbb -- .`");
		expect(native).toContain("Required prior-finding outcome IDs: I1");
		expect(native).toContain("DC1");
		expect(native).toContain("Imported latency risk");
		expect(native).toContain("decision decision-risk");
		expect(native).toContain("approved scope: W1");
		expect(native).toContain("decision decision-waive");
		expect(author).toContain("Implement only the admitted findings");
		expect(author).toContain("old sentence");
		expect(author).not.toContain("baselineAssessment");
		expect(governance).not.toContain("B0");
	});

	test("a fresh session does not reset imported risk or due claims", () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		ctx.store.saveImplementationBinding(
			binding(),
			ctx.originFor({
				kind: "system",
				role: "cli",
			}),
		);
		const fresh = buildImplementationReviewPromptContext({
			runId: "run1",
			phase: "1",
			store: ctx.store,
			recordStore: ctx.recordStore,
			sessionId: "new",
		});
		const continued = buildImplementationReviewPromptContext({
			runId: "run1",
			phase: "1",
			store: ctx.store,
			recordStore: ctx.recordStore,
			sessionId: "session-1",
		});
		expect(fresh).toEqual(continued);
		expect(fresh?.reviewKind).toBe("initial");
		expect(fresh?.dueClaims[0]?.creditClaimId).toBe("DC1");
		expect(fresh?.deferredOrAcceptedRisks[0]?.source).toBe("imported");
		expect(fresh?.deferredOrAcceptedRisks[0]?.title).toBe("P1.1");
		if (!fresh || !continued)
			throw new Error("expected implementation context");
		expect(formatImplementationReviewerContext(fresh)).toBe(
			formatImplementationReviewerContext(continued),
		);
		ctx.db.close();
	});
});

describe("implementation instruction templates", () => {
	test("documents classes, planImpact locations, and no plan score formulas", () => {
		const initial = renderTemplate("reviewer-commit", {
			commit_hash: "abc",
			review_path: "review.md",
			plan_path: "plan.md",
			review_template_path: "template.md",
		}).prompt;
		const closure = renderTemplate("reviewer-commit-continued", {
			commit_hash: "abc",
			review_path: "review.md",
			plan_path: "plan.md",
			review_template_path: "template.md",
			previous_review_commit: "old",
			current_commit: "new",
		}).prompt;
		for (const prompt of [initial, closure]) {
			expect(prompt).toContain("implementation_defect");
			expect(prompt).toContain("plan_defect");
			expect(prompt).toContain("scope_expansion");
			expect(prompt).toContain("pre_existing");
			expect(prompt).toContain('"kind": "text_only"');
			expect(prompt).toContain("staleText");
			expect(prompt).toContain("Missing or ambiguous");
			expect(prompt).toContain("Do not emit `baselineAssessment`");
			expect(prompt).not.toContain("--baseline-assessment");
			expect(prompt).not.toContain("projectedEffort");
		}
		expect(initial).toContain("one exhaustive material pass");
		expect(closure).toContain("closure review");
		expect(closure).toContain("Nonblocking follow-ups");
	});

	test("author prompts admit only governed findings and forbid cleanup", () => {
		const fix = renderTemplate("author-process-impl-review", {
			review_path: "review.md",
			plan_path: "plan.md",
			user_notes: "",
		}).prompt;
		const next = renderTemplate("author-next-phase", {
			plan_path: "plan.md",
			phase_number: "1",
			user_notes: "",
		}).prompt;
		expect(fix).toContain("Admitted implementation work");
		expect(fix).toContain("latest addendum");
		expect(fix).toContain("text guard");
		expect(fix).toContain("approved amendment workflow");
		expect(fix).toContain("only the eligible item");
		expect(fix).toContain("code implementation");
		expect(next).toContain("approved work-item IDs");
		expect(next).not.toContain("--baseline-assessment");
	});
});
