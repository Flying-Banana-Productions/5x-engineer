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
import { parsePlan } from "../parsers/plan.js";
import type { ImplementationPlanRecoveryPayload } from "../review-budget/record-lines.js";
import { decodeImplementationPlanRecoveryPayload } from "../review-budget/record-lines.js";
import {
	classifyDecisionAcceptance,
	listImplementationDecisions,
} from "./decisions.js";
import {
	detectPlanDrift,
	hashPlanBytes,
	normalizeCheckboxState,
} from "./implementation-state.js";
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
	const priorRecovery = existing.find(
		(entry) => entry.kind === "implementation-plan-recovery",
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
	if (priorRecovery) {
		if (priorRecovery.id !== id)
			reject(
				"Only one frontier recovery per binding is supported. Use the full revision workflow for further amendments.",
			);
		return {
			created: false,
			dryRun: Boolean(input.dryRun),
			recovery: priorRecovery,
			completionAuthorized: false as const,
			nextAction: "implementation_corrections",
		};
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
	const oldPlan = parsePlan(binding.approvedPlanBytes);
	const newPlan = parsePlan(deps.committedPlanBytes);
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
		if (
			section(
				binding.approvedPlanBytes,
				oldPhase.line,
				oldPlan.phases[index + 1]?.line,
			) !==
			section(
				deps.committedPlanBytes,
				newPhase.line,
				newPlan.phases[index + 1]?.line,
			)
		) {
			reject(
				`Earlier phase ${oldPhase.number} changed; frontier recovery cannot preserve its approval.`,
			);
		}
	}
	const parsed = parseDeliveryBudget(deps.committedPlanBytes);
	if (!parsed.ok) reject(parsed.message);
	// Addresses/rationale may document the amendment; numeric scope and credit cannot change.
	const contract = (ledger: typeof binding.ledger) => ({
		surface: ledger.surface,
		workItems: ledger.workItems.map((item) => ({
			id: item.id,
			title: item.title,
			effort: item.effort,
			architectureDelta: item.architectureDelta,
			debtClaim: item.debtClaim,
		})),
	});
	if (
		binding.ledger.workItems.some(
			(item) => item.debtClaim || item.architectureDelta < 0,
		) ||
		JSON.stringify(contract(binding.ledger)) !==
			JSON.stringify(contract(parsed.value))
	) {
		reject(
			"Frontier recovery requires unchanged work-item IDs, scores and surface, and no debt claims. Baseline/policy cannot change.",
		);
	}
	const snapshot = store.latestSnapshot(input.runId);
	if (
		!snapshot ||
		snapshot.id !== input.snapshotId ||
		snapshot.phase !== "plan" ||
		JSON.stringify(snapshot.currentLedger) !== JSON.stringify(parsed.value)
	) {
		reject(
			"The latest same-run plan-review snapshot must match the amended ledger exactly.",
		);
	}
	const reviewerIndex = parsedSteps.findIndex(
		(step) =>
			step.step_name === snapshot.stepName &&
			step.phase === "plan" &&
			step.iteration === snapshot.iteration,
	);
	const reviewer = parsedSteps[reviewerIndex];
	const verdict = reviewer?.result_json as
		| { readiness?: string; items?: unknown[] }
		| undefined;
	const authorIndex = parsedSteps.findIndex(
		(step) =>
			step.phase === "plan" &&
			step.step_name.startsWith("author:") &&
			(step.result_json as { commit?: string } | null)?.commit === input.commit,
	);
	const humanIndex = parsedSteps.findIndex(
		(step) =>
			(step.result_json as { decisionId?: string } | null)?.decisionId ===
			input.authorizationId,
	);
	if (
		humanIndex < 0 ||
		authorIndex <= humanIndex ||
		reviewerIndex <= authorIndex ||
		verdict?.readiness !== "ready" ||
		!Array.isArray(verdict.items) ||
		verdict.items.length ||
		parsedSteps
			.slice(reviewerIndex + 1)
			.some(
				(step) =>
					step.phase === "plan" && /^(author|reviewer):/.test(step.step_name),
			) ||
		createReviewGovernanceStore(recordStore).deriveOpenGate(input.runId)
	) {
		reject(
			"Recovery requires authorization → committed plan author → coupled ready/empty plan review, with no later plan author/reviewer or open plan gate.",
		);
	}
	const drift = detectPlanDrift({
		approvedPlanBytes: binding.approvedPlanBytes,
		approvedPlanHash: binding.approvedPlanHash,
		amendments: existing,
		currentPlanBytes: deps.committedPlanBytes,
	});
	if (!drift.chainValid || !drift.drifted)
		reject(
			"Recovery requires valid existing lineage and a substantive amendment not already admitted.",
		);
	const parent = existing.at(-1);
	const recovery: ImplementationPlanRecoveryPayload = {
		kind: "implementation-plan-recovery",
		version: 1,
		id,
		...intent,
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
					idempotencyKey: `budget:implementation-plan-recovery:${binding.id}`,
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
