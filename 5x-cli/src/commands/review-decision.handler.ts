import type { Database } from "bun:sqlite";
import type {
	RecordPerformer,
	StepRecordPayload,
} from "../control-plane/index.js";
import { createSqlitePromptStore } from "../control-plane/sqlite-store.js";
import type { PromptStore } from "../control-plane/store.js";
import { completeRun, getRunV1 } from "../db/operations-v1.js";
import { CliError } from "../output.js";
import type { ReviewerVerdict } from "../protocol.js";
import type { DerivedBudgetResult } from "../review-budget/types.js";
import {
	decodeReviewDecisionPayload,
	encodeReviewDecisionPayload,
} from "../review-governance/codec.js";
import {
	classifyDecisionAcceptance,
	createReviewDecision,
	governanceDecisionKey,
	type ReviewDecisionPayload,
} from "../review-governance/decisions.js";
import { fingerprintVerdictItem } from "../review-governance/fingerprint.js";
import { routeAfterDecision } from "../review-governance/routing.js";
import {
	allowedChoicesForGate,
	createReviewGovernanceStore,
	ensureReviewGatePrompt,
	repairReviewGatePrompts,
	resolveGatePromptProjection,
	reviewGatePromptContext,
} from "../review-governance/store.js";
import type {
	FindingIdentity,
	ReviewDecisionChoice,
	ReviewDecisionRoute,
	ReviewGateCause,
} from "../review-governance/types.js";
import type { ReviewBudgetCommandContext } from "./review-budget-context.js";
import { createReviewBudgetContext } from "./review-budget-context.js";
import {
	finalizeAndWritePreparedStep,
	prepareRecordStepAppend,
	RecordError,
	recordStepInternal,
} from "./run-v1.handler.js";

export interface SubmitPlanReviewDecisionPayload {
	choice: ReviewDecisionChoice;
	rationale: string;
	evidence?: string[];
	findingRefs?: FindingIdentity[];
	retained?: string[];
	removed?: string[];
	baseline?: number;
	approvedP?: number;
	approvedItemIds?: string[];
	approvedWorkItemIds?: string[];
	snapshotId?: string;
}

export interface SubmitPlanReviewDecisionInput {
	runId: string;
	gateId: string;
	payload: SubmitPlanReviewDecisionPayload;
	/** ID-only terminal form. Fingerprints are resolved from the gate snapshot. */
	findingIds?: string[];
	/** Authenticated adapters supply their actor here; terminal callers use operator. */
	performer?: RecordPerformer;
}

export interface ReviewDecisionDeps {
	context?: ReviewBudgetCommandContext;
	promptStore?: PromptStore;
	createContext?: typeof createReviewBudgetContext;
	now?: () => string;
	abortRun?: (input: {
		runId: string;
		rationale: string;
		context: ReviewBudgetCommandContext;
	}) => Promise<void>;
}

export async function showPlanReviewGate(
	runId: string,
	deps: ReviewDecisionDeps = {},
) {
	const ctx =
		deps.context ??
		(await (deps.createContext ?? createReviewBudgetContext)({ runId }));
	const promptStore =
		deps.promptStore ?? createSqlitePromptStore(ctx.db as Database);
	const baseline = ctx.store.getBaseline(runId);
	if (!baseline)
		fail("BUDGET_BASELINE_MISSING", "review budget baseline is missing");
	const governance = createReviewGovernanceStore(ctx.recordStore, promptStore);
	repairReviewGatePrompts(ctx.recordStore, promptStore, runId);
	const gate = governance.deriveOpenGate(runId);
	if (!gate) return { open: false as const };
	const state = governance.deriveGoverningState(runId, baseline.b0);
	const eligibleFindings = [
		...eligibleFindingMap(ctx, runId, gate.snapshotId, gate.causes).values(),
	];
	const prompt = ensureReviewGatePrompt({
		promptStore,
		gate,
		baselineReestimatePending: Boolean(state.baselineReestimatePending),
		eligibleFindings,
	});
	const context = reviewGatePromptContext({
		gate,
		baselineReestimatePending: Boolean(state.baselineReestimatePending),
		eligibleFindings,
	});
	return {
		open: true as const,
		gate,
		promptId: prompt.id,
		...context,
		jsonFields: [
			"choice",
			"rationale",
			"evidence",
			"findingRefs",
			"retained",
			"removed",
			"baseline",
			"approvedP",
			"approvedItemIds",
			"approvedWorkItemIds",
			"snapshotId",
		],
		exampleCommand: `5x review decide --gate ${gate.gateId} --choice <choice> --rationale '<text>'`,
	};
}

function fail(code: string, message: string, detail?: unknown): never {
	throw new CliError(code, message, detail);
}

function duplicates(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const duplicate = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) duplicate.add(value);
		seen.add(value);
	}
	return [...duplicate];
}

function stepPayloadForSnapshot(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	snapshotId: string,
): { step: StepRecordPayload; verdict: ReviewerVerdict } {
	const snapshot = ctx.store
		.listSnapshots(runId)
		.find((candidate) => candidate.id === snapshotId);
	if (!snapshot?.stepName || snapshot.iteration === null)
		fail("REVIEW_GATE_SNAPSHOT_MISSING", "review gate snapshot is unavailable");
	const lines = ctx.recordStore.listLines(runId, "steps");
	const matching = lines.flatMap((line) => {
		const step = line.payload as Partial<StepRecordPayload>;
		return step.step_name === snapshot.stepName &&
			(step.phase ?? null) === snapshot.phase &&
			step.iteration === snapshot.iteration
			? [step as StepRecordPayload]
			: [];
	});
	if (matching.length !== 1)
		fail(
			"REVIEW_GATE_AUDIT_INVALID",
			"gate reviewer boundary is missing or duplicated",
		);
	const step = matching[0] as StepRecordPayload;
	return { step, verdict: step.result_json as ReviewerVerdict };
}

function eligibleFindingMap(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	snapshotId: string,
	causes: readonly ReviewGateCause[],
): Map<string, FindingIdentity> {
	const map = new Map<string, FindingIdentity>();
	for (const cause of causes) {
		if ("finding" in cause) map.set(cause.finding.findingId, cause.finding);
	}
	const snapshot = ctx.store
		.listSnapshots(runId)
		.find((candidate) => candidate.id === snapshotId);
	const { verdict } = stepPayloadForSnapshot(ctx, runId, snapshotId);
	for (const finding of snapshot?.findings ?? []) {
		const item = verdict.items.find((candidate) => candidate.id === finding.id);
		const persistedFingerprint = (
			finding as unknown as { fingerprint?: unknown }
		).fingerprint;
		if (typeof persistedFingerprint === "string") {
			map.set(finding.id, {
				findingId: finding.id,
				fingerprint: persistedFingerprint,
			});
		} else if (item?.failure && item.lowestCostCorrection) {
			map.set(finding.id, {
				findingId: finding.id,
				fingerprint: fingerprintVerdictItem(item),
			});
		}
	}
	return map;
}

function positiveArchitectureForSnapshot(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	snapshotId: string,
): number {
	const snapshot = ctx.store
		.listSnapshots(runId)
		.find((candidate) => candidate.id === snapshotId);
	const { verdict } = stepPayloadForSnapshot(ctx, runId, snapshotId);
	return (
		(verdict as ReviewerVerdict & { budget?: DerivedBudgetResult }).budget?.P ??
		snapshot?.derived?.P ??
		0
	);
}

function validateAndCreate(input: {
	runId: string;
	gateId: string;
	snapshotId: string;
	payload: SubmitPlanReviewDecisionPayload;
	findingIds: readonly string[];
	eligible: Map<string, FindingIdentity>;
	gateCauses: readonly ReviewGateCause[];
	allowedChoices: readonly ReviewDecisionChoice[];
	governingBaseline: number;
	currentPositiveArchitecture: number;
	now: string;
}): ReviewDecisionPayload {
	const payload = input.payload;
	for (const [name, value] of [
		["evidence", payload.evidence],
		["findingRefs", payload.findingRefs],
		["retained", payload.retained],
		["removed", payload.removed],
		["approvedItemIds", payload.approvedItemIds],
		["approvedWorkItemIds", payload.approvedWorkItemIds],
	] as const) {
		if (value !== undefined && !Array.isArray(value))
			fail("REVIEW_DECISION_INVALID", `${name} must be an array`);
	}
	if (
		(payload.evidence ?? []).some((value) => typeof value !== "string") ||
		(payload.retained ?? []).some((value) => typeof value !== "string") ||
		(payload.removed ?? []).some((value) => typeof value !== "string") ||
		(payload.approvedItemIds ?? []).some(
			(value) => typeof value !== "string",
		) ||
		(payload.approvedWorkItemIds ?? []).some(
			(value) => typeof value !== "string",
		)
	)
		fail("REVIEW_DECISION_INVALID", "list fields must contain strings");
	if (
		(payload.findingRefs ?? []).some(
			(ref) =>
				!ref ||
				typeof ref !== "object" ||
				typeof ref.findingId !== "string" ||
				typeof ref.fingerprint !== "string",
		)
	)
		fail(
			"REVIEW_DECISION_INVALID",
			"findingRefs must contain findingId/fingerprint pairs",
		);
	if (!input.allowedChoices.includes(payload.choice))
		fail(
			"REVIEW_DECISION_CHOICE_NOT_ALLOWED",
			`${payload.choice} is not allowed for this gate`,
			{
				allowedChoices: input.allowedChoices,
			},
		);
	if (!payload.rationale?.trim())
		fail("REVIEW_DECISION_INVALID", "rationale is required");
	if (payload.snapshotId && payload.snapshotId !== input.snapshotId)
		fail(
			"REVIEW_GATE_STALE",
			"decision snapshotId does not match the gate snapshot",
		);
	const ids = [...input.findingIds];
	const refs = [...(payload.findingRefs ?? [])];
	const allFindingIds = [...ids, ...refs.map((ref) => ref.findingId)];
	if (
		duplicates(ids).length ||
		duplicates(refs.map((ref) => ref.findingId)).length ||
		duplicates(allFindingIds).length
	)
		fail(
			"REVIEW_DECISION_INVALID",
			"duplicate finding identities are not allowed",
		);
	for (const id of ids) {
		const finding = input.eligible.get(id);
		if (!finding)
			fail(
				"REVIEW_DECISION_FINDING_INVALID",
				`finding ${id} is not eligible for this gate`,
			);
		refs.push(finding);
	}
	for (const ref of refs) {
		const authoritative = input.eligible.get(ref.findingId);
		if (!authoritative || authoritative.fingerprint !== ref.fingerprint)
			fail(
				"REVIEW_DECISION_FINDING_INVALID",
				`finding ${ref.findingId} is unknown, stale, or has a mismatched fingerprint`,
			);
	}
	const scalarBaselineChoices =
		payload.choice === "increase_budget" ||
		payload.choice === "adjust_baseline";
	if (
		scalarBaselineChoices &&
		(!Number.isInteger(payload.baseline) || (payload.baseline ?? 0) <= 0)
	)
		fail(
			"REVIEW_DECISION_INVALID",
			`${payload.choice} requires a positive integer baseline`,
		);
	if (!scalarBaselineChoices && payload.baseline !== undefined)
		fail(
			"REVIEW_DECISION_FIELD_NOT_ALLOWED",
			"baseline is not applicable to this choice",
		);
	if (
		payload.choice !== "defer_accept_risk" &&
		(refs.length || (payload.evidence?.length ?? 0))
	)
		fail(
			"REVIEW_DECISION_FIELD_NOT_ALLOWED",
			"finding/evidence fields are not applicable to this choice",
		);
	if (
		payload.choice === "defer_accept_risk" &&
		(refs.length === 0 ||
			!(payload.evidence ?? []).some((value) => value.trim()))
	)
		fail(
			"REVIEW_DECISION_INVALID",
			"risk deferral requires eligible findings and evidence",
		);
	const retained = payload.retained ?? [];
	const removed = payload.removed ?? [];
	if (payload.choice !== "trade_scope" && (retained.length || removed.length))
		fail(
			"REVIEW_DECISION_FIELD_NOT_ALLOWED",
			"scope fields are not applicable to this choice",
		);
	if (
		payload.choice === "trade_scope" &&
		retained.length + removed.length === 0
	)
		fail(
			"REVIEW_DECISION_INVALID",
			"scope trade requires retained or removed scope",
		);
	const architectureFields =
		payload.approvedP !== undefined ||
		(payload.approvedItemIds?.length ?? 0) > 0 ||
		(payload.approvedWorkItemIds?.length ?? 0) > 0;
	if (payload.choice !== "approve_architecture_burden" && architectureFields)
		fail(
			"REVIEW_DECISION_FIELD_NOT_ALLOWED",
			"architecture approval fields are not applicable to this choice",
		);
	if (
		payload.choice === "approve_architecture_burden" &&
		(!Number.isInteger(payload.approvedP) ||
			(payload.approvedP ?? -1) < 0 ||
			(payload.approvedItemIds?.length ?? 0) +
				(payload.approvedWorkItemIds?.length ?? 0) ===
				0)
	)
		fail(
			"REVIEW_DECISION_INVALID",
			"architecture approval requires approvedP and item/work-item IDs",
		);
	if (payload.choice === "approve_architecture_burden") {
		const architectureCauses = input.gateCauses.flatMap((cause) =>
			cause.kind === "budget_alert" &&
			cause.alert === "positive_architecture_exceeded"
				? [cause]
				: [],
		);
		const eligibleItemIds = new Set(
			architectureCauses.flatMap((cause) => cause.itemIds ?? []),
		);
		const eligibleWorkItemIds = new Set(
			architectureCauses.flatMap((cause) => cause.workItemIds ?? []),
		);
		const unknownItems = (payload.approvedItemIds ?? []).filter(
			(id) => !eligibleItemIds.has(id),
		);
		const unknownWorkItems = (payload.approvedWorkItemIds ?? []).filter(
			(id) => !eligibleWorkItemIds.has(id),
		);
		const missingItems = [...eligibleItemIds].filter(
			(id) => !(payload.approvedItemIds ?? []).includes(id),
		);
		const missingWorkItems = [...eligibleWorkItemIds].filter(
			(id) => !(payload.approvedWorkItemIds ?? []).includes(id),
		);
		if (
			architectureCauses.length === 0 ||
			(payload.approvedP ?? -1) < input.currentPositiveArchitecture ||
			unknownItems.length > 0 ||
			unknownWorkItems.length > 0 ||
			missingItems.length > 0 ||
			missingWorkItems.length > 0
		)
			fail(
				"REVIEW_DECISION_ARCHITECTURE_ID_INVALID",
				"architecture approval must cover this gate's current burden and exact threshold-crossing IDs",
				{
					currentPositiveArchitecture: input.currentPositiveArchitecture,
					unknownItemIds: unknownItems,
					unknownWorkItemIds: unknownWorkItems,
					missingItemIds: missingItems,
					missingWorkItemIds: missingWorkItems,
				},
			);
	}
	return createReviewDecision({
		gateId: input.gateId,
		snapshotId: input.snapshotId,
		choice: payload.choice,
		findingRefs: refs,
		rationale: payload.rationale.trim(),
		evidence: payload.evidence ?? [],
		approvedScope: { retained, removed },
		...(scalarBaselineChoices
			? {
					governingBaselineChange: {
						from: input.governingBaseline,
						to: payload.baseline as number,
					},
				}
			: {}),
		...(payload.choice === "approve_architecture_burden"
			? {
					architectureApproval: {
						approvedP: payload.approvedP as number,
						approvedItemIds: payload.approvedItemIds ?? [],
						approvedWorkItemIds: payload.approvedWorkItemIds ?? [],
					},
				}
			: {}),
		createdAt: input.now,
	});
}

async function defaultAbort(input: {
	runId: string;
	rationale: string;
	context: ReviewBudgetCommandContext;
}): Promise<void> {
	try {
		await recordStepInternal(
			{
				run: input.runId,
				stepName: "run:abort",
				result: JSON.stringify({ status: "aborted", reason: input.rationale }),
				performer: { kind: "system", role: "cli" },
			},
			input.context,
		);
	} catch (error) {
		// The durable governance decision is itself terminal authority. A run that
		// reached its step limit while writing it must still transition to aborted.
		if (!(error instanceof RecordError) || error.code !== "MAX_STEPS_EXCEEDED")
			throw error;
	}
	completeRun(input.context.db, input.runId, "aborted");
	const summary = input.context.recordStore.getRun(input.runId);
	if (summary)
		input.context.recordStore.putRun({
			...summary,
			status: "aborted",
			sealed_at: new Date().toISOString(),
		});
}

export async function submitPlanReviewDecision(
	input: SubmitPlanReviewDecisionInput,
	deps: ReviewDecisionDeps = {},
): Promise<{
	decision: ReviewDecisionPayload;
	created: boolean;
	route: ReviewDecisionRoute;
}> {
	const ctx =
		deps.context ??
		(await (deps.createContext ?? createReviewBudgetContext)({
			runId: input.runId,
		}));
	const promptStore =
		deps.promptStore ?? createSqlitePromptStore(ctx.db as Database);
	const run = getRunV1(ctx.db, input.runId);
	if (!run) fail("RUN_NOT_FOUND", `Run ${input.runId} not found`);
	const baseline = ctx.store.getBaseline(input.runId);
	if (!baseline)
		fail("BUDGET_BASELINE_MISSING", "review budget baseline is missing");
	const governance = createReviewGovernanceStore(ctx.recordStore, promptStore);
	const alreadyResolved = ctx.recordStore.getLine(
		input.runId,
		"decisions",
		governanceDecisionKey(input.gateId),
	);
	if (alreadyResolved) {
		const winner = decodeReviewDecisionPayload(alreadyResolved.payload);
		const acceptance = classifyDecisionAcceptance({
			decision: winner,
			steps: ctx.recordStore.listLines(input.runId, "steps"),
			budget: ctx.recordStore.listLines(input.runId, "budget"),
		});
		if (!acceptance.accepted)
			fail(
				"REVIEW_GATE_STALE",
				acceptance.diagnostic ?? "review gate decision is stale",
			);
		const state = governance.deriveGoverningState(input.runId, baseline.b0);
		const snapshot = ctx.store
			.listSnapshots(input.runId)
			.find((candidate) => candidate.id === winner.snapshotId);
		if (!snapshot)
			fail(
				"REVIEW_GATE_SNAPSHOT_MISSING",
				"winning decision snapshot is unavailable",
			);
		const eligible = eligibleFindingMap(
			ctx,
			input.runId,
			winner.snapshotId,
			snapshot.effectiveGateCauses,
		);
		const retry = validateAndCreate({
			runId: input.runId,
			gateId: input.gateId,
			snapshotId: winner.snapshotId,
			payload: input.payload,
			findingIds: input.findingIds ?? [],
			eligible,
			gateCauses: snapshot.effectiveGateCauses,
			allowedChoices: allowedChoicesForGate({
				causes: snapshot.effectiveGateCauses,
				baselineReestimatePending: Boolean(state.baselineReestimatePending),
			}),
			governingBaseline:
				winner.governingBaselineChange?.from ?? state.governingBaseline,
			currentPositiveArchitecture: positiveArchitectureForSnapshot(
				ctx,
				input.runId,
				winner.snapshotId,
			),
			now: deps.now?.() ?? new Date().toISOString(),
		});
		if (winner.decisionIntentHash !== retry.decisionIntentHash)
			fail(
				"REVIEW_GATE_ALREADY_RESOLVED",
				"review gate was resolved by a different decision",
				{ decision: winner },
			);
		return {
			decision: winner,
			created: false,
			route: routeForStoredDecision(ctx, input.runId, winner, baseline.b0),
		};
	}
	if (run.status !== "active")
		fail("RUN_NOT_ACTIVE", `Run ${input.runId} is ${run.status}`);
	const gate = governance.deriveOpenGate(input.runId);
	if (!gate || gate.gateId !== input.gateId)
		fail(
			"REVIEW_GATE_NOT_OPEN",
			`Review gate ${input.gateId} is not the current open gate`,
		);
	const governing = governance.deriveGoverningState(input.runId, baseline.b0);
	const eligible = eligibleFindingMap(
		ctx,
		input.runId,
		gate.snapshotId,
		gate.causes,
	);
	const allowedChoices = allowedChoicesForGate({
		causes: gate.causes,
		baselineReestimatePending: Boolean(governing.baselineReestimatePending),
	});
	const proposed = validateAndCreate({
		runId: input.runId,
		gateId: gate.gateId,
		snapshotId: gate.snapshotId,
		payload: input.payload,
		findingIds: input.findingIds ?? [],
		eligible,
		gateCauses: gate.causes,
		allowedChoices,
		governingBaseline: governing.governingBaseline,
		currentPositiveArchitecture: positiveArchitectureForSnapshot(
			ctx,
			input.runId,
			gate.snapshotId,
		),
		now: deps.now?.() ?? new Date().toISOString(),
	});

	// Gate-key pre-read intentionally occurs before admission/finalization so a
	// loser can observe the winner even when no step budget remains.
	const existing = ctx.recordStore.getLine(
		input.runId,
		"decisions",
		governanceDecisionKey(gate.gateId),
	);
	if (existing) {
		const winner = decodeReviewDecisionPayload(existing.payload);
		if (winner.decisionIntentHash !== proposed.decisionIntentHash)
			fail(
				"REVIEW_GATE_ALREADY_RESOLVED",
				"review gate was resolved by a different decision",
				{ decision: winner },
			);
		return {
			decision: winner,
			created: false,
			route: routeForStoredDecision(ctx, input.runId, winner, baseline.b0),
		};
	}

	let admitted: Awaited<ReturnType<typeof prepareRecordStepAppend>>;
	try {
		admitted = await prepareRecordStepAppend(
			{
				run: input.runId,
				stepName: "human:review-governance",
				phase: "plan",
				result: JSON.stringify({
					decisionId: proposed.decisionId,
					gateId: proposed.gateId,
					choice: proposed.choice,
				}),
				performer: input.performer ?? { kind: "human", role: "operator" },
			},
			ctx,
		);
	} catch (error) {
		if (error instanceof RecordError)
			throw new CliError(error.code, error.message, error.detail);
		throw error;
	}
	if (admitted.outcome === "duplicate")
		fail(
			"REVIEW_GATE_STEP_CONFLICT",
			"human governance step identity already exists",
		);
	const written = await finalizeAndWritePreparedStep(
		admitted.prepared,
		{
			db: ctx.db,
			config: ctx.config,
			recordStore: ctx.recordStore,
			originFor: ctx.originFor,
			run,
		},
		{
			mode: "paired-all-new",
			extraOps: (_finalized, envelope) => [
				{
					runId: input.runId,
					stream: "decisions",
					idempotencyKey: governanceDecisionKey(gate.gateId),
					payload: encodeReviewDecisionPayload(proposed),
					createdAt: proposed.createdAt,
					...envelope,
				},
			],
		},
	);
	if (written.outcome === "coupled-key-exists") {
		const winner = decodeReviewDecisionPayload(written.line.payload);
		if (winner.decisionIntentHash !== proposed.decisionIntentHash)
			fail(
				"REVIEW_GATE_ALREADY_RESOLVED",
				"review gate was resolved by a different decision",
				{ decision: winner },
			);
		return {
			decision: winner,
			created: false,
			route: routeForStoredDecision(ctx, input.runId, winner, baseline.b0),
		};
	}

	const acceptance = classifyDecisionAcceptance({
		decision: proposed,
		steps: ctx.recordStore.listLines(input.runId, "steps"),
		budget: ctx.recordStore.listLines(input.runId, "budget"),
	});
	if (!acceptance.accepted)
		fail(
			"REVIEW_GATE_STALE",
			acceptance.diagnostic ?? "review gate decision is stale",
		);
	const state = governance.deriveGoverningState(input.runId, baseline.b0);
	const { verdict } = stepPayloadForSnapshot(
		ctx,
		input.runId,
		proposed.snapshotId,
	);
	const snapshot = ctx.store
		.listSnapshots(input.runId)
		.find((item) => item.id === proposed.snapshotId);
	if (!snapshot)
		fail("REVIEW_GATE_SNAPSHOT_MISSING", "review gate snapshot is unavailable");
	const route = routeAfterDecision({
		latestVerdict: verdict,
		latestBudgetSnapshot: {
			...snapshot,
			derived:
				(verdict as ReviewerVerdict & { budget?: DerivedBudgetResult })
					.budget ?? snapshot.derived,
		},
		newGoverningState: state,
		decision: proposed,
	});
	resolveGatePromptProjection(
		promptStore,
		input.runId,
		proposed.gateId,
		proposed.decisionId,
	);
	if (route === "human_gate") {
		const successor = governance.deriveOpenGate(input.runId);
		if (successor) {
			ensureReviewGatePrompt({
				promptStore,
				gate: successor,
				baselineReestimatePending: Boolean(state.baselineReestimatePending),
				eligibleFindings: [
					...eligibleFindingMap(
						ctx,
						input.runId,
						successor.snapshotId,
						successor.causes,
					).values(),
				],
			});
		}
	}
	if (route === "aborted")
		await (deps.abortRun ?? defaultAbort)({
			runId: input.runId,
			rationale: proposed.rationale,
			context: ctx,
		});
	return { decision: proposed, created: true, route };
}

function routeForStoredDecision(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	decision: ReviewDecisionPayload,
	b0: number,
): ReviewDecisionRoute {
	const governance = createReviewGovernanceStore(ctx.recordStore);
	const state = governance.deriveGoverningState(runId, b0);
	const snapshot = ctx.store
		.listSnapshots(runId)
		.find((candidate) => candidate.id === decision.snapshotId);
	if (!snapshot) return "human_gate";
	const { verdict } = stepPayloadForSnapshot(ctx, runId, decision.snapshotId);
	return routeAfterDecision({
		latestVerdict: verdict,
		latestBudgetSnapshot: {
			...snapshot,
			derived:
				(verdict as ReviewerVerdict & { budget?: DerivedBudgetResult })
					.budget ?? snapshot.derived,
		},
		newGoverningState: state,
		decision,
	});
}
