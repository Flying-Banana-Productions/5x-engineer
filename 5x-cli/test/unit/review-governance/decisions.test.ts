import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMemoryRecordStore,
	createWorkingTreeRecordStore,
	type RecordOrigin,
	recordedEnvelope,
	type StepRecordPayload,
} from "../../../src/control-plane/index.js";
import { encodeBudgetSnapshotPayload } from "../../../src/review-budget/record-lines.js";
import {
	classifyDecisionAcceptance,
	createReviewDecision,
	foldGoverningReviewState,
	governanceDecisionKey,
} from "../../../src/review-governance/decisions.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "human", role: "operator" },
};
const runId = "run-governance";

function step(
	step_name: string,
	iteration: number,
	result_json: unknown = {},
): StepRecordPayload {
	return {
		step_name,
		phase: "plan",
		iteration,
		result_json,
		head_commit: null,
		patch_id: null,
		diff_summary: null,
		duration_ms: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		model: null,
	};
}

function setup(intervening = false) {
	const store = createMemoryRecordStore();
	store.putRun({
		id: runId,
		plan_path: "/plan.md",
		config_json: null,
		created_at: "2026-01-01",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "test",
		format_version: 1,
		creator: origin.recorder,
	});
	const appendStep = (payload: StepRecordPayload) =>
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: `step:${payload.step_name}:${payload.iteration}`,
			payload,
			...recordedEnvelope(origin),
		});
	appendStep(step("reviewer:plan", 1));
	store.append({
		runId,
		stream: "budget",
		idempotencyKey: "snapshot",
		payload: encodeBudgetSnapshotPayload({
			kind: "snapshot",
			id: "snapshot-1",
			runId,
			stepKey: { stepName: "reviewer:plan", phase: "plan", iteration: 1 },
			currentLedger: {
				workItems: [],
				surface: {},
				estimateConfidence: "medium",
			} as never,
			findings: [],
			assessments: [],
			effectiveGateCauses: [{ kind: "budget_band", band: "over_effective" }],
			createdAt: "2026-01-01",
		}),
		...recordedEnvelope(origin),
	});
	if (intervening) appendStep(step("reviewer:closure", 2));
	return { store, appendStep };
}

function decision(
	choice:
		| "adjust_baseline"
		| "request_author_reestimate"
		| "defer_accept_risk" = "adjust_baseline",
) {
	return createReviewDecision({
		gateId: "gate-1",
		snapshotId: "snapshot-1",
		choice,
		findingRefs:
			choice === "defer_accept_risk"
				? [{ findingId: "F1", fingerprint: "sha256:a" }]
				: [],
		rationale: "Operator approved the governance change",
		evidence: choice === "defer_accept_risk" ? ["Accepted for this scope"] : [],
		approvedScope: { retained: [], removed: [] },
		...(choice === "adjust_baseline"
			? { governingBaselineChange: { from: 5, to: 8 } }
			: {}),
		decisionId: "11111111-1111-4111-8111-111111111112",
		createdAt: "2026-01-02",
	});
}

describe("durable governance decisions", () => {
	test("intent hash ignores generated identity and validates choice fields", () => {
		const first = decision();
		const second = createReviewDecision({
			...first,
			decisionId: "11111111-1111-4111-8111-111111111113",
			createdAt: "2026-01-03",
		});
		expect(second.decisionIntentHash).toBe(first.decisionIntentHash);
		expect(() =>
			createReviewDecision({
				gateId: "g",
				snapshotId: "s",
				choice: "trade_scope",
				findingRefs: [],
				rationale: "why",
				evidence: [],
				approvedScope: { retained: [], removed: [] },
			}),
		).toThrow("scope delta");
		expect(() =>
			createReviewDecision({
				gateId: "g",
				snapshotId: "s",
				choice: "abort",
				findingRefs: [],
				rationale: "why",
				evidence: [],
				approvedScope: { retained: [], removed: [] },
				governingBaselineChange: { from: 1, to: 2 },
			}),
		).toThrow("cannot mutate");
	});

	test("steps insertion order distinguishes stale acceptance from later reviews", () => {
		for (const intervening of [false, true]) {
			const { store, appendStep } = setup(intervening);
			const current = decision();
			appendStep(
				step("human:review-governance", 3, {
					decisionId: current.decisionId,
					gateId: current.gateId,
				}),
			);
			if (!intervening) appendStep(step("reviewer:after-human", 4));
			const result = classifyDecisionAcceptance({
				decision: current,
				steps: store.listLines(runId, "steps"),
				budget: store.listLines(runId, "budget"),
			});
			expect(result.accepted).toBe(!intervening);
			expect(result.stale).toBe(intervening);
		}
	});

	test("fold applies accepted history in insertion order and keeps stale decisions audit-only", () => {
		const { store, appendStep } = setup(false);
		const adjusted = decision();
		appendStep(
			step("human:review-governance", 2, {
				decisionId: adjusted.decisionId,
				gateId: adjusted.gateId,
			}),
		);
		store.append({
			runId,
			stream: "decisions",
			idempotencyKey: governanceDecisionKey(adjusted.gateId),
			payload: adjusted,
			...recordedEnvelope(origin),
		});
		const state = foldGoverningReviewState({
			b0: 5,
			decisions: [adjusted],
			steps: store.listLines(runId, "steps"),
			budget: store.listLines(runId, "budget"),
		});
		expect(state.governingBaseline).toBe(8);
		expect(state.baselineDisputeResolution).toEqual({
			decisionId: adjusted.decisionId,
			choice: "adjust_baseline",
		});
		expect(state.auditOnly).toEqual([]);
	});

	test("memory and working-tree stores fold identical authoritative history", () => {
		const { store: memory, appendStep } = setup(false);
		const adjusted = decision();
		appendStep(
			step("human:review-governance", 2, {
				decisionId: adjusted.decisionId,
				gateId: adjusted.gateId,
			}),
		);
		memory.append({
			runId,
			stream: "decisions",
			idempotencyKey: governanceDecisionKey(adjusted.gateId),
			payload: adjusted,
			...recordedEnvelope(origin),
		});
		const root = mkdtempSync(join(tmpdir(), "5x-governance-contract-"));
		try {
			const workingTree = createWorkingTreeRecordStore({ recordsRoot: root });
			const summary = memory.getRun(runId);
			if (!summary) throw new Error("missing fixture run");
			workingTree.putRun(summary);
			for (const stream of ["steps", "budget", "decisions"] as const) {
				for (const line of memory.listLines(runId, stream))
					workingTree.append({ ...line });
			}
			const fold = (store: typeof memory) =>
				foldGoverningReviewState({
					b0: 5,
					decisions: [adjusted],
					steps: store.listLines(runId, "steps"),
					budget: store.listLines(runId, "budget"),
				});
			expect(fold(workingTree)).toEqual(fold(memory));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("three decision kinds fold baseline, re-estimate, and accepted-risk state", () => {
		const { store, appendStep } = setup(false);
		const reestimate = createReviewDecision({
			gateId: "gate-reestimate",
			snapshotId: "snapshot-1",
			choice: "request_author_reestimate",
			findingRefs: [],
			rationale: "Ask the author for a new estimate",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
		});
		const retain = createReviewDecision({
			gateId: "gate-retain",
			snapshotId: "snapshot-1",
			choice: "retain_baseline",
			findingRefs: [],
			rationale: "Retain the reviewed baseline",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
		});
		const finding = { findingId: "F1", fingerprint: "sha256:risk" };
		const risk = createReviewDecision({
			gateId: "gate-risk",
			snapshotId: "snapshot-1",
			choice: "defer_accept_risk",
			findingRefs: [finding],
			rationale: "Accept the named risk",
			evidence: ["Explicit operator evidence"],
			approvedScope: { retained: ["current scope"], removed: [] },
		});
		for (const [index, current] of [reestimate, retain, risk].entries())
			appendStep(
				step("human:review-governance", index + 2, {
					decisionId: current.decisionId,
					gateId: current.gateId,
				}),
			);
		const state = foldGoverningReviewState({
			b0: 5,
			decisions: [reestimate, retain, risk],
			steps: store.listLines(runId, "steps"),
			budget: store.listLines(runId, "budget"),
		});
		expect(state.baselineReestimatePending).toBeUndefined();
		expect(state.baselineDisputeResolution).toEqual({
			decisionId: retain.decisionId,
			choice: "retain_baseline",
		});
		expect(state.acceptedRisks).toEqual([
			{
				...finding,
				decisionId: risk.decisionId,
				rationale: risk.rationale,
				evidence: risk.evidence,
			},
		]);
	});
});
