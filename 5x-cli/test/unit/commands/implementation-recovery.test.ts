import { describe, expect, test } from "bun:test";
import { submitReviewDecision } from "../../../src/commands/review-decision.handler.js";
import {
	createMemoryPromptStore,
	recordedEnvelope,
} from "../../../src/control-plane/index.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import {
	deriveBudget,
	sumEffort,
} from "../../../src/review-budget/arithmetic.js";
import type { ImplementationReviewObservationPayload } from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	buildImplementationReviewPromptContext,
	formatImplementationAuthorContext,
} from "../../../src/review-governance/context.js";
import { createReviewDecision } from "../../../src/review-governance/decisions.js";
import { evaluateImplementationBoundary } from "../../../src/review-governance/implementation-boundary.js";
import { recoverImplementationPlan } from "../../../src/review-governance/implementation-recovery.js";
import {
	detectPlanDrift,
	ensureImplementationAdmission,
	hashPlanBytes,
	verifyImplementationReviewContext,
} from "../../../src/review-governance/implementation-state.js";
import {
	createReviewGovernanceStore,
	deriveOpenImplementationGate,
} from "../../../src/review-governance/store.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

const ORIGINAL = `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Providers | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Foundation

**Completion gate:** Stable types.

- [ ] Stable types

## Phase 2: Providers

**Completion gate:** Normalize time.

- [ ] Read digits as Eastern

## Phase 3: Verification

**Completion gate:** Verify normalization.

- [ ] Verify timestamps
`;
const AMENDED = ORIGINAL.replace(
	"Read digits as Eastern",
	"Honor explicit offsets; only offsetless digits are Eastern",
);
const COMMIT = "a".repeat(40);

function ledger(text: string) {
	const parsed = parseDeliveryBudget(text);
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.value;
}

function fixtureHash(value: unknown): string {
	const keys = new Set<string>();
	JSON.stringify(value, (key, entry) => {
		if (key) keys.add(key);
		return entry;
	});
	return hashPlanBytes(JSON.stringify(value, [...keys].sort()));
}

async function fixture(
	options: {
		original?: string;
		amended?: string;
		finalCorrections?: boolean;
		finalAuthorResult?: string;
		approvedP?: number;
		approvedWorkItemIds?: string[];
	} = {},
) {
	const original = options.original ?? ORIGINAL;
	const amended = options.amended ?? AMENDED;
	const ctx = makeBudgetContext({ mode: "enforced" });
	const append = (stream: "budget" | "steps", key: string, payload: unknown) =>
		ctx.recordStore.append({
			runId: "run1",
			stream,
			idempotencyKey: key,
			payload,
			...recordedEnvelope(TEST_ORIGIN),
		});
	const step = (name: string, phase: string, result: unknown, iteration = 0) =>
		append("steps", `${name}:${phase}:${iteration}`, {
			step_name: name,
			phase,
			iteration,
			result_json: result,
			head_commit: (result as { commit?: string })?.commit ?? COMMIT,
		});
	const binding = ctx.store.saveImplementationBinding(
		{
			kind: "implementation-binding",
			version: 1,
			id: "binding",
			executionRunId: "run1",
			sourceRunId: "source",
			sourceSnapshotId: "source-snapshot",
			sourceBaselineId: "source-baseline",
			approvedPlanCommit: "b".repeat(40),
			approvedPlanHash: hashPlanBytes(original),
			approvedPlanBytes: original,
			b0: 2,
			governingB: 2,
			mode: "enforced",
			thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
			ledger: ledger(original),
			effectiveDecisions: [],
			phaseMap: [
				{ id: "1", heading: "Foundation" },
				{ id: "2", heading: "Providers" },
				{ id: "3", heading: "Verification" },
			],
			debtTargets: [],
			ledgerHash: fixtureHash(ledger(original)),
			decisionsHash: fixtureHash([]),
			createdAt: "2026-01-01",
		},
		TEST_ORIGIN,
	).payload;
	const observation: ImplementationReviewObservationPayload = {
		kind: "implementation-review",
		version: 1,
		id: "observation",
		runId: "run1",
		stepKey: { stepName: "reviewer:impl", phase: "2", iteration: 0 },
		bindingId: binding.id,
		contextId: "old-context",
		domain: "implementation",
		phase: "2",
		originalVerdict: {
			readiness: "not_ready",
			items: [
				{
					id: "R1",
					title: "Timestamp policy",
					action: "human_required",
					reason: "Choose authority",
					priority: "P1",
					scopeClass: "plan_defect",
					effortDelta: 1,
					architectureDelta: 0,
					estimateConfidence: "high",
					failure: "Wrong instant",
					lowestCostCorrection: "Honor offsets",
					planImpact: { kind: "design", locations: [] },
				},
				{
					id: "R2",
					title: "Pagination",
					action: "auto_fix",
					reason: "Missing page",
					priority: "P1",
					scopeClass: "implementation_defect",
					planWorkItemIds: ["W1"],
					effortDelta: 1,
					architectureDelta: 0,
					estimateConfidence: "high",
					failure: "Lost filings",
					lowestCostCorrection: "Fetch page",
				},
			],
		},
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [
			{
				kind: "plan_amendment",
				findingId: "R1",
				fingerprint: "sha256:timestamp",
			},
		],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: 1,
				plan_defect: 1,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 1,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 2,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 2, R: 0, B: 2, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-01-01",
	};
	step("reviewer:impl", "2", observation.originalVerdict);
	append("budget", "observation", observation);
	ctx.store.saveImplementationReviewContext(
		{
			kind: "implementation-review-context",
			version: 1,
			id: "old-context",
			executionRunId: "run1",
			bindingId: binding.id,
			phase: "2",
			baseCommit: "b".repeat(40),
			reviewedCommit: COMMIT,
			patchHash: "sha256:patch",
			excludedPaths: [],
			hunks: [],
			binaryPaths: [],
			createdAt: "2026-01-01",
		},
		TEST_ORIGIN,
	);
	const gate = deriveOpenImplementationGate(ctx.recordStore, "run1", "2");
	if (!gate) throw new Error("No gate");
	const decision = await submitReviewDecision(
		{
			runId: "run1",
			gateId: gate.gateId,
			payload: {
				choice: "authorize_amendment",
				rationale: "Offline timestamp normalization only",
				findingRefs: [{ findingId: "R1", fingerprint: "sha256:timestamp" }],
			},
		},
		{ context: ctx, promptStore: createMemoryPromptStore() },
	);
	step("author:process-plan-review", "plan", {
		result: "complete",
		commit: COMMIT,
	});
	ctx.store.captureBaseline({
		runId: "run1",
		captureKind: "initial",
		parsed: ledger(amended),
		mode: "enforced",
		configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
		origin: TEST_ORIGIN,
	});
	const items = options.finalCorrections
		? [
				{
					id: "R8",
					title: "Clarify wording",
					action: "auto_fix",
					reason: "Mechanical wording",
					priority: "P2",
					scopeClass: "acceptance_required",
					effortDelta: 0,
					architectureDelta: 0,
					failure: "Ambiguous wording",
					lowestCostCorrection: "Clarify",
					requiresReviewerVerification: false,
				},
			]
		: [];
	step("reviewer:plan", "plan", {
		readiness: options.finalCorrections ? "ready_with_corrections" : "ready",
		items,
		governance: {
			route:
				options.approvedP !== undefined
					? "human_gate"
					: options.finalCorrections
						? "final_corrections"
						: "complete",
		},
	});
	const findings = items.map((item) => ({
		id: item.id,
		effortDelta: 0,
		architectureDelta: 0,
		scopeClass: "acceptance_required" as const,
		coupling: undefined,
	}));
	const snapshot = ctx.store.appendSnapshot({
		runId: "run1",
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 0,
		currentLedger: ledger(amended),
		findings,
		assessments: [],
		derived: deriveBudget({
			B0: sumEffort(ledger(amended).workItems),
			B: sumEffort(ledger(amended).workItems),
			I: null,
			semanticHumanRequired: false,
			workItems: ledger(amended).workItems,
			findings,
			assessments: [],
			config: DEFAULT_REVIEW_BUDGET_CONFIG,
		}),
		origin: TEST_ORIGIN,
	});
	let architectureApprovalId: string | undefined;
	if (options.approvedP !== undefined) {
		const approval = createReviewDecision({
			gateId: "architecture-gate",
			snapshotId: snapshot.id,
			choice: "approve_architecture_burden",
			rationale: "Explicitly approve the amended architecture burden",
			findingRefs: [],
			evidence: [],
			approvedScope: { retained: [], removed: [] },
			architectureApproval: {
				approvedP: options.approvedP,
				approvedItemIds: [],
				approvedWorkItemIds: options.approvedWorkItemIds ?? [],
			},
		});
		createReviewGovernanceStore(ctx.recordStore).resolveGate({
			runId: "run1",
			decision: approval,
			origin: TEST_ORIGIN,
			humanStep: {
				step_name: "human:review-governance",
				phase: "plan",
				iteration: 1,
				result_json: {
					decisionId: approval.decisionId,
					gateId: approval.gateId,
				},
				head_commit: COMMIT,
				patch_id: null,
				diff_summary: null,
				duration_ms: null,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
				model: null,
			},
		});
		architectureApprovalId = approval.decisionId;
	}
	const finalCommit = "c".repeat(40);
	if (options.finalCorrections)
		step(
			"author:process-plan-review",
			"plan",
			{ result: options.finalAuthorResult ?? "complete", commit: finalCommit },
			1,
		);
	const input = {
		runId: "run1",
		phase: "2",
		authorizationId: decision.decision.decisionId,
		snapshotId: snapshot.id,
		commit: options.finalCorrections ? finalCommit : COMMIT,
		scopeConfirmation:
			"Only authorized timestamp policy and pending pagination; offline only",
		preservedPhaseConfirmation:
			"Shared policy does not change Phase 1 type contracts",
	};
	const deps = {
		recordStore: ctx.recordStore,
		store: ctx.store,
		origin: TEST_ORIGIN,
		committedPlanBytes: amended,
		worktreePlanBytes: amended,
	};
	return {
		ctx,
		binding,
		observation,
		input,
		deps,
		step,
		append,
		architectureApprovalId,
	};
}

describe("unfinished-frontier amendment recovery", () => {
	test("accepts a completed final-correction author and descriptive Addresses changes after review", async () => {
		const f = await fixture({ finalCorrections: true });
		try {
			f.deps.committedPlanBytes =
				f.deps.worktreePlanBytes = `${AMENDED.replace("| - | - | Required |", "| - | R8 | Clarified wording |")}\nFinal wording.\n`;
			const result = recoverImplementationPlan(f.input, f.deps);
			expect(result.created).toBe(true);
			expect(result.recovery.afterCommit).toBe("c".repeat(40));
			expect(result.completionAuthorized).toBe(false);
		} finally {
			f.ctx.db.close();
		}
	});

	for (const scenario of [
		"incomplete author",
		"earlier author",
		"later author",
		"later reviewer",
		"unreviewed score",
	] as const) {
		test(`final corrections reject ${scenario}`, async () => {
			const f = await fixture({
				finalCorrections: true,
				finalAuthorResult:
					scenario === "incomplete author" ? "needs_human" : "complete",
			});
			try {
				if (scenario === "earlier author") f.input.commit = COMMIT;
				if (scenario === "later author")
					f.step(
						"author:process-plan-review",
						"plan",
						{ result: "complete", commit: "d".repeat(40) },
						2,
					);
				if (scenario === "later reviewer")
					f.step("reviewer:plan", "plan", { readiness: "ready", items: [] }, 1);
				if (scenario === "unreviewed score")
					f.deps.committedPlanBytes = f.deps.worktreePlanBytes =
						AMENDED.replace("| 2 | 0 |", "| 2 | 1 |");
				expect(() => recoverImplementationPlan(f.input, f.deps)).toThrow();
				expect(
					f.ctx.store.listImplementationTextAmendments("run1", "binding"),
				).toEqual([]);
			} finally {
				f.ctx.db.close();
			}
		});
	}

	const architectureOriginal = ORIGINAL.replace(
		"| W1 | Providers | 2 | 0 | - | - | Required |",
		[
			"| W16 | Providers | 2 | 2 | - | - | Required |",
			...Array.from(
				{ length: 7 },
				(_, i) => `| W${i + 1} | Other ${i} | 1 | 3 | - | - | Required |`,
			),
		].join("\n"),
	);
	const architectureAmended = architectureOriginal.replace(
		"| W16 | Providers | 2 | 2 | - | - | Required |",
		"| W16 | Validation projection | 2 | 3 | - | R1 | Queue-state coupling |",
	);
	test("admits W16 2 → 3 / P23 → P24 with durable approval, including post-decision final corrections", async () => {
		const f = await fixture({
			original: architectureOriginal,
			amended: architectureAmended,
			approvedP: 24,
			finalCorrections: true,
		});
		try {
			f.deps.committedPlanBytes = f.deps.worktreePlanBytes = architectureAmended
				.replace(
					"| R1 | Queue-state coupling |",
					"| R1, R8 | Clarified queue-state coupling |",
				)
				.replace(
					"| Validation projection |",
					"| Public validation projection |",
				);
			const history = f.ctx.recordStore.listLines("run1", "steps");
			const decisions = f.ctx.recordStore.listLines("run1", "decisions");
			const result = recoverImplementationPlan(f.input, f.deps);
			expect(result.recovery.architectureApprovalId).toBe(
				f.architectureApprovalId,
			);
			expect(result.completionAuthorized).toBe(false);
			expect(result.nextAction).toBe("implementation_corrections");
			const rebuilt = createReviewBudgetStore(f.ctx.recordStore);
			expect(
				rebuilt.listImplementationTextAmendments("run1", "binding"),
			).toEqual([result.recovery]);
			expect(rebuilt.getImplementationBinding("run1")).toEqual(f.binding);
			expect(f.ctx.recordStore.listLines("run1", "steps")).toEqual(history);
			expect(f.ctx.recordStore.listLines("run1", "decisions")).toEqual(
				decisions,
			);
			expect(
				recoverImplementationPlan(f.input, f.deps).recovery
					.architectureApprovalId,
			).toBe(f.architectureApprovalId);
		} finally {
			f.ctx.db.close();
		}
	});

	for (const scenario of [
		"missing approval",
		"unpaired approval",
		"insufficient ceiling",
		"uncovered item",
		"effort",
		"surface",
		"debt",
	] as const) {
		test(`architecture recovery rejects ${scenario}`, async () => {
			const amended =
				scenario === "uncovered item"
					? architectureAmended.replace("| 2 | 3 |", "| 2 | 5 |")
					: architectureAmended;
			const f = await fixture({
				original: architectureOriginal,
				amended,
				approvedP:
					scenario === "missing approval"
						? undefined
						: scenario === "insufficient ceiling"
							? 23
							: 30,
			});
			try {
				if (scenario === "unpaired approval") {
					const list = f.ctx.recordStore.listLines.bind(f.ctx.recordStore);
					f.ctx.recordStore.listLines = (runId, stream) =>
						list(runId, stream).filter(
							(line) =>
								stream !== "steps" ||
								(line.payload as { result_json?: { decisionId?: string } })
									.result_json?.decisionId !== f.architectureApprovalId,
						);
				}
				if (scenario === "effort")
					f.deps.committedPlanBytes = f.deps.worktreePlanBytes =
						amended.replace("| 2 | 3 |", "| 3 | 3 |");
				if (scenario === "surface")
					f.deps.committedPlanBytes = f.deps.worktreePlanBytes =
						amended.replace("Production files: 1", "Production files: 2");
				if (scenario === "debt")
					f.deps.committedPlanBytes = f.deps.worktreePlanBytes =
						amended.replace("| 2 | 3 |", "| 2 | -1 |");
				expect(() => recoverImplementationPlan(f.input, f.deps)).toThrow();
				expect(
					f.ctx.store.listImplementationTextAmendments("run1", "binding"),
				).toEqual([]);
			} finally {
				f.ctx.db.close();
			}
		});
	}

	test("extends legacy recovery through repeated same-phase and later-frontier amendments", async () => {
		const f = await fixture();
		try {
			// Simulate a receipt persisted by the original binding-wide-key writer.
			const append = f.ctx.recordStore.atomicAppendIfAllNew.bind(
				f.ctx.recordStore,
			);
			f.ctx.recordStore.atomicAppendIfAllNew = (ops, keys) =>
				append(
					ops.map((op) => ({
						...op,
						idempotencyKey: "budget:implementation-plan-recovery:binding",
					})),
					keys,
				);
			let previous = recoverImplementationPlan(f.input, f.deps).recovery;
			f.ctx.recordStore.atomicAppendIfAllNew = append;
			expect(recoverImplementationPlan(f.input, f.deps).created).toBe(false);
			expect(() =>
				recoverImplementationPlan(
					{ ...f.input, scopeConfirmation: "Changed" },
					f.deps,
				),
			).toThrow("authorization already has an accepted recovery");

			let bytes = AMENDED;
			for (let iteration = 1; iteration <= 3; iteration++) {
				const phase = iteration < 3 ? "2" : "3";
				if (phase === "3") f.step("phase:complete", "2", {});
				const observation = {
					...f.observation,
					id: `observation-${iteration}`,
					phase,
					stepKey: { stepName: "reviewer:impl", phase, iteration },
				};
				f.step("reviewer:impl", phase, observation.originalVerdict, iteration);
				f.append("budget", observation.id, observation);
				const gate = deriveOpenImplementationGate(
					f.ctx.recordStore,
					"run1",
					phase,
				);
				if (!gate) throw new Error("No amendment gate");
				const decision = await submitReviewDecision(
					{
						runId: "run1",
						gateId: gate.gateId,
						payload: {
							choice: "authorize_amendment",
							rationale: `Amendment ${iteration}`,
							findingRefs: [
								{ findingId: "R1", fingerprint: "sha256:timestamp" },
							],
						},
					},
					{ context: f.ctx, promptStore: createMemoryPromptStore() },
				);
				bytes = bytes.replace(
					phase === "2" ? "only offsetless digits" : "Verify timestamps",
					phase === "2"
						? `validated ${iteration}; only offsetless digits`
						: "Verify all offsets",
				);
				const commit = String(iteration).repeat(40);
				f.step(
					"author:process-plan-review",
					"plan",
					{ result: "complete", commit },
					iteration,
				);
				f.step(
					"reviewer:plan",
					"plan",
					{ readiness: "ready", items: [] },
					iteration,
				);
				const snapshot = f.ctx.store.appendSnapshot({
					runId: "run1",
					stepName: "reviewer:plan",
					phase: "plan",
					iteration,
					currentLedger: ledger(bytes),
					findings: [],
					assessments: [],
					origin: TEST_ORIGIN,
				});
				const input = {
					...f.input,
					phase,
					commit,
					authorizationId: decision.decision.decisionId,
					snapshotId: snapshot.id,
				};
				const deps = {
					...f.deps,
					committedPlanBytes: bytes,
					worktreePlanBytes: bytes,
				};
				if (phase === "3") {
					const reverted = bytes.replace(
						"validated 1; validated 2; only offsetless digits",
						"only offsetless digits",
					);
					expect(() =>
						recoverImplementationPlan(input, {
							...deps,
							committedPlanBytes: reverted,
							worktreePlanBytes: reverted,
						}),
					).toThrow("Earlier phase 2 changed");
				}
				const before = f.ctx.recordStore.listLines("run1", "budget");
				expect(
					recoverImplementationPlan({ ...input, dryRun: true }, deps).created,
				).toBe(false);
				expect(f.ctx.recordStore.listLines("run1", "budget")).toEqual(before);
				const result = recoverImplementationPlan(input, deps);
				expect(result.created).toBe(true);
				expect(result.completionAuthorized).toBe(false);
				expect(result.recovery.parentLineageId).toBe(previous.id);
				expect(result.recovery.beforeCommit).toBe(previous.afterCommit);
				expect(result.recovery.beforeBlobHash).toBe(previous.afterBlobHash);
				expect(recoverImplementationPlan(input, deps).created).toBe(false);
				previous = result.recovery;
			}
			const rebuilt = createReviewBudgetStore(f.ctx.recordStore);
			expect(rebuilt.getImplementationBinding("run1")).toEqual(f.binding);
			const amendments = rebuilt.listImplementationTextAmendments(
				"run1",
				"binding",
			);
			expect(amendments).toHaveLength(4);
			expect(
				detectPlanDrift({
					approvedPlanBytes: ORIGINAL,
					approvedPlanHash: f.binding.approvedPlanHash,
					amendments,
					currentPlanBytes: bytes,
				}),
			).toMatchObject({
				chainValid: true,
				drifted: false,
				authorizedBytes: bytes,
			});
			const prompt = buildImplementationReviewPromptContext({
				runId: "run1",
				phase: "2",
				store: rebuilt,
				recordStore: f.ctx.recordStore,
			});
			expect(prompt?.planRecovery?.id).toBe(amendments[2]?.id);
		} finally {
			f.ctx.db.close();
		}
	});

	test("dry-run is pure; durable replay admits exact plan, preserves baseline and findings, requires fresh review", async () => {
		const f = await fixture();
		try {
			const before = f.ctx.recordStore.listLines("run1", "budget");
			expect(
				recoverImplementationPlan({ ...f.input, dryRun: true }, f.deps).created,
			).toBe(false);
			expect(f.ctx.recordStore.listLines("run1", "budget")).toEqual(before);
			const result = recoverImplementationPlan(f.input, f.deps);
			expect(result.completionAuthorized).toBe(false);
			expect(result.recovery.invalidatedContextIds).toEqual(["old-context"]);
			expect(recoverImplementationPlan(f.input, f.deps).created).toBe(false);
			const rebuilt = createReviewBudgetStore(f.ctx.recordStore);
			expect(rebuilt.getImplementationBinding("run1")).toEqual(f.binding);
			const admission = await ensureImplementationAdmission({
				store: rebuilt,
				recordStore: f.ctx.recordStore,
				executionRunId: "run1",
				planPath: "/tmp/plan.md",
				planMarkdown: AMENDED,
				configuredMode: "enforced",
				origin: TEST_ORIGIN,
			});
			expect(admission.status).toBe("bound");
			const prompt = buildImplementationReviewPromptContext({
				runId: "run1",
				phase: "2",
				store: rebuilt,
				recordStore: f.ctx.recordStore,
			});
			if (!prompt) throw new Error("No prompt");
			expect(prompt.actionableFindings.map((item) => item.id)).toEqual([
				"R1",
				"R2",
			]);
			expect(prompt.authorNextAction).toBe("author_revision");
			expect(formatImplementationAuthorContext(prompt)).toContain(
				"offline only",
			);
			expect(
				(
					await verifyImplementationReviewContext({
						store: rebuilt,
						executionRunId: "run1",
						bindingId: "binding",
						phase: "2",
						reviewContextId: "old-context",
					})
				).status,
			).toBe("error");
			const oldComplete = {
				...f.observation,
				route: "complete" as const,
				completionAuthorized: true,
			};
			const boundary = evaluateImplementationBoundary({
				intent: "phase_complete",
				phase: "2",
				mode: "enforced",
				binding: f.binding,
				compatibility: null,
				currentPlanBytes: AMENDED,
				amendments: rebuilt.listImplementationTextAmendments("run1", "binding"),
				observations: [oldComplete],
				contexts: rebuilt.listImplementationReviewContexts("run1"),
				reconciliations: [],
				correctionAttempts: [],
				openMaterialGatePhases: [],
				headCommit: COMMIT,
				hasImplementationHistory: true,
				hasDeliveryBudget: true,
			});
			expect(boundary.status).toBe("deny");
			expect(boundary.readiness.planDrifted).toBe(false);
			expect(
				detectPlanDrift({
					approvedPlanBytes: ORIGINAL,
					approvedPlanHash: f.binding.approvedPlanHash,
					amendments: rebuilt.listImplementationTextAmendments(
						"run1",
						"binding",
					),
					currentPlanBytes: `${AMENDED}\nUnapproved scope`,
				}).drifted,
			).toBe(true);
		} finally {
			f.ctx.db.close();
		}
	});

	for (const scenario of [
		"missing authorization",
		"wrong phase",
		"unreviewed",
		"dirty",
		"changed score",
		"earlier phase",
		"completed frontier",
		"no scope confirmation",
		"later reviewer",
		"competing history",
	] as const) {
		test(`rejects ${scenario}`, async () => {
			const f = await fixture();
			try {
				if (scenario === "missing authorization")
					f.input.authorizationId = "missing";
				if (scenario === "wrong phase") f.input.phase = "1";
				if (scenario === "unreviewed") f.input.snapshotId = "missing";
				if (scenario === "dirty") f.deps.worktreePlanBytes += "\n";
				if (scenario === "changed score")
					f.deps.committedPlanBytes = f.deps.worktreePlanBytes =
						AMENDED.replace("| 2 | 0 |", "| 3 | 0 |");
				if (scenario === "earlier phase")
					f.deps.committedPlanBytes = f.deps.worktreePlanBytes =
						AMENDED.replace("Stable types", "Different types");
				if (scenario === "completed frontier")
					f.step("phase:complete", "2", {});
				if (scenario === "no scope confirmation")
					f.input.scopeConfirmation = "";
				if (scenario === "later reviewer")
					f.step(
						"reviewer:plan",
						"plan",
						{ readiness: "not_ready", items: [] },
						1,
					);
				if (scenario === "competing history") {
					const original = f.ctx.recordStore.atomicAppendIfAllNew.bind(
						f.ctx.recordStore,
					);
					f.ctx.recordStore.atomicAppendIfAllNew = (ops, keys) => {
						f.step("author:other", "2", {});
						return original(ops, keys);
					};
				}
				expect(() => recoverImplementationPlan(f.input, f.deps)).toThrow();
				expect(
					f.ctx.store.listImplementationTextAmendments("run1", "binding"),
				).toEqual([]);
			} finally {
				f.ctx.db.close();
			}
		});
	}
});
