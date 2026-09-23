import type { Database } from "bun:sqlite";
import type { RecordLine, StepRecordPayload } from "../control-plane/index.js";
import { stepIdempotencyKey } from "../control-plane/index.js";
import type {
	RecordOrigin,
	RecordPerformer,
} from "../control-plane/record-types.js";
import type { RecordCommandContext } from "../control-plane/record-writer-types.js";
import { createReviewBudgetIndex } from "../control-plane/review-budget-index.js";
import {
	createReviewBudgetStore,
	type ReviewBudgetStore,
} from "../control-plane/review-budget-store.js";
import { createSqlitePromptStore } from "../control-plane/sqlite-store.js";
import {
	computeRunSummary,
	getRunV1,
	getStepsByPhase,
	recordStep,
} from "../db/operations-v1.js";
import type { ReviewerVerdict } from "../protocol.js";
import {
	applyPlanReviewBudget,
	type BaselineAssessmentContract,
	baselineAssessmentContract,
	type PendingBudgetSnapshot,
} from "../review-budget/apply.js";
import {
	type EnsurePlanReviewBaselineResult,
	ensurePlanReviewBaseline,
} from "../review-budget/ensure-baseline.js";
import {
	encodeBudgetSnapshotPayload,
	snapshotIdempotencyKey,
} from "../review-budget/record-lines.js";
import { applyPlanReviewGovernance } from "../review-governance/apply.js";
import { validateClosureReview } from "../review-governance/closure.js";
import {
	buildPlanReviewDiffContext,
	PlanDiffError,
	type PlanDiffFailure,
} from "../review-governance/plan-diff.js";
import {
	createReviewGovernanceStore,
	ensureReviewGatePrompt,
	repairReviewGatePrompts,
} from "../review-governance/store.js";
import { createRecordContext } from "./record-context.js";
import {
	finalizeAndWritePreparedStep,
	prepareRecordStepAppend,
	RecordError,
	type RecordStepResult,
	type RunRecordParams,
} from "./run-v1.handler.js";
import type { PriorReviewIdentity } from "./template-vars.js";

export interface ReviewBudgetCommandContext extends RecordCommandContext {
	store: ReviewBudgetStore;
}

function projectDurableSnapshot(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	key: string,
	pending: PendingBudgetSnapshot,
): void {
	const durable = ctx.store.projectSnapshot(runId, key);
	if (
		durable &&
		JSON.stringify(durable.currentLedger) ===
			JSON.stringify(pending.currentLedger) &&
		JSON.stringify(durable.findings) === JSON.stringify(pending.findings) &&
		JSON.stringify(durable.assessments) ===
			JSON.stringify(pending.assessments) &&
		JSON.stringify(durable.baselineAssessment) ===
			JSON.stringify(pending.baselineAssessment) &&
		JSON.stringify(durable.priorFindings ?? []) ===
			JSON.stringify(pending.priorFindings) &&
		JSON.stringify(durable.effectiveGateCauses) ===
			JSON.stringify(pending.effectiveGateCauses) &&
		JSON.stringify(durable.suppressedGateCauses) ===
			JSON.stringify(pending.suppressedGateCauses) &&
		JSON.stringify(durable.diagnostics ?? []) ===
			JSON.stringify(pending.diagnostics)
	) {
		ctx.store.projectSnapshot(runId, key, pending.derived);
	}
}

function repairGovernanceProjection(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	pending: PendingBudgetSnapshot,
): void {
	if (pending.mode !== "enforced" || pending.effectiveGateCauses.length === 0)
		return;
	const promptStore = createSqlitePromptStore(ctx.db as Database);
	const governance = createReviewGovernanceStore(ctx.recordStore, promptStore);
	repairReviewGatePrompts(ctx.recordStore, promptStore, runId);
	const gate = governance.deriveOpenGate(runId);
	if (!gate || gate.snapshotId !== pending.id) return;
	const baseline = ctx.store.getBaseline(runId);
	if (!baseline) return;
	const state = governance.deriveGoverningState(runId, baseline.b0);
	ensureReviewGatePrompt({
		promptStore,
		gate,
		baselineReestimatePending: Boolean(state.baselineReestimatePending),
		eligibleFindings: pending.findings.flatMap((finding) =>
			finding.fingerprint
				? [{ findingId: finding.id, fingerprint: finding.fingerprint }]
				: [],
		),
	});
}

export async function createReviewBudgetContext(
	input: Parameters<typeof createRecordContext>[0],
	onDiagnostic?: (message: string) => void,
): Promise<ReviewBudgetCommandContext> {
	const record = await createRecordContext(input);
	return {
		...record,
		store: createReviewBudgetStore(
			record.recordStore,
			createReviewBudgetIndex(record.db),
			onDiagnostic,
		),
	};
}

export function hasPriorPlanReviewerStep(
	ctx: Pick<ReviewBudgetCommandContext, "db" | "recordStore">,
	runId: string,
): boolean {
	const isPlanReviewer = (stepName: unknown, phase: unknown) =>
		phase === "plan" &&
		typeof stepName === "string" &&
		stepName.startsWith("reviewer:");
	if (
		getStepsByPhase(ctx.db, runId, "plan").some((step) =>
			isPlanReviewer(step.step_name, step.phase),
		)
	) {
		return true;
	}
	return ctx.recordStore.listLines(runId, "steps").some((line) => {
		const payload = line.payload as Partial<StepRecordPayload>;
		return isPlanReviewer(payload.step_name, payload.phase);
	});
}

/** Durable snapshots of an active-budget run; null when no baseline governs it. */
function activePlanReviewSnapshots(
	ctx: Pick<ReviewBudgetCommandContext, "recordStore" | "store">,
	runId: string,
) {
	try {
		if (ctx.recordStore.getRun(runId) === null) return null;
	} catch {
		// A mode-off legacy run may not have an authoritative records directory.
		return null;
	}
	return ctx.store.getBaseline(runId) ? ctx.store.listSnapshots(runId) : null;
}

/**
 * Step identity of the latest recorded plan review, taken from the durable
 * budget snapshot — the same identity closure composition diffs against.
 */
export function latestPlanReviewIdentity(
	ctx: Pick<ReviewBudgetCommandContext, "recordStore" | "store">,
	runId: string,
): PriorReviewIdentity | undefined {
	const latest = activePlanReviewSnapshots(ctx, runId)?.at(-1);
	return latest?.stepName
		? {
				stepName: latest.stepName,
				phase: latest.phase,
				iteration: latest.iteration,
			}
		: undefined;
}

/**
 * The `baselineAssessment` contract the budget validator will apply to a
 * plan-reviewer verdict recorded under `step`. Undefined when no active
 * baseline governs the run (mode off or v1-compatible), where the generic
 * schema applies.
 */
export function planReviewBaselineAssessmentContract(
	ctx: Pick<ReviewBudgetCommandContext, "recordStore" | "store">,
	runId: string,
	step: Parameters<typeof baselineAssessmentContract>[1],
): BaselineAssessmentContract | undefined {
	const snapshots = activePlanReviewSnapshots(ctx, runId);
	return snapshots ? baselineAssessmentContract(snapshots, step) : undefined;
}

export type ComposePlanReviewerRecordResult =
	| { status: "skipped"; reason: "off" | "v1_compat" }
	| { status: "error"; code: string; message: string; detail?: unknown }
	| {
			status: "applied";
			verdict: ReviewerVerdict & {
				budget: import("../review-budget/types.js").DerivedBudgetResult;
				governance: import("../review-governance/types.js").PlanReviewGovernanceResult;
			};
			pendingSnapshot: PendingBudgetSnapshot;
	  };

/** Shared protocol/invoke composition before the paired writer. */
export async function composePlanReviewerRecord(input: {
	ctx: ReviewBudgetCommandContext;
	runId: string;
	stepName: string;
	phase: string | undefined;
	iteration: number | undefined;
	planMarkdown: string;
	verdict: ReviewerVerdict;
	optInBaseline: boolean;
	origin: RecordOrigin;
	warn: (message: string) => void;
	buildDiffContext?: typeof buildPlanReviewDiffContext;
}): Promise<ComposePlanReviewerRecordResult> {
	const baseline = input.ctx.store.getBaseline(input.runId);
	const mode = baseline?.mode ?? input.ctx.config.reviewBudget.mode;
	const snapshotsBefore = baseline
		? input.ctx.store.listSnapshots(input.runId)
		: [];
	const governance = createReviewGovernanceStore(input.ctx.recordStore);
	const decisions = governance.listDecisions(input.runId);
	let governingState = baseline
		? governance.deriveGoverningState(input.runId, baseline.b0)
		: undefined;

	// An initial enforced verdict must fail before baseline capture.
	if (!baseline && mode === "enforced") {
		const precheck = validateClosureReview({
			reviewKind: "initial",
			mode,
			verdict: input.verdict,
			priorFindings: [],
			priorDecisions: decisions,
		});
		if (!precheck.accepted) {
			const first = precheck.diagnostics.find(
				(diagnostic) => diagnostic.severity === "error",
			);
			return {
				status: "error",
				code: first?.code ?? "CLOSURE_REVIEW_INVALID",
				message: first?.message ?? "Initial review evidence is invalid.",
				detail: { diagnostics: precheck.diagnostics },
			};
		}
	}

	const budget = applyPlanReviewBudget({
		runId: input.runId,
		stepName: input.stepName,
		phase: input.phase,
		iteration: input.iteration,
		planMarkdown: input.planMarkdown,
		verdict: input.verdict,
		config: input.ctx.config.reviewBudget,
		store: input.ctx.store,
		hasPriorPlanReviewerStep: hasPriorPlanReviewerStep(input.ctx, input.runId),
		optInBaseline: input.optInBaseline,
		origin: input.origin,
		warn: input.warn,
		...(governingState
			? { governingBaseline: governingState.governingBaseline }
			: {}),
	});
	if (budget.status !== "applied") return budget;
	const activeBaseline = input.ctx.store.getBaseline(input.runId);
	if (!activeBaseline)
		return {
			status: "error",
			code: "BUDGET_BASELINE_MISSING",
			message: "Review budget baseline is missing",
		};
	governingState ??= governance.deriveGoverningState(
		input.runId,
		activeBaseline.b0,
	);
	const priorSnapshot = snapshotsBefore
		.filter((snapshot) => snapshot.id !== budget.pendingSnapshot.id)
		.at(-1);
	let diffContext:
		| import("../review-governance/types.js").PlanDiffContext
		| undefined;
	let diffContextFailure: PlanDiffFailure | undefined;
	if (priorSnapshot?.stepName) {
		const priorStep = input.ctx.recordStore
			.listLines(input.runId, "steps")
			.find((line) => {
				const payload = line.payload as Partial<StepRecordPayload>;
				return (
					payload.step_name === priorSnapshot.stepName &&
					(payload.phase ?? null) === priorSnapshot.phase &&
					payload.iteration === priorSnapshot.iteration
				);
			});
		const head = (priorStep?.payload as Partial<StepRecordPayload> | undefined)
			?.head_commit;
		if (head) {
			try {
				diffContext = await (
					input.buildDiffContext ?? buildPlanReviewDiffContext
				)({
					workdir: input.ctx.executionContext.effectiveWorkingDirectory,
					planPath: input.ctx.executionContext.effectivePlanPath,
					previousReviewCommit: head,
				});
			} catch (error) {
				diffContextFailure =
					error instanceof PlanDiffError
						? { code: error.code, message: error.message }
						: {
								code: "PLAN_DIFF_GIT_ERROR",
								message: error instanceof Error ? error.message : String(error),
							};
			}
		}
	}
	const composed = applyPlanReviewGovernance({
		verdict: input.verdict,
		budgetResult: budget,
		snapshots: snapshotsBefore,
		decisions,
		governingState,
		mode: activeBaseline.mode,
		...(diffContext ? { diffContext } : {}),
		...(diffContextFailure ? { diffContextFailure } : {}),
	});
	return composed.status === "error"
		? { ...composed, detail: { diagnostics: composed.diagnostics } }
		: composed;
}

/** Shared capture entry point for render, invoke, and record-time safety nets. */
export function ensurePlanReviewBaselineForContext(input: {
	ctx: ReviewBudgetCommandContext;
	runId: string;
	planMarkdown: string;
	optIn: boolean;
	performer: RecordPerformer;
	warn: (message: string) => void;
}): EnsurePlanReviewBaselineResult {
	return ensurePlanReviewBaseline({
		runId: input.runId,
		planMarkdown: input.planMarkdown,
		config: input.ctx.config.reviewBudget,
		store: input.ctx.store,
		hasPriorPlanReviewerStep: hasPriorPlanReviewerStep(input.ctx, input.runId),
		optIn: input.optIn,
		origin: input.ctx.originFor(input.performer),
		warn: input.warn,
	});
}

function projectStepLine(
	ctx: ReviewBudgetCommandContext,
	prepared: Awaited<ReturnType<typeof prepareRecordStepAppend>>["prepared"],
	line: RecordLine,
): ReturnType<typeof recordStep> {
	const payload = line.payload as StepRecordPayload;
	return recordStep(ctx.db, {
		run_id: prepared.runId,
		step_name: payload.step_name,
		phase: payload.phase ?? undefined,
		iteration: payload.iteration,
		result_json: JSON.stringify(payload.result_json),
		session_id: prepared.sessionId,
		model: payload.model ?? undefined,
		tokens_in: payload.tokens_in ?? undefined,
		tokens_out: payload.tokens_out ?? undefined,
		cost_usd: payload.cost_usd ?? undefined,
		duration_ms: payload.duration_ms ?? undefined,
		log_path: prepared.logPath,
		head_commit: payload.head_commit ?? undefined,
	});
}

export async function recordPlanReviewerStepWithSnapshot(
	params: RunRecordParams & { run: string; stepName: string; result: string },
	pending: PendingBudgetSnapshot,
	ctx: ReviewBudgetCommandContext,
): Promise<RecordStepResult & { max_steps: number }> {
	const admitted = await prepareRecordStepAppend(params, ctx);
	const { prepared } = admitted;
	const run = getRunV1(ctx.db, prepared.runId);
	if (!run)
		throw new RecordError("RUN_NOT_FOUND", `Run ${prepared.runId} not found`);

	if (admitted.outcome === "duplicate") {
		if (prepared.iteration === undefined) {
			throw new RecordError(
				"INVALID_RECORD_IDENTITY",
				"Duplicate step has no iteration",
			);
		}
		const stepKey = stepIdempotencyKey({
			runId: prepared.runId,
			stepName: prepared.stepName,
			phase: prepared.phase ?? null,
			iteration: prepared.iteration,
		});
		const line = ctx.recordStore.getLine(prepared.runId, "steps", stepKey);
		const dbResult = line
			? projectStepLine(ctx, prepared, line)
			: recordStep(ctx.db, {
					run_id: prepared.runId,
					step_name: prepared.stepName,
					phase: prepared.phase,
					iteration: prepared.iteration,
					result_json: prepared.resultJson,
					session_id: prepared.sessionId,
					model: prepared.model,
					tokens_in: prepared.tokensIn,
					tokens_out: prepared.tokensOut,
					cost_usd: prepared.costUsd,
					duration_ms: prepared.durationMs,
					log_path: prepared.logPath,
					head_commit: prepared.headCommit,
				});
		const snapshotKey = snapshotIdempotencyKey(prepared.runId, {
			stepName: prepared.stepName,
			phase: prepared.phase ?? null,
			iteration: prepared.iteration,
		});
		projectDurableSnapshot(ctx, prepared.runId, snapshotKey, pending);
		repairGovernanceProjection(ctx, prepared.runId, pending);
		const after = computeRunSummary(ctx.db, prepared.runId);
		return {
			...dbResult,
			recorded: false,
			total_steps: after.total_steps,
			max_steps: prepared.maxSteps,
		};
	}

	const written = await finalizeAndWritePreparedStep(
		prepared,
		{
			db: ctx.db,
			config: ctx.config,
			recordStore: ctx.recordStore,
			originFor: ctx.originFor,
			run,
		},
		{
			mode: "paired-all-new",
			extraOps: (finalized, envelope) => {
				const stepKey = {
					stepName: finalized.stepName,
					phase: finalized.phase ?? null,
					iteration: finalized.iteration,
				};
				const createdAt = new Date()
					.toISOString()
					.replace("T", " ")
					.slice(0, 19);
				return [
					{
						runId: finalized.runId,
						stream: "budget",
						idempotencyKey: snapshotIdempotencyKey(finalized.runId, stepKey),
						payload: encodeBudgetSnapshotPayload({
							kind: "snapshot",
							id: pending.id,
							runId: finalized.runId,
							stepKey,
							currentLedger: pending.currentLedger,
							findings: pending.findings,
							assessments: pending.assessments,
							...(pending.baselineAssessment
								? { baselineAssessment: pending.baselineAssessment }
								: {}),
							priorFindings: pending.priorFindings,
							effectiveGateCauses: pending.effectiveGateCauses,
							suppressedGateCauses: pending.suppressedGateCauses,
							diagnostics: pending.diagnostics,
							createdAt,
						}),
						createdAt,
						...envelope,
					},
				];
			},
		},
	);
	if (written.outcome === "coupled-key-exists") {
		throw new RecordError(
			"RECORD_PAIR_CORRUPT",
			"Budget snapshot identity exists without its coupled step",
		);
	}
	const snapshotKey = snapshotIdempotencyKey(prepared.runId, {
		stepName: written.finalized.stepName,
		phase: written.finalized.phase ?? null,
		iteration: written.finalized.iteration,
	});
	projectDurableSnapshot(ctx, prepared.runId, snapshotKey, pending);
	repairGovernanceProjection(ctx, prepared.runId, pending);
	const after = computeRunSummary(ctx.db, prepared.runId);
	return {
		...written.dbResult,
		recorded: written.recorded && written.dbResult.recorded,
		total_steps: after.total_steps,
		max_steps: prepared.maxSteps,
	};
}
