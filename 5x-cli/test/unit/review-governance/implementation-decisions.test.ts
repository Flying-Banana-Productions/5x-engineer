import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	createMemoryPromptStore,
	createMemoryRecordStore,
	type RecordOrigin,
	recordedEnvelope,
	type StepRecordPayload,
} from "../../../src/control-plane/index.js";
import { runMigrations } from "../../../src/db/schema.js";
import type { ImplementationReviewObservationPayload } from "../../../src/review-budget/record-lines.js";
import {
	encodeBudgetSnapshotPayload,
	encodeImplementationReviewObservationPayload,
} from "../../../src/review-budget/record-lines.js";
import {
	applyImplementationDecisionCauseCoverage,
	assertImplementationDecisionScope,
	classifyDecisionAcceptance,
	createImplementationDecision,
	createReviewDecision,
	deriveGateId,
	foldGoverningReviewState,
	type ImplementationDecisionPayload,
} from "../../../src/review-governance/decisions.js";
import { reindexReviewGovernance } from "../../../src/review-governance/sqlite-index.js";
import {
	createReviewGovernanceStore,
	deriveOpenImplementationGate,
	repairReviewGatePrompts,
} from "../../../src/review-governance/store.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "human", role: "operator" },
};
const runId = "run-impl";

function step(
	step_name: string,
	iteration: number,
	phase: string,
	result_json: unknown = {},
	createdAt = "2026-01-01 00:00:00",
): { payload: StepRecordPayload; createdAt: string } {
	return {
		createdAt,
		payload: {
			step_name,
			phase,
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
		},
	};
}

function observation(
	overrides: Partial<ImplementationReviewObservationPayload> = {},
): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: "obs-1",
		runId,
		stepKey: { stepName: "reviewer:impl", phase: "1", iteration: 1 },
		bindingId: "binding-1",
		contextId: "ctx-1",
		domain: "implementation",
		phase: "1",
		originalVerdict: { readiness: "not_ready", items: [] },
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [
			{
				kind: "semantic_human",
				findingId: "F1",
				fingerprint: "sha256:finding-1",
			},
			{
				kind: "credit_shortfall",
				claimIds: ["C1"],
				claims: [
					{
						creditClaimId: "C1",
						approvedArchitectureDelta: -4,
						realizedArchitectureDelta: -1,
						evidence: "partial",
					},
				],
			},
		],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: 0,
				plan_defect: 0,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 0,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 0,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 1, R: 0, B: 5, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-01-01 00:00:00",
		...overrides,
	};
}

function seed() {
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
	return store;
}

function appendObservation(
	store: ReturnType<typeof seed>,
	payload = observation(),
) {
	store.append({
		runId,
		stream: "budget",
		idempotencyKey: `budget:implementation-review:${payload.id}`,
		payload: encodeImplementationReviewObservationPayload(payload),
		...recordedEnvelope(origin),
	});
	const reviewer = step("reviewer:impl", payload.stepKey.iteration ?? 1, "1");
	store.append({
		runId,
		stream: "steps",
		idempotencyKey: `reviewer:${payload.id}`,
		payload: reviewer.payload,
		createdAt: reviewer.createdAt,
		...recordedEnvelope(origin),
	});
}

function decision(
	gateId: string,
	choice: ImplementationDecisionPayload["choice"] = "defer_accept_risk",
): ImplementationDecisionPayload {
	return createImplementationDecision({
		gateId,
		observationId: "obs-1",
		bindingId: "binding-1",
		phase: "1",
		choice,
		findingRefs:
			choice === "defer_accept_risk" || choice === "authorize_amendment"
				? [{ findingId: "F1", fingerprint: "sha256:finding-1" }]
				: [],
		rationale: "Operator recorded the implementation decision",
		evidence: choice === "defer_accept_risk" ? ["accepted risk"] : [],
		claimAdjustments:
			choice === "approve_higher_burden" || choice === "reduce_scope"
				? [{ creditClaimId: "C1", approvedArchitectureDelta: -2 }]
				: choice === "restore_simplification"
					? [
							{
								creditClaimId: "C1",
								approvedArchitectureDelta: -4,
								supersedesObservationId: "obs-1",
							},
						]
					: [],
		ledgerHash: "ledger-a",
		decisionsHash: "decisions-a",
		createdAt: "2026-01-02 00:00:00",
	});
}

describe("implementation review decisions", () => {
	test("plan gate ids ignore implementation identity fields", () => {
		const plan = deriveGateId({
			runId,
			snapshotId: "snapshot-1",
			causes: [{ kind: "budget_band", band: "over_effective" }],
		});
		const withDomain = deriveGateId({
			runId,
			snapshotId: "snapshot-1",
			causes: [{ kind: "budget_band", band: "over_effective" }],
			domain: "implementation",
			phase: "1",
			bindingId: "binding-1",
			observationId: "obs-1",
		});
		expect(withDomain).not.toBe(plan);
	});

	test("same-intent CAS keeps one decision and a different intent loses", () => {
		const store = seed();
		appendObservation(store);
		const governance = createReviewGovernanceStore(store);
		const gate = governance.deriveOpenImplementationGate(runId, "1");
		if (!gate) throw new Error("expected gate");
		const winner = decision(gate.gateId);
		const human = (id: string, iteration: number): StepRecordPayload => ({
			...step("human:review-governance", iteration, "1", {
				decisionId: id,
				gateId: gate.gateId,
			}).payload,
		});
		expect(
			governance.resolveImplementationGate({
				runId,
				decision: winner,
				humanStep: human(winner.decisionId, 2),
				origin,
				ledgerHash: "ledger-a",
				decisionsHash: "decisions-a",
			}).created,
		).toBe(true);
		const same = createImplementationDecision({
			...winner,
			decisionId: "22222222-2222-4222-8222-222222222222",
			createdAt: "2026-01-03 00:00:00",
		});
		const retry = governance.resolveImplementationGate({
			runId,
			decision: same,
			humanStep: human(same.decisionId, 3),
			origin,
			ledgerHash: "ledger-a",
			decisionsHash: "decisions-a",
		});
		expect(retry.created).toBe(false);
		expect(retry.semanticRetry).toBe(true);
		expect(retry.decision.decisionId).toBe(winner.decisionId);
		const other = createImplementationDecision({
			...winner,
			rationale: "A different operator intent",
			decisionId: "33333333-3333-4333-8333-333333333333",
		});
		const loser = governance.resolveImplementationGate({
			runId,
			decision: other,
			humanStep: human(other.decisionId, 4),
			origin,
			ledgerHash: "ledger-a",
			decisionsHash: "decisions-a",
		});
		expect(loser.semanticRetry).toBe(false);
		expect(store.listLines(runId, "decisions")).toHaveLength(1);
	});

	test("a same-phase review before the human step is stale and a later one is not", () => {
		const store = seed();
		appendObservation(store);
		const gate = deriveOpenImplementationGate(store, runId, "1");
		if (!gate) throw new Error("expected gate");
		const made = decision(gate.gateId);
		const human = step("human:review-governance", 4, "1", {
			decisionId: made.decisionId,
			gateId: made.gateId,
		});
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "late-review",
			payload: step("reviewer:again", 2, "1").payload,
			createdAt: "2026-01-02 00:00:00",
			...recordedEnvelope(origin),
		});
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "human",
			payload: human.payload,
			createdAt: human.createdAt,
			...recordedEnvelope(origin),
		});
		store.append({
			runId,
			stream: "decisions",
			idempotencyKey: `decision:review-gate:${made.gateId}`,
			payload: made,
			createdAt: made.createdAt,
			...recordedEnvelope(origin),
		});
		const stale = classifyDecisionAcceptance({
			decision: made,
			steps: store.listLines(runId, "steps"),
			budget: store.listLines(runId, "budget"),
		});
		expect(stale.stale).toBe(true);
		const after = seed();
		appendObservation(after);
		const humanFirst = step(
			"human:review-governance",
			2,
			"1",
			{ decisionId: made.decisionId, gateId: made.gateId },
			"2026-01-02 00:00:00",
		);
		after.append({
			runId,
			stream: "steps",
			idempotencyKey: "human",
			payload: humanFirst.payload,
			createdAt: "2026-01-02 00:00:00",
			...recordedEnvelope(origin),
		});
		after.append({
			runId,
			stream: "steps",
			idempotencyKey: "later-review",
			payload: step("reviewer:later", 3, "1").payload,
			createdAt: "2026-01-02 00:00:00",
			...recordedEnvelope(origin),
		});
		expect(
			classifyDecisionAcceptance({
				decision: made,
				steps: after.listLines(runId, "steps"),
				budget: after.listLines(runId, "budget"),
			}).accepted,
		).toBe(true);
	});

	test("a review in another phase does not stale the decision", () => {
		const store = seed();
		appendObservation(store);
		const gate = deriveOpenImplementationGate(store, runId, "1");
		if (!gate) throw new Error("expected gate");
		const made = decision(gate.gateId);
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "other-phase",
			payload: step("reviewer:other", 2, "2").payload,
			...recordedEnvelope(origin),
		});
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "human",
			payload: step("human:review-governance", 3, "1", {
				decisionId: made.decisionId,
				gateId: made.gateId,
			}).payload,
			...recordedEnvelope(origin),
		});
		expect(
			classifyDecisionAcceptance({
				decision: made,
				steps: store.listLines(runId, "steps"),
				budget: store.listLines(runId, "budget"),
			}).accepted,
		).toBe(true);
	});

	test("a superseding binding invalidates the earlier gate", () => {
		const store = seed();
		appendObservation(store);
		const gate = deriveOpenImplementationGate(store, runId, "1");
		if (!gate) throw new Error("expected gate");
		const made = decision(gate.gateId);
		store.append({
			runId,
			stream: "budget",
			idempotencyKey: "budget:implementation-binding:next",
			payload: { kind: "implementation-binding", id: "binding-2" },
			...recordedEnvelope(origin),
		});
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "human",
			payload: step("human:review-governance", 2, "1", {
				decisionId: made.decisionId,
				gateId: made.gateId,
			}).payload,
			...recordedEnvelope(origin),
		});
		const acceptance = classifyDecisionAcceptance({
			decision: made,
			steps: store.listLines(runId, "steps"),
			budget: store.listLines(runId, "budget"),
		});
		expect(acceptance.stale).toBe(true);
		expect(acceptance.diagnostic).toContain("superseding binding");
	});

	test("plan fold ignores implementation decisions and keeps imported risk identity", () => {
		const plan = createReviewDecision({
			gateId: "plan-gate",
			snapshotId: "snapshot-1",
			choice: "defer_accept_risk",
			findingRefs: [{ findingId: "F1", fingerprint: "sha256:finding-1" }],
			rationale: "Plan risk",
			evidence: ["plan evidence"],
			approvedScope: { retained: [], removed: [] },
		});
		const store = seed();
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "plan-reviewer",
			payload: step("reviewer:plan", 1, "plan").payload,
			...recordedEnvelope(origin),
		});
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
				createdAt: "2026-01-01",
			}),
			...recordedEnvelope(origin),
		});
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "plan-human",
			payload: step("human:review-governance", 2, "plan", {
				decisionId: plan.decisionId,
				gateId: plan.gateId,
			}).payload,
			...recordedEnvelope(origin),
		});
		appendObservation(store);
		const gate = deriveOpenImplementationGate(store, runId, "1");
		if (!gate) throw new Error("expected gate");
		const impl = decision(gate.gateId);
		store.append({
			runId,
			stream: "decisions",
			idempotencyKey: "plan-decision",
			payload: plan,
			...recordedEnvelope(origin),
		});
		store.append({
			runId,
			stream: "decisions",
			idempotencyKey: "impl-decision",
			payload: impl,
			...recordedEnvelope(origin),
		});
		const folded = foldGoverningReviewState({
			b0: 5,
			decisions: createReviewGovernanceStore(store).listDecisions(runId),
			steps: store.listLines(runId, "steps"),
			budget: store.listLines(runId, "budget"),
		});
		expect(folded.acceptedRisks.map((risk) => risk.decisionId)).toEqual([
			plan.decisionId,
		]);
		expect(folded.acceptedRisks[0]?.fingerprint).toBe("sha256:finding-1");
		expect(
			folded.history.some((item) => item.decisionId === impl.decisionId),
		).toBe(false);
	});

	test("claim scope rejects arbitrary ids and broader credit", () => {
		const made = decision("gate", "approve_higher_burden");
		expect(() =>
			assertImplementationDecisionScope({
				decision: made,
				allowedClaimIds: new Set(["C9"]),
				originalDeltas: new Map([["C1", -4]]),
				gateClaimIds: new Set(["C1"]),
			}),
		).toThrow("arbitrary claim");
		expect(() =>
			assertImplementationDecisionScope({
				decision: createImplementationDecision({
					...made,
					claimAdjustments: [
						{ creditClaimId: "C1", approvedArchitectureDelta: -8 },
					],
				}),
				allowedClaimIds: new Set(["C1"]),
				originalDeltas: new Map([["C1", -4]]),
				gateClaimIds: new Set(["C1"]),
			}),
		).toThrow("broaden");
	});

	test("deferral leaves one successor and does not conceal an unreconciled claim", () => {
		const causes = observation().gateCauses.concat({
			kind: "credit_unreconciled",
			claimIds: ["C2"],
		});
		const made = decision("gate");
		const remaining = applyImplementationDecisionCauseCoverage(causes, made);
		expect(remaining.map((cause) => cause.kind)).toEqual([
			"credit_shortfall",
			"credit_unreconciled",
		]);
		const restored = decision("gate", "restore_simplification");
		const afterRestore = applyImplementationDecisionCauseCoverage(
			observation().gateCauses,
			restored,
		);
		expect(afterRestore.map((cause) => cause.kind)).toEqual(["semantic_human"]);
	});

	test("malformed observation boundaries are not accepted", () => {
		const store = seed();
		const made = decision("gate");
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "human",
			payload: step("human:review-governance", 2, "1", {
				decisionId: made.decisionId,
				gateId: made.gateId,
			}).payload,
			...recordedEnvelope(origin),
		});
		expect(
			classifyDecisionAcceptance({
				decision: made,
				steps: store.listLines(runId, "steps"),
				budget: store.listLines(runId, "budget"),
			}).diagnostic,
		).toBe("observation boundary is missing or duplicated");
	});

	test("prompt repair closes an implementation gate and abort is terminal only after acceptance", () => {
		const store = seed();
		appendObservation(store);
		const prompts = createMemoryPromptStore();
		const governance = createReviewGovernanceStore(store, prompts);
		const gate = governance.deriveOpenImplementationGate(runId, "1");
		if (!gate) throw new Error("expected gate");
		prompts.createPrompt({
			runId,
			kind: "choose",
			message: "decide",
			options: ["abort"],
			contextVersion: 1,
			context: {
				type: "implementation_review_gate",
				gateId: gate.gateId,
				observationId: gate.observationId,
				bindingId: gate.bindingId,
				phase: gate.phase,
				causes: gate.causes,
				eligibleFindings: [],
				allowedChoices: ["abort"],
				requiredFieldsByChoice: {
					authorize_amendment: [],
					defer_accept_risk: [],
					restore_simplification: [],
					approve_higher_burden: [],
					reduce_scope: [],
					abort: ["rationale"],
				},
				ledgerHash: "ledger-a",
				decisionsHash: "decisions-a",
			},
		});
		const open = prompts.listOpenPrompts(runId)[0];
		if (!open) throw new Error("expected an open prompt");
		expect(() => prompts.answerPrompt(open.id, "abort", "terminal")).toThrow(
			"5x review decide",
		);
		const made = decision(gate.gateId, "abort");
		governance.resolveImplementationGate({
			runId,
			decision: made,
			humanStep: step("human:review-governance", 2, "1", {
				decisionId: made.decisionId,
				gateId: made.gateId,
			}).payload,
			origin,
			ledgerHash: "ledger-a",
			decisionsHash: "decisions-a",
		});
		expect(repairReviewGatePrompts(store, prompts, runId)).toBe(1);
		expect(prompts.listOpenPrompts(runId)).toHaveLength(0);
		expect(
			governance.resolveImplementationGate({
				runId,
				decision: made,
				humanStep: step("human:review-governance", 2, "1", {
					decisionId: made.decisionId,
					gateId: made.gateId,
				}).payload,
				origin,
				ledgerHash: "ledger-a",
				decisionsHash: "decisions-a",
			}).nextAction,
		).toBe("aborted");
	});

	test("wiped index rebuild matches the live implementation projection", () => {
		const store = seed();
		appendObservation(store);
		const gate = deriveOpenImplementationGate(store, runId, "1");
		if (!gate) throw new Error("expected gate");
		const made = decision(gate.gateId, "approve_higher_burden");
		store.append({
			runId,
			stream: "steps",
			idempotencyKey: "human",
			payload: step("human:review-governance", 2, "1", {
				decisionId: made.decisionId,
				gateId: made.gateId,
			}).payload,
			...recordedEnvelope(origin),
		});
		store.append({
			runId,
			stream: "decisions",
			idempotencyKey: `decision:review-gate:${made.gateId}`,
			payload: made,
			...recordedEnvelope(origin),
		});
		store.append({
			runId,
			stream: "budget",
			idempotencyKey: "budget:implementation-binding:run",
			payload: {
				kind: "implementation-binding",
				version: 99,
				id: "binding-future",
			},
			...recordedEnvelope(origin),
		});
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.exec(
				"INSERT INTO runs(id, plan_path) VALUES ('run-impl', '/plan.md')",
			);
			const live = reindexReviewGovernance(store, db, runId);
			const before = db
				.query(
					"SELECT decision_id, domain, acceptance FROM review_decision_index ORDER BY record_seq",
				)
				.all();
			db.exec(
				"DELETE FROM review_decision_index; DELETE FROM review_gate_index; DELETE FROM implementation_observation_index; DELETE FROM implementation_binding_index",
			);
			const rebuilt = reindexReviewGovernance(store, db, runId);
			expect(rebuilt.decisions).toBe(live.decisions);
			expect(rebuilt.gates).toBe(live.gates);
			expect(
				db
					.query(
						"SELECT decision_id, domain, acceptance FROM review_decision_index ORDER BY record_seq",
					)
					.all(),
			).toEqual(before);
			expect(rebuilt.diagnostics.join("\n")).toContain(
				"unsupported implementation record version",
			);
			expect(
				(
					db
						.query("SELECT COUNT(*) AS n FROM implementation_observation_index")
						.get() as { n: number }
				).n,
			).toBe(1);
		} finally {
			db.close();
		}
	});
});
