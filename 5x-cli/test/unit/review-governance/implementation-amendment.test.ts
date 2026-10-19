import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	createMemoryRecordStore,
	type RecordOrigin,
	type RecordStore,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import type { VerdictItem } from "../../../src/protocol.js";
import {
	decodeImplementationReviewObservationPayload,
	decodeImplementationSemanticAmendmentPayload,
	encodeImplementationReviewObservationPayload,
	encodeImplementationSemanticAmendmentPayload,
	type ImplementationBindingPayload,
	type ImplementationPlanRecoveryPayload,
	type ImplementationReviewObservationPayload,
	type ImplementationSemanticAmendmentPayload,
	implementationBindingKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	computeImplementationDecisionIntentHash,
	createImplementationDecision,
} from "../../../src/review-governance/decisions.js";
import { fingerprintImplementationVerdictItem } from "../../../src/review-governance/fingerprint.js";
import {
	foldEffectiveExecution,
	formatAmendmentReviewPromptContext,
	initialRevisionId,
	verifyAmendmentAssessment,
} from "../../../src/review-governance/implementation-amendment.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "human", role: "operator" },
};
const runId = "run-amend";
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

function digest(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function item(id: string, failure: string): VerdictItem {
	return {
		id,
		title: id,
		action: "human_required",
		reason: failure,
		priority: "P1",
		scopeClass: "implementation_defect",
		planWorkItemIds: ["W1"],
		effortDelta: 1,
		architectureDelta: 0,
		estimateConfidence: "high",
		failure,
		lowestCostCorrection: "Amend the plan",
	};
}

function binding(bytes = PLAN): ImplementationBindingPayload {
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: runId,
		sourceRunId: "source-run",
		sourceSnapshotId: "snapshot-1",
		sourceBaselineId: "baseline-1",
		approvedPlanCommit: COMMIT,
		approvedPlanHash: hashPlanBytes(bytes),
		approvedPlanBytes: bytes,
		b0: 2,
		governingB: 4,
		mode: "advisory",
		thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
		ledger: {
			estimateConfidence: "high",
			workItems: [],
			surface: {
				subsystems: 1,
				productionFiles: 1,
				persistentOrExternalBoundaries: 0,
			},
		},
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
	};
}

function observation(input: {
	id: string;
	phase: string;
	iteration: number;
	items?: VerdictItem[];
	completionAuthorized?: boolean;
	revisionId?: string;
}): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: input.id,
		runId,
		stepKey: {
			stepName: "reviewer:impl",
			phase: input.phase,
			iteration: input.iteration,
		},
		bindingId: "binding-1",
		contextId: `ctx-${input.id}`,
		domain: "implementation",
		phase: input.phase,
		originalVerdict: {
			readiness: "not_ready",
			items: input.items ?? [],
		},
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: input.items?.length ?? 0,
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
		...(input.revisionId ? { revisionId: input.revisionId } : {}),
		createdAt: "2026-10-19T00:00:00.000Z",
	};
}

function context(id: string, phase: string) {
	return {
		kind: "implementation-review-context" as const,
		version: 1 as const,
		id,
		executionRunId: runId,
		bindingId: "binding-1",
		phase,
		baseCommit: COMMIT,
		reviewedCommit: COMMIT,
		patchHash: digest(`patch-${id}`),
		excludedPaths: [],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-10-19T00:00:00.000Z",
	};
}

function recovery(input: {
	id: string;
	authorizationId: string;
	parent: string | null;
	beforeHash: string;
	beforeCommit: string;
	bytes: string;
	phase: string;
	contexts: string[];
	observations: string[];
}): ImplementationPlanRecoveryPayload {
	return {
		kind: "implementation-plan-recovery",
		version: 1,
		id: input.id,
		bindingId: "binding-1",
		executionRunId: runId,
		guardId: null,
		sourceObservationId: "obs-2",
		parentLineageId: input.parent,
		beforeCommit: input.beforeCommit,
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

function decision(input: {
	id: string;
	observationId: string;
	phase: string;
	scope?: boolean;
	fingerprint?: string;
}) {
	return createImplementationDecision({
		decisionId: input.id,
		gateId: `gate-${input.id}`,
		observationId: input.observationId,
		bindingId: "binding-1",
		phase: input.phase,
		choice: "authorize_amendment",
		findingRefs: [
			{
				findingId: "R7",
				fingerprint: input.fingerprint ?? digest("finding"),
			},
		],
		rationale: "Authorize the recorded scope only",
		evidence: [],
		claimAdjustments: [],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-10-19T00:00:00.000Z",
		...(input.scope
			? {
					amendmentScope: {
						predecessorRevisionId: "binding-1",
						earliestAffectedPhase: "2",
						reopenCompletedPhases: false,
						claimEdits: [],
						resolutionRefs: [],
					},
				}
			: {}),
	});
}

function storeWith(lines: {
	budget?: Array<{ key: string; payload: unknown }>;
	steps?: Array<{ key: string; payload: unknown }>;
	decisions?: Array<{ key: string; payload: unknown }>;
}): RecordStore {
	const store = createMemoryRecordStore();
	store.putRun({
		id: runId,
		plan_path: "plan.md",
		config_json: null,
		created_at: "2026-10-19T00:00:00.000Z",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "test",
		format_version: 1,
		creator: origin.recorder,
	});
	for (const line of lines.budget ?? []) {
		store.append({
			runId,
			stream: "budget",
			idempotencyKey: line.key,
			payload: line.payload,
			...recordedEnvelope(origin),
		});
	}
	for (const line of lines.steps ?? []) {
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: line.key,
			payload: line.payload,
			...recordedEnvelope(origin),
		});
	}
	for (const line of lines.decisions ?? []) {
		store.append({
			runId,
			stream: "decisions",
			idempotencyKey: line.key,
			payload: line.payload,
			...recordedEnvelope(origin),
		});
	}
	return store;
}

function step(
	name: string,
	phase: string,
	iteration: number,
	result: unknown = {},
) {
	return {
		key: stepIdempotencyKey({ runId, stepName: name, phase, iteration }),
		payload: {
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
		},
	};
}

describe("amendment codecs", () => {
	test("round-trips a semantic amendment and keeps omitted revisions absent", () => {
		const payload: ImplementationSemanticAmendmentPayload = {
			kind: "implementation-plan-amendment",
			version: 1,
			id: "rev-1",
			bindingId: "binding-1",
			executionRunId: runId,
			predecessorRevisionId: "binding-1",
			authorizationId: "11111111-1111-4111-8111-111111111111",
			humanStep: { idempotencyKey: "step:human" },
			approvalStep: { idempotencyKey: "step:approval" },
			parentLineageId: null,
			beforeCommit: COMMIT,
			afterCommit: COMMIT,
			beforeBlobHash: hashPlanBytes(PLAN),
			afterBlobHash: hashPlanBytes(PLAN),
			approvedPlanCommit: COMMIT,
			approvedPlanHash: hashPlanBytes(PLAN),
			approvedPlanBytes: PLAN,
			earliestAffectedPhase: "2",
			preservedPhases: [{ phaseId: "1", reason: "unchanged" }],
			resolvedFindings: [],
			claimEdits: [],
			invalidatedContextIds: [],
			invalidatedObservationIds: [],
			intentDigest: digest("intent"),
			createdAt: "2026-10-19T00:00:00.000Z",
		};
		expect(
			decodeImplementationSemanticAmendmentPayload(
				encodeImplementationSemanticAmendmentPayload(payload),
			),
		).toEqual(payload);
		expect(() =>
			decodeImplementationSemanticAmendmentPayload({ ...payload, version: 2 }),
		).toThrow("unsupported implementation-state version");
		const historical = observation({ id: "obs-1", phase: "1", iteration: 1 });
		const encoded = encodeImplementationReviewObservationPayload(historical);
		expect(encoded).not.toHaveProperty("revisionId");
		expect(decodeImplementationReviewObservationPayload(encoded)).toEqual(
			historical,
		);
		const qualified = observation({
			id: "obs-1",
			phase: "1",
			iteration: 1,
			revisionId: "binding-1",
		});
		expect(
			decodeImplementationReviewObservationPayload(
				encodeImplementationReviewObservationPayload(qualified),
			).revisionId,
		).toBe("binding-1");
	});
});

describe("effective revision fold", () => {
	test("attributes an old run to the initial revision without a synthetic assessment", () => {
		const approved = binding();
		const obs = observation({
			id: "obs-1",
			phase: "1",
			iteration: 1,
			items: [item("R1", "Still open")],
			completionAuthorized: true,
		});
		const folded = foldEffectiveExecution({
			recordStore: storeWith({
				budget: [
					{ key: implementationBindingKey(runId), payload: approved },
					{ key: "ctx-1", payload: context("ctx-obs-1", "1") },
					{
						key: "obs-1",
						payload: encodeImplementationReviewObservationPayload(obs),
					},
				],
				steps: [
					step("implementation:pre-author", "1", 1, {
						kind: "phase-author-admission",
						version: 1,
						bindingId: "binding-1",
						phase: "1",
						preAuthorCommit: COMMIT,
					}),
					step("phase:complete", "1", 2),
					step("git:commit", "1", 3),
				],
			}),
			runId,
		});
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(folded.currentRevisionId).toBe(initialRevisionId(approved.id));
		expect(folded.revisions).toHaveLength(1);
		expect(folded.dispositions).toEqual([]);
		expect(folded.pinned).toMatchObject({
			b0: 2,
			governingB: 4,
			mode: "advisory",
		});
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-1"),
		).toMatchObject({
			revisionId: "binding-1",
			applicability: "applicable",
			certifies: true,
		});
		expect(folded.findings).toEqual([
			expect.objectContaining({
				findingId: "R1",
				status: "pending",
				recordedRevisionId: "binding-1",
			}),
		]);
		expect(
			folded.evidence.find(
				(entry) => entry.kind === "implementation:pre-author",
			),
		).toMatchObject({ revisionId: "binding-1", applicability: "baseline" });
		expect(
			folded.evidence.some((entry) => entry.kind === "phase:complete"),
		).toBe(false);
	});

	test("folds repeated legacy recoveries and keeps evidence between boundaries", () => {
		const approved = binding();
		const amended = PLAN.replace("[ ] Read digits", "[x] Read digits");
		const first = recovery({
			id: "recovery-1",
			authorizationId: "11111111-1111-4111-8111-111111111112",
			parent: null,
			beforeHash: approved.approvedPlanHash,
			beforeCommit: approved.approvedPlanCommit,
			bytes: amended,
			phase: "2",
			contexts: ["ctx-obs-2"],
			observations: ["obs-2"],
		});
		const secondBytes = amended.replace(
			"[ ] Verify timestamps",
			"[x] Verify timestamps",
		);
		const second = recovery({
			id: "recovery-2",
			authorizationId: "11111111-1111-4111-8111-111111111113",
			parent: "text-1",
			beforeHash: hashPlanBytes(amended),
			beforeCommit: COMMIT,
			bytes: secondBytes,
			phase: "2",
			contexts: ["ctx-obs-2"],
			observations: ["obs-2", "obs-2b"],
		});
		const phaseOne = observation({
			id: "obs-1",
			phase: "1",
			iteration: 1,
			items: [item("R1", "Foundation")],
			completionAuthorized: true,
		});
		const phaseTwo = observation({
			id: "obs-2",
			phase: "2",
			iteration: 1,
			items: [item("R7", "Providers"), item("R8", "Kept")],
			completionAuthorized: true,
		});
		const between = observation({
			id: "obs-2b",
			phase: "2",
			iteration: 2,
			items: [item("R9", "Between")],
		});
		const records = storeWith({
			budget: [
				{ key: implementationBindingKey(runId), payload: approved },
				{ key: "ctx-1", payload: context("ctx-obs-1", "1") },
				{ key: "obs-1", payload: phaseOne },
				{ key: "ctx-2", payload: context("ctx-obs-2", "2") },
				{ key: "obs-2", payload: phaseTwo },
				{
					key: "budget:implementation-plan-recovery:binding-1",
					payload: first,
				},
				{
					key: "text-1",
					payload: {
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
					},
				},
				{ key: "obs-2b", payload: between },
				{
					key: "budget:implementation-plan-recovery:binding-1:11111111-1111-4111-8111-111111111113",
					payload: second,
				},
			],
			decisions: [
				{
					key: "decision-1",
					payload: decision({
						id: "11111111-1111-4111-8111-111111111112",
						observationId: "obs-2",
						phase: "2",
					}),
				},
				{
					key: "decision-2",
					payload: decision({
						id: "11111111-1111-4111-8111-111111111113",
						observationId: "obs-2",
						phase: "2",
					}),
				},
			],
			steps: [
				step("reviewer:impl", "2", 1, { readiness: "not_ready", items: [] }),
				step("human:review-governance", "2", 3, {
					decisionId: "11111111-1111-4111-8111-111111111112",
				}),
			],
		});
		const folded = foldEffectiveExecution({ recordStore: records, runId });
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(folded.revisions.map((revision) => revision.kind)).toEqual([
			"initial",
			"legacy_frontier_recovery",
			"legacy_frontier_recovery",
		]);
		expect(folded.revisions[1]?.amendmentAssessment).toBeNull();
		expect(folded.dispositions).toEqual([]);
		expect(folded.currentRevisionId).toBe("recovery-2");
		expect(folded.pinned.b0).toBe(2);
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-1"),
		).toMatchObject({
			revisionId: "binding-1",
			applicability: "applicable",
			certifies: true,
		});
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-2"),
		).toMatchObject({
			revisionId: "binding-1",
			applicability: "invalidated",
			certifies: false,
		});
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-2b"),
		).toMatchObject({ revisionId: "recovery-1", applicability: "invalidated" });
		expect(
			folded.evidence.find((entry) => entry.recordId === "text-1"),
		).toMatchObject({ revisionId: "recovery-1", applicability: "applicable" });
		expect(
			folded.findings.find((finding) => finding.findingId === "R7")?.status,
		).toBe("pending");
		expect(
			folded.evidence.find((entry) => entry.kind === "reviewer:impl"),
		).toMatchObject({ revisionId: "binding-1" });
		const earlier = foldEffectiveExecution({
			recordStore: records,
			runId,
			revisionId: "recovery-1",
		});
		expect(earlier.ok).toBe(true);
		if (!earlier.ok) return;
		expect(
			earlier.evidence.find((entry) => entry.recordId === "obs-2b"),
		).toMatchObject({ applicability: "applicable" });
		expect(earlier.evidence.some((entry) => entry.recordId === "obs-2b")).toBe(
			true,
		);
		expect(
			earlier.evidence.find((entry) => entry.recordId === "obs-2"),
		).toMatchObject({ applicability: "invalidated" });
	});

	test("rejects corrupt lineage and does not infer carry", () => {
		const approved = binding();
		const changed = PLAN.replace("Read digits", "Honor offsets");
		const renumbered = changed.replace("## Phase 2:", "## Phase 4:");
		const phaseTwo = observation({
			id: "obs-2",
			phase: "2",
			iteration: 1,
			items: [item("R7", "Providers"), item("R1", "Kept")],
		});
		const fingerprint = fingerprintImplementationVerdictItem(
			item("R7", "Providers"),
			"2",
		);
		const baseBudget = [
			{ key: implementationBindingKey(runId), payload: approved },
			{ key: "ctx-2", payload: context("ctx-obs-2", "2") },
			{ key: "obs-2", payload: phaseTwo },
		];
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111114",
			observationId: "obs-2",
			phase: "2",
			scope: true,
			fingerprint,
		});
		const historical = decision({
			id: "11111111-1111-4111-8111-111111111115",
			observationId: "obs-2",
			phase: "2",
		});
		const amendment = (
			bytes: string,
			preserved: Array<{ phaseId: string; reason: string }>,
			authorizationId = authorization.decisionId,
		): ImplementationSemanticAmendmentPayload => ({
			kind: "implementation-plan-amendment",
			version: 1,
			id: "rev-1",
			bindingId: "binding-1",
			executionRunId: runId,
			predecessorRevisionId: "binding-1",
			authorizationId,
			humanStep: { idempotencyKey: "step:human" },
			approvalStep: { idempotencyKey: "step:approval" },
			parentLineageId: null,
			beforeCommit: COMMIT,
			afterCommit: COMMIT,
			beforeBlobHash: approved.approvedPlanHash,
			afterBlobHash: hashPlanBytes(bytes),
			approvedPlanCommit: COMMIT,
			approvedPlanHash: hashPlanBytes(bytes),
			approvedPlanBytes: bytes,
			earliestAffectedPhase: "2",
			preservedPhases: preserved,
			resolvedFindings: [
				{
					phase: "2",
					observationId: "obs-2",
					findingId: "R7",
					fingerprint,
					reason: "scope changed",
				},
			],
			claimEdits: [],
			invalidatedContextIds: ["ctx-obs-2"],
			invalidatedObservationIds: ["obs-2"],
			intentDigest: digest("register"),
			createdAt: "2026-10-19T00:00:00.000Z",
		});
		const foldAmendment = (payload: unknown, decisions = [authorization]) =>
			foldEffectiveExecution({
				recordStore: storeWith({
					budget: [...baseBudget, { key: "amend-1", payload }],
					decisions: decisions.map((entry) => ({
						key: entry.decisionId,
						payload: entry,
					})),
				}),
				runId,
			});

		const wrongHash = amendment(changed, [
			{ phaseId: "1", reason: "unchanged" },
		]);
		wrongHash.beforeBlobHash = digest("wrong");
		expect(foldAmendment(wrongHash).ok).toBe(false);

		const forked = recovery({
			id: "recovery-a",
			authorizationId: historical.decisionId,
			parent: null,
			beforeHash: approved.approvedPlanHash,
			beforeCommit: COMMIT,
			bytes: changed,
			phase: "2",
			contexts: ["ctx-obs-2"],
			observations: ["obs-2"],
		});
		const fork = foldEffectiveExecution({
			recordStore: storeWith({
				budget: [
					...baseBudget,
					{
						key: "budget:implementation-plan-recovery:binding-1",
						payload: forked,
					},
					{
						key: "budget:implementation-plan-recovery:binding-1:other",
						payload: { ...forked, id: "recovery-b", parentLineageId: null },
					},
				],
				decisions: [
					{ key: historical.decisionId, payload: historical },
					{
						key: "other-decision",
						payload: decision({
							id: "11111111-1111-4111-8111-111111111116",
							observationId: "obs-2",
							phase: "2",
						}),
					},
				],
			}),
			runId,
		});
		expect(fork.ok).toBe(false);
		if (!fork.ok) expect(fork.diagnostic.recoveryIds).toContain("recovery-a");

		expect(
			foldAmendment(
				amendment(renumbered, [{ phaseId: "1", reason: "unchanged" }]),
			).ok,
		).toBe(false);
		expect(foldAmendment(amendment(changed, [])).ok).toBe(false);
		expect(
			foldAmendment(
				amendment(
					changed,
					[{ phaseId: "1", reason: "unchanged" }],
					historical.decisionId,
				),
				[historical],
			).ok,
		).toBe(false);

		const missing = foldEffectiveExecution({
			recordStore: storeWith({
				budget: baseBudget,
				decisions: [
					{
						key: "missing",
						payload: decision({
							id: "11111111-1111-4111-8111-111111111117",
							observationId: "missing-obs",
							phase: "2",
						}),
					},
				],
			}),
			runId,
		});
		expect(missing.ok).toBe(false);

		const collided = observation({
			id: "obs-2-copy",
			phase: "2",
			iteration: 1,
		});
		const collision = foldEffectiveExecution({
			recordStore: storeWith({
				budget: [...baseBudget, { key: "obs-copy", payload: collided }],
			}),
			runId,
		});
		expect(collision.ok).toBe(false);

		const unknown = foldAmendment({
			...amendment(changed, [{ phaseId: "1", reason: "unchanged" }]),
			version: 2,
		});
		expect(unknown.ok).toBe(false);
	});

	test("registers explicit carry and resolves only the qualified finding", () => {
		const approved = binding();
		const changed = PLAN.replace(
			"[ ] Stable types",
			"[x] Stable types",
		).replace("Read digits", "Honor offsets");
		const kept = item("R1", "Kept");
		const resolved = item("R7", "Providers");
		const fingerprint = fingerprintImplementationVerdictItem(resolved, "2");
		const phaseOne = observation({
			id: "obs-1",
			phase: "1",
			iteration: 1,
			items: [item("R2", "Foundation")],
			completionAuthorized: true,
		});
		const phaseTwo = observation({
			id: "obs-2",
			phase: "2",
			iteration: 1,
			items: [resolved, kept],
			completionAuthorized: true,
		});
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111118",
			observationId: "obs-2",
			phase: "2",
			scope: true,
			fingerprint,
		});
		const payload: ImplementationSemanticAmendmentPayload = {
			kind: "implementation-plan-amendment",
			version: 1,
			id: "rev-1",
			bindingId: "binding-1",
			executionRunId: runId,
			predecessorRevisionId: "binding-1",
			authorizationId: authorization.decisionId,
			humanStep: { idempotencyKey: "step:human" },
			approvalStep: { idempotencyKey: "step:approval" },
			parentLineageId: null,
			beforeCommit: COMMIT,
			afterCommit: COMMIT,
			beforeBlobHash: approved.approvedPlanHash,
			afterBlobHash: hashPlanBytes(changed),
			approvedPlanCommit: COMMIT,
			approvedPlanHash: hashPlanBytes(changed),
			approvedPlanBytes: changed,
			earliestAffectedPhase: "2",
			preservedPhases: [{ phaseId: "1", reason: "section unchanged" }],
			resolvedFindings: [
				{
					phase: "2",
					observationId: "obs-2",
					findingId: "R7",
					fingerprint,
					reason: "withdrawn with the scope",
				},
			],
			claimEdits: [],
			invalidatedContextIds: ["ctx-obs-2"],
			invalidatedObservationIds: ["obs-2"],
			intentDigest: digest("register"),
			createdAt: "2026-10-19T00:00:00.000Z",
		};
		const records = storeWith({
			budget: [
				{ key: implementationBindingKey(runId), payload: approved },
				{ key: "ctx-1", payload: context("ctx-obs-1", "1") },
				{ key: "obs-1", payload: phaseOne },
				{ key: "ctx-2", payload: context("ctx-obs-2", "2") },
				{ key: "obs-2", payload: phaseTwo },
				{
					key: "budget:implementation-plan-amendment:binding-1:rev-1",
					payload: encodeImplementationSemanticAmendmentPayload(payload),
				},
			],
			decisions: [{ key: authorization.decisionId, payload: authorization }],
		});
		const folded = foldEffectiveExecution({ recordStore: records, runId });
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(folded.currentRevisionId).toBe("rev-1");
		expect(folded.revisions[1]?.amendmentAssessment).toBeNull();
		expect(folded.dispositions[0]?.resolvedFindings).toHaveLength(1);
		expect(
			folded.findings.find((finding) => finding.findingId === "R7"),
		).toMatchObject({ status: "amendment_resolved" });
		expect(
			folded.findings.find((finding) => finding.findingId === "R1"),
		).toMatchObject({ status: "pending" });
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-1"),
		).toMatchObject({ applicability: "applicable", certifies: true });
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-2"),
		).toMatchObject({ applicability: "invalidated", certifies: false });
		const otherPhase = verifyAmendmentAssessment({
			assessment: {
				predecessorRevisionId: "binding-1",
				reviewedPlanHash: hashPlanBytes(changed),
				earliestAffectedPhase: "2",
				preservedPhases: [{ phaseId: "1", reason: "unchanged" }],
				resolvedFindings: [
					{
						phase: "1",
						observationId: "obs-1",
						findingId: "R7",
						fingerprint,
						reason: "wrong phase",
					},
				],
				claimEdits: [],
			},
			predecessorRevisionId: "binding-1",
			reviewedPlanHash: hashPlanBytes(changed),
			observations: [
				{
					id: "obs-2",
					phase: "2",
					items: [{ findingId: "R7", fingerprint }],
				},
			],
		});
		expect(otherPhase.ok).toBe(false);
		const prompt = formatAmendmentReviewPromptContext({
			predecessorRevisionId: "binding-1",
			reviewedPlanHash: hashPlanBytes(changed),
			planDiff: "diff --git a/plan.md b/plan.md\n+Honor offsets",
		});
		expect(prompt).toContain("binding-1");
		expect(prompt).toContain(hashPlanBytes(changed));
		expect(prompt).toContain("Honor offsets");
		const budget = createReviewBudgetStore(records);
		expect(budget.readEffectiveImplementationRevision(runId)).toMatchObject({
			ok: true,
			currentRevisionId: "rev-1",
		});
		expect(
			budget.listImplementationSemanticAmendments(runId, "binding-1"),
		).toHaveLength(1);
		const empty = createMemoryRecordStore();
		empty.putRun({
			id: runId,
			plan_path: "plan.md",
			config_json: null,
			created_at: "2026-10-19T00:00:00.000Z",
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: "test",
			format_version: 1,
			creator: origin.recorder,
		});
		expect(
			createReviewBudgetStore(empty).readEffectiveImplementationRevision(runId),
		).toBeNull();
	});
});

describe("former-contract decision hashes", () => {
	test("omitted amendmentScope keeps the historical intent hash", () => {
		const historical = decision({
			id: "11111111-1111-4111-8111-111111111119",
			observationId: "obs-2",
			phase: "2",
		});
		expect(historical.amendmentScope).toBeUndefined();
		expect(JSON.stringify(historical)).not.toContain("amendmentScope");
		expect(historical.decisionIntentHash).toBe(
			computeImplementationDecisionIntentHash({
				kind: historical.kind,
				version: historical.version,
				gateId: historical.gateId,
				observationId: historical.observationId,
				bindingId: historical.bindingId,
				phase: historical.phase,
				domain: historical.domain,
				choice: historical.choice,
				findingRefs: historical.findingRefs,
				rationale: historical.rationale,
				evidence: historical.evidence,
				claimAdjustments: historical.claimAdjustments,
				ledgerHash: historical.ledgerHash,
				decisionsHash: historical.decisionsHash,
				supersedesDecisionId: historical.supersedesDecisionId,
			}),
		);
		const scoped = decision({
			id: "11111111-1111-4111-8111-111111111120",
			observationId: "obs-2",
			phase: "2",
			scope: true,
		});
		expect(scoped.decisionIntentHash).not.toBe(historical.decisionIntentHash);
		expect(() =>
			createImplementationDecision({
				gateId: "gate",
				observationId: "obs-2",
				bindingId: "binding-1",
				phase: "2",
				choice: "defer_accept_risk",
				findingRefs: [{ findingId: "R1", fingerprint: digest("r1") }],
				rationale: "not scope",
				evidence: ["kept"],
				claimAdjustments: [],
				ledgerHash: "ledger",
				decisionsHash: "decisions",
				amendmentScope: scoped.amendmentScope,
			}),
		).toThrow("only valid on authorize_amendment");
	});
});
