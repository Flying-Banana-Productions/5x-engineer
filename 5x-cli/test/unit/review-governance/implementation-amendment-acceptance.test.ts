import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatStateText,
	presentImplementationGovernance,
} from "../../../src/commands/run-v1.handler.js";
import { discoverLegacyRecoveryLineage } from "../../../src/commands/upgrade.handler.js";
import { loadConfig } from "../../../src/config.js";
import {
	createMemoryRecordStore,
	createWorkingTreeRecordStore,
	type RecordOrigin,
	type RecordStore,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import { runMigrations } from "../../../src/db/schema.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import type {
	AmendmentAssessment,
	VerdictItem,
} from "../../../src/protocol.js";
import { rebuildRecordsIndex } from "../../../src/records/index-rebuild.js";
import { resolvePlanProgress } from "../../../src/records/resolve.js";
import {
	decodeImplementationBindingPayload,
	type ImplementationPlanRecoveryPayload,
	type ImplementationReviewObservationPayload,
	implementationBindingKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import { createImplementationDecision } from "../../../src/review-governance/decisions.js";
import { fingerprintImplementationVerdictItem } from "../../../src/review-governance/fingerprint.js";
import {
	foldEffectiveExecution,
	registerImplementationAmendment,
} from "../../../src/review-governance/implementation-amendment.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "human", role: "operator" },
};
const COMMIT = "a".repeat(40);
const PLAN = `# Plan

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

function ledgerOf(text: string) {
	const parsed = parseDeliveryBudget(text);
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.value;
}

function item(id: string): VerdictItem {
	return {
		id,
		title: id,
		action: "human_required",
		reason: id,
		priority: "P1",
		scopeClass: "implementation_defect",
		planWorkItemIds: ["W1"],
		effortDelta: 1,
		architectureDelta: 0,
		estimateConfidence: "high",
		failure: id,
		lowestCostCorrection: "Amend the plan",
	};
}

function putRun(
	store: RecordStore,
	id: string,
	status: "active" | "completed" | "aborted",
	planPath = "plan.md",
) {
	store.putRun({
		id,
		plan_path: planPath,
		config_json: null,
		created_at: "2026-10-19T00:00:00.000Z",
		sealed_at: status === "active" ? null : "2026-10-19T01:00:00.000Z",
		status,
		final_head_commit: null,
		cli_version: "test",
		format_version: 1,
		creator: origin.recorder,
	});
}

function append(
	store: RecordStore,
	runId: string,
	stream: "budget" | "steps" | "decisions",
	key: string,
	payload: unknown,
) {
	store.append({
		runId,
		stream,
		idempotencyKey: key,
		payload,
		...recordedEnvelope(origin),
	});
}

function step(
	store: RecordStore,
	runId: string,
	name: string,
	phase: string,
	iteration: number,
	result: unknown,
) {
	const key = stepIdempotencyKey({ runId, stepName: name, phase, iteration });
	append(store, runId, "steps", key, {
		step_name: name,
		phase,
		iteration,
		result_json: result,
		head_commit: COMMIT,
		patch_id: null,
		diff_summary: null,
		duration_ms: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		model: null,
	});
	return key;
}

function observation(input: {
	runId: string;
	id: string;
	phase: string;
	iteration: number;
	items: VerdictItem[];
	bindingId?: string;
	completionAuthorized?: boolean;
	causes?: ImplementationReviewObservationPayload["gateCauses"];
}): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: input.id,
		runId: input.runId,
		stepKey: {
			stepName: "reviewer:impl",
			phase: input.phase,
			iteration: input.iteration,
		},
		bindingId: input.bindingId ?? "binding-1",
		contextId: `ctx-${input.id}`,
		domain: "implementation",
		phase: input.phase,
		originalVerdict: { readiness: "not_ready", items: input.items },
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: input.causes ?? [],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: input.items.length,
				plan_defect: 0,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 0,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 0,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 2, R: 0, B: 4, D: 0 },
		completionAuthorized: input.completionAuthorized ?? false,
		createdAt: "2026-10-19T00:00:00.000Z",
	};
}

function context(
	runId: string,
	id: string,
	phase: string,
	bindingId = "binding-1",
) {
	return {
		kind: "implementation-review-context" as const,
		version: 1 as const,
		id,
		executionRunId: runId,
		bindingId,
		phase,
		baseCommit: COMMIT,
		reviewedCommit: COMMIT,
		patchHash: hashPlanBytes(id),
		excludedPaths: [],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-10-19T00:00:00.000Z",
	};
}

function recovery(input: {
	runId: string;
	id: string;
	authorizationId: string;
	parent: string | null;
	beforeHash: string;
	bytes: string;
	phase: string;
	contexts: string[];
	observations: string[];
	bindingId?: string;
}): ImplementationPlanRecoveryPayload {
	return {
		kind: "implementation-plan-recovery",
		version: 1,
		id: input.id,
		bindingId: input.bindingId ?? "binding-1",
		executionRunId: input.runId,
		guardId: null,
		sourceObservationId: "obs-2",
		parentLineageId: input.parent,
		beforeCommit: COMMIT,
		afterCommit: COMMIT,
		beforeBlobHash: input.beforeHash,
		afterBlobHash: hashPlanBytes(input.bytes),
		authorizedPlanBytes: input.bytes,
		authorizationId: input.authorizationId,
		snapshotId: "snapshot-1",
		phase: input.phase,
		scopeConfirmation: "frontier",
		preservedPhaseConfirmation: "earlier phases stay",
		invalidatedContextIds: input.contexts,
		invalidatedObservationIds: input.observations,
		createdAt: "2026-10-19T00:00:00.000Z",
	};
}

function authority(store: RecordStore, runId: string) {
	const folded = foldEffectiveExecution({ recordStore: store, runId });
	if (!folded.ok) return folded;
	return {
		ok: true as const,
		currentRevisionId: folded.currentRevisionId,
		revisions: folded.revisions.map((revision) => ({
			id: revision.id,
			kind: revision.kind,
			hash: revision.approvedPlanHash,
			legacy: revision.legacy ?? null,
		})),
		evidence: folded.evidence.map((entry) => ({
			recordId: entry.recordId,
			revisionId: entry.revisionId,
			applicability: entry.applicability,
			certifies: entry.certifies,
		})),
		pinned: folded.pinned,
	};
}

function playerPlan() {
	return PLAN.replace(
		"| W1 | Foundation | 2 | 0 | - | - | Required |",
		[
			"| W1 | Foundation | 2 | 0 | - | - | Required |",
			"| W2 | Carry | 1 | -1 | DC0 (`intrinsic`) | - | Unchanged contract |",
			"| W3 | Withdraw | 1 | -1 | DC1 (`intrinsic`) | - | Withdrawn |",
		].join("\n"),
	).replace(
		"### Surface Snapshot",
		[
			"### Debt Claims",
			"",
			"#### DC0",
			"",
			"- Target phase: 2",
			"- Minimal-compliant effort delta: 0",
			"- Minimal-compliant architecture delta: 0",
			"- Before: two parsers",
			"- After: one parser",
			"",
			"#### DC1",
			"",
			"- Target phase: 2",
			"- Minimal-compliant effort delta: 0",
			"- Minimal-compliant architecture delta: 0",
			"- Before: extra send",
			"- After: no extra send",
			"",
			"### Surface Snapshot",
		].join("\n"),
	);
}

function withdrawDc1(text: string): string {
	return text
		.replace(
			"\n| W3 | Withdraw | 1 | -1 | DC1 (`intrinsic`) | - | Withdrawn |",
			"",
		)
		.replace(
			[
				"#### DC1",
				"",
				"- Target phase: 2",
				"- Minimal-compliant effort delta: 0",
				"- Minimal-compliant architecture delta: 0",
				"- Before: extra send",
				"- After: no extra send",
				"",
				"",
			].join("\n"),
			"",
		)
		.replace("- [ ] Read digits", "- [ ] Honor offsets");
}

describe("phase 4 amendment acceptance", () => {
	test("player desk registration keeps phase 1, withdraws DC1, and carries DC0 conservatively", async () => {
		const runId = "run-player";
		const base = playerPlan();
		const amended = withdrawDc1(base);
		const again = amended.replace("Honor offsets", "Honor offsets exactly");
		const findings = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"].map(
			(id) => item(id),
		);
		const r7 = findings.find((entry) => entry.id === "R7");
		if (!r7) throw new Error("missing R7");
		const fingerprint = fingerprintImplementationVerdictItem(r7, "2");
		const source = observation({
			runId,
			id: "obs-2",
			phase: "2",
			iteration: 0,
			items: findings,
			bindingId: "binding-player",
			causes: [{ kind: "plan_amendment", findingId: "R7", fingerprint }],
		});
		const phaseOne = observation({
			runId,
			id: "obs-1",
			phase: "1",
			iteration: 0,
			items: [],
			bindingId: "binding-player",
			completionAuthorized: true,
		});
		const parsed = ledgerOf(base);
		const store = createMemoryRecordStore();
		putRun(store, runId, "active");
		append(store, runId, "budget", implementationBindingKey(runId), {
			kind: "implementation-binding",
			version: 1,
			id: "binding-player",
			executionRunId: runId,
			sourceRunId: "source-player",
			sourceSnapshotId: "snapshot-player",
			sourceBaselineId: "baseline-player",
			approvedPlanCommit: COMMIT,
			approvedPlanHash: hashPlanBytes(base),
			approvedPlanBytes: base,
			b0: 2,
			governingB: 4,
			mode: "advisory",
			thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
			ledger: parsed,
			effectiveDecisions: [],
			phaseMap: [
				{ id: "1", heading: "Foundation" },
				{ id: "2", heading: "Providers" },
				{ id: "3", heading: "Verification" },
			],
			debtTargets: [
				{ claimId: "DC0", sourceLabel: "2", phaseId: "2" },
				{ claimId: "DC1", sourceLabel: "2", phaseId: "2" },
			],
			ledgerHash: "ledger",
			decisionsHash: "decisions",
			createdAt: "2026-10-19T00:00:00.000Z",
		});
		append(
			store,
			runId,
			"budget",
			"ctx-obs-1",
			context(runId, "ctx-obs-1", "1", "binding-player"),
		);
		append(store, runId, "budget", "obs-1", phaseOne);
		append(
			store,
			runId,
			"budget",
			"ctx-obs-2",
			context(runId, "ctx-obs-2", "2", "binding-player"),
		);
		append(store, runId, "budget", "obs-2", source);
		append(store, runId, "budget", "credit-dc0", {
			kind: "implementation-credit-reconciliation",
			version: 1,
			id: "credit-dc0",
			runId,
			stepKey: { stepName: "reviewer:credit", phase: "2", iteration: 1 },
			bindingId: "binding-player",
			observationId: "obs-2",
			phase: "2",
			reviewedCommit: COMMIT,
			claims: [
				{
					creditClaimId: "DC0",
					phaseId: "2",
					status: "realized",
					approvedArchitectureDelta: -1,
					effectiveApprovedMagnitude: 1,
					realizedArchitectureDelta: -1,
					evidence: "parser merged",
					assessedCommit: COMMIT,
					sourceObservationId: "obs-2",
					carried: true,
					waiverDecisionId: null,
				},
			],
			pendingClaimIds: [],
			supersedesId: null,
			supersedesObservationId: null,
			budget: {
				W: 2,
				R: 0,
				B: 4,
				P: 0,
				N: 0,
				D: 0,
				E: 0,
				S: 0,
				A: 0,
				provisionalCredit: 0,
				realizedCredit: 1,
				budgetBand: "within_standard",
				budgetAlerts: [],
				requiresHuman: false,
			},
			creditUnrealized: false,
			material: false,
			completionSatisfied: false,
			createdAt: "2026-10-19T00:00:00.000Z",
		});
		step(store, runId, "reviewer:impl", "2", 0, source.originalVerdict);
		step(store, runId, "phase:complete", "1", 1, { phase: "1" });
		const scope = {
			predecessorRevisionId: "binding-player",
			earliestAffectedPhase: "2",
			reopenCompletedPhases: false,
			claimEdits: [{ creditClaimId: "DC1", effect: "withdraw" as const }],
			resolutionRefs: [
				{
					phase: "2",
					observationId: "obs-2",
					findingId: "R7",
					fingerprint,
				},
			],
		};
		const decision = createImplementationDecision({
			decisionId: "11111111-1111-4111-8111-111111111121",
			gateId: "gate-player",
			observationId: "obs-2",
			bindingId: "binding-player",
			phase: "2",
			choice: "authorize_amendment",
			findingRefs: [{ findingId: "R7", fingerprint }],
			rationale: "Rationale mentions phase 1 and DC0 but is not scope",
			evidence: [],
			claimAdjustments: [],
			ledgerHash: "ledger",
			decisionsHash: "decisions",
			createdAt: "2026-10-19T00:00:00.000Z",
			amendmentScope: scope,
		});
		append(store, runId, "decisions", decision.decisionId, decision);
		const humanKey = step(store, runId, "human:review-governance", "2", 1, {
			decisionId: decision.decisionId,
			gateId: decision.gateId,
			choice: "authorize_amendment",
		});
		step(store, runId, "author:process-plan-review", "plan", 1, {
			result: "complete",
			commit: COMMIT,
		});
		step(store, runId, "git:commit", "plan", 1, {
			hash: COMMIT,
			message: "review",
			files: ["docs/development/reviews/review.md"],
		});
		const assessment: AmendmentAssessment = {
			predecessorRevisionId: "binding-player",
			reviewedPlanHash: hashPlanBytes(amended),
			earliestAffectedPhase: "2",
			preservedPhases: [{ phaseId: "1", reason: "phase section unchanged" }],
			resolvedFindings: [
				{
					phase: "2",
					observationId: "obs-2",
					findingId: "R7",
					fingerprint,
					reason: "scope change",
				},
			],
			claimEdits: [{ creditClaimId: "DC1", effect: "withdraw" }],
		};
		const approvalKey = step(store, runId, "reviewer:plan", "plan", 1, {
			readiness: "ready",
			items: [],
			governance: { route: "complete" },
			amendmentAssessment: assessment,
		});
		createReviewBudgetStore(store).appendSnapshot({
			runId,
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 1,
			currentLedger: ledgerOf(amended),
			findings: [],
			assessments: [],
			effectiveGateCauses: [],
			origin,
		});
		const before = store.listLines(runId, "budget").length;
		const preview = await registerImplementationAmendment(
			{
				runId,
				humanStepKey: humanKey,
				approvalStepKey: approvalKey,
				fromPhase: "2",
				resolves: ["R7"],
				dryRun: true,
				committedPlanBytes: amended,
				worktreePlanBytes: amended,
				approvedPlanCommit: COMMIT,
				boundaryCommit: COMMIT,
				headAccepted: true,
				unresolvedApprovalGate: false,
			},
			{ recordStore: store, origin, now: () => "2026-10-19T00:00:00.000Z" },
		);
		expect(preview.dryRun).toBe(true);
		expect(preview.created).toBe(false);
		expect(preview.completionAuthorized).toBe(false);
		expect(preview.provenance.completionAuthorized).toBe(false);
		expect(preview.provenance.original).toMatchObject({
			bindingId: "binding-player",
			sourceRunId: "source-player",
			b0: 2,
			governingB: 4,
		});
		expect(preview.provenance.effective.kind).toBe(
			"implementation_plan_amendment",
		);
		expect(preview.provenance.affectedPhases).toEqual(["2", "3"]);
		expect(preview.provenance.creditDifferences).toEqual([
			{ creditClaimId: "DC1", effect: "withdraw" },
		]);
		expect(preview.provenance.unchangedClaimIds).toEqual(["DC0"]);
		expect(preview.provenance.baselineUnchanged).toBe(true);
		expect(
			preview.provenance.pendingFindings.map((finding) => finding.findingId),
		).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R8"]);
		expect(
			preview.provenance.resolvedFindings.map((finding) => finding.findingId),
		).toEqual(["R7"]);
		expect(store.listLines(runId, "budget")).toHaveLength(before);

		const recorded = await registerImplementationAmendment(
			{
				runId,
				humanStepKey: humanKey,
				approvalStepKey: approvalKey,
				fromPhase: "2",
				resolves: ["R7"],
				committedPlanBytes: amended,
				worktreePlanBytes: amended,
				approvedPlanCommit: COMMIT,
				boundaryCommit: COMMIT,
				headAccepted: true,
				unresolvedApprovalGate: false,
			},
			{ recordStore: store, origin, now: () => "2026-10-19T00:00:00.000Z" },
		);
		expect(recorded.created).toBe(true);
		expect(recorded.completionAuthorized).toBe(false);
		expect(recorded.provenance.effective.revisionId).toBe(recorded.amendmentId);
		const folded = foldEffectiveExecution({ recordStore: store, runId });
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(folded.pinned).toMatchObject({
			b0: 2,
			governingB: 4,
			mode: "advisory",
		});
		expect(folded.approvedPlanHash).toBe(hashPlanBytes(amended));
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-1"),
		).toMatchObject({ applicability: "applicable", certifies: true });
		expect(
			folded.evidence.find((entry) => entry.recordId === "credit-dc0"),
		).toMatchObject({ applicability: "invalidated", certifies: false });
		expect(
			folded.findings
				.filter((finding) => finding.status === "pending")
				.map((finding) => finding.findingId),
		).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R8"]);
		expect(
			folded.findings.find((finding) => finding.findingId === "R7")?.status,
		).toBe("amendment_resolved");

		const binding = decodeImplementationBindingPayload(
			store.getLine(runId, "budget", implementationBindingKey(runId))?.payload,
		);
		const state = presentImplementationGovernance({
			readiness: {
				executionObligations: true,
				checklistSufficient: false,
				planDrifted: false,
				bindingPresent: true,
				phases: [],
			},
			binding,
			contexts: [],
			observations: [],
			reconciliations: [],
			correctionAttempts: [],
			activeGate: null,
			recordStore: store,
			runId,
		});
		expect(state.revision?.ok).toBe(true);
		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => lines.push(String(args[0] ?? ""));
		try {
			formatStateText({
				run: {
					id: runId,
					plan_path: "plan.md",
					status: "active",
					created_at: "2026-10-19T00:00:00.000Z",
					updated_at: "2026-10-19T00:00:00.000Z",
				},
				steps: [],
				summary: {
					total_steps: 0,
					phases_completed: [],
					total_tokens_in: 0,
					total_tokens_out: 0,
					total_cost_usd: 0,
					total_duration_ms: 0,
				},
				steps_used: 0,
				max_steps: 10,
				steps_remaining: 10,
				implementation_governance: state,
			});
		} finally {
			console.log = originalLog;
		}
		const text = lines.join("\n");
		expect(text).toContain("original_binding=binding-player");
		expect(text).toContain("effective_kind=implementation_plan_amendment");
		expect(text).toContain("completion_authorized=no");
		expect(text).toContain("DC1=withdraw");
		expect(text).toContain("pending=R1,R2,R3,R4,R5,R6,R8");
		expect(text).toContain("resolved=R7");
		expect(text).toContain("baseline_unchanged=yes");

		const secondScope = {
			predecessorRevisionId: recorded.amendmentId,
			earliestAffectedPhase: "2",
			reopenCompletedPhases: false,
			claimEdits: [],
			resolutionRefs: [],
		};
		const secondDecision = createImplementationDecision({
			decisionId: "11111111-1111-4111-8111-111111111122",
			gateId: "gate-player-2",
			observationId: "obs-2",
			bindingId: "binding-player",
			phase: "2",
			choice: "authorize_amendment",
			findingRefs: [{ findingId: "R7", fingerprint }],
			rationale: "Second amendment. Rationale is still not scope.",
			evidence: [],
			claimAdjustments: [],
			ledgerHash: "ledger",
			decisionsHash: "decisions",
			createdAt: "2026-10-19T00:00:00.000Z",
			amendmentScope: secondScope,
		});
		append(
			store,
			runId,
			"decisions",
			secondDecision.decisionId,
			secondDecision,
		);
		const secondHuman = step(store, runId, "human:review-governance", "2", 2, {
			decisionId: secondDecision.decisionId,
			gateId: secondDecision.gateId,
			choice: "authorize_amendment",
		});
		step(store, runId, "author:process-plan-review", "plan", 2, {
			result: "complete",
			commit: COMMIT,
		});
		step(store, runId, "git:commit", "plan", 2, {
			hash: COMMIT,
			message: "review again",
			files: ["docs/development/reviews/review.md"],
		});
		const secondAssessment: AmendmentAssessment = {
			predecessorRevisionId: recorded.amendmentId,
			reviewedPlanHash: hashPlanBytes(again),
			earliestAffectedPhase: "2",
			preservedPhases: [{ phaseId: "1", reason: "phase section unchanged" }],
			resolvedFindings: [],
			claimEdits: [],
		};
		const secondApproval = step(store, runId, "reviewer:plan", "plan", 2, {
			readiness: "ready",
			items: [],
			governance: { route: "complete" },
			amendmentAssessment: secondAssessment,
		});
		createReviewBudgetStore(store).appendSnapshot({
			runId,
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 2,
			currentLedger: ledgerOf(again),
			findings: [],
			assessments: [],
			effectiveGateCauses: [],
			origin,
		});
		const repeated = await registerImplementationAmendment(
			{
				runId,
				humanStepKey: secondHuman,
				approvalStepKey: secondApproval,
				fromPhase: "2",
				resolves: [],
				committedPlanBytes: again,
				worktreePlanBytes: again,
				approvedPlanCommit: COMMIT,
				boundaryCommit: COMMIT,
				headAccepted: true,
				unresolvedApprovalGate: false,
			},
			{ recordStore: store, origin, now: () => "2026-10-19T00:00:00.000Z" },
		);
		expect(repeated.created).toBe(true);
		expect(repeated.predecessorRevisionId).toBe(recorded.amendmentId);
		expect(repeated.provenance.history.map((entry) => entry.kind)).toEqual([
			"initial",
			"implementation_plan_amendment",
			"implementation_plan_amendment",
		]);
		expect(repeated.provenance.creditDifferences).toEqual([]);
		expect(repeated.completionAuthorized).toBe(false);
	});

	test("legacy chain survives upgrade discovery, rebuild, and a new-format amendment", async () => {
		const runId = "run-legacy";
		const amended = PLAN.replace("[ ] Read digits", "[x] Read digits");
		const secondBytes = amended.replace(
			"[ ] Verify timestamps",
			"[x] Verify timestamps",
		);
		const registeredBytes = secondBytes.replace("Read digits", "Honor offsets");
		const phaseOne = observation({
			runId,
			id: "obs-1",
			phase: "1",
			iteration: 1,
			items: [item("R1")],
			completionAuthorized: true,
		});
		const phaseTwo = observation({
			runId,
			id: "obs-2",
			phase: "2",
			iteration: 1,
			items: [item("R7"), item("R8")],
		});
		const between = observation({
			runId,
			id: "obs-2b",
			phase: "2",
			iteration: 2,
			items: [item("R9")],
		});
		const store = createMemoryRecordStore();
		putRun(store, runId, "active", "docs/development/plans/legacy.md");
		const approvedHash = hashPlanBytes(PLAN);
		append(store, runId, "budget", implementationBindingKey(runId), {
			kind: "implementation-binding",
			version: 1,
			id: "binding-1",
			executionRunId: runId,
			sourceRunId: "source-run",
			sourceSnapshotId: "snapshot-1",
			sourceBaselineId: "baseline-1",
			approvedPlanCommit: COMMIT,
			approvedPlanHash: approvedHash,
			approvedPlanBytes: PLAN,
			b0: 2,
			governingB: 4,
			mode: "advisory",
			thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
			ledger: ledgerOf(PLAN),
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
		append(
			store,
			runId,
			"budget",
			"ctx-obs-1",
			context(runId, "ctx-obs-1", "1"),
		);
		append(store, runId, "budget", "obs-1", phaseOne);
		append(
			store,
			runId,
			"budget",
			"ctx-obs-2",
			context(runId, "ctx-obs-2", "2"),
		);
		append(store, runId, "budget", "obs-2", phaseTwo);
		const legacyDecision = (id: string, observationId: string) =>
			createImplementationDecision({
				decisionId: id,
				gateId: `gate-${id}`,
				observationId,
				bindingId: "binding-1",
				phase: "2",
				choice: "authorize_amendment",
				findingRefs: [
					{
						findingId: "R7",
						fingerprint: fingerprintImplementationVerdictItem(item("R7"), "2"),
					},
				],
				rationale: "Historical recovery authorization",
				evidence: [],
				claimAdjustments: [],
				ledgerHash: "ledger",
				decisionsHash: "decisions",
				createdAt: "2026-10-19T00:00:00.000Z",
			});
		const firstAuth = "11111111-1111-4111-8111-111111111112";
		const secondAuth = "11111111-1111-4111-8111-111111111113";
		append(
			store,
			runId,
			"decisions",
			firstAuth,
			legacyDecision(firstAuth, "obs-2"),
		);
		append(
			store,
			runId,
			"decisions",
			secondAuth,
			legacyDecision(secondAuth, "obs-2"),
		);
		step(store, runId, "reviewer:impl", "2", 1, phaseTwo.originalVerdict);
		step(store, runId, "human:review-governance", "2", 1, {
			decisionId: firstAuth,
			gateId: `gate-${firstAuth}`,
			choice: "authorize_amendment",
		});
		step(store, runId, "human:review-governance", "2", 2, {
			decisionId: secondAuth,
			gateId: `gate-${secondAuth}`,
			choice: "authorize_amendment",
		});
		step(store, runId, "phase:complete", "1", 1, { phase: "1" });
		append(
			store,
			runId,
			"budget",
			"budget:implementation-plan-recovery:binding-1",
			recovery({
				runId,
				id: "recovery-1",
				authorizationId: firstAuth,
				parent: null,
				beforeHash: approvedHash,
				bytes: amended,
				phase: "2",
				contexts: ["ctx-obs-2"],
				observations: ["obs-2"],
			}),
		);
		append(store, runId, "budget", "text-1", {
			kind: "implementation-text-amendment",
			version: 1,
			id: "text-1",
			bindingId: "binding-1",
			executionRunId: runId,
			guardId: "guard-1",
			sourceObservationId: "obs-1",
			parentLineageId: "recovery-1",
			beforeCommit: COMMIT,
			afterCommit: COMMIT,
			beforeBlobHash: hashPlanBytes(amended),
			afterBlobHash: hashPlanBytes(amended),
			authorizedPlanBytes: amended,
			createdAt: "2026-10-19T00:00:00.000Z",
		});
		append(store, runId, "budget", "obs-2b", between);
		step(store, runId, "reviewer:impl", "2", 2, between.originalVerdict);
		append(
			store,
			runId,
			"budget",
			`budget:implementation-plan-recovery:binding-1:${secondAuth}`,
			recovery({
				runId,
				id: "recovery-2",
				authorizationId: secondAuth,
				parent: "text-1",
				beforeHash: hashPlanBytes(amended),
				bytes: secondBytes,
				phase: "2",
				contexts: ["ctx-obs-2"],
				observations: ["obs-2", "obs-2b"],
			}),
		);
		const historical = authority(store, runId);
		expect(historical.ok).toBe(true);
		if (!historical.ok) return;
		expect(historical.currentRevisionId).toBe("recovery-2");
		expect(historical.revisions.map((revision) => revision.kind)).toEqual([
			"initial",
			"legacy_frontier_recovery",
			"legacy_frontier_recovery",
		]);
		expect(historical.revisions[1]?.legacy).not.toBeNull();
		expect(historical.pinned).toMatchObject({ b0: 2, governingB: 4 });

		putRun(store, "run-completed", "completed");
		append(
			store,
			"run-completed",
			"budget",
			implementationBindingKey("run-completed"),
			{
				kind: "implementation-binding",
				version: 1,
				id: "binding-completed",
				executionRunId: "run-completed",
				sourceRunId: "source-run",
				sourceSnapshotId: "snapshot-1",
				sourceBaselineId: "baseline-1",
				approvedPlanCommit: COMMIT,
				approvedPlanHash: approvedHash,
				approvedPlanBytes: PLAN,
				b0: 2,
				governingB: 4,
				mode: "advisory",
				thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
				ledger: ledgerOf(PLAN),
				effectiveDecisions: [],
				phaseMap: [{ id: "1", heading: "Foundation" }],
				debtTargets: [],
				ledgerHash: "ledger",
				decisionsHash: "decisions",
				createdAt: "2026-10-19T00:00:00.000Z",
			},
		);
		putRun(store, "run-aborted", "aborted");
		append(
			store,
			"run-aborted",
			"budget",
			implementationBindingKey("run-aborted"),
			{
				kind: "implementation-binding",
				version: 1,
				id: "binding-aborted",
				executionRunId: "run-aborted",
				sourceRunId: "source-run",
				sourceSnapshotId: "snapshot-1",
				sourceBaselineId: "baseline-1",
				approvedPlanCommit: COMMIT,
				approvedPlanHash: approvedHash,
				approvedPlanBytes: PLAN,
				b0: 2,
				governingB: 4,
				mode: "advisory",
				thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
				ledger: ledgerOf(PLAN),
				effectiveDecisions: [],
				phaseMap: [
					{ id: "1", heading: "Foundation" },
					{ id: "2", heading: "Providers" },
				],
				debtTargets: [],
				ledgerHash: "ledger",
				decisionsHash: "decisions",
				createdAt: "2026-10-19T00:00:00.000Z",
			},
		);
		append(
			store,
			"run-aborted",
			"budget",
			"budget:implementation-plan-recovery:binding-aborted",
			recovery({
				runId: "run-aborted",
				id: "recovery-bad",
				authorizationId: firstAuth,
				parent: null,
				beforeHash: "sha256:not-the-binding",
				bytes: amended,
				phase: "2",
				contexts: [],
				observations: [],
				bindingId: "binding-aborted",
			}),
		);
		const budgetBefore = store
			.listLines(runId, "budget")
			.map((line) => line.idempotencyKey);
		const firstReport = await discoverLegacyRecoveryLineage({
			recordStore: store,
		});
		const secondReport = await discoverLegacyRecoveryLineage({
			recordStore: store,
		});
		expect(secondReport).toEqual(firstReport);
		expect(
			store.listLines(runId, "budget").map((line) => line.idempotencyKey),
		).toEqual(budgetBefore);
		expect(firstReport.resumed).toBe(false);
		expect(firstReport.journalRewritten).toBe(false);
		expect(firstReport.syntheticApproval).toBe(false);
		expect(firstReport.scanned).toMatchObject({
			active: 1,
			completed: 1,
			aborted: 1,
		});
		const active = firstReport.reports.find((report) => report.runId === runId);
		const aborted = firstReport.reports.find(
			(report) => report.runId === "run-aborted",
		);
		expect(
			firstReport.reports.some((report) => report.runId === "run-completed"),
		).toBe(false);
		expect(active).toMatchObject({
			source: "records",
			lineageValid: true,
			resumeCompatible: true,
			completionAuthorized: false,
			currentRevisionId: "recovery-2",
			recoveryIds: ["recovery-1", "recovery-2"],
		});
		expect(active?.history.map((entry) => entry.kind)).toEqual([
			"initial",
			"legacy_frontier_recovery",
			"legacy_frontier_recovery",
		]);
		expect(aborted).toMatchObject({
			lineageValid: false,
			resumeCompatible: false,
			completionAuthorized: false,
		});
		expect(aborted?.diagnostic?.message.length).toBeGreaterThan(0);

		const fingerprint = fingerprintImplementationVerdictItem(item("R9"), "2");
		const newDecision = createImplementationDecision({
			decisionId: "11111111-1111-4111-8111-111111111131",
			gateId: "gate-new",
			observationId: "obs-2b",
			bindingId: "binding-1",
			phase: "2",
			choice: "authorize_amendment",
			findingRefs: [{ findingId: "R9", fingerprint }],
			rationale: "New contract. The prose does not widen scope.",
			evidence: [],
			claimAdjustments: [],
			ledgerHash: "ledger",
			decisionsHash: "decisions",
			createdAt: "2026-10-19T00:00:00.000Z",
			amendmentScope: {
				predecessorRevisionId: "recovery-2",
				earliestAffectedPhase: "2",
				reopenCompletedPhases: false,
				claimEdits: [],
				resolutionRefs: [],
			},
		});
		append(store, runId, "decisions", newDecision.decisionId, newDecision);
		const humanKey = step(store, runId, "human:review-governance", "2", 3, {
			decisionId: newDecision.decisionId,
			gateId: newDecision.gateId,
			choice: "authorize_amendment",
		});
		step(store, runId, "author:process-plan-review", "plan", 1, {
			result: "complete",
			commit: COMMIT,
		});
		step(store, runId, "git:commit", "plan", 1, {
			hash: COMMIT,
			message: "review",
			files: ["docs/development/reviews/review.md"],
		});
		const approvalKey = step(store, runId, "reviewer:plan", "plan", 1, {
			readiness: "ready",
			items: [],
			governance: { route: "complete" },
			amendmentAssessment: {
				predecessorRevisionId: "recovery-2",
				reviewedPlanHash: hashPlanBytes(registeredBytes),
				earliestAffectedPhase: "2",
				preservedPhases: [{ phaseId: "1", reason: "phase section unchanged" }],
				resolvedFindings: [],
				claimEdits: [],
			},
		});
		createReviewBudgetStore(store).appendSnapshot({
			runId,
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 1,
			currentLedger: ledgerOf(registeredBytes),
			findings: [],
			assessments: [],
			effectiveGateCauses: [],
			origin,
		});
		const registered = await registerImplementationAmendment(
			{
				runId,
				humanStepKey: humanKey,
				approvalStepKey: approvalKey,
				fromPhase: "2",
				resolves: [],
				committedPlanBytes: registeredBytes,
				worktreePlanBytes: registeredBytes,
				approvedPlanCommit: COMMIT,
				boundaryCommit: COMMIT,
				headAccepted: true,
				unresolvedApprovalGate: false,
			},
			{ recordStore: store, origin, now: () => "2026-10-19T00:00:00.000Z" },
		);
		expect(registered.predecessorRevisionId).toBe("recovery-2");
		expect(registered.provenance.history.map((entry) => entry.id)).toEqual([
			"binding-1",
			"recovery-1",
			"recovery-2",
			registered.amendmentId,
		]);
		const after = authority(store, runId);
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.revisions.slice(0, 3)).toEqual(historical.revisions);
		expect(after.pinned).toEqual(historical.pinned);
		const replay = createMemoryRecordStore();
		const summary = store.getRun(runId);
		if (!summary) throw new Error("missing legacy run");
		replay.putRun(summary);
		for (const stream of ["budget", "steps", "decisions"] as const) {
			for (const line of store.listLines(runId, stream))
				replay.append({ ...line });
		}
		expect(authority(replay, runId)).toEqual(after);
	});
});

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().trim();
}

describe("legacy discovery without the source worktree", () => {
	test("reads committed recoveries after the worktree copy is removed and an index rebuild", async () => {
		const dir = mkdtempSync(join(tmpdir(), "5x-legacy-discovery-"));
		mkdirSync(join(dir, ".5x"), { recursive: true });
		const db = new Database(join(dir, ".5x", "5x.db"));
		try {
			git(["init"], dir);
			git(["config", "user.email", "test@test.com"], dir);
			git(["config", "user.name", "Test"], dir);
			writeFileSync(join(dir, ".gitignore"), ".5x/\n");
			mkdirSync(join(dir, "docs/development/plans"), { recursive: true });
			writeFileSync(
				join(dir, "docs/development/plans/legacy.md"),
				PLAN,
				"utf-8",
			);
			git(["add", "-A"], dir);
			git(["commit", "-m", "plan"], dir);

			const runId = "run-git-legacy";
			const records = createWorkingTreeRecordStore({
				recordsRoot: join(dir, "docs/development/runs"),
			});
			putRun(records, runId, "completed", "docs/development/plans/legacy.md");
			const approvedHash = hashPlanBytes(PLAN);
			append(records, runId, "budget", implementationBindingKey(runId), {
				kind: "implementation-binding",
				version: 1,
				id: "binding-git",
				executionRunId: runId,
				sourceRunId: "source-run",
				sourceSnapshotId: "snapshot-1",
				sourceBaselineId: "baseline-1",
				approvedPlanCommit: COMMIT,
				approvedPlanHash: approvedHash,
				approvedPlanBytes: PLAN,
				b0: 2,
				governingB: 4,
				mode: "advisory",
				thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
				ledger: ledgerOf(PLAN),
				effectiveDecisions: [],
				phaseMap: [
					{ id: "1", heading: "Foundation" },
					{ id: "2", heading: "Providers" },
				],
				debtTargets: [],
				ledgerHash: "ledger",
				decisionsHash: "decisions",
				createdAt: "2026-10-19T00:00:00.000Z",
			});
			append(
				records,
				runId,
				"budget",
				"ctx-obs-2",
				context(runId, "ctx-obs-2", "2", "binding-git"),
			);
			const phaseTwo = observation({
				runId,
				id: "obs-2",
				phase: "2",
				iteration: 1,
				items: [item("R7")],
				bindingId: "binding-git",
			});
			append(records, runId, "budget", "obs-2", phaseTwo);
			const auth = "11111111-1111-4111-8111-111111111141";
			append(
				records,
				runId,
				"decisions",
				auth,
				createImplementationDecision({
					decisionId: auth,
					gateId: "gate-git",
					observationId: "obs-2",
					bindingId: "binding-git",
					phase: "2",
					choice: "authorize_amendment",
					findingRefs: [
						{
							findingId: "R7",
							fingerprint: fingerprintImplementationVerdictItem(
								item("R7"),
								"2",
							),
						},
					],
					rationale: "historical",
					evidence: [],
					claimAdjustments: [],
					ledgerHash: "ledger",
					decisionsHash: "decisions",
					createdAt: "2026-10-19T00:00:00.000Z",
				}),
			);
			const bytes = PLAN.replace("[ ] Read digits", "[x] Read digits");
			append(
				records,
				runId,
				"budget",
				"budget:implementation-plan-recovery:binding-git",
				recovery({
					runId,
					id: "recovery-git",
					authorizationId: auth,
					parent: null,
					beforeHash: approvedHash,
					bytes,
					phase: "2",
					contexts: ["ctx-obs-2"],
					observations: ["obs-2"],
					bindingId: "binding-git",
				}),
			);
			const before = authority(records, runId);
			expect(before.ok).toBe(true);
			git(["add", "-A"], dir);
			git(["commit", "-m", "records"], dir);
			const budgetRel = `docs/development/runs/legacy/${runId}/budget.jsonl`;
			const budgetBytes = readFileSync(join(dir, budgetRel), "utf8");
			rmSync(join(dir, "docs/development/runs"), {
				recursive: true,
				force: true,
			});
			const commit = git(["rev-parse", "HEAD"], dir);
			const discovered = await discoverLegacyRecoveryLineage({
				recordStore: createWorkingTreeRecordStore({
					recordsRoot: join(dir, "docs/development/runs"),
				}),
				git: {
					commit,
					workdir: dir,
					recordsRelPath: "docs/development/runs",
				},
			});
			expect(discovered.journalRewritten).toBe(false);
			expect(discovered.syntheticApproval).toBe(false);
			expect(discovered.resumed).toBe(false);
			expect(discovered.reports).toEqual([
				expect.objectContaining({
					runId,
					status: "completed",
					source: "git",
					lineageValid: true,
					resumeCompatible: true,
					completionAuthorized: false,
					currentRevisionId: "recovery-git",
					recoveryIds: ["recovery-git"],
				}),
			]);
			expect(discovered.scanned.completed).toBe(1);
			db.exec("PRAGMA foreign_keys=ON");
			runMigrations(db);
			const { config } = await loadConfig(dir, undefined, undefined, dir);
			await rebuildRecordsIndex({
				db,
				workdir: dir,
				config,
				resolve: resolvePlanProgress,
			});
			expect(existsSync(join(dir, budgetRel))).toBe(false);
			expect(git(["show", `HEAD:${budgetRel}`], dir)).toBe(budgetBytes.trim());
			const again = await discoverLegacyRecoveryLineage({
				recordStore: createWorkingTreeRecordStore({
					recordsRoot: join(dir, "docs/development/runs"),
				}),
				git: {
					commit,
					workdir: dir,
					recordsRelPath: "docs/development/runs",
				},
			});
			expect(again.reports[0]?.currentRevisionId).toBe("recovery-git");
			expect(again.reports[0]?.history.map((entry) => entry.id)).toEqual([
				"binding-git",
				"recovery-git",
			]);
		} finally {
			try {
				db.close();
			} catch {
				/* already closed */
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
