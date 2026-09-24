import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
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
import { workdirCodeDiffGit } from "../review-governance/code-diff.js";
import {
	decodeImplementationDecisionPayload,
	decodeReviewDecisionPayload,
	encodeImplementationDecisionPayload,
	encodeReviewDecisionPayload,
} from "../review-governance/codec.js";
import { finishImplementationCorrection } from "../review-governance/corrections.js";
import {
	assertImplementationDecisionScope,
	classifyDecisionAcceptance,
	createImplementationDecision,
	createReviewDecision,
	foldGoverningReviewState,
	governanceDecisionKey,
	type ImplementationDecisionPayload,
	implementationDecisionNextAction,
	type ReviewDecisionPayload,
} from "../review-governance/decisions.js";
import { fingerprintVerdictItem } from "../review-governance/fingerprint.js";
import {
	ensureImplementationAdmission,
	planRepoPath,
} from "../review-governance/implementation-state.js";
import { routeAfterDecision } from "../review-governance/routing.js";
import {
	allowedChoicesForGate,
	allowedImplementationChoices,
	createReviewGovernanceStore,
	deriveOpenImplementationGate,
	ensureImplementationGatePrompt,
	ensureReviewGatePrompt,
	repairReviewGatePrompts,
	resolveGatePromptProjection,
	reviewGatePromptContext,
} from "../review-governance/store.js";
import type {
	FindingIdentity,
	ImplementationDecisionChoice,
	ReviewDecisionChoice,
	ReviewDecisionRoute,
	ReviewGateCause,
} from "../review-governance/types.js";
import { resolveQualityTarget, runQualityCore } from "./quality-v1.handler.js";
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
	warn?: (message: string) => void;
	now?: () => string;
	abortRun?: (input: {
		runId: string;
		rationale: string;
		context: ReviewBudgetCommandContext;
	}) => Promise<void>;
	/**
	 * Runs after the requested gate is not the open gate and before the
	 * decision stream is re-read. Concurrent same-intent writers commit in
	 * this window; production callers omit it.
	 */
	onOpenGateMiss?: () => void | Promise<void>;
}

export async function showPlanReviewGate(
	runId: string,
	deps: ReviewDecisionDeps = {},
) {
	const ctx =
		deps.context ??
		(await (deps.createContext ?? createReviewBudgetContext)(
			{ runId },
			deps.warn ?? ((message) => console.error(`Warning: ${message}`)),
		));
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
		(!Number.isInteger(payload.approvedP) || (payload.approvedP ?? -1) < 0)
	)
		fail(
			"REVIEW_DECISION_INVALID",
			"architecture approval requires a non-negative integer approvedP",
		);
	if (payload.choice === "approve_architecture_burden") {
		// Aggregate burden can cross its limit without any individual item
		// crossing the single-item threshold. Exact ID coverage may be empty.
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
		(await (deps.createContext ?? createReviewBudgetContext)(
			{
				runId: input.runId,
			},
			deps.warn ?? ((message) => console.error(`Warning: ${message}`)),
		));
	const promptStore =
		deps.promptStore ?? createSqlitePromptStore(ctx.db as Database);
	const run = getRunV1(ctx.db, input.runId);
	if (!run) fail("RUN_NOT_FOUND", `Run ${input.runId} not found`);
	const baseline = ctx.store.getBaseline(input.runId);
	if (!baseline)
		fail("BUDGET_BASELINE_MISSING", "review budget baseline is missing");
	const governance = createReviewGovernanceStore(ctx.recordStore, promptStore);
	const decisionKey = governanceDecisionKey(input.gateId);
	const readDecision = () =>
		ctx.recordStore.getLine(input.runId, "decisions", decisionKey);
	const acceptStoredWinner = async (
		line: NonNullable<ReturnType<typeof readDecision>>,
	) => {
		const winner = decodeReviewDecisionPayload(line.payload);
		const state = governingStateBeforeWinner(
			ctx,
			input.runId,
			baseline.b0,
			winner,
		);
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
		return acceptedWinnerResult({
			ctx,
			promptStore,
			runId: input.runId,
			baselineB0: baseline.b0,
			decision: winner,
			created: false,
			abortRun: deps.abortRun,
		});
	};
	const alreadyResolved = readDecision();
	if (alreadyResolved) return acceptStoredWinner(alreadyResolved);
	if (run.status !== "active")
		fail("RUN_NOT_ACTIVE", `Run ${input.runId} is ${run.status}`);
	const gate = governance.deriveOpenGate(input.runId);
	if (!gate || gate.gateId !== input.gateId) {
		// The other process can commit between the first read and this
		// derivation, or between this miss and the re-read below.
		// Same-intent losers must observe that winner.
		if (deps.onOpenGateMiss) await deps.onOpenGateMiss();
		const raced = readDecision();
		if (raced) return acceptStoredWinner(raced);
		fail(
			"REVIEW_GATE_NOT_OPEN",
			`Review gate ${input.gateId} is not the current open gate`,
		);
	}
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
		return acceptedWinnerResult({
			ctx,
			promptStore,
			runId: input.runId,
			baselineB0: baseline.b0,
			decision: winner,
			created: false,
			abortRun: deps.abortRun,
		});
	}
	return acceptedWinnerResult({
		ctx,
		promptStore,
		runId: input.runId,
		baselineB0: baseline.b0,
		decision: proposed,
		created: true,
		abortRun: deps.abortRun,
	});
}

function governingStateBeforeWinner(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	b0: number,
	winner: ReviewDecisionPayload,
) {
	const decisions = createReviewGovernanceStore(ctx.recordStore).listDecisions(
		runId,
	);
	const winnerIndex = decisions.findIndex(
		(decision) => decision.decisionId === winner.decisionId,
	);
	return foldGoverningReviewState({
		b0,
		decisions: winnerIndex < 0 ? [] : decisions.slice(0, winnerIndex),
		steps: ctx.recordStore.listLines(runId, "steps"),
		budget: ctx.recordStore.listLines(runId, "budget"),
	});
}

async function acceptedWinnerResult(input: {
	ctx: ReviewBudgetCommandContext;
	promptStore: PromptStore;
	runId: string;
	baselineB0: number;
	decision: ReviewDecisionPayload;
	created: boolean;
	abortRun?: ReviewDecisionDeps["abortRun"];
}): Promise<{
	decision: ReviewDecisionPayload;
	created: boolean;
	route: ReviewDecisionRoute;
}> {
	const { ctx, decision } = input;
	const runId = input.runId;
	const authoritativeAcceptance = classifyDecisionAcceptance({
		decision,
		steps: ctx.recordStore.listLines(runId, "steps"),
		budget: ctx.recordStore.listLines(runId, "budget"),
	});
	if (!authoritativeAcceptance.accepted)
		fail(
			"REVIEW_GATE_STALE",
			authoritativeAcceptance.diagnostic ?? "review gate decision is stale",
		);
	const governance = createReviewGovernanceStore(
		ctx.recordStore,
		input.promptStore,
	);
	const state = governance.deriveGoverningState(runId, input.baselineB0);
	const route = routeForStoredDecision(ctx, runId, decision, input.baselineB0);
	resolveGatePromptProjection(
		input.promptStore,
		runId,
		decision.gateId,
		decision.decisionId,
	);
	if (route === "human_gate") {
		const successor = governance.deriveOpenGate(runId);
		if (successor) {
			ensureReviewGatePrompt({
				promptStore: input.promptStore,
				gate: successor,
				baselineReestimatePending: Boolean(state.baselineReestimatePending),
				eligibleFindings: [
					...eligibleFindingMap(
						ctx,
						runId,
						successor.snapshotId,
						successor.causes,
					).values(),
				],
			});
		}
	}
	if (route === "aborted" && getRunV1(ctx.db, runId)?.status === "active")
		await (input.abortRun ?? defaultAbort)({
			runId,
			rationale: decision.rationale,
			context: ctx,
		});
	return { decision, created: input.created, route };
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

/** Explicit `5x review implementation bind`. Uses the same admission validator. */
export async function bindApprovedImplementation(
	input: { executionRunId: string; sourceRunId: string },
	deps: { context: ReviewBudgetCommandContext },
): Promise<{
	created: boolean;
	bindingId: string;
	executionRunId: string;
	sourceRunId: string;
	approvedPlanCommit: string;
	approvedPlanHash: string;
	mode: "advisory" | "enforced";
	b0: number;
	governingB: number;
}> {
	const ctx = deps.context;
	const planPath = ctx.executionContext.run.plan_path;
	let planMarkdown: string;
	try {
		planMarkdown = readFileSync(ctx.executionContext.effectivePlanPath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CliError("PLAN_NOT_FOUND", `Failed to read plan: ${message}`);
	}
	const result = await ensureImplementationAdmission({
		store: ctx.store,
		recordStore: ctx.recordStore,
		executionRunId: input.executionRunId,
		planPath,
		planMarkdown,
		configuredMode: ctx.config.reviewBudget.mode,
		origin: ctx.originFor({ kind: "human", role: "operator" }),
		explicitSourceRunId: input.sourceRunId,
		workdir: ctx.executionContext.effectiveWorkingDirectory,
		controlPlaneRoot: ctx.executionContext.controlPlaneRoot,
	});
	if (result.status === "bound") {
		return {
			created: result.created,
			bindingId: result.binding.id,
			executionRunId: result.binding.executionRunId,
			sourceRunId: result.binding.sourceRunId,
			approvedPlanCommit: result.binding.approvedPlanCommit,
			approvedPlanHash: result.binding.approvedPlanHash,
			mode: result.binding.mode,
			b0: result.binding.b0,
			governingB: result.binding.governingB,
		};
	}
	if (result.status === "approval_required" || result.status === "error") {
		throw new CliError(result.code, result.message, result.detail);
	}
	throw new CliError(
		"IMPLEMENTATION_PLAN_UNAPPROVED",
		"Implementation bind did not establish an approved execution binding",
	);
}

/** `5x review corrections finish`. Runs the full quality configuration. */
export async function finishImplementationCorrections(
	input: {
		runId: string;
		phase: string;
		observationId: string;
		commit: string;
	},
	deps: { context: ReviewBudgetCommandContext },
): Promise<Awaited<ReturnType<typeof finishImplementationCorrection>>> {
	const ctx = deps.context;
	const target = await resolveQualityTarget({
		run: input.runId,
		db: ctx.db,
		startDir: ctx.executionContext.effectiveWorkingDirectory,
	});
	const repoRoot = ctx.executionContext.effectiveWorkingDirectory;
	const result = await finishImplementationCorrection({
		runId: input.runId,
		phase: input.phase,
		observationId: input.observationId,
		commit: input.commit,
		store: ctx.store,
		recordStore: ctx.recordStore,
		origin: ctx.originFor({ kind: "system", role: "cli" }),
		executionDirectory: target.projectRoot,
		planRepoPath: planRepoPath(ctx.executionContext.run.plan_path, repoRoot),
		gates: target.qualityGates,
		skipQualityGates: target.skipQualityGates,
		git: workdirCodeDiffGit(repoRoot),
		runQuality: async () => {
			const quality = await runQualityCore({
				run: input.runId,
				phase: input.phase,
				db: ctx.db,
				startDir: repoRoot,
				record: false,
			});
			return {
				passed: quality.passed,
				...(quality.skipped ? { skipped: true } : {}),
				workdir: quality.workdir,
				results: quality.results.flatMap((entry) => {
					if (!entry || typeof entry !== "object") return [];
					const row = entry as {
						command?: unknown;
						passed?: unknown;
						duration_ms?: unknown;
						output?: unknown;
					};
					return [
						{
							...(typeof row.command === "string"
								? { command: row.command }
								: {}),
							...(typeof row.passed === "boolean"
								? { passed: row.passed }
								: {}),
							...(typeof row.duration_ms === "number"
								? { duration_ms: row.duration_ms }
								: {}),
							...(typeof row.output === "string" ? { output: row.output } : {}),
						},
					];
				}),
			};
		},
	});
	if (result.status === "error") {
		throw new CliError(result.code, result.message);
	}
	return result;
}

export async function showReviewGate(
	runId: string,
	deps: ReviewDecisionDeps = {},
	options: { phase?: string } = {},
) {
	if (!options.phase) return showPlanReviewGate(runId, deps);
	return showImplementationReviewGate(runId, options.phase, deps);
}

export async function submitReviewDecision(
	input: SubmitPlanReviewDecisionInput & {
		phase?: string;
		claimAdjustments?: ImplementationDecisionPayload["claimAdjustments"];
	},
	deps: ReviewDecisionDeps = {},
) {
	const ctx =
		deps.context ??
		(await (deps.createContext ?? createReviewBudgetContext)(
			{ runId: input.runId },
			deps.warn ?? ((message) => console.error(`Warning: ${message}`)),
		));
	const storedLine = ctx.recordStore.getLine(
		input.runId,
		"decisions",
		governanceDecisionKey(input.gateId),
	);
	if (storedLine) {
		try {
			const stored = decodeImplementationDecisionPayload(storedLine.payload);
			return acceptStoredImplementationDecision(
				{ ...input, phase: stored.phase },
				stored,
				{ ...deps, context: ctx },
			);
		} catch (error) {
			if (error instanceof CliError) throw error;
		}
	}
	const gate = findImplementationGate(
		ctx,
		input.runId,
		input.gateId,
		input.phase,
	);
	if (!gate) return submitPlanReviewDecision(input, { ...deps, context: ctx });
	return submitImplementationReviewDecision(
		{ ...input, phase: gate.phase },
		{ ...deps, context: ctx },
	);
}

async function showImplementationReviewGate(
	runId: string,
	phase: string,
	deps: ReviewDecisionDeps,
) {
	const ctx =
		deps.context ??
		(await (deps.createContext ?? createReviewBudgetContext)(
			{ runId },
			deps.warn ?? ((message) => console.error(`Warning: ${message}`)),
		));
	const promptStore =
		deps.promptStore ?? createSqlitePromptStore(ctx.db as Database);
	const binding = ctx.store.getImplementationBinding(runId);
	if (!binding)
		fail("IMPLEMENTATION_BINDING_MISSING", "implementation binding is missing");
	repairReviewGatePrompts(ctx.recordStore, promptStore, runId);
	const gate = deriveOpenImplementationGate(ctx.recordStore, runId, phase);
	if (!gate)
		return { open: false as const, domain: "implementation" as const, phase };
	const prompt = ensureImplementationGatePrompt({
		promptStore,
		gate,
		ledgerHash: binding.ledgerHash,
		decisionsHash: binding.decisionsHash,
	});
	const context = prompt.context;
	const claimDecision =
		context?.type === "implementation_review_gate" &&
		context.allowedChoices.some(
			(choice) =>
				choice === "approve_higher_burden" ||
				choice === "reduce_scope" ||
				choice === "restore_simplification",
		);
	return {
		open: true as const,
		domain: "implementation" as const,
		gate,
		promptId: prompt.id,
		...context,
		exampleCommand: claimDecision
			? `5x review decide --gate ${gate.gateId} --input-json '{"choice":"<choice>","rationale":"<text>","claimAdjustments":[{"creditClaimId":"<id>","approvedArchitectureDelta":0}]}'`
			: `5x review decide --gate ${gate.gateId} --choice <choice> --rationale '<text>'`,
	};
}

async function acceptStoredImplementationDecision(
	input: SubmitPlanReviewDecisionInput & {
		phase: string;
		claimAdjustments?: ImplementationDecisionPayload["claimAdjustments"];
	},
	stored: ImplementationDecisionPayload,
	deps: ReviewDecisionDeps,
) {
	const ctx = deps.context;
	if (!ctx) fail("NO_CONTROL_PLANE", "review context is missing");
	const promptStore =
		deps.promptStore ?? createSqlitePromptStore(ctx.db as Database);
	const binding = ctx.store.getImplementationBinding(input.runId);
	if (!binding)
		fail("IMPLEMENTATION_BINDING_MISSING", "implementation binding is missing");
	const observation = ctx.store
		.listImplementationReviews(input.runId)
		.find((candidate) => candidate.id === stored.observationId);
	const eligible = new Map<string, string>();
	for (const ref of stored.findingRefs)
		eligible.set(ref.findingId, ref.fingerprint);
	for (const cause of observation?.gateCauses ?? []) {
		if ("findingId" in cause) eligible.set(cause.findingId, cause.fingerprint);
	}
	const findingRefs = implementationFindingRefs({
		eligible,
		findingIds: input.findingIds ?? [],
		supplied: input.payload.findingRefs ?? [],
	});
	let proposed: ImplementationDecisionPayload;
	try {
		proposed = createImplementationDecision({
			gateId: stored.gateId,
			observationId: stored.observationId,
			bindingId: stored.bindingId,
			phase: stored.phase,
			choice: input.payload.choice as ImplementationDecisionChoice,
			findingRefs,
			rationale: input.payload.rationale,
			evidence: input.payload.evidence ?? [],
			claimAdjustments: input.claimAdjustments ?? [],
			ledgerHash: stored.ledgerHash,
			decisionsHash: stored.decisionsHash,
			createdAt: stored.createdAt,
		});
	} catch (error) {
		fail(
			"REVIEW_DECISION_INVALID",
			error instanceof Error ? error.message : String(error),
		);
	}
	if (proposed.decisionIntentHash !== stored.decisionIntentHash)
		fail(
			"REVIEW_GATE_ALREADY_RESOLVED",
			"review gate was resolved by a different decision",
			{ decision: stored },
		);
	return finishImplementationDecision({
		ctx,
		promptStore,
		deps,
		runId: input.runId,
		binding,
		stored,
		created: false,
	});
}

function implementationFindingRefs(input: {
	eligible: ReadonlyMap<string, string>;
	findingIds: readonly string[];
	supplied: readonly FindingIdentity[];
}): FindingIdentity[] {
	if (
		input.supplied.some(
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
	const findingIds = [...input.findingIds];
	const findingRefs = [...input.supplied];
	const allFindingIds = [
		...findingIds,
		...findingRefs.map((ref) => ref.findingId),
	];
	if (
		duplicates(findingIds).length ||
		duplicates(findingRefs.map((ref) => ref.findingId)).length ||
		duplicates(allFindingIds).length
	)
		fail(
			"REVIEW_DECISION_INVALID",
			"duplicate finding identities are not allowed",
		);
	for (const findingId of findingIds) {
		const fingerprint = input.eligible.get(findingId);
		if (!fingerprint)
			fail(
				"REVIEW_DECISION_FINDING_INVALID",
				`finding ${findingId} is not eligible for this gate`,
			);
		findingRefs.push({ findingId, fingerprint });
	}
	for (const ref of findingRefs) {
		const fingerprint = input.eligible.get(ref.findingId);
		if (!fingerprint || fingerprint !== ref.fingerprint)
			fail(
				"REVIEW_DECISION_FINDING_INVALID",
				`finding ${ref.findingId} is unknown, stale, or has a mismatched fingerprint`,
			);
	}
	return findingRefs;
}

function findImplementationGate(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	gateId: string,
	phase?: string,
) {
	const phases = phase
		? [phase]
		: [
				...new Set(
					ctx.store
						.listImplementationReviews(runId)
						.map((observation) => observation.phase),
				),
			];
	for (const candidate of phases) {
		const gate = deriveOpenImplementationGate(
			ctx.recordStore,
			runId,
			candidate,
		);
		if (gate?.gateId === gateId) return gate;
	}
	return null;
}

async function submitImplementationReviewDecision(
	input: SubmitPlanReviewDecisionInput & {
		phase: string;
		claimAdjustments?: ImplementationDecisionPayload["claimAdjustments"];
	},
	deps: ReviewDecisionDeps,
) {
	const ctx = deps.context;
	if (!ctx) fail("NO_CONTROL_PLANE", "review context is missing");
	const promptStore =
		deps.promptStore ?? createSqlitePromptStore(ctx.db as Database);
	const binding = ctx.store.getImplementationBinding(input.runId);
	if (!binding)
		fail("IMPLEMENTATION_BINDING_MISSING", "implementation binding is missing");
	const gate = findImplementationGate(
		ctx,
		input.runId,
		input.gateId,
		input.phase,
	);
	if (!gate)
		fail(
			"REVIEW_GATE_NOT_OPEN",
			`Review gate ${input.gateId} is not the current open gate`,
		);
	const choice = input.payload.choice as ImplementationDecisionChoice;
	const allowed = allowedImplementationChoices(gate.causes);
	if (!allowed.includes(choice))
		fail("REVIEW_DECISION_INVALID", `${choice} is not allowed for this gate`);
	const claimIds = new Set(binding.debtTargets.map((target) => target.claimId));
	const originals = new Map(
		binding.ledger.workItems.flatMap((item) =>
			item.debtClaim
				? [[item.debtClaim.debtClaimId, item.architectureDelta] as const]
				: [],
		),
	);
	const findingRefs = implementationFindingRefs({
		eligible: new Map(
			gate.causes.flatMap((cause) =>
				"findingId" in cause
					? [[cause.findingId, cause.fingerprint] as const]
					: [],
			),
		),
		findingIds: input.findingIds ?? [],
		supplied: input.payload.findingRefs ?? [],
	});
	const gateClaimIds = new Set(
		gate.causes.flatMap((cause) =>
			cause.kind === "credit_shortfall" || cause.kind === "credit_unreconciled"
				? cause.claimIds
				: [],
		),
	);
	let decision: ImplementationDecisionPayload;
	try {
		decision = createImplementationDecision({
			gateId: gate.gateId,
			observationId: gate.observationId,
			bindingId: binding.id,
			phase: gate.phase,
			choice,
			findingRefs,
			rationale: input.payload.rationale,
			evidence: input.payload.evidence ?? [],
			claimAdjustments: input.claimAdjustments ?? [],
			ledgerHash: binding.ledgerHash,
			decisionsHash: binding.decisionsHash,
			createdAt: deps.now?.() ?? new Date().toISOString(),
		});
		assertImplementationDecisionScope({
			decision,
			allowedClaimIds: claimIds,
			originalDeltas: originals,
			gateClaimIds,
		});
	} catch (error) {
		fail(
			"REVIEW_DECISION_INVALID",
			error instanceof Error ? error.message : String(error),
		);
	}
	const run = getRunV1(ctx.db, input.runId);
	if (!run) fail("RUN_NOT_FOUND", `Run ${input.runId} not found`);
	let admitted: Awaited<ReturnType<typeof prepareRecordStepAppend>>;
	try {
		admitted = await prepareRecordStepAppend(
			{
				run: input.runId,
				stepName: "human:review-governance",
				phase: gate.phase,
				result: JSON.stringify({
					decisionId: decision.decisionId,
					gateId: decision.gateId,
					choice: decision.choice,
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
					payload: encodeImplementationDecisionPayload(decision),
					createdAt: decision.createdAt,
					...envelope,
				},
			],
		},
	);
	const stored =
		written.outcome === "coupled-key-exists"
			? decodeImplementationDecisionPayload(written.line.payload)
			: decision;
	if (
		written.outcome === "coupled-key-exists" &&
		stored.decisionIntentHash !== decision.decisionIntentHash
	)
		fail(
			"REVIEW_GATE_ALREADY_RESOLVED",
			"review gate was resolved by a different decision",
			{ decision: stored },
		);
	return finishImplementationDecision({
		ctx,
		promptStore,
		deps,
		runId: input.runId,
		binding,
		stored,
		created: written.outcome !== "coupled-key-exists",
	});
}

async function finishImplementationDecision(input: {
	ctx: ReviewBudgetCommandContext;
	promptStore: PromptStore;
	deps: ReviewDecisionDeps;
	runId: string;
	binding: NonNullable<
		ReturnType<ReviewBudgetCommandContext["store"]["getImplementationBinding"]>
	>;
	stored: ImplementationDecisionPayload;
	created: boolean;
}) {
	const { ctx, promptStore, deps, stored, binding } = input;
	const acceptance = classifyDecisionAcceptance({
		decision: stored,
		steps: ctx.recordStore.listLines(input.runId, "steps"),
		budget: ctx.recordStore.listLines(input.runId, "budget"),
	});
	if (!acceptance.accepted)
		fail(
			"REVIEW_GATE_STALE",
			acceptance.diagnostic ?? "review gate decision is stale",
		);
	resolveGatePromptProjection(
		promptStore,
		input.runId,
		stored.gateId,
		stored.decisionId,
	);
	const successor = deriveOpenImplementationGate(
		ctx.recordStore,
		input.runId,
		stored.phase,
	);
	const nextAction = implementationDecisionNextAction(
		stored.choice,
		successor && successor.gateId !== stored.gateId
			? successor.causes.length
			: 0,
	);
	if (successor && successor.gateId !== stored.gateId)
		ensureImplementationGatePrompt({
			promptStore,
			gate: successor,
			ledgerHash: binding.ledgerHash,
			decisionsHash: binding.decisionsHash,
		});
	const route =
		nextAction === "aborted"
			? "aborted"
			: nextAction === "human_gate"
				? "human_gate"
				: nextAction === "complete"
					? "complete"
					: "author_revision";
	if (route === "aborted" && getRunV1(ctx.db, input.runId)?.status === "active")
		await (deps.abortRun ?? defaultAbort)({
			runId: input.runId,
			rationale: stored.rationale,
			context: ctx,
		});
	return {
		decision: stored,
		created: input.created,
		route,
		nextAction,
		...(successor && successor.gateId !== stored.gateId
			? { successorGateId: successor.gateId }
			: {}),
	};
}
