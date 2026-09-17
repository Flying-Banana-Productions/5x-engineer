import { createReviewBudgetId } from "../control-plane/ids.js";
import type { RecordLine, StepRecordPayload } from "../control-plane/index.js";
import { stepIdempotencyKey } from "../control-plane/index.js";
import type { RecordPerformer } from "../control-plane/record-types.js";
import type { RecordCommandContext } from "../control-plane/record-writer-types.js";
import { createReviewBudgetIndex } from "../control-plane/review-budget-index.js";
import {
	createReviewBudgetStore,
	type ReviewBudgetStore,
} from "../control-plane/review-budget-store.js";
import {
	computeRunSummary,
	getRunV1,
	getStepsByPhase,
	recordStep,
} from "../db/operations-v1.js";
import type { PendingBudgetSnapshot } from "../review-budget/apply.js";
import {
	type EnsurePlanReviewBaselineResult,
	ensurePlanReviewBaseline,
} from "../review-budget/ensure-baseline.js";
import {
	encodeBudgetSnapshotPayload,
	snapshotIdempotencyKey,
} from "../review-budget/record-lines.js";
import { createRecordContext } from "./record-context.js";
import {
	finalizeAndWritePreparedStep,
	prepareRecordStepAppend,
	RecordError,
	type RecordStepResult,
	type RunRecordParams,
} from "./run-v1.handler.js";

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
			JSON.stringify(pending.baselineAssessment)
	) {
		ctx.store.projectSnapshot(runId, key, pending.derived);
	}
}

export async function createReviewBudgetContext(
	...args: Parameters<typeof createRecordContext>
): Promise<ReviewBudgetCommandContext> {
	const record = await createRecordContext(...args);
	return {
		...record,
		store: createReviewBudgetStore(
			record.recordStore,
			createReviewBudgetIndex(record.db),
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
							id: createReviewBudgetId(),
							runId: finalized.runId,
							stepKey,
							currentLedger: pending.currentLedger,
							findings: pending.findings,
							assessments: pending.assessments,
							...(pending.baselineAssessment
								? { baselineAssessment: pending.baselineAssessment }
								: {}),
							createdAt,
						}),
						createdAt,
						...envelope,
					},
				];
			},
		},
	);
	const snapshotKey = snapshotIdempotencyKey(prepared.runId, {
		stepName: written.finalized.stepName,
		phase: written.finalized.phase ?? null,
		iteration: written.finalized.iteration,
	});
	projectDurableSnapshot(ctx, prepared.runId, snapshotKey, pending);
	const after = computeRunSummary(ctx.db, prepared.runId);
	return {
		...written.dbResult,
		recorded: written.recorded && written.dbResult.recorded,
		total_steps: after.total_steps,
		max_steps: prepared.maxSteps,
	};
}
