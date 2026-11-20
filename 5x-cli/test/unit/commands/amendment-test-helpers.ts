import type { ReviewBudgetCommandContext } from "../../../src/commands/review-budget-context.js";
import {
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { recordStep } from "../../../src/db/operations-v1.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import type { VerdictItem } from "../../../src/protocol.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	createImplementationDecision,
	governanceDecisionKey,
} from "../../../src/review-governance/decisions.js";
import { fingerprintImplementationVerdictItem } from "../../../src/review-governance/fingerprint.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";
import { TEST_ORIGIN } from "./review-budget-test-helpers.js";

/** Three-phase schema 0 plan whose phase 2 an amendment rewrites. */
export const AMENDMENT_PLAN = `# Plan

## Design Decisions

Keep the binding.

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Foundation | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Foundation

**Completion gate:** Stable.

- [ ] Stable types

## Phase 2: Providers

**Completion gate:** Normalize.

- [ ] Read digits

## Phase 3: Verification

**Completion gate:** Verify.

- [ ] Verify timestamps
`;

export const AMENDED_PLAN = AMENDMENT_PLAN.replace(
	"Read digits",
	"Honor offsets",
);

export function amendmentLedger(text: string) {
	const parsed = parseDeliveryBudget(text);
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.value;
}

function item(id: string): VerdictItem {
	return {
		id,
		title: id,
		action: "human_required",
		reason: "Providers",
		priority: "P1",
		scopeClass: "implementation_defect",
		planWorkItemIds: ["W1"],
		effortDelta: 1,
		architectureDelta: 0,
		estimateConfidence: "high",
		failure: "Providers",
		lowestCostCorrection: "Amend the plan",
	};
}

/**
 * Seed an implementation run with a binding on `AMENDMENT_PLAN` and a phase 2
 * reviewer step whose observation carries a `plan_amendment` cause for R1.
 * Nothing authorizes the amendment yet.
 */
export function seedImplementationAmendmentObservation(
	ctx: ReviewBudgetCommandContext,
	input: {
		runId: string;
		priorCommit: string;
		authorCommit: string;
		mode?: "advisory" | "enforced";
	},
) {
	const { runId } = input;
	const finding = item("R1");
	const fingerprint = fingerprintImplementationVerdictItem(finding, "2");
	const append = (
		stream: "budget" | "steps" | "decisions",
		key: string,
		payload: unknown,
	) =>
		ctx.recordStore.append({
			runId,
			stream,
			idempotencyKey: key,
			payload,
			...recordedEnvelope(TEST_ORIGIN),
		});
	const putStep = (
		name: string,
		phase: string,
		iteration: number,
		result: unknown,
		head: string,
	) => {
		const key = stepIdempotencyKey({
			runId,
			stepName: name,
			phase,
			iteration,
		});
		append("steps", key, {
			step_name: name,
			phase,
			iteration,
			result_json: result,
			head_commit: head,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		});
		const row = recordStep(ctx.db, {
			run_id: runId,
			step_name: name,
			phase,
			iteration,
			result_json: JSON.stringify(result),
			head_commit: head,
		});
		return { key, id: String(row.step_id) };
	};
	append("budget", `budget:implementation-binding:${runId}`, {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: runId,
		sourceRunId: "source-run",
		sourceSnapshotId: "snapshot-1",
		sourceBaselineId: "baseline-1",
		approvedPlanCommit: input.priorCommit,
		approvedPlanHash: hashPlanBytes(AMENDMENT_PLAN),
		approvedPlanBytes: AMENDMENT_PLAN,
		b0: 2,
		governingB: 4,
		mode: input.mode ?? "advisory",
		thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
		ledger: amendmentLedger(AMENDMENT_PLAN),
		effectiveDecisions: [],
		phaseMap: [
			{ id: "1", heading: "Foundation" },
			{ id: "2", heading: "Providers" },
			{ id: "3", heading: "Verification" },
		],
		debtTargets: [],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-10-19T00:00:00.000Z",
	});
	append("budget", "ctx-obs-2", {
		kind: "implementation-review-context",
		version: 1,
		id: "ctx-obs-2",
		executionRunId: runId,
		bindingId: "binding-1",
		phase: "2",
		baseCommit: input.priorCommit,
		reviewedCommit: input.authorCommit,
		patchHash: hashPlanBytes("patch"),
		excludedPaths: ["docs/development/reviews"],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-10-19T00:00:00.000Z",
	});
	append("budget", "obs-2", {
		kind: "implementation-review",
		version: 1,
		id: "obs-2",
		runId,
		stepKey: { stepName: "reviewer:impl", phase: "2", iteration: 0 },
		bindingId: "binding-1",
		contextId: "ctx-obs-2",
		domain: "implementation",
		phase: "2",
		originalVerdict: { readiness: "not_ready", items: [finding] },
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [{ kind: "plan_amendment", findingId: "R1", fingerprint }],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: 1,
				plan_defect: 0,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 1,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 0,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 2, R: 0, B: 4, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-10-19T00:00:00.000Z",
	});
	putStep(
		"reviewer:impl",
		"2",
		0,
		{ readiness: "not_ready", items: [finding] },
		input.priorCommit,
	);
	return { fingerprint, append, putStep };
}

/**
 * Seed `seedImplementationAmendmentObservation` plus an accepted
 * `authorize_amendment` from revision `binding-1`. This is the state a plan
 * reviewer sees before registration.
 */
export function seedPendingImplementationAmendment(
	ctx: ReviewBudgetCommandContext,
	input: {
		runId: string;
		priorCommit: string;
		authorCommit: string;
		mode?: "advisory" | "enforced";
	},
) {
	const { fingerprint, append, putStep } =
		seedImplementationAmendmentObservation(ctx, input);
	const scope = {
		predecessorRevisionId: "binding-1",
		earliestAffectedPhase: "2",
		reopenCompletedPhases: false,
		claimEdits: [],
		resolutionRefs: [],
	};
	const decision = createImplementationDecision({
		decisionId: "11111111-1111-4111-8111-111111111111",
		gateId: "gate-1",
		observationId: "obs-2",
		bindingId: "binding-1",
		phase: "2",
		choice: "authorize_amendment",
		findingRefs: [{ findingId: "R1", fingerprint }],
		rationale: "Authorize only the structured scope",
		evidence: [],
		claimAdjustments: [],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-10-19T00:00:00.000Z",
		amendmentScope: scope,
	});
	append("decisions", governanceDecisionKey(decision.gateId), decision);
	const human = putStep(
		"human:review-governance",
		"2",
		1,
		{
			decisionId: decision.decisionId,
			gateId: decision.gateId,
			choice: "authorize_amendment",
		},
		input.authorCommit,
	);
	return { decision, scope, fingerprint, human, putStep };
}
