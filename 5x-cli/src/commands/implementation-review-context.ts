/**
 * Shared composition and paired writer for implementation reviews.
 *
 * Plan composition and `recordPlanReviewerStepWithSnapshot` stay the plan
 * path. An implementation observation is a separate budget-stream kind and is
 * never applied as `FindingDelta[]`.
 */

import { createReviewBudgetId } from "../control-plane/ids.js";
import type { RecordLine, StepRecordPayload } from "../control-plane/index.js";
import { stepIdempotencyKey } from "../control-plane/index.js";
import {
	computeRunSummary,
	getRunV1,
	recordStep,
} from "../db/operations-v1.js";
import {
	isImplementationScopeClass,
	type ReviewerVerdict,
	type VerdictItem,
} from "../protocol.js";
import { deriveBudget } from "../review-budget/arithmetic.js";
import {
	encodeImplementationReviewObservationPayload,
	type ImplementationBudgetInvariant,
	type ImplementationObservationGateCause,
	type ImplementationReviewObservationPayload,
	type ImplementationReviewStepKey,
	type ImplementationReviewTelemetry,
	type ImplementationTextAmendmentPayload,
	implementationReviewObservationKey,
} from "../review-budget/record-lines.js";
import type { BudgetAlert, BudgetBand } from "../review-budget/types.js";
import type { CodeDiffContext } from "../review-governance/code-diff.js";
import {
	isExcludedPath,
	parseCodePatch,
} from "../review-governance/code-diff.js";
import {
	canonicalPhaseId,
	readImplementationCodeClosure,
	validateImplementationReview,
} from "../review-governance/implementation.js";
import { listRecordedImplementationReviews } from "../review-governance/implementation-state.js";
import type {
	ImplementationDiagnostic,
	ImplementationNextAction,
	PlanReviewRoute,
} from "../review-governance/types.js";
import type { ReviewBudgetCommandContext } from "./review-budget-context.js";
import {
	deriveImplementationActivityTelemetry,
	finalizeAndWritePreparedStep,
	prepareRecordStepAppend,
	RecordError,
	type RecordStepResult,
	type RunRecordParams,
} from "./run-v1.handler.js";

const WORKFLOW_PATH_PREFIXES = [
	".5x",
	"docs/development/runs",
	"docs/development/reviews",
];

export interface PendingImplementationObservation
	extends Omit<
		ImplementationReviewObservationPayload,
		"createdAt" | "completionAuthorized"
	> {
	/** Always false until the paired append encodes the durable line. */
	completionAuthorized: false;
}

export type ComposeImplementationReviewerRecordResult =
	| { status: "skipped"; reason: "context_missing" | "not_implementation" }
	| { status: "error"; code: string; message: string; detail?: unknown }
	| {
			status: "applied";
			pending: PendingImplementationObservation;
			diagnostics: ImplementationDiagnostic[];
	  };

export interface ImplementationGovernanceDecoration {
	domain: "implementation";
	phase: string;
	route: PlanReviewRoute;
	nextAction: ImplementationNextAction;
	diagnostics: ImplementationDiagnostic[];
	gateCauses: ImplementationObservationGateCause[];
	completionAuthorized: boolean;
	observationId: string;
}

export type RecordImplementationReviewResult = RecordStepResult & {
	max_steps: number;
	observation: ImplementationReviewObservationPayload | null;
	completionAuthorized: boolean;
};

function now(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function workflowPath(path: string, excludedPaths: readonly string[]): boolean {
	if (isExcludedPath(path, excludedPaths)) return true;
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
	return WORKFLOW_PATH_PREFIXES.some(
		(prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
	);
}

function considerAddedPath(
	paths: Set<string>,
	path: string | undefined,
	excludedPaths: readonly string[],
): void {
	if (!path || path === "/dev/null") return;
	const normalized = path.replaceAll("\\", "/");
	if (workflowPath(normalized, excludedPaths)) return;
	paths.add(normalized);
}

/**
 * New files in the prepared diff. Headers cover empty files and binary
 * additions that never produce a text hunk. Workflow artifacts are not
 * code growth. Synthetic contexts without a `diff --git` patch still
 * contribute hunks whose old side is `/dev/null`.
 */
export function addedPathsFromCodeContext(
	codeContext: CodeDiffContext,
): string[] {
	const paths = new Set<string>();
	const parsed = parseCodePatch(codeContext.patch);
	const addedBinary = new Set(
		parsed.addedPaths.filter((path) => parsed.binaryPaths.includes(path)),
	);
	for (const path of parsed.addedPaths) {
		considerAddedPath(paths, path, codeContext.excludedPaths);
	}
	for (const path of codeContext.binaryPaths) {
		if (!addedBinary.has(path) && !parsed.addedPaths.includes(path)) continue;
		considerAddedPath(paths, path, codeContext.excludedPaths);
	}
	if (!codeContext.patch.includes("diff --git ")) {
		for (const hunk of codeContext.hunks) {
			if (hunk.oldPath !== "/dev/null") continue;
			considerAddedPath(paths, hunk.newPath, codeContext.excludedPaths);
		}
	}
	return [...paths].sort();
}

function planAmendmentCount(input: {
	observations: readonly ImplementationReviewObservationPayload[];
	amendments: readonly ImplementationTextAmendmentPayload[];
	current: readonly ImplementationObservationGateCause[];
}): number {
	const byId = new Map(
		input.observations.map((observation) => [observation.id, observation]),
	);
	const fingerprints = new Set<string>();
	const addCauses = (causes: readonly ImplementationObservationGateCause[]) => {
		for (const cause of causes) {
			if (cause.kind === "plan_amendment") fingerprints.add(cause.fingerprint);
		}
	};
	for (const observation of input.observations) {
		addCauses(observation.gateCauses);
	}
	for (const amendment of input.amendments) {
		const source = byId.get(amendment.sourceObservationId);
		if (!source) continue;
		addCauses(source.gateCauses);
	}
	addCauses(input.current);
	return fingerprints.size;
}

function classCounts(
	items: readonly VerdictItem[],
): ImplementationReviewTelemetry["classCounts"] {
	const counts = {
		implementation_defect: 0,
		plan_defect: 0,
		scope_expansion: 0,
		pre_existing: 0,
	};
	for (const item of items) {
		if (isImplementationScopeClass(item.scopeClass))
			counts[item.scopeClass] += 1;
	}
	return counts;
}

function boundaryInventory(
	items: readonly VerdictItem[],
): ImplementationReviewTelemetry["boundaryInventory"] {
	return items.flatMap((item) => {
		if (!isImplementationScopeClass(item.scopeClass)) return [];
		return [
			{
				itemId: item.id,
				changes: item.boundaryChanges ? [...item.boundaryChanges] : [],
				unknown: item.boundaryChanges === undefined,
			},
		];
	});
}

function variance(items: readonly VerdictItem[]): {
	effortVariance: number;
	architectureVariance: number;
} {
	let effortVariance = 0;
	let architectureVariance = 0;
	for (const item of items) {
		if (!isImplementationScopeClass(item.scopeClass)) continue;
		effortVariance += item.effortDelta ?? 0;
		architectureVariance += item.architectureDelta ?? 0;
	}
	return { effortVariance, architectureVariance };
}

/**
 * Completion is authorized only for a clean complete route, and only when the
 * caller reads it back from the durable line.
 */
export function implementationCompletionAuthorized(input: {
	route: PlanReviewRoute;
	nextAction: ImplementationNextAction;
	gateCauses: readonly ImplementationObservationGateCause[];
}): boolean {
	return (
		input.route === "complete" &&
		input.nextAction === "complete" &&
		input.gateCauses.length === 0
	);
}

export function implementationGovernanceDecoration(
	observation: Pick<
		ImplementationReviewObservationPayload,
		| "domain"
		| "phase"
		| "route"
		| "nextAction"
		| "diagnostics"
		| "gateCauses"
		| "completionAuthorized"
		| "id"
	>,
): ImplementationGovernanceDecoration {
	return {
		domain: observation.domain,
		phase: observation.phase,
		route: observation.route,
		nextAction: observation.nextAction,
		diagnostics: observation.diagnostics,
		gateCauses: observation.gateCauses,
		completionAuthorized: observation.completionAuthorized,
		observationId: observation.id,
	};
}

function gateCausesFor(input: {
	items: readonly VerdictItem[];
	identities: ReadonlyMap<string, { findingId: string; fingerprint: string }>;
	exemptionAuthorized: boolean;
	inheritedRequiresHuman: boolean;
	band: BudgetBand;
	alerts: readonly BudgetAlert[];
}): ImplementationObservationGateCause[] {
	const causes: ImplementationObservationGateCause[] = [];
	for (const item of input.items) {
		const identity = input.identities.get(item.id);
		if (!identity) continue;
		if (item.lateDiscovery === "critical_safety") {
			causes.push({ kind: "critical_safety", ...identity });
			continue;
		}
		const textOnly =
			item.scopeClass === "plan_defect" &&
			item.planImpact?.kind === "text_only" &&
			input.exemptionAuthorized;
		if (item.scopeClass === "plan_defect" && !textOnly) {
			causes.push({ kind: "plan_amendment", ...identity });
			continue;
		}
		if (
			item.scopeClass === "scope_expansion" ||
			item.action === "human_required" ||
			(item.boundaryChanges !== undefined && item.boundaryChanges.length > 0)
		) {
			causes.push({ kind: "semantic_human", ...identity });
		}
	}
	if (input.inheritedRequiresHuman) {
		causes.push({
			kind: "inherited_budget",
			band: input.band,
			alerts: [...input.alerts],
		});
	}
	return causes;
}

function activitySteps(ctx: ReviewBudgetCommandContext, runId: string) {
	return ctx.recordStore.listLines(runId, "steps").flatMap((line) => {
		const payload = line.payload as Partial<StepRecordPayload> | null;
		if (!payload || typeof payload.step_name !== "string") return [];
		return [
			{
				stepName: payload.step_name,
				phase: typeof payload.phase === "string" ? payload.phase : null,
				iteration:
					typeof payload.iteration === "number" ? payload.iteration : null,
				headCommit:
					typeof payload.head_commit === "string" ? payload.head_commit : null,
			},
		];
	});
}

/**
 * Compose one implementation observation from the bound ledger, the prepared
 * code range, and prior observations. Does not append and does not authorize
 * completion. Inherited W/R/B/D are copied with an empty finding list.
 */
export async function composeImplementationReviewerRecord(input: {
	ctx: ReviewBudgetCommandContext;
	runId: string;
	stepName: string;
	phase: string;
	iteration?: number;
	verdict: ReviewerVerdict;
	contextId?: string;
	codeContext?: CodeDiffContext | null;
	envelopePhase?: string;
	envelopeDomain?: string;
	sessionId?: string;
}): Promise<ComposeImplementationReviewerRecordResult> {
	const binding = input.ctx.store.getImplementationBinding(input.runId);
	if (!binding) {
		return { status: "skipped", reason: "not_implementation" };
	}
	const phaseId = canonicalPhaseId(input.phase);
	if (!phaseId || phaseId === "plan") {
		return {
			status: "error",
			code: "UNKNOWN_PHASE",
			message: `Phase '${input.phase}' is not an implementation phase.`,
		};
	}
	if (!input.codeContext || !input.contextId) {
		if (binding.mode === "enforced") {
			return {
				status: "error",
				code: "IMPLEMENTATION_REVIEW_CONTEXT_REQUIRED",
				message:
					"Enforced implementation recording requires the prepared review context. Render the reviewer template instead of manufacturing endpoints.",
			};
		}
		return { status: "skipped", reason: "context_missing" };
	}
	const stored = input.ctx.store.getImplementationReviewContext(
		input.runId,
		input.contextId,
	);
	if (!stored) {
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_CONTEXT_NOT_FOUND",
			message: `Review context ${input.contextId} was not prepared for this run.`,
		};
	}
	if (stored.bindingId !== binding.id || stored.phase !== phaseId) {
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_CONTEXT_REUSE",
			message: `Review context ${stored.id} belongs to binding ${stored.bindingId} phase ${stored.phase} and cannot be reused here.`,
		};
	}
	if (
		stored.patchHash !== input.codeContext.patchHash ||
		stored.baseCommit !== input.codeContext.baseCommit ||
		stored.reviewedCommit !== input.codeContext.reviewedCommit
	) {
		return {
			status: "error",
			code: "CODE_DIFF_STALE",
			message: `Review context ${stored.id} does not match the verified code range.`,
		};
	}
	const closure = readImplementationCodeClosure(
		input.ctx.recordStore,
		input.runId,
		phaseId,
	);
	const reviewed = validateImplementationReview({
		verdict: input.verdict,
		phase: phaseId,
		envelopePhase: input.envelopePhase,
		envelopeDomain: input.envelopeDomain,
		mode: binding.mode,
		phaseIds: binding.phaseMap.map((entry) => entry.id),
		workItemIds: binding.ledger.workItems.map((item) => item.id),
		creditClaimIds: binding.ledger.workItems.flatMap((item) =>
			item.debtClaim ? [item.debtClaim.debtClaimId] : [],
		),
		approvedPlanBytes: binding.approvedPlanBytes,
		approvedPlanHash: binding.approvedPlanHash,
		amendments: input.ctx.store.listImplementationTextAmendments(
			input.runId,
			binding.id,
		),
		hasRun: true,
		priorReviewCount: closure.priorReviewCount,
		sessionId: input.sessionId,
		codeContext: input.codeContext,
		priorCodeFindings: closure.priorCodeFindings,
		priorCodeDecisions: closure.priorCodeDecisions,
	});
	if (!reviewed.governance) {
		return {
			status: "error",
			code: reviewed.fatalCode ?? "INVALID_STRUCTURED_OUTPUT",
			message:
				reviewed.fatalMessage ?? "Implementation review contract was rejected.",
			detail: { diagnostics: reviewed.diagnostics },
		};
	}
	if (!reviewed.valid || !reviewed.accepted) {
		return {
			status: "error",
			code: reviewed.fatalCode ?? "INVALID_STRUCTURED_OUTPUT",
			message:
				reviewed.fatalMessage ?? "Implementation review contract was rejected.",
			detail: { diagnostics: reviewed.diagnostics },
		};
	}
	// Variance is telemetry. Findings stay empty so W/R/B/D cannot move and
	// implementation effort cannot mint D.
	const inherited = deriveBudget({
		B0: binding.b0,
		B: binding.governingB,
		I: null,
		workItems: binding.ledger.workItems,
		findings: [],
		assessments: [],
		config: binding.thresholds,
		semanticHumanRequired: false,
	});
	const budgetInvariant: ImplementationBudgetInvariant = {
		W: inherited.W,
		R: inherited.R,
		B: inherited.B,
		D: inherited.D,
	};
	const identities = new Map(
		reviewed.governance.findingIdentities.map((identity) => [
			identity.findingId,
			{
				findingId: identity.findingId,
				fingerprint: identity.fingerprint,
			},
		]),
	);
	const gateCauses = gateCausesFor({
		items: input.verdict.items,
		identities,
		exemptionAuthorized: reviewed.governance.exemptionAuthorized,
		inheritedRequiresHuman: inherited.requiresHuman,
		band: inherited.budgetBand,
		alerts: inherited.budgetAlerts,
	});
	let route = reviewed.governance.route;
	let nextAction = reviewed.governance.nextAction;
	if (route === "complete" && gateCauses.length > 0) {
		route = "human_gate";
		nextAction = "human_gate";
	}
	let priorObservations: ImplementationReviewObservationPayload[];
	try {
		priorObservations = listRecordedImplementationReviews(
			input.ctx.store,
			input.runId,
		).filter((observation) => observation.phase === phaseId);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_RECORD_CORRUPT",
			message: `Implementation review history could not be read: ${message}`,
		};
	}
	const amendments = input.ctx.store.listImplementationTextAmendments(
		input.runId,
		binding.id,
	);
	const planAmendments = planAmendmentCount({
		observations: priorObservations,
		amendments,
		current: gateCauses,
	});
	const activity = deriveImplementationActivityTelemetry({
		steps: activitySteps(input.ctx, input.runId),
		phase: phaseId,
		pendingReviewer: {
			stepName: input.stepName,
			iteration: input.iteration ?? null,
		},
	});
	const deltas = variance(input.verdict.items);
	const telemetry: ImplementationReviewTelemetry = {
		...activity,
		classCounts: classCounts(input.verdict.items),
		planAmendments,
		addedPaths: addedPathsFromCodeContext(input.codeContext),
		boundaryInventory: boundaryInventory(input.verdict.items),
		effortVariance: deltas.effortVariance,
		architectureVariance: deltas.architectureVariance,
	};
	const stepKey: ImplementationReviewStepKey = {
		stepName: input.stepName,
		phase: phaseId,
		iteration: input.iteration ?? null,
	};
	const pending: PendingImplementationObservation = {
		kind: "implementation-review",
		version: 1,
		id: createReviewBudgetId(),
		runId: input.runId,
		stepKey,
		bindingId: binding.id,
		contextId: stored.id,
		domain: "implementation",
		phase: phaseId,
		originalVerdict: structuredClone(input.verdict),
		outcomes: structuredClone(input.verdict.priorFindings ?? []),
		route,
		nextAction,
		diagnostics: reviewed.governance.diagnostics,
		claimObservations: (input.verdict.creditRealizations ?? []).map(
			(realization) => ({
				creditClaimId: realization.creditClaimId,
				realization: realization.realization,
				realizedArchitectureDelta: realization.realizedArchitectureDelta,
				evidence: realization.evidence,
			}),
		),
		gateCauses,
		telemetry,
		budgetInvariant,
		completionAuthorized: false,
	};
	return {
		status: "applied",
		pending,
		diagnostics: reviewed.diagnostics,
	};
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

function persistedObservation(
	ctx: ReviewBudgetCommandContext,
	runId: string,
	stepKey: ImplementationReviewStepKey,
): ImplementationReviewObservationPayload | null {
	const key = implementationReviewObservationKey(runId, stepKey);
	return ctx.store.projectImplementationReview(runId, key);
}

/**
 * Append the reviewer step and its observation together. A paired collision
 * returns the stored observation. It does not publish the pending route.
 * Completion stays unauthorized until that durable line says otherwise.
 */
export async function recordImplementationReviewerStepWithObservation(
	params: RunRecordParams & { run: string; stepName: string; result: string },
	pending: PendingImplementationObservation,
	ctx: ReviewBudgetCommandContext,
): Promise<RecordImplementationReviewResult> {
	const admitted = await prepareRecordStepAppend(params, ctx);
	const { prepared } = admitted;
	const run = getRunV1(ctx.db, prepared.runId);
	if (!run) {
		throw new RecordError("RUN_NOT_FOUND", `Run ${prepared.runId} not found`);
	}
	if (admitted.outcome === "duplicate") {
		if (prepared.iteration === undefined) {
			throw new RecordError(
				"INVALID_RECORD_IDENTITY",
				"Duplicate step has no iteration",
			);
		}
		const stepKey: ImplementationReviewStepKey = {
			stepName: prepared.stepName,
			phase: prepared.phase ?? null,
			iteration: prepared.iteration,
		};
		const stepRecordKey = stepIdempotencyKey({
			runId: prepared.runId,
			stepName: prepared.stepName,
			phase: prepared.phase ?? null,
			iteration: prepared.iteration,
		});
		const line = ctx.recordStore.getLine(
			prepared.runId,
			"steps",
			stepRecordKey,
		);
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
		const observation = line
			? persistedObservation(ctx, prepared.runId, stepKey)
			: null;
		if (line && !observation) {
			const binding = ctx.store.getImplementationBinding(prepared.runId);
			if (binding?.mode === "enforced") {
				throw new RecordError(
					"RECORD_PAIR_CORRUPT",
					"Implementation review step exists without its coupled observation",
				);
			}
		}
		const after = computeRunSummary(ctx.db, prepared.runId);
		return {
			...dbResult,
			recorded: false,
			total_steps: after.total_steps,
			max_steps: prepared.maxSteps,
			observation,
			completionAuthorized: observation?.completionAuthorized ?? false,
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
				const stepKey: ImplementationReviewStepKey = {
					stepName: finalized.stepName,
					phase: finalized.phase ?? null,
					iteration: finalized.iteration,
				};
				const createdAt = now();
				const payload: ImplementationReviewObservationPayload = {
					...pending,
					runId: finalized.runId,
					stepKey,
					completionAuthorized: implementationCompletionAuthorized(pending),
					createdAt,
				};
				return [
					{
						runId: finalized.runId,
						stream: "budget",
						idempotencyKey: implementationReviewObservationKey(
							finalized.runId,
							stepKey,
						),
						payload: encodeImplementationReviewObservationPayload(payload),
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
			"Implementation review observation identity exists without its coupled step",
		);
	}
	const stepKey: ImplementationReviewStepKey = {
		stepName: written.finalized.stepName,
		phase: written.finalized.phase ?? null,
		iteration: written.finalized.iteration,
	};
	const observation = persistedObservation(ctx, prepared.runId, stepKey);
	const after = computeRunSummary(ctx.db, prepared.runId);
	return {
		...written.dbResult,
		recorded: written.recorded && written.dbResult.recorded,
		total_steps: after.total_steps,
		max_steps: prepared.maxSteps,
		observation,
		completionAuthorized: observation?.completionAuthorized ?? false,
	};
}
