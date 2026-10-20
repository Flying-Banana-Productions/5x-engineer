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
import type { AmendmentClaimEdit, VerdictItem } from "../../../src/protocol.js";
import { REVIEWER_PROTOCOL_HELP } from "../../../src/protocol-help.js";
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
import { createImplementationDecision } from "../../../src/review-governance/decisions.js";
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
	priorFindings?: Array<{
		id: string;
		status: "addressed" | "partially_addressed" | "still_open";
	}>;
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
			...(input.priorFindings ? { priorFindings: input.priorFindings } : {}),
		},
		outcomes: input.priorFindings ?? [],
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
	predecessorRevisionId?: string;
	earliestAffectedPhase?: string;
	claimEdits?: AmendmentClaimEdit[];
	resolutionRefs?: Array<{
		phase: string;
		observationId: string;
		findingId: string;
		fingerprint: string;
	}>;
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
						predecessorRevisionId: input.predecessorRevisionId ?? "binding-1",
						earliestAffectedPhase: input.earliestAffectedPhase ?? "2",
						reopenCompletedPhases: false,
						claimEdits: input.claimEdits ?? [],
						resolutionRefs: input.resolutionRefs ?? [],
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

function semanticAmendment(input: {
	bytes: string;
	authorizationId: string;
	beforeHash: string;
	preserved?: Array<{ phaseId: string; reason: string }>;
	resolvedFindings?: ImplementationSemanticAmendmentPayload["resolvedFindings"];
	claimEdits?: ImplementationSemanticAmendmentPayload["claimEdits"];
	earliestAffectedPhase?: string;
	invalidatedContextIds?: string[];
	invalidatedObservationIds?: string[];
}): ImplementationSemanticAmendmentPayload {
	return {
		kind: "implementation-plan-amendment",
		version: 1,
		id: "rev-1",
		bindingId: "binding-1",
		executionRunId: runId,
		predecessorRevisionId: "binding-1",
		authorizationId: input.authorizationId,
		humanStep: { idempotencyKey: "step:human" },
		approvalStep: { idempotencyKey: "step:approval" },
		parentLineageId: null,
		beforeCommit: COMMIT,
		afterCommit: COMMIT,
		beforeBlobHash: input.beforeHash,
		afterBlobHash: hashPlanBytes(input.bytes),
		approvedPlanCommit: COMMIT,
		approvedPlanHash: hashPlanBytes(input.bytes),
		approvedPlanBytes: input.bytes,
		earliestAffectedPhase: input.earliestAffectedPhase ?? "2",
		preservedPhases: input.preserved ?? [
			{ phaseId: "1", reason: "phase section unchanged" },
		],
		resolvedFindings: input.resolvedFindings ?? [],
		claimEdits: input.claimEdits ?? [],
		invalidatedContextIds: input.invalidatedContextIds ?? ["ctx-obs-2"],
		invalidatedObservationIds: input.invalidatedObservationIds ?? ["obs-2"],
		intentDigest: digest("register"),
		createdAt: "2026-10-19T00:00:00.000Z",
	};
}

function foldSemantic(input: {
	base?: string;
	amended: string;
	authorization: ReturnType<typeof decision>;
	observations?: ImplementationReviewObservationPayload[];
	contexts?: Array<ReturnType<typeof context>>;
	preserved?: Array<{ phaseId: string; reason: string }>;
	resolvedFindings?: ImplementationSemanticAmendmentPayload["resolvedFindings"];
	claimEdits?: ImplementationSemanticAmendmentPayload["claimEdits"];
	earliestAffectedPhase?: string;
	invalidatedContextIds?: string[];
	invalidatedObservationIds?: string[];
}) {
	const base = input.base ?? PLAN;
	const approved = binding(base);
	const contexts = input.contexts ?? [context("ctx-obs-2", "2")];
	const observations = input.observations ?? [
		observation({
			id: "obs-2",
			phase: "2",
			iteration: 1,
			items: [item("R7", "Providers")],
		}),
	];
	const payload = semanticAmendment({
		bytes: input.amended,
		authorizationId: input.authorization.decisionId,
		beforeHash: approved.approvedPlanHash,
		preserved: input.preserved,
		resolvedFindings: input.resolvedFindings,
		claimEdits: input.claimEdits,
		earliestAffectedPhase: input.earliestAffectedPhase,
		invalidatedContextIds: input.invalidatedContextIds,
		invalidatedObservationIds: input.invalidatedObservationIds,
	});
	return foldEffectiveExecution({
		recordStore: storeWith({
			budget: [
				{ key: implementationBindingKey(runId), payload: approved },
				...contexts.map((entry) => ({ key: entry.id, payload: entry })),
				...observations.map((entry) => ({
					key: entry.id,
					payload: encodeImplementationReviewObservationPayload(entry),
				})),
				{
					key: "budget:implementation-plan-amendment:binding-1:rev-1",
					payload: encodeImplementationSemanticAmendmentPayload(payload),
				},
			],
			decisions: [
				{
					key: input.authorization.decisionId,
					payload: input.authorization,
				},
			],
		}),
		runId,
	});
}

function correction(id: string, observationId: string, phase: string) {
	return {
		kind: "implementation-correction-attempt" as const,
		version: 1 as const,
		id,
		runId,
		observationId,
		phase,
		bindingId: "binding-1",
		authorCommit: COMMIT,
		tree: "tree",
		qualityConfigDigest: digest("quality"),
		executionDirectory: "/tmp",
		outcome: "passed" as const,
		shortcutInvalidated: false,
		reason: "",
		qualityPassed: true,
		qualitySkipped: false,
		qualityTimedOut: false,
		qualityResults: [],
		architectureDelta: 0,
		boundaryChanges: [],
		changedPaths: [],
		inventoryClean: true,
		boundaryUncertain: false,
		sourceObservationId: observationId,
		assessedCommit: COMMIT,
		destinationCommit: COMMIT,
		carriedClaims: [],
		qualityRerun: 0,
		createdAt: "2026-10-19T00:00:00.000Z",
	};
}

function credit(id: string, observationId: string, phase: string) {
	return {
		kind: "implementation-credit-reconciliation" as const,
		version: 1 as const,
		id,
		runId,
		stepKey: { stepName: "reviewer:credit", phase, iteration: 1 },
		bindingId: "binding-1",
		observationId,
		phase,
		reviewedCommit: COMMIT,
		claims: [],
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
			realizedCredit: 0,
			budgetBand: "within_standard" as const,
			budgetAlerts: [],
			requiresHuman: false,
		},
		creditUnrealized: false,
		material: false,
		completionSatisfied: false,
		createdAt: "2026-10-19T00:00:00.000Z",
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

	test("rejects duplicate preserved phases, findings, and claim edits", () => {
		const payload = semanticAmendment({
			bytes: PLAN,
			authorizationId: "11111111-1111-4111-8111-111111111111",
			beforeHash: hashPlanBytes(PLAN),
			invalidatedContextIds: [],
			invalidatedObservationIds: [],
		});
		expect(() =>
			decodeImplementationSemanticAmendmentPayload({
				...payload,
				preservedPhases: [
					...payload.preservedPhases,
					...payload.preservedPhases,
				],
			}),
		).toThrow("preservedPhases repeats 1");
		const finding = {
			phase: "2",
			observationId: "obs-2",
			findingId: "R7",
			fingerprint: digest("finding"),
			reason: "scope",
		};
		expect(() =>
			decodeImplementationSemanticAmendmentPayload({
				...payload,
				resolvedFindings: [finding, { ...finding }],
			}),
		).toThrow("resolvedFindings repeats R7");
		const edit = { creditClaimId: "DC0", effect: "withdraw" as const };
		expect(() =>
			decodeImplementationSemanticAmendmentPayload({
				...payload,
				claimEdits: [edit, { ...edit }],
			}),
		).toThrow("claimEdits repeats DC0 withdraw");
	});

	test("tells reviewers to copy the predecessor and hash and to review the diff", () => {
		expect(REVIEWER_PROTOCOL_HELP).toContain(
			"predecessor revision and reviewed plan hash",
		);
		expect(REVIEWER_PROTOCOL_HELP).toContain("review the plan diff");
		expect(REVIEWER_PROTOCOL_HELP).not.toContain(
			"reviewed plan hash, and plan diff",
		);
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
			folded.findings.find((finding) => finding.findingId === "R7"),
		).toBeUndefined();
		expect(
			folded.findings.find((finding) => finding.findingId === "R9"),
		).toMatchObject({
			status: "pending",
			observationId: "obs-2b",
			phase: "2",
		});
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-2b"),
		).toMatchObject({ applicability: "invalidated" });
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
			resolutionRefs: [
				{
					phase: "2",
					observationId: "obs-2",
					findingId: "R7",
					fingerprint,
				},
			],
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
		expect(prompt).toContain(
			"Copy the predecessor and hash into amendmentAssessment, and review the diff.",
		);
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

	test("preserves an earlier phase when only a shared design section changes", () => {
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111121",
			observationId: "obs-2",
			phase: "2",
			scope: true,
		});
		const folded = foldSemantic({
			amended: PLAN.replace(
				"Keep the binding.",
				"Keep the binding and the ledger.",
			),
			authorization,
		});
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(folded.currentRevisionId).toBe("rev-1");
		expect(folded.dispositions[0]?.preservedPhases).toEqual([
			{ phaseId: "1", reason: "phase section unchanged" },
		]);
	});

	test("rejects a preserved phase that changed beyond checkbox state", () => {
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111122",
			observationId: "obs-2",
			phase: "2",
			scope: true,
		});
		const folded = foldSemantic({
			amended: PLAN.replace("- [ ] Stable types", "- [ ] Stable contracts"),
			authorization,
		});
		expect(folded.ok).toBe(false);
		if (folded.ok) return;
		expect(folded.diagnostic.message).toContain(
			"Preserved phase 1 changed beyond checkbox state.",
		);
	});

	test("rejects a changed linked claim contract on a preserved phase", () => {
		const claimPlan = PLAN.replace(
			"| W1 | Foundation | 2 | 0 | - | - | Required |",
			[
				"| W1 | Foundation | 2 | 0 | - | - | Required |",
				"| W2 | Claim | 2 | -1 | DC0 (`intrinsic`) | - | Credit |",
			].join("\n"),
		).replace(
			"### Surface Snapshot",
			[
				"### Debt Claims",
				"",
				"#### DC0",
				"",
				"- Target phase: 1",
				"- Minimal-compliant effort delta: 0",
				"- Minimal-compliant architecture delta: 0",
				"- Before: two parsers",
				"- After: one parser",
				"",
				"### Surface Snapshot",
			].join("\n"),
		);
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111123",
			observationId: "obs-2",
			phase: "2",
			scope: true,
		});
		const folded = foldSemantic({
			base: claimPlan,
			amended: claimPlan.replace(
				"| W2 | Claim | 2 | -1 | DC0 (`intrinsic`) | - | Credit |",
				"| W2 | Claim | 3 | -1 | DC0 (`intrinsic`) | - | Credit |",
			),
			authorization,
		});
		expect(folded.ok).toBe(false);
		if (folded.ok) return;
		expect(folded.diagnostic.message).toContain(
			"Preserved phase 1 changed a linked claim contract.",
		);
	});

	test("rejects a changed work-item contract named by a preserved phase", () => {
		const named = PLAN.replace(
			"## Phase 1: Foundation",
			"## Phase 1: Foundation (W1)",
		);
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111124",
			observationId: "obs-2",
			phase: "2",
			scope: true,
		});
		const folded = foldSemantic({
			base: named,
			amended: named.replace(
				"| W1 | Foundation | 2 | 0 | - | - | Required |",
				"| W1 | Foundation | 8 | 3 | - | - | Expanded |",
			),
			authorization,
		});
		expect(folded.ok).toBe(false);
		if (folded.ok) return;
		expect(folded.diagnostic.message).toContain(
			"Preserved phase 1 changed a linked work-item contract.",
		);
	});

	test("rejects a semantic amendment outside the consumed amendmentScope", () => {
		const resolved = item("R7", "Providers");
		const fingerprint = fingerprintImplementationVerdictItem(resolved, "2");
		const resolvedFinding = {
			phase: "2",
			observationId: "obs-2",
			findingId: "R7",
			fingerprint,
			reason: "scope changed",
		};
		const observations = [
			observation({
				id: "obs-2",
				phase: "2",
				iteration: 1,
				items: [resolved],
			}),
		];
		const amended = PLAN.replace("Read digits", "Honor offsets");
		const predecessor = foldSemantic({
			amended,
			observations,
			authorization: decision({
				id: "11111111-1111-4111-8111-111111111125",
				observationId: "obs-2",
				phase: "2",
				scope: true,
				predecessorRevisionId: "some-other-revision",
			}),
		});
		expect(predecessor.ok).toBe(false);
		if (!predecessor.ok) {
			expect(predecessor.diagnostic.message).toContain(
				"does not match amendment predecessor binding-1",
			);
		}
		const boundary = foldSemantic({
			amended,
			observations,
			authorization: decision({
				id: "11111111-1111-4111-8111-111111111126",
				observationId: "obs-2",
				phase: "2",
				scope: true,
				earliestAffectedPhase: "3",
			}),
		});
		expect(boundary.ok).toBe(false);
		if (!boundary.ok) {
			expect(boundary.diagnostic.message).toContain(
				"Amendment boundary 2 is earlier than authorized phase 3.",
			);
		}
		const claim = foldSemantic({
			amended,
			observations,
			authorization: decision({
				id: "11111111-1111-4111-8111-111111111127",
				observationId: "obs-2",
				phase: "2",
				scope: true,
			}),
			claimEdits: [{ creditClaimId: "DC0", effect: "withdraw" }],
		});
		expect(claim.ok).toBe(false);
		if (!claim.ok) {
			expect(claim.diagnostic.message).toContain(
				"Claim edit DC0 withdraw is outside amendmentScope.",
			);
		}
		const finding = foldSemantic({
			amended,
			observations,
			authorization: decision({
				id: "11111111-1111-4111-8111-111111111128",
				observationId: "obs-2",
				phase: "2",
				scope: true,
			}),
			resolvedFindings: [resolvedFinding],
		});
		expect(finding.ok).toBe(false);
		if (!finding.ok) {
			expect(finding.diagnostic.message).toContain(
				"Resolved finding R7 is outside amendmentScope.",
			);
		}
	});

	test("keeps one original finding identity and applies amendment resolution", () => {
		const r1 = item("R1", "first");
		const r2 = item("R2", "second");
		const r4 = item("R4", "original wording");
		const r5 = item("R5", "partial");
		const r2Fingerprint = fingerprintImplementationVerdictItem(r2, "1");
		const r4Fingerprint = fingerprintImplementationVerdictItem(r4, "1");
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111129",
			observationId: "obs-b",
			phase: "1",
			scope: true,
			resolutionRefs: [
				{
					phase: "1",
					observationId: "obs-a",
					findingId: "R2",
					fingerprint: r2Fingerprint,
				},
			],
		});
		const folded = foldSemantic({
			amended: PLAN.replace("Read digits", "Honor offsets"),
			authorization,
			contexts: [],
			observations: [
				observation({
					id: "obs-a",
					phase: "1",
					iteration: 1,
					items: [r1, r2, r4, r5],
				}),
				observation({
					id: "obs-b",
					phase: "1",
					iteration: 2,
					items: [item("R3", "third"), item("R4", "reworded later")],
					priorFindings: [
						{ id: "R1", status: "addressed" },
						{ id: "R2", status: "still_open" },
						{ id: "R4", status: "still_open" },
						{ id: "R5", status: "partially_addressed" },
					],
				}),
			],
			invalidatedContextIds: [],
			invalidatedObservationIds: [],
			resolvedFindings: [
				{
					phase: "1",
					observationId: "obs-a",
					findingId: "R2",
					fingerprint: r2Fingerprint,
					reason: "scope changed",
				},
			],
		});
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(folded.findings).toHaveLength(4);
		expect(folded.findings.map((finding) => finding.findingId).sort()).toEqual([
			"R2",
			"R3",
			"R4",
			"R5",
		]);
		expect(
			folded.findings.find((finding) => finding.findingId === "R1"),
		).toBeUndefined();
		expect(
			folded.findings.filter((finding) => finding.findingId === "R4"),
		).toHaveLength(1);
		expect(
			folded.findings.find((finding) => finding.findingId === "R4"),
		).toMatchObject({
			observationId: "obs-a",
			fingerprint: r4Fingerprint,
			status: "pending",
		});
		expect(
			folded.findings.find((finding) => finding.findingId === "R2"),
		).toMatchObject({
			observationId: "obs-a",
			fingerprint: r2Fingerprint,
			status: "amendment_resolved",
			reason: "scope changed",
		});
		expect(
			folded.findings.find((finding) => finding.findingId === "R5"),
		).toMatchObject({ observationId: "obs-a", status: "pending" });
		expect(
			folded.findings.find((finding) => finding.findingId === "R3"),
		).toMatchObject({ observationId: "obs-b", status: "pending" });
	});

	test("labels corrections and credits invalidated with their observation", () => {
		const approved = binding();
		const amended = PLAN.replace("[ ] Read digits", "[x] Read digits");
		const kept = item("R7", "Providers");
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
			items: [kept],
			completionAuthorized: true,
		});
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111130",
			observationId: "obs-2",
			phase: "2",
		});
		const recovered = recovery({
			id: "recovery-1",
			authorizationId: authorization.decisionId,
			parent: null,
			beforeHash: approved.approvedPlanHash,
			beforeCommit: approved.approvedPlanCommit,
			bytes: amended,
			phase: "2",
			contexts: ["ctx-obs-2"],
			observations: ["obs-2"],
		});
		const folded = foldEffectiveExecution({
			recordStore: storeWith({
				budget: [
					{ key: implementationBindingKey(runId), payload: approved },
					{ key: "ctx-1", payload: context("ctx-obs-1", "1") },
					{ key: "obs-1", payload: phaseOne },
					{ key: "corr-1", payload: correction("corr-1", "obs-1", "1") },
					{ key: "credit-1", payload: credit("credit-1", "obs-1", "1") },
					{ key: "ctx-2", payload: context("ctx-obs-2", "2") },
					{ key: "obs-2", payload: phaseTwo },
					{ key: "corr-2", payload: correction("corr-2", "obs-2", "2") },
					{ key: "credit-2", payload: credit("credit-2", "obs-2", "2") },
					{
						key: "budget:implementation-plan-recovery:binding-1",
						payload: recovered,
					},
				],
				decisions: [{ key: authorization.decisionId, payload: authorization }],
			}),
			runId,
		});
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(
			folded.evidence.find((entry) => entry.recordId === "corr-1"),
		).toMatchObject({ applicability: "applicable", certifies: true });
		expect(
			folded.evidence.find((entry) => entry.recordId === "credit-1"),
		).toMatchObject({ applicability: "applicable", certifies: true });
		expect(
			folded.evidence.find((entry) => entry.recordId === "corr-2"),
		).toMatchObject({ applicability: "invalidated", certifies: false });
		expect(
			folded.evidence.find((entry) => entry.recordId === "credit-2"),
		).toMatchObject({ applicability: "invalidated", certifies: false });
		expect(
			folded.evidence.find(
				(entry) => entry.recordId === authorization.decisionId,
			),
		).toMatchObject({ applicability: "invalidated" });
		expect(
			folded.findings.find((finding) => finding.findingId === "R7"),
		).toMatchObject({
			status: "pending",
			observationId: "obs-2",
			fingerprint: fingerprintImplementationVerdictItem(kept, "2"),
		});
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-2"),
		).toMatchObject({ applicability: "invalidated", certifies: false });
	});

	test("keeps an invalidated finding that a later round still carries", () => {
		const kept = item("R7", "Providers");
		const fingerprint = fingerprintImplementationVerdictItem(kept, "2");
		const approved = binding();
		const amended = PLAN.replace("Read digits", "Honor offsets");
		const authorization = decision({
			id: "11111111-1111-4111-8111-111111111131",
			observationId: "obs-2",
			phase: "2",
		});
		const recovered = recovery({
			id: "recovery-1",
			authorizationId: authorization.decisionId,
			parent: null,
			beforeHash: approved.approvedPlanHash,
			beforeCommit: approved.approvedPlanCommit,
			bytes: amended,
			phase: "2",
			contexts: ["ctx-obs-2"],
			observations: ["obs-2"],
		});
		const folded = foldEffectiveExecution({
			recordStore: storeWith({
				budget: [
					{ key: implementationBindingKey(runId), payload: approved },
					{ key: "ctx-2", payload: context("ctx-obs-2", "2") },
					{
						key: "obs-2",
						payload: observation({
							id: "obs-2",
							phase: "2",
							iteration: 1,
							items: [kept],
						}),
					},
					{
						key: "budget:implementation-plan-recovery:binding-1",
						payload: recovered,
					},
					{
						key: "obs-2b",
						payload: observation({
							id: "obs-2b",
							phase: "2",
							iteration: 2,
							items: [item("R9", "Between")],
							priorFindings: [{ id: "R7", status: "still_open" }],
						}),
					},
				],
				decisions: [{ key: authorization.decisionId, payload: authorization }],
			}),
			runId,
		});
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(
			folded.findings.find((finding) => finding.findingId === "R7"),
		).toMatchObject({
			status: "pending",
			observationId: "obs-2",
			fingerprint,
			phase: "2",
		});
		expect(
			folded.findings.find((finding) => finding.findingId === "R9"),
		).toMatchObject({ observationId: "obs-2b", status: "pending" });
		expect(
			folded.evidence.find((entry) => entry.recordId === "obs-2"),
		).toMatchObject({ applicability: "invalidated" });
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
			"sha256:24fe14675ecc9e06fe62893ac3cea7a2d8e9a8021d13490d98f41aa7d2d7d862",
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
