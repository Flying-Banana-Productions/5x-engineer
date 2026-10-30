/** Narrow recovery for an authorized amendment at an unfinished frontier.
 * This does not implement plan 215's general revision/evidence-carry model.
 */
import { createHash } from "node:crypto";
import type { RecordStore } from "../control-plane/record-store.js";
import type {
	RecordOrigin,
	StepRecordPayload,
} from "../control-plane/record-types.js";
import { recordedEnvelope } from "../control-plane/record-types.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import { CliError } from "../output.js";
import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import { readAuthoritativePlan } from "../plan-schema/authority.js";
import { governingLinesInLineRange } from "../plan-schema/document.js";
import type { ReviewerVerdict } from "../protocol.js";
import type { ImplementationPlanRecoveryPayload } from "../review-budget/record-lines.js";
import { decodeImplementationPlanRecoveryPayload } from "../review-budget/record-lines.js";
import { applicableArchitectureApproval } from "./architecture-approval.js";
import {
	classifyDecisionAcceptance,
	listImplementationDecisions,
} from "./decisions.js";
import {
	detectPlanDrift,
	hashPlanBytes,
	normalizeCheckboxState,
	recordedPlanSchemaFromBinding,
} from "./implementation-state.js";
import { routeAfterDecision } from "./routing.js";
import { createReviewGovernanceStore } from "./store.js";

export interface RecoverImplementationPlanInput {
	runId: string;
	phase: string;
	authorizationId: string;
	snapshotId: string;
	commit: string;
	/** Explicit operator attestations, never inferred from reviewer summaries. */
	scopeConfirmation: string;
	preservedPhaseConfirmation: string;
	dryRun?: boolean;
}

function reject(message: string): never {
	throw new CliError("IMPLEMENTATION_RECOVERY_UNSUPPORTED", message);
}

/** Shared by Git admission and durable admission; never infer a final pass from prose. */
export function implementationRecoveryReview(
	input: RecoverImplementationPlanInput,
	recordStore: RecordStore,
	store: ReviewBudgetStore,
) {
	const snapshot = store.latestSnapshot(input.runId);
	if (
		!snapshot ||
		snapshot.id !== input.snapshotId ||
		snapshot.phase !== "plan"
	)
		reject("The latest same-run plan-review snapshot is required.");
	const steps = recordStore
		.listLines(input.runId, "steps")
		.map((line) => line.payload as StepRecordPayload);
	const reviewerIndex = steps.findIndex(
		(step) =>
			step.step_name === snapshot.stepName &&
			step.phase === "plan" &&
			step.iteration === snapshot.iteration,
	);
	const verdict = steps[reviewerIndex]?.result_json as
		| (ReviewerVerdict & {
				governance?: { route?: string };
		  })
		| undefined;
	const governance = createReviewGovernanceStore(recordStore);
	const governing = governance.deriveGoverningState(
		input.runId,
		store.getBaseline(input.runId)?.b0 ?? 0,
	);
	let route = verdict?.governance?.route;
	const decision = governing.history.at(-1);
	if (verdict && decision?.snapshotId === snapshot.id) {
		route = routeAfterDecision({
			latestVerdict: verdict,
			latestBudgetSnapshot: snapshot,
			newGoverningState: governing,
			decision,
		});
	}
	const finalCorrections = route === "final_corrections";
	const authorIndex = steps.findIndex(
		(step) =>
			step.phase === "plan" &&
			step.step_name.startsWith("author:") &&
			(step.result_json as { commit?: string } | null)?.commit === input.commit,
	);
	const author = steps[authorIndex]?.result_json as
		| { result?: string }
		| undefined;
	const routeDecisionIndex =
		decision?.snapshotId === snapshot.id
			? steps.findIndex(
					(step) =>
						(step.result_json as { decisionId?: string } | null)?.decisionId ===
						decision.decisionId,
				)
			: reviewerIndex;
	const humanIndex = steps.findIndex(
		(step) =>
			(step.result_json as { decisionId?: string } | null)?.decisionId ===
			input.authorizationId,
	);
	const laterPlanPasses = steps
		.slice(reviewerIndex + 1)
		.filter(
			(step) =>
				step.phase === "plan" && /^(author|reviewer):/.test(step.step_name),
		);
	if (
		humanIndex < 0 ||
		reviewerIndex <= humanIndex ||
		authorIndex <= humanIndex ||
		author?.result !== "complete" ||
		(Boolean(steps[authorIndex]?.head_commit) &&
			steps[authorIndex]?.head_commit !== input.commit) ||
		(finalCorrections
			? authorIndex <= Math.max(reviewerIndex, routeDecisionIndex) ||
				laterPlanPasses.length !== 1 ||
				laterPlanPasses[0] !== steps[authorIndex]
			: reviewerIndex <= authorIndex ||
				verdict?.readiness !== "ready" ||
				!Array.isArray(verdict.items) ||
				verdict.items.length > 0 ||
				laterPlanPasses.length > 0) ||
		governing.aborted ||
		governance.deriveOpenGate(input.runId)
	) {
		reject(
			"Recovery requires authorization, a coupled ready/empty review or durable final_corrections route, and its completed committed author pass, with no later plan pass or open plan gate.",
		);
	}
	return { snapshot, governing, finalCorrections, reviewerIndex, steps };
}

/** No Git/subprocesses here. The command verifies the exact committed bytes. */
export function recoverImplementationPlan(
	input: RecoverImplementationPlanInput,
	deps: {
		recordStore: RecordStore;
		store: ReviewBudgetStore;
		origin: RecordOrigin;
		committedPlanBytes: string;
		worktreePlanBytes: string;
	},
) {
	const { recordStore, store } = deps;
	const binding = store.getImplementationBinding(input.runId);
	if (!binding || recordStore.getRun(input.runId)?.status !== "active") {
		reject("Recovery requires an active, already-bound implementation run.");
	}
	if (
		!input.scopeConfirmation.trim() ||
		!input.preservedPhaseConfirmation.trim()
	) {
		reject(
			"The operator must confirm bounded scope and non-impact on earlier phases, including shared design documents.",
		);
	}
	if (deps.worktreePlanBytes !== deps.committedPlanBytes) {
		reject(
			"Worktree plan must exactly match the supplied amendment commit, including checkbox state.",
		);
	}
	const steps = recordStore.listLines(input.runId, "steps");
	const budget = recordStore.listLines(input.runId, "budget");
	const decisions = recordStore.listLines(input.runId, "decisions");
	const existing = store.listImplementationTextAmendments(
		input.runId,
		binding.id,
	);
	const intent = {
		bindingId: binding.id,
		phase: input.phase,
		authorizationId: input.authorizationId,
		snapshotId: input.snapshotId,
		afterCommit: input.commit,
		afterBlobHash: hashPlanBytes(deps.committedPlanBytes),
		scopeConfirmation: input.scopeConfirmation,
		preservedPhaseConfirmation: input.preservedPhaseConfirmation,
	};
	const id = `recovery:${createHash("sha256").update(JSON.stringify(intent)).digest("hex")}`;
	const priorRecovery = existing.find(
		(entry): entry is ImplementationPlanRecoveryPayload =>
			entry.kind === "implementation-plan-recovery" && entry.id === id,
	);
	if (priorRecovery) {
		return {
			created: false,
			dryRun: Boolean(input.dryRun),
			recovery: priorRecovery,
			completionAuthorized: false as const,
			nextAction: "implementation_corrections",
		};
	}
	if (
		existing.some(
			(entry) =>
				entry.kind === "implementation-plan-recovery" &&
				entry.authorizationId === input.authorizationId,
		)
	) {
		reject("This amendment authorization already has an accepted recovery.");
	}
	const listed = listImplementationDecisions(recordStore, input.runId);
	if (listed.diagnostics.length)
		reject("Implementation decision history is unreadable.");
	const authorization = listed.decisions.find(
		(decision) => decision.decisionId === input.authorizationId,
	);
	if (
		authorization?.choice !== "authorize_amendment" ||
		authorization.bindingId !== binding.id ||
		authorization.phase !== input.phase ||
		!classifyDecisionAcceptance({ decision: authorization, steps, budget })
			.accepted ||
		listed.decisions.some(
			(decision) => decision.supersedesDecisionId === authorization.decisionId,
		)
	) {
		reject(
			"An accepted, unsuperseded authorize_amendment decision for this binding and phase is required.",
		);
	}
	const observations = store.listImplementationReviews(input.runId);
	const source = observations
		.filter((entry) => entry.phase === input.phase)
		.at(-1);
	if (
		!source ||
		source.id !== authorization.observationId ||
		source.bindingId !== binding.id ||
		!authorization.findingRefs.length ||
		authorization.findingRefs.some(
			(finding) =>
				!source.gateCauses.some(
					(cause) =>
						cause.kind === "plan_amendment" &&
						cause.findingId === finding.findingId &&
						cause.fingerprint === finding.fingerprint,
				),
		)
	) {
		reject(
			"Authorization must cover exact amendment finding fingerprints on the latest same-phase observation.",
		);
	}
	const recorded = recordedPlanSchemaFromBinding(binding, existing);
	const drift = detectPlanDrift({
		approvedPlanBytes: binding.approvedPlanBytes,
		approvedPlanHash: binding.approvedPlanHash,
		amendments: existing,
		currentPlanBytes: deps.committedPlanBytes,
		recordedSchema: recorded.recordedSchema,
		...(recorded.governingHash
			? { governingHash: recorded.governingHash }
			: {}),
	});
	if (!drift.chainValid || !drift.drifted)
		reject(
			"Recovery requires valid existing lineage and a substantive amendment not already admitted.",
		);
	const oldRead = readAuthoritativePlan(
		drift.authorizedBytes,
		recorded.recordedSchema,
	);
	if (!oldRead.ok) reject(`${oldRead.code}: ${oldRead.message}`);
	const newRead = readAuthoritativePlan(
		deps.committedPlanBytes,
		recorded.recordedSchema,
	);
	if (!newRead.ok) reject(`${newRead.code}: ${newRead.message}`);
	const oldPlan = oldRead.plan;
	const newPlan = newRead.plan;
	const frontier = oldPlan.phases.findIndex(
		(phase) => phase.number === input.phase,
	);
	if (
		frontier < 0 ||
		new Set(oldPlan.phases.map((phase) => phase.number)).size !==
			oldPlan.phases.length ||
		JSON.stringify(
			oldPlan.phases.map((phase) => [phase.number, phase.title]),
		) !==
			JSON.stringify(newPlan.phases.map((phase) => [phase.number, phase.title]))
	) {
		reject("Recovery cannot add, remove, rename, reorder or renumber phases.");
	}
	const affected = new Set(
		oldPlan.phases.slice(frontier).map((phase) => phase.number),
	);
	const parsedSteps = steps.map((line) => line.payload as StepRecordPayload);
	if (
		parsedSteps.some(
			(step) =>
				step.step_name === "phase:complete" && affected.has(step.phase ?? ""),
		) ||
		observations.some(
			(entry) => affected.has(entry.phase) && entry.completionAuthorized,
		)
	) {
		reject(
			"Recovery cannot invalidate already-completed or completion-authorized phases. Use the full revision workflow.",
		);
	}
	for (let index = 0; index < frontier; index++) {
		const oldPhase = oldPlan.phases[index];
		const newPhase = newPlan.phases[index];
		if (!oldPhase || !newPhase) reject("Phase mapping is incomplete.");
		const section = (text: string, start: number, end: number | undefined) =>
			normalizeCheckboxState(
				text
					.split(/\r\n|\n|\r/)
					.slice(start - 1, end === undefined ? undefined : end - 1)
					.join("\n"),
			).trim();
		const oldSection =
			recorded.recordedSchema === 1
				? governingLinesInLineRange(
						oldRead.document,
						oldPhase.line,
						oldPlan.phases[index + 1]?.line,
					).join("\n")
				: section(
						drift.authorizedBytes,
						oldPhase.line,
						oldPlan.phases[index + 1]?.line,
					);
		const newSection =
			recorded.recordedSchema === 1
				? governingLinesInLineRange(
						newRead.document,
						newPhase.line,
						newPlan.phases[index + 1]?.line,
					).join("\n")
				: section(
						deps.committedPlanBytes,
						newPhase.line,
						newPlan.phases[index + 1]?.line,
					);
		if (oldSection !== newSection) {
			reject(
				`Earlier phase ${oldPhase.number} changed; frontier recovery cannot preserve its approval.`,
			);
		}
	}
	const parsed = parseDeliveryBudget(newRead.document.authorityMarkdown);
	if (!parsed.ok) reject(parsed.message);
	const previousLedger = parseDeliveryBudget(
		oldRead.document.authorityMarkdown,
	);
	if (!previousLedger.ok) reject(previousLedger.message);
	const { snapshot, governing, finalCorrections } =
		implementationRecoveryReview(input, recordStore, store);
	// Descriptions may document approved architecture changes; effort/surface/credit stay fixed.
	const contract = (
		ledger: typeof binding.ledger,
		architecture = true,
		title = true,
	) => ({
		surface: ledger.surface,
		workItems: ledger.workItems.map((item) => ({
			id: item.id,
			...(title ? { title: item.title } : {}),
			effort: item.effort,
			...(architecture ? { architectureDelta: item.architectureDelta } : {}),
			debtClaim: item.debtClaim,
		})),
	});
	const architectureChanged =
		JSON.stringify(contract(previousLedger.value)) !==
		JSON.stringify(contract(parsed.value));
	const architectureApprovalId = architectureChanged
		? applicableArchitectureApproval({
				P: parsed.value.workItems.reduce(
					(total, item) => total + Math.max(0, item.architectureDelta),
					0,
				),
				approvals: governing.architectureApprovals.filter((approval) =>
					governing.history.some(
						(decision) =>
							decision.decisionId === approval.decisionId &&
							decision.snapshotId === snapshot.id,
					),
				),
				itemIds: [],
				workItemIds: parsed.value.workItems
					.filter(
						(item) =>
							item.architectureDelta >=
							binding.thresholds.singleArchitectureReviewPoints,
					)
					.map((item) => item.id),
			})
		: undefined;
	if (
		[...previousLedger.value.workItems, ...parsed.value.workItems].some(
			(item) => item.debtClaim || item.architectureDelta < 0,
		) ||
		JSON.stringify(contract(previousLedger.value, false, false)) !==
			JSON.stringify(contract(parsed.value, false, false)) ||
		(architectureChanged && !architectureApprovalId)
	) {
		reject(
			"Frontier recovery requires unchanged work-item IDs, effort and surface, and no debt claims. Architecture/title changes require a covering durable architecture approval on this snapshot. Baseline/policy cannot change.",
		);
	}
	if (
		finalCorrections
			? JSON.stringify(
					contract(snapshot.currentLedger, true, !architectureApprovalId),
				) !==
				JSON.stringify(contract(parsed.value, true, !architectureApprovalId))
			: JSON.stringify(snapshot.currentLedger) !== JSON.stringify(parsed.value)
	) {
		reject(
			"The latest same-run plan-review snapshot must match the amended ledger exactly.",
		);
	}
	const parent = existing.at(-1);
	const recovery: ImplementationPlanRecoveryPayload = {
		kind: "implementation-plan-recovery",
		version: 1,
		id,
		...intent,
		...(architectureApprovalId ? { architectureApprovalId } : {}),
		executionRunId: input.runId,
		guardId: null,
		sourceObservationId: source.id,
		parentLineageId: parent?.id ?? null,
		beforeCommit: parent?.afterCommit ?? binding.approvedPlanCommit,
		beforeBlobHash: hashPlanBytes(drift.authorizedBytes),
		authorizedPlanBytes: deps.committedPlanBytes,
		invalidatedContextIds: store
			.listImplementationReviewContexts(input.runId, binding.id)
			.filter((entry) => affected.has(entry.phase))
			.map((entry) => entry.id),
		invalidatedObservationIds: observations
			.filter((entry) => affected.has(entry.phase))
			.map((entry) => entry.id),
		createdAt: new Date().toISOString(),
	};
	if (!input.dryRun) {
		const result = recordStore.atomicAppendIfAllNew(
			[
				{
					runId: input.runId,
					stream: "budget",
					idempotencyKey: `budget:implementation-plan-recovery:${binding.id}:${input.authorizationId}`,
					payload: recovery,
					createdAt: recovery.createdAt,
					...recordedEnvelope(deps.origin),
				},
			],
			{
				steps: steps.map((line) => line.idempotencyKey),
				budget: budget.map((line) => line.idempotencyKey),
				decisions: decisions.map((line) => line.idempotencyKey),
			},
		);
		if (!result.created) {
			const winner = decodeImplementationPlanRecoveryPayload(
				result.duplicates[0]?.line.payload,
			);
			if (winner.id !== id)
				reject("Another recovery won this binding; inspect its receipt.");
			return {
				created: false,
				dryRun: false,
				recovery: winner,
				completionAuthorized: false as const,
				nextAction: "implementation_corrections",
			};
		}
	}
	return {
		created: !input.dryRun,
		dryRun: Boolean(input.dryRun),
		recovery,
		completionAuthorized: false as const,
		nextAction: "implementation_corrections",
	};
}
