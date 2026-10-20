import { describe, expect, test } from "bun:test";
import {
	createMemoryRecordStore,
	type RecordOrigin,
	RecordStoreError,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import type {
	AmendmentAssessment,
	VerdictItem,
} from "../../../src/protocol.js";
import { parseAmendmentScope } from "../../../src/protocol.js";
import type { ImplementationReviewObservationPayload } from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import { createImplementationDecision } from "../../../src/review-governance/decisions.js";
import { fingerprintImplementationVerdictItem } from "../../../src/review-governance/fingerprint.js";
import {
	foldEffectiveExecution,
	prepareAuthorizeAmendmentScope,
	registerImplementationAmendment,
} from "../../../src/review-governance/implementation-amendment.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "human", role: "operator" },
};
const runId = "run-amend";
const COMMIT = "a".repeat(40);
const PRIOR = "b".repeat(40);
const decisionId = "11111111-1111-4111-8111-111111111111";

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

function ledger(text: string) {
	const parsed = parseDeliveryBudget(text);
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.value;
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

function claimPlan(text = PLAN) {
	return text
		.replace(
			"| W1 | Foundation | 2 | 0 | - | - | Required |",
			[
				"| W1 | Foundation | 2 | 0 | - | - | Required |",
				"| W2 | Claim | 2 | -1 | DC0 (`intrinsic`) | - | Credit |",
			].join("\n"),
		)
		.replace(
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
				"### Surface Snapshot",
			].join("\n"),
		);
}

function world(options?: {
	base?: string;
	amended?: string;
	fromPhase?: string;
	reopen?: boolean;
	claimEdits?: AmendmentAssessment["claimEdits"];
	resolved?: AmendmentAssessment["resolvedFindings"];
	scopeResolutions?: Array<{
		phase: string;
		observationId: string;
		findingId: string;
		fingerprint: string;
	}>;
	scopeClaims?: AmendmentAssessment["claimEdits"];
	earliestAuthorized?: string;
	predecessor?: string;
	omitScope?: boolean;
	rationale?: string;
	humanStepName?: string;
	humanChoice?: string;
	phaseComplete?: string[];
	otherPhaseFinding?: boolean;
	decisionId?: string;
	headAccepted?: boolean;
	worktree?: string;
	unresolvedApprovalGate?: boolean;
}) {
	const base = options?.base ?? PLAN;
	const amended =
		options?.amended ?? base.replace("Read digits", "Honor offsets");
	const fromPhase = options?.fromPhase ?? "2";
	const source = item("R1", "Providers");
	const fingerprint = fingerprintImplementationVerdictItem(source, "2");
	const other = item("R7", "Elsewhere");
	const otherFingerprint = fingerprintImplementationVerdictItem(other, "3");
	const preserved =
		fromPhase === "1"
			? []
			: [{ phaseId: "1", reason: "phase section unchanged" }];
	const assessment: AmendmentAssessment = {
		predecessorRevisionId: options?.predecessor ?? "binding-1",
		reviewedPlanHash: hashPlanBytes(amended),
		earliestAffectedPhase: fromPhase,
		preservedPhases: preserved,
		resolvedFindings: options?.resolved ?? [],
		claimEdits: options?.claimEdits ?? [],
	};
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
	const append = (
		stream: "budget" | "steps" | "decisions",
		key: string,
		payload: unknown,
	) =>
		store.append({
			runId,
			stream,
			idempotencyKey: key,
			payload,
			...recordedEnvelope(origin),
		});
	const step = (
		name: string,
		phase: string,
		iteration: number,
		result: unknown,
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
	};
	const observation = (
		id: string,
		phase: string,
		iteration: number,
		finding: VerdictItem,
		causeFingerprint: string,
	): ImplementationReviewObservationPayload => ({
		kind: "implementation-review",
		version: 1,
		id,
		runId,
		stepKey: { stepName: "reviewer:impl", phase, iteration },
		bindingId: "binding-1",
		contextId: `ctx-${id}`,
		domain: "implementation",
		phase,
		originalVerdict: { readiness: "not_ready", items: [finding] },
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [
			{
				kind: "plan_amendment",
				findingId: finding.id,
				fingerprint: causeFingerprint,
			},
		],
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
	const parsedBase = ledger(base);
	append("budget", `budget:implementation-binding:${runId}`, {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: runId,
		sourceRunId: "source-run",
		sourceSnapshotId: "snapshot-1",
		sourceBaselineId: "baseline-1",
		approvedPlanCommit: PRIOR,
		approvedPlanHash: hashPlanBytes(base),
		approvedPlanBytes: base,
		b0: 2,
		governingB: 4,
		mode: "advisory",
		thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
		ledger: parsedBase,
		effectiveDecisions: [],
		phaseMap: [
			{ id: "1", heading: "Foundation" },
			{ id: "2", heading: "Providers" },
			{ id: "3", heading: "Verification" },
		],
		debtTargets: parsedBase.workItems.flatMap((workItem) =>
			workItem.debtClaim
				? [
						{
							claimId: workItem.debtClaim.debtClaimId,
							sourceLabel: workItem.id,
							phaseId: "2",
						},
					]
				: [],
		),
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
		baseCommit: PRIOR,
		reviewedCommit: COMMIT,
		patchHash: hashPlanBytes("patch"),
		excludedPaths: ["docs/development/runs"],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-10-19T00:00:00.000Z",
	});
	const sourceObservation = observation("obs-2", "2", 0, source, fingerprint);
	append("budget", "obs-2", sourceObservation);
	if (options?.otherPhaseFinding) {
		append(
			"budget",
			"obs-3",
			observation("obs-3", "3", 0, other, otherFingerprint),
		);
		append("budget", "ctx-obs-3", {
			kind: "implementation-review-context",
			version: 1,
			id: "ctx-obs-3",
			executionRunId: runId,
			bindingId: "binding-1",
			phase: "3",
			baseCommit: PRIOR,
			reviewedCommit: COMMIT,
			patchHash: hashPlanBytes("patch-3"),
			excludedPaths: [],
			hunks: [],
			binaryPaths: [],
			createdAt: "2026-10-19T00:00:00.000Z",
		});
	}
	step("reviewer:impl", "2", 0, sourceObservation.originalVerdict);
	const scope = options?.omitScope
		? undefined
		: {
				predecessorRevisionId: options?.predecessor ?? "binding-1",
				earliestAffectedPhase: options?.earliestAuthorized ?? "2",
				reopenCompletedPhases: options?.reopen ?? false,
				claimEdits: options?.scopeClaims ?? [],
				resolutionRefs: options?.scopeResolutions ?? [],
			};
	const decision = createImplementationDecision({
		decisionId: options?.decisionId ?? decisionId,
		gateId: "gate-1",
		observationId: "obs-2",
		bindingId: "binding-1",
		phase: "2",
		choice: "authorize_amendment",
		findingRefs: [{ findingId: "R1", fingerprint }],
		rationale: options?.rationale ?? "Authorize only the structured scope",
		evidence: [],
		claimAdjustments: [],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-10-19T00:00:00.000Z",
		...(scope ? { amendmentScope: scope } : {}),
	});
	append("decisions", decision.decisionId, decision);
	const humanKey = step(
		options?.humanStepName ?? "human:review-governance",
		"2",
		1,
		{
			decisionId: decision.decisionId,
			gateId: decision.gateId,
			choice: options?.humanChoice ?? "authorize_amendment",
		},
	);
	step("author:process-plan-review", "plan", 1, {
		result: "complete",
		commit: COMMIT,
	});
	const approvalKey = step("reviewer:plan", "plan", 1, {
		readiness: "ready",
		items: [],
		governance: { route: "complete" },
		amendmentAssessment: assessment,
	});
	for (const phase of options?.phaseComplete ?? []) {
		step("phase:complete", phase, 1, { phase });
	}
	createReviewBudgetStore(store).appendSnapshot({
		runId,
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: ledger(amended),
		findings: [],
		assessments: [],
		effectiveGateCauses: [],
		origin,
	});
	const input = {
		runId,
		humanStepKey: humanKey,
		approvalStepKey: approvalKey,
		fromPhase,
		resolves: [] as string[],
		committedPlanBytes: amended,
		worktreePlanBytes: options?.worktree ?? amended,
		approvedPlanCommit: COMMIT,
		boundaryCommit: COMMIT,
		headAccepted: options?.headAccepted ?? true,
		unresolvedApprovalGate: options?.unresolvedApprovalGate ?? false,
	};
	return {
		store,
		input,
		decision,
		fingerprint,
		otherFingerprint,
		assessment,
	};
}

function register(
	built: ReturnType<typeof world>,
	overrides: Partial<ReturnType<typeof world>["input"]> & {
		dryRun?: boolean;
	} = {},
) {
	return registerImplementationAmendment(
		{ ...built.input, ...overrides },
		{ recordStore: built.store, origin, now: () => "2026-10-19T00:00:00.000Z" },
	);
}

describe("amendment registration", () => {
	test("dry-run writes nothing and record is idempotent", () => {
		const built = world();
		const before = {
			steps: built.store.listLines(runId, "steps").length,
			budget: built.store.listLines(runId, "budget").length,
			decisions: built.store.listLines(runId, "decisions").length,
		};
		const preview = register(built, { dryRun: true });
		expect(preview.created).toBe(false);
		expect(preview.dryRun).toBe(true);
		expect(preview.completionAuthorized).toBe(false);
		expect(preview.nextAction).toBe("resume_author");
		expect(preview.preservedBinding).toMatchObject({
			id: "binding-1",
			b0: 2,
			governingB: 4,
			mode: "advisory",
		});
		expect(preview.authorizedScope.earliestAffectedPhase).toBe("2");
		expect(preview.assessedScope.earliestAffectedPhase).toBe("2");
		expect(preview.intersection.earliestAffectedPhase).toBe("2");
		expect(built.store.listLines(runId, "steps")).toHaveLength(before.steps);
		expect(built.store.listLines(runId, "budget")).toHaveLength(before.budget);
		expect(built.store.listLines(runId, "decisions")).toHaveLength(
			before.decisions,
		);
		const recorded = register(built);
		expect(recorded.created).toBe(true);
		expect(recorded.completionAuthorized).toBe(false);
		const again = register(built);
		expect(again.created).toBe(false);
		expect(again.amendmentId).toBe(recorded.amendmentId);
		expect(
			built.store
				.listLines(runId, "budget")
				.filter(
					(line) =>
						(line.payload as { kind?: string }).kind ===
						"implementation-plan-amendment",
				),
		).toHaveLength(1);
		const folded = foldEffectiveExecution({
			recordStore: built.store,
			runId,
		});
		expect(folded.ok).toBe(true);
		if (!folded.ok) return;
		expect(folded.pinned).toMatchObject({
			b0: 2,
			governingB: 4,
			mode: "advisory",
		});
		expect(folded.currentRevisionId).toBe(recorded.amendmentId);
		expect(folded.bindingId).toBe("binding-1");
	});

	test("a failed precondition leaves no receipt and the retry wins", () => {
		const built = world();
		const original = built.store.atomicAppendIfAllNew.bind(built.store);
		let armed = true;
		built.store.atomicAppendIfAllNew = (ops, keys) => {
			if (armed) {
				armed = false;
				throw new RecordStoreError(
					"RECORD_PRECONDITION_FAILED",
					"Run history changed; repeat the recovery dry-run.",
				);
			}
			return original(ops, keys);
		};
		expect(() => register(built)).toThrow("repeat the dry-run");
		expect(
			built.store
				.listLines(runId, "budget")
				.some(
					(line) =>
						(line.payload as { kind?: string }).kind ===
						"implementation-plan-amendment",
				),
		).toBe(false);
		const recorded = register(built);
		expect(recorded.created).toBe(true);
	});

	test("a concurrent step makes the captured history stale", () => {
		const built = world();
		const original = built.store.atomicAppendIfAllNew.bind(built.store);
		let armed = true;
		built.store.atomicAppendIfAllNew = (ops, keys) => {
			if (armed) {
				armed = false;
				built.store.append({
					runId,
					stream: "steps",
					idempotencyKey: stepIdempotencyKey({
						runId,
						stepName: "quality:test",
						phase: "2",
						iteration: 9,
					}),
					payload: {
						step_name: "quality:test",
						phase: "2",
						iteration: 9,
						result_json: {},
						head_commit: COMMIT,
						patch_id: null,
						diff_summary: null,
						duration_ms: null,
						tokens_in: null,
						tokens_out: null,
						cost_usd: null,
						model: null,
					},
					...recordedEnvelope(origin),
				});
			}
			return original(ops, keys);
		};
		expect(() => register(built)).toThrow("repeat the dry-run");
		const recorded = register(built);
		expect(recorded.created).toBe(true);
	});

	function competingAuthorization(
		built: ReturnType<typeof world>,
		predecessorRevisionId: string,
	) {
		const second = createImplementationDecision({
			decisionId: "22222222-2222-4222-8222-222222222222",
			gateId: "gate-1",
			observationId: "obs-2",
			bindingId: "binding-1",
			phase: "2",
			choice: "authorize_amendment",
			findingRefs: [{ findingId: "R1", fingerprint: built.fingerprint }],
			rationale: "A competing authorization",
			evidence: [],
			claimAdjustments: [],
			ledgerHash: "ledger",
			decisionsHash: "decisions",
			createdAt: "2026-10-19T00:00:00.000Z",
			amendmentScope: {
				predecessorRevisionId,
				earliestAffectedPhase: "2",
				reopenCompletedPhases: false,
				claimEdits: [],
				resolutionRefs: [],
			},
		});
		built.store.append({
			runId,
			stream: "decisions",
			idempotencyKey: second.decisionId,
			payload: second,
			...recordedEnvelope(origin),
		});
		const appendStep = (
			name: string,
			phase: string,
			iteration: number,
			result: unknown,
		) => {
			const key = stepIdempotencyKey({
				runId,
				stepName: name,
				phase,
				iteration,
			});
			built.store.append({
				runId,
				stream: "steps",
				idempotencyKey: key,
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
				...recordedEnvelope(origin),
			});
			return key;
		};
		const humanKey = appendStep("human:review-governance", "2", 2, {
			decisionId: second.decisionId,
			gateId: second.gateId,
			choice: "authorize_amendment",
		});
		appendStep("author:process-plan-review", "plan", 2, {
			result: "complete",
			commit: COMMIT,
		});
		const approvalKey = appendStep("reviewer:plan", "plan", 2, {
			readiness: "ready",
			items: [],
			governance: { route: "complete" },
			amendmentAssessment: built.assessment,
		});
		createReviewBudgetStore(built.store).appendSnapshot({
			runId,
			stepName: "reviewer:plan",
			phase: "plan",
			iteration: 2,
			currentLedger: ledger(built.input.committedPlanBytes),
			findings: [],
			assessments: [],
			effectiveGateCauses: [],
			origin,
		});
		return { humanKey, approvalKey };
	}

	test("a changed intent for the same predecessor conflicts", () => {
		const built = world();
		const first = register(built);
		const competing = competingAuthorization(built, "binding-1");
		expect(() =>
			register(built, {
				humanStepKey: competing.humanKey,
				approvalStepKey: competing.approvalKey,
			}),
		).toThrow("different amendment already won");
		expect(first.created).toBe(true);
		expect(
			built.store
				.listLines(runId, "budget")
				.filter(
					(line) =>
						(line.payload as { kind?: string }).kind ===
						"implementation-plan-amendment",
				),
		).toHaveLength(1);
	});

	test("an authorization cannot be reused after the predecessor advances", () => {
		const built = world();
		const first = register(built);
		const retry = register(built);
		expect(retry.created).toBe(false);
		expect(retry.amendmentId).toBe(first.amendmentId);
		const competing = competingAuthorization(built, "binding-1");
		expect(() =>
			register(built, {
				humanStepKey: competing.humanKey,
				approvalStepKey: competing.approvalKey,
			}),
		).toThrow("different amendment already won");
		const folded = foldEffectiveExecution({
			recordStore: built.store,
			runId,
		});
		expect(folded.ok ? folded.currentRevisionId : "").toBe(first.amendmentId);
	});

	test("rejects a generic human gate, missing scope, and a stale plan or head", () => {
		expect(() => register(world({ humanStepName: "human:gate" }))).toThrow(
			"human:gate",
		);
		expect(() => register(world({ humanChoice: "continue" }))).toThrow(
			"Continue and override",
		);
		expect(() => register(world({ humanChoice: "override" }))).toThrow(
			"Continue and override",
		);
		expect(() => register(world({ omitScope: true }))).toThrow(
			"omits amendmentScope",
		);
		expect(() => register(world(), { worktreePlanBytes: `${PLAN}\n` })).toThrow(
			"worktree plan",
		);
		expect(() => register(world({ headAccepted: false }))).toThrow(
			"HEAD is stale",
		);
		const missing = world();
		expect(() =>
			register(missing, {
				humanStepKey: stepIdempotencyKey({
					runId,
					stepName: "human:review-governance",
					phase: "2",
					iteration: 8,
				}),
			}),
		).toThrow("human:review-governance");
	});

	test("rejects a broader boundary, a completed reopen, and an unenumerated claim", () => {
		const broader = world({ fromPhase: "1", earliestAuthorized: "2" });
		expect(() => register(broader)).toThrow("was not clamped");
		expect(
			broader.store
				.listLines(runId, "budget")
				.some(
					(line) =>
						(line.payload as { kind?: string }).kind ===
						"implementation-plan-amendment",
				),
		).toBe(false);
		expect(() =>
			register(world({ phaseComplete: ["2"], reopen: false })),
		).toThrow("reopenCompletedPhases");
		const claimed = claimPlan();
		const withdrawn = claimed
			.replace("| W2 | Claim | 2 | -1 | DC0 (`intrinsic`) | - | Credit |\n", "")
			.replace(
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
					"",
				].join("\n"),
				"",
			);
		expect(() =>
			register(
				world({
					base: claimed,
					amended: withdrawn,
					claimEdits: [{ creditClaimId: "DC0", effect: "withdraw" }],
					scopeClaims: [],
					rationale: "withdraw DC0 and reopen phase 1",
				}),
			),
		).toThrow("outside amendmentScope");
		const recorded = createImplementationDecision({
			decisionId: "33333333-3333-4333-8333-333333333333",
			gateId: "gate-rationale",
			observationId: "obs-2",
			bindingId: "binding-1",
			phase: "2",
			choice: "authorize_amendment",
			findingRefs: [{ findingId: "R1", fingerprint: "sha256:placeholder" }],
			rationale: "withdraw DC0 and reopen phase 1",
			evidence: [],
			claimAdjustments: [],
			ledgerHash: "ledger",
			decisionsHash: "decisions",
			amendmentScope: {
				predecessorRevisionId: "binding-1",
				earliestAffectedPhase: "2",
				reopenCompletedPhases: false,
				claimEdits: [],
				resolutionRefs: [],
			},
		});
		expect(recorded.amendmentScope?.claimEdits).toEqual([]);
		expect(recorded.amendmentScope?.reopenCompletedPhases).toBe(false);
		expect(recorded.rationale).toContain("withdraw DC0");
	});

	test("rejects a finding outside resolutionRefs and a plain id from another phase", () => {
		const source = item("R1", "Providers");
		const fingerprint = fingerprintImplementationVerdictItem(source, "2");
		expect(() =>
			register(
				world({
					resolved: [
						{
							phase: "2",
							observationId: "obs-2",
							findingId: "R1",
							fingerprint,
							reason: "scope changed",
						},
					],
					scopeResolutions: [],
				}),
				{ resolves: ["R1"] },
			),
		).toThrow("outside amendmentScope");
		const cross = world({ otherPhaseFinding: true });
		expect(() => register(cross, { resolves: ["R7"] })).toThrow(
			"another phase",
		);
	});

	test("rejects an unresolved approval gate", () => {
		expect(() => register(world({ unresolvedApprovalGate: true }))).toThrow(
			"unresolved approval gate",
		);
	});

	test("records scope only from the structured object", () => {
		const built = world();
		const observations = [
			built.store.listLines(runId, "budget").flatMap((line) => {
				const payload = line.payload as { kind?: string; id?: string };
				return payload.kind === "implementation-review" &&
					payload.id === "obs-2"
					? [line.payload as ImplementationReviewObservationPayload]
					: [];
			})[0],
		].filter(
			(observation): observation is ImplementationReviewObservationPayload =>
				Boolean(observation),
		);
		expect(() =>
			prepareAuthorizeAmendmentScope({
				choice: "abort",
				amendmentScope: {
					predecessorRevisionId: "binding-1",
					earliestAffectedPhase: "2",
					reopenCompletedPhases: false,
					claimEdits: [],
					resolutionRefs: [],
				},
				findingRefs: [],
				sourceObservationId: "obs-2",
				observations,
				phaseIds: ["1", "2", "3"],
				currentRevisionId: "binding-1",
				ledgerClaimIds: new Set(),
			}),
		).toThrow("only valid on authorize_amendment");
		expect(() =>
			prepareAuthorizeAmendmentScope({
				choice: "authorize_amendment",
				amendmentScope: {
					predecessorRevisionId: "binding-1",
					earliestAffectedPhase: "2",
					claimEdits: [],
					resolutionRefs: [],
				},
				findingRefs: built.decision.findingRefs,
				sourceObservationId: "obs-2",
				observations,
				phaseIds: ["1", "2", "3"],
				currentRevisionId: "binding-1",
				ledgerClaimIds: new Set(),
			}),
		).toThrow("reopenCompletedPhases");
		expect(() =>
			prepareAuthorizeAmendmentScope({
				choice: "authorize_amendment",
				amendmentScope: {
					predecessorRevisionId: "old-revision",
					earliestAffectedPhase: "2",
					reopenCompletedPhases: false,
					claimEdits: [],
					resolutionRefs: [],
				},
				findingRefs: built.decision.findingRefs,
				sourceObservationId: "obs-2",
				observations,
				phaseIds: ["1", "2", "3"],
				currentRevisionId: "binding-1",
				ledgerClaimIds: new Set(),
			}),
		).toThrow("not the current revision");
		expect(() =>
			prepareAuthorizeAmendmentScope({
				choice: "authorize_amendment",
				amendmentScope: {
					predecessorRevisionId: "binding-1",
					earliestAffectedPhase: "9",
					reopenCompletedPhases: false,
					claimEdits: [],
					resolutionRefs: [],
				},
				findingRefs: built.decision.findingRefs,
				sourceObservationId: "obs-2",
				observations,
				phaseIds: ["1", "2", "3"],
				currentRevisionId: "binding-1",
				ledgerClaimIds: new Set(),
			}),
		).toThrow("not in the current plan");
		expect(() =>
			prepareAuthorizeAmendmentScope({
				choice: "authorize_amendment",
				amendmentScope: {
					predecessorRevisionId: "binding-1",
					earliestAffectedPhase: "2",
					reopenCompletedPhases: false,
					claimEdits: [{ creditClaimId: "DC9", effect: "withdraw" }],
					resolutionRefs: [],
				},
				findingRefs: built.decision.findingRefs,
				sourceObservationId: "obs-2",
				observations,
				phaseIds: ["1", "2", "3"],
				currentRevisionId: "binding-1",
				ledgerClaimIds: new Set(["DC0"]),
			}),
		).toThrow("not on the bound ledger");
		const filled = prepareAuthorizeAmendmentScope({
			choice: "authorize_amendment",
			amendmentScope: {
				predecessorRevisionId: "binding-1",
				earliestAffectedPhase: "2",
				reopenCompletedPhases: false,
				claimEdits: [],
				resolutionRefs: [
					{ phase: "2", observationId: "obs-2", findingId: "R1" },
				],
			},
			findingRefs: built.decision.findingRefs,
			sourceObservationId: "obs-2",
			observations,
			phaseIds: ["1", "2", "3"],
			currentRevisionId: "binding-1",
			ledgerClaimIds: new Set(),
		});
		expect(filled?.resolutionRefs[0]?.fingerprint).toBe(built.fingerprint);
		expect(() =>
			parseAmendmentScope({
				predecessorRevisionId: "binding-1",
				earliestAffectedPhase: "2",
				reopenCompletedPhases: "false",
				claimEdits: [],
				resolutionRefs: [],
			}),
		).toThrow("boolean");
		expect(() =>
			createImplementationDecision({
				gateId: "gate-other",
				observationId: "obs-2",
				bindingId: "binding-1",
				phase: "2",
				choice: "abort",
				findingRefs: [],
				rationale: "stop",
				evidence: [],
				claimAdjustments: [],
				ledgerHash: "ledger",
				decisionsHash: "decisions",
				amendmentScope: {
					predecessorRevisionId: "binding-1",
					earliestAffectedPhase: "2",
					reopenCompletedPhases: false,
					claimEdits: [],
					resolutionRefs: [],
				},
			}),
		).toThrow("only valid on authorize_amendment");
	});
});
