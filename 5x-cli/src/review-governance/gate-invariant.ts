/**
 * Enforced `human_gate` routes must name a decision the operator can take.
 *
 * Composition, paired persistence and readback share these checks for plan
 * and implementation reviews. An empty negative verdict is a structured-output
 * repair for the reviewer, never a fabricated finding or an empty gate. A
 * historical gate-less observation stays audit history; inspection reports it
 * with same-run commands to repair drift and record a corrective review.
 * Advisory and off modes keep v1 routing and are not checked here.
 */

import {
	type StepRecordPayload,
	stepIdempotencyKey,
} from "../control-plane/index.js";
import type { RecordStore } from "../control-plane/record-store.js";
import type { ReviewerVerdict } from "../protocol.js";
import {
	baselineIdempotencyKey,
	decodeBudgetBaselinePayload,
	decodeBudgetSnapshotPayload,
	decodeImplementationReviewContextPayload,
	implementationReviewContextKey,
} from "../review-budget/record-lines.js";
import { deriveGatelessImplementationObservation } from "./store.js";

export const UNEXPLAINED_NEGATIVE_VERDICT = "UNEXPLAINED_NEGATIVE_VERDICT";
export const GATELESS_HUMAN_GATE = "GATELESS_HUMAN_GATE";
export const REVIEW_GATE_INVARIANT = "REVIEW_GATE_INVARIANT";

export type GateInvariantDomain = "plan" | "implementation";

/**
 * `not_ready` with nothing a reviewer, author or operator can act on: no
 * items and no prior finding left open. Closure validation already rejects
 * an open prior finding that is missing from `items`.
 */
export function isUnexplainedNegativeVerdict(
	verdict: Pick<ReviewerVerdict, "readiness" | "items" | "priorFindings">,
): boolean {
	if (verdict.readiness !== "not_ready") return false;
	if ((verdict.items ?? []).length > 0) return false;
	return !(verdict.priorFindings ?? []).some(
		(outcome) =>
			outcome.status === "still_open" ||
			outcome.status === "partially_addressed",
	);
}

export interface UnexplainedNegativeVerdictError {
	status: "error";
	code: "INVALID_STRUCTURED_OUTPUT";
	message: string;
	detail: {
		reason: typeof UNEXPLAINED_NEGATIVE_VERDICT;
		domain: GateInvariantDomain;
		diagnostics: Array<{
			code: typeof UNEXPLAINED_NEGATIVE_VERDICT;
			severity: "error";
			message: string;
		}>;
		retryGuidance: string;
		recorded: false;
		runPreserved: true;
	};
}

function retryGuidance(domain: GateInvariantDomain): string {
	const evidence =
		domain === "implementation"
			? "Report each blocking problem as an item: an implementation_defect cites the exact introducing code hunk from the supplied range; a plan_defect cites planImpact anchored to the supplied plan evidence and needs no code hunk."
			: "Report each blocking problem as an item with its failure and lowest-cost correction.";
	return `Ask the same reviewer to correct the structured response, not to repeat the review. ${evidence} If nothing blocks, return readiness "ready" (or "ready_with_corrections" with the corrections as items). This is a structured-output retry under the existing retry limit; it does not restart implementation, rerun quality, or open a human gate.`;
}

/**
 * Response-repair error for an enforced empty negative verdict. Uses the
 * existing `INVALID_STRUCTURED_OUTPUT` code so the bounded output-correction
 * retry policy applies. Nothing is recorded.
 */
export function unexplainedNegativeVerdictError(
	domain: GateInvariantDomain,
): UnexplainedNegativeVerdictError {
	const message = `${UNEXPLAINED_NEGATIVE_VERDICT}: the ${domain} review returned readiness "not_ready" with no findings and no independent gate cause. Nothing was recorded and no human gate was opened.`;
	return {
		status: "error",
		code: "INVALID_STRUCTURED_OUTPUT",
		message: `${message} ${retryGuidance(domain)}`,
		detail: {
			reason: UNEXPLAINED_NEGATIVE_VERDICT,
			domain,
			diagnostics: [
				{ code: UNEXPLAINED_NEGATIVE_VERDICT, severity: "error", message },
			],
			retryGuidance: retryGuidance(domain),
			recorded: false,
			runPreserved: true,
		},
	};
}

/**
 * Null when consistent. An enforced `human_gate` route needs at least one
 * durable gate cause; a cause-less gate cannot be shown or decided.
 */
export function enforcedGateInvariantViolation(input: {
	domain: GateInvariantDomain;
	mode: "off" | "advisory" | "enforced" | null | undefined;
	route: string | null | undefined;
	causeCount: number;
}): string | null {
	if (input.mode !== "enforced") return null;
	if (input.route !== "human_gate" || input.causeCount > 0) return null;
	return `${REVIEW_GATE_INVARIANT}: the enforced ${input.domain} review routes to human_gate with no durable gate cause, so no gate could be shown or decided. Nothing was recorded; correct the review response and record it again on this run.`;
}

function shellArg(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface GatelessHumanGateReport {
	code: typeof GATELESS_HUMAN_GATE;
	domain: GateInvariantDomain;
	phase: string;
	/** Implementation observation id or plan snapshot id. */
	recordId: string;
	route: "human_gate";
	nextAction: string;
	planDrifted: boolean;
	message: string;
	/** Ordered: direct mechanical repair first when drift exists, then re-review. */
	next: string[];
	remediation: string;
	runPreserved: true;
}

/**
 * Report a recorded enforced `human_gate` with no gate. The record stays as
 * audit history; a later valid review on this run supersedes its route.
 * Recovery needs no decision on the absent gate.
 */
export function gatelessHumanGateReport(input: {
	domain: GateInvariantDomain;
	runId: string;
	phase: string;
	recordId: string;
	nextAction: string;
	planDrifted: boolean;
	stepName?: string | null;
	nextIteration?: number | null;
	/**
	 * Implementation only: the reviewed end of the observation's recorded
	 * review context. `reviewer-commit` requires `commit_hash`; the prepared
	 * governance context stays the authority for the reviewed range.
	 */
	reviewedCommit?: string | null;
	/** Implementation only: names the context when its commit is unreadable. */
	contextId?: string | null;
}): GatelessHumanGateReport {
	const run = shellArg(input.runId);
	const phase = shellArg(input.phase);
	const repair = input.planDrifted
		? [
				`5x plan repair-checklists --run ${run} --dry-run`,
				`5x plan repair-checklists --run ${run} --apply --reason ${shellArg("Operator authorized checklist-format repair and continuation")}`,
			]
		: [];
	const iteration =
		input.nextIteration != null ? ` --iteration ${input.nextIteration}` : "";
	const commitHash = shellArg(
		input.reviewedCommit ??
			`<reviewed commit of review context ${input.contextId ?? "unknown"}>`,
	);
	const review =
		input.domain === "implementation"
			? [
					`5x template render reviewer-commit --run ${run} --var phase_number=${phase} --var commit_hash=${commitHash} --new-session`,
					`5x protocol validate reviewer --record --run ${run} --step ${shellArg(input.stepName ?? "reviewer:commit")} --phase ${phase}${iteration} --review-context <review_context_id from the render>`,
					`5x invoke reviewer reviewer-commit --run ${run} --var phase_number=${phase} --var commit_hash=${commitHash} --record --record-step ${shellArg(input.stepName ?? "reviewer:commit")} --phase ${phase}${iteration}`,
				]
			: [
					`5x template render reviewer-plan --run ${run} --new-session`,
					`5x protocol validate reviewer --record --run ${run} --step ${shellArg(input.stepName ?? "reviewer:review")} --phase plan${iteration}`,
					`5x invoke reviewer reviewer-plan --run ${run} --record --record-step ${shellArg(input.stepName ?? "reviewer:review")} --phase plan${iteration}`,
				];
	const scope =
		input.domain === "implementation" ? `phase ${input.phase}` : "the plan";
	const message = `${GATELESS_HUMAN_GATE}: the recorded ${input.domain} review ${input.recordId} for ${scope} routes to human_gate but carries no gate cause, so there is no gate to show or decide. This is a workflow inconsistency, not an operator decision.`;
	const remediation = `${input.planDrifted ? "First repair the plan drift directly with the mechanical checklist repair (preview, then apply under the operator's instruction); drift that is not a checklist-prefix change uses the scoped amendment process instead. " : ""}Then record a corrective review of ${scope} on this same run (native render + validate, or invoke). The earlier record stays as audit history and the new valid review supersedes its route. No gate decision, new run, implementation restart or quality rerun is required.`;
	return {
		code: GATELESS_HUMAN_GATE,
		domain: input.domain,
		phase: input.phase,
		recordId: input.recordId,
		route: "human_gate",
		nextAction: input.nextAction,
		planDrifted: input.planDrifted,
		message,
		next: [...repair, ...review],
		remediation,
		runPreserved: true,
	};
}

function nextStepIteration(
	recordStore: RecordStore,
	runId: string,
	stepName: string,
	phase: string | null,
): number {
	let max = 0;
	for (const line of recordStore.listLines(runId, "steps")) {
		const step = line.payload as Partial<StepRecordPayload> | null;
		if (
			step?.step_name === stepName &&
			(step.phase ?? null) === phase &&
			typeof step.iteration === "number" &&
			step.iteration > max
		)
			max = step.iteration;
	}
	return max + 1;
}

/** Reviewed end of the observation's durable review context, or null. */
function recordedReviewedCommit(
	recordStore: RecordStore,
	runId: string,
	contextId: string,
): string | null {
	const line = recordStore.getLine(
		runId,
		"budget",
		implementationReviewContextKey(contextId),
	);
	if (!line) return null;
	try {
		return decodeImplementationReviewContextPayload(line.payload)
			.reviewedCommit;
	} catch {
		return null;
	}
}

/** Readback report for an enforced implementation phase, or null. */
export function implementationGatelessReport(input: {
	recordStore: RecordStore;
	runId: string;
	phase: string;
	planDrifted: boolean;
}): GatelessHumanGateReport | null {
	const observation = deriveGatelessImplementationObservation(
		input.recordStore,
		input.runId,
		input.phase,
	);
	if (!observation) return null;
	return gatelessHumanGateReport({
		domain: "implementation",
		runId: input.runId,
		phase: input.phase,
		recordId: observation.id,
		nextAction: observation.nextAction,
		planDrifted: input.planDrifted,
		stepName: observation.stepKey.stepName,
		reviewedCommit: recordedReviewedCommit(
			input.recordStore,
			input.runId,
			observation.contextId,
		),
		contextId: observation.contextId,
		nextIteration: nextStepIteration(
			input.recordStore,
			input.runId,
			observation.stepKey.stepName,
			observation.stepKey.phase,
		),
	});
}

/**
 * Readback report for an enforced plan run whose latest snapshot recorded a
 * `human_gate` route with no effective gate cause, or null.
 */
export function planGatelessReport(input: {
	recordStore: RecordStore;
	runId: string;
}): GatelessHumanGateReport | null {
	const baselineLine = input.recordStore.getLine(
		input.runId,
		"budget",
		baselineIdempotencyKey(input.runId),
	);
	if (!baselineLine) return null;
	try {
		if (decodeBudgetBaselinePayload(baselineLine.payload).mode !== "enforced")
			return null;
	} catch {
		return null;
	}
	let latest: ReturnType<typeof decodeBudgetSnapshotPayload> | undefined;
	for (const line of input.recordStore.listLines(input.runId, "budget")) {
		try {
			latest = decodeBudgetSnapshotPayload(line.payload);
		} catch {
			// Other budget kinds are skipped.
		}
	}
	if (!latest || (latest.effectiveGateCauses?.length ?? 0) > 0) return null;
	if (latest.stepKey.iteration === null) return null;
	const step = input.recordStore.getLine(
		input.runId,
		"steps",
		stepIdempotencyKey({
			runId: input.runId,
			stepName: latest.stepKey.stepName,
			phase: latest.stepKey.phase,
			iteration: latest.stepKey.iteration,
		}),
	)?.payload as Partial<StepRecordPayload> | undefined;
	const result = step?.result_json as
		| { governance?: { route?: unknown } }
		| null
		| undefined;
	if (result?.governance?.route !== "human_gate") return null;
	return gatelessHumanGateReport({
		domain: "plan",
		runId: input.runId,
		phase: "plan",
		recordId: latest.id,
		nextAction: "human_gate",
		planDrifted: false,
		stepName: latest.stepKey.stepName,
		nextIteration: nextStepIteration(
			input.recordStore,
			input.runId,
			latest.stepKey.stepName,
			latest.stepKey.phase,
		),
	});
}
