import type {
	AppendOp,
	RecordOrigin,
	RecordStore,
	StepRecordPayload,
} from "../control-plane/index.js";
import type { PromptStore } from "../control-plane/store.js";
import { decodeBudgetSnapshotPayload } from "../review-budget/record-lines.js";
import {
	decodeReviewDecisionPayload,
	encodeReviewDecisionPayload,
} from "./codec.js";
import {
	applyDecisionCauseCoverage,
	deriveGateId,
	foldGoverningReviewState,
	type GoverningReviewState,
	governanceCorrectionKey,
	governanceDecisionKey,
	listGovernanceDecisions,
	type ReviewDecisionPayload,
} from "./decisions.js";
import type { ReviewDecisionRoute, ReviewGateCause } from "./types.js";

export interface DerivedReviewGate {
	gateId: string;
	runId: string;
	snapshotId: string;
	causes: ReviewGateCause[];
	resolved: boolean;
	decision?: ReviewDecisionPayload;
}

export interface ResolveReviewGateInput {
	runId: string;
	decision: ReviewDecisionPayload;
	humanStep: StepRecordPayload;
	origin: RecordOrigin;
}

export type ResolveReviewGateResult =
	| {
			created: true;
			decision: ReviewDecisionPayload;
			route: ReviewDecisionRoute;
	  }
	| { created: false; decision: ReviewDecisionPayload; semanticRetry: boolean };

export interface ReviewGovernanceStore {
	getDecision(runId: string, decisionId: string): ReviewDecisionPayload | null;
	listDecisions(runId: string): ReviewDecisionPayload[];
	deriveOpenGate(runId: string): DerivedReviewGate | null;
	resolveGate(input: ResolveReviewGateInput): ResolveReviewGateResult;
	deriveGoverningState(runId: string, b0: number): GoverningReviewState;
}

function routeForChoice(
	choice: ReviewDecisionPayload["choice"],
): ReviewDecisionRoute {
	if (choice === "abort") return "aborted";
	if (choice === "trade_scope" || choice === "request_author_reestimate")
		return "author_revision";
	// Phase 4 replaces this conservative route with an authoritative budget rerun.
	return "human_gate";
}

export function createReviewGovernanceStore(
	recordStore: RecordStore,
	promptStore?: PromptStore,
): ReviewGovernanceStore {
	void promptStore;
	return {
		getDecision(runId, decisionId) {
			return (
				this.listDecisions(runId).find(
					(decision) => decision.decisionId === decisionId,
				) ?? null
			);
		},
		listDecisions(runId) {
			return listGovernanceDecisions(recordStore, runId).decisions;
		},
		deriveOpenGate(runId) {
			const snapshots = recordStore
				.listLines(runId, "budget")
				.flatMap((line) => {
					try {
						const snapshot = decodeBudgetSnapshotPayload(line.payload);
						return snapshot.effectiveGateCauses?.length ? [snapshot] : [];
					} catch {
						return [];
					}
				});
			const latest = snapshots.at(-1);
			if (!latest) return null;
			let causes = latest.effectiveGateCauses ?? [];
			let predecessorGateId: string | undefined;
			while (causes.length > 0) {
				const gateId = deriveGateId({
					runId,
					snapshotId: latest.id,
					causes,
					...(predecessorGateId ? { predecessorGateId } : {}),
				});
				const line = recordStore.getLine(
					runId,
					"decisions",
					governanceDecisionKey(gateId),
				);
				if (!line)
					return {
						gateId,
						runId,
						snapshotId: latest.id,
						causes,
						resolved: false,
					};
				const decision = decodeReviewDecisionPayload(line.payload);
				const next = applyDecisionCauseCoverage(causes, decision);
				if (next.length === 0 || next.length === causes.length) return null;
				causes = next;
				predecessorGateId = gateId;
			}
			return null;
		},
		resolveGate(input) {
			if (input.humanStep.step_name !== "human:review-governance")
				throw new TypeError("human governance step has the wrong step name");
			const result = input.humanStep.result_json;
			if (
				!result ||
				typeof result !== "object" ||
				(result as { decisionId?: unknown }).decisionId !==
					input.decision.decisionId ||
				(result as { gateId?: unknown }).gateId !== input.decision.gateId
			)
				throw new TypeError(
					"human governance step must be stamped with decisionId and gateId",
				);
			const now = input.decision.createdAt;
			const ops: AppendOp[] = [
				{
					runId: input.runId,
					stream: "steps",
					idempotencyKey: `step:${input.runId}:human:review-governance:${input.humanStep.phase ?? ""}:${input.humanStep.iteration}`,
					payload: structuredClone(input.humanStep),
					createdAt: now,
					schemaVersion: 1,
					provenance: "recorded",
					origin: input.origin,
				},
				{
					runId: input.runId,
					stream: "decisions",
					idempotencyKey: input.decision.supersedesDecisionId
						? governanceCorrectionKey(input.decision.decisionId)
						: governanceDecisionKey(input.decision.gateId),
					payload: encodeReviewDecisionPayload(input.decision),
					createdAt: now,
					schemaVersion: 1,
					provenance: "recorded",
					origin: input.origin,
				},
			];
			const appended = recordStore.atomicAppendIfAllNew(ops);
			if (appended.created)
				return {
					created: true,
					decision: input.decision,
					route: routeForChoice(input.decision.choice),
				};
			const winnerLine = recordStore.getLine(
				input.runId,
				"decisions",
				governanceDecisionKey(input.decision.gateId),
			);
			if (!winnerLine) throw new Error("REVIEW_GATE_ALREADY_RESOLVED");
			const winner = decodeReviewDecisionPayload(winnerLine.payload);
			return {
				created: false,
				decision: winner,
				semanticRetry:
					winner.decisionIntentHash === input.decision.decisionIntentHash,
			};
		},
		deriveGoverningState(runId, b0) {
			return foldGoverningReviewState({
				b0,
				decisions: this.listDecisions(runId),
				steps: recordStore.listLines(runId, "steps"),
				budget: recordStore.listLines(runId, "budget"),
			});
		},
	};
}
