import { describe, expect, test } from "bun:test";
import { createMemoryRecordStore } from "../../../src/control-plane/record-memory.js";
import {
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
} from "../../../src/control-plane/record-types.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import type { VerdictItem } from "../../../src/protocol.js";
import {
	encodeImplementationReviewObservationPayload,
	type ImplementationBindingPayload,
	type ImplementationReviewObservationPayload,
	implementationReviewObservationKey,
} from "../../../src/review-budget/record-lines.js";
import type { ParsedDeliveryBudget } from "../../../src/review-budget/types.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import { validateImplementationReview } from "../../../src/review-governance/implementation.js";
import {
	assessSupersedingApproval,
	detectPlanDrift,
	hashPlanBytes,
	verifyAuthorTextAmendment,
} from "../../../src/review-governance/implementation-state.js";
import {
	evaluateSupersedingLedger,
	extractBudgetTableBytes,
	planDefectBlocksShortcut,
	planImpactDisposition,
	prepareTextAmendmentGuard,
	structuralSignature,
	type TextAmendmentGuard,
	verifyGuardedPlanBytes,
} from "../../../src/review-governance/plan-amendment.js";

const ORIGIN: RecordOrigin = {
	recorder: { installation_id: "00000000-0000-4000-8000-000000000001" },
	performer: { kind: "system", role: "cli" },
};

function plan(prose = "Bind execution to the approved plan."): string {
	return `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Bind | 2 | -1 | DC0 (\`intrinsic\`) | - | Required |

### Debt Claims

#### DC0

- Target phase: phase-1
- Minimal-compliant effort delta: 0
- Minimal-compliant architecture delta: -1
- Before: two authorities
- After: one binding

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Design Decisions

Keep the approved ledger.

## Phase 1: Bind

**Completion gate:** The run stays on the approved plan.

${prose}

- [ ] Complete the phase

## Acceptance

The binding is unchanged.
`;
}

function ledger(): ParsedDeliveryBudget {
	return {
		estimateConfidence: "high",
		workItems: [
			{
				id: "W1",
				title: "Bind",
				effort: 2,
				architectureDelta: -1,
				debtClaim: {
					debtClaimId: "DC0",
					coupling: "intrinsic",
					targetPhase: "phase-1",
					minimalAlternativeEffortDelta: 0,
					minimalAlternativeArchitectureDelta: -1,
					before: "two authorities",
					after: "one binding",
				},
				addresses: [],
				rationale: "Required",
				line: 1,
			},
		],
		surface: {
			subsystems: 1,
			productionFiles: 1,
			persistentOrExternalBoundaries: 0,
		},
	};
}

function bindingFor(markdown: string): ImplementationBindingPayload {
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: "exec",
		sourceRunId: "source",
		sourceSnapshotId: "snap-1",
		sourceBaselineId: "base-1",
		approvedPlanCommit: "a".repeat(40),
		approvedPlanHash: hashPlanBytes(markdown),
		approvedPlanBytes: markdown,
		b0: 2,
		governingB: 2,
		mode: "enforced",
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger: ledger(),
		effectiveDecisions: [],
		phaseMap: [{ id: "1", heading: "Phase 1: Bind" }],
		debtTargets: [],
		ledgerHash: "sha256:ledger",
		decisionsHash: "sha256:decisions",
		createdAt: "2026-09-23 00:00:00",
	};
}

function guardFor(
	markdown: string,
	staleText: string,
	parentLineageId: string | null = null,
	anchorCommit = "a".repeat(40),
	id = "guard-1",
): TextAmendmentGuard {
	const start = Buffer.from(markdown, "utf8").indexOf(Buffer.from(staleText));
	const prepared = prepareTextAmendmentGuard({
		id,
		anchorBytes: markdown,
		anchorCommit,
		parentLineageId,
		allowedSpans: [
			{
				itemId: "R1",
				heading: "Phase 1: Bind",
				staleText,
				start,
				end: start + Buffer.byteLength(staleText),
			},
		],
	});
	if (!prepared.ok) throw new Error(prepared.message);
	return prepared.guard;
}

function observation(
	binding: ImplementationBindingPayload,
	guard: TextAmendmentGuard,
	id = "obs-1",
): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id,
		runId: binding.executionRunId,
		stepKey: { stepName: "reviewer:review", phase: "1", iteration: 0 },
		bindingId: binding.id,
		contextId: "ctx-1",
		domain: "implementation",
		phase: "1",
		originalVerdict: {
			readiness: "not_ready",
			items: [
				{
					id: "R1",
					title: "Stale wording",
					action: "auto_fix",
					reason: "The sentence is stale.",
					scopeClass: "plan_defect",
					priority: "P2",
					effortDelta: 0,
					architectureDelta: 0,
					planImpact: {
						kind: "text_only",
						locations: [
							{
								heading: "Phase 1: Bind",
								staleText: "Bind execution to the approved plan.",
							},
						],
					},
				},
			],
		},
		outcomes: [],
		route: "author_revision",
		nextAction: "author_revision",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: 0,
				plan_defect: 1,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 0,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 0,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 2, R: 0, B: 2, D: 0 },
		completionAuthorized: false,
		textGuard: guard,
		createdAt: "2026-09-23 00:00:01",
	};
}

function setup(markdown: string, guard: TextAmendmentGuard) {
	const recordStore = createMemoryRecordStore();
	recordStore.putRun({
		id: "exec",
		plan_path: "docs/development/plans/gov.md",
		config_json: null,
		created_at: "2026-09-23 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "0.0.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: ORIGIN.recorder,
	});
	const store = createReviewBudgetStore(recordStore);
	const binding = bindingFor(markdown);
	store.saveImplementationBinding(binding, ORIGIN);
	const saved = observation(binding, guard);
	recordStore.append({
		runId: "exec",
		stream: "budget",
		idempotencyKey: implementationReviewObservationKey("exec", saved.stepKey),
		payload: encodeImplementationReviewObservationPayload(saved),
		createdAt: saved.createdAt,
		...recordedEnvelope(ORIGIN),
	});
	return { store, binding, recordStore };
}

describe("plan amendment guards", () => {
	test("routes on planImpact.kind and blocks the shortcut for every plan defect", () => {
		expect(
			planImpactDisposition({ kind: "text_only", spansAuthorized: true }),
		).toBe("author_revision");
		expect(
			planImpactDisposition({ kind: "text_only", spansAuthorized: false }),
		).toBe("plan_amendment");
		expect(
			planImpactDisposition({ kind: "design", spansAuthorized: true }),
		).toBe("plan_amendment");
		expect(
			planImpactDisposition({ kind: "budget", spansAuthorized: false }),
		).toBe("plan_amendment");
		expect(planDefectBlocksShortcut([{ scopeClass: "plan_defect" }])).toBe(
			true,
		);
		const markdown = plan();
		const reviewed = validateImplementationReview({
			verdict: {
				readiness: "not_ready",
				items: [
					{
						id: "R1",
						title: "Design",
						action: "auto_fix",
						reason: "The design is wrong.",
						scopeClass: "plan_defect",
						priority: "P2",
						effortDelta: 0,
						architectureDelta: 0,
						planWorkItemIds: ["W1"],
						planImpact: { kind: "design", locations: [] },
					} as VerdictItem,
				],
			},
			phase: "1",
			mode: "enforced",
			phaseIds: ["1"],
			workItemIds: ["W1"],
			approvedPlanBytes: markdown,
			approvedPlanHash: hashPlanBytes(markdown),
			hasRun: true,
		});
		expect(reviewed.governance?.nextAction).toBe("plan_amendment");
		expect(reviewed.governance?.route).toBe("human_gate");
		expect(reviewed.governance?.shortcutCandidate).toBe(false);
	});

	test("rejects missing, duplicate, and ambiguous budget tables", () => {
		const missing = extractBudgetTableBytes("# Plan\n\nNo table\n");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.code).toBe("PLAN_AMENDMENT_TABLE");
		const duplicated = `${plan()}\n## Delivery Budget\n\n| ID |\n|---|\n| W2 |\n`;
		const duplicate = extractBudgetTableBytes(duplicated);
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.code).toBe("PLAN_AMENDMENT_TABLE");
		const split = plan().replace(
			"| W1 | Bind | 2 | -1 | DC0 (`intrinsic`) | - | Required |\n",
			"| W1 | Bind | 2 | -1 | DC0 (`intrinsic`) | - | Required |\n\n| ID |\n",
		);
		const splitTable = extractBudgetTableBytes(split);
		expect(splitTable.ok).toBe(false);
		if (!splitTable.ok) expect(splitTable.code).toBe("PLAN_AMENDMENT_TABLE");
	});

	test("permits a length-changing replacement inside the span and rejects an edit just outside it", () => {
		const markdown = plan();
		const guard = guardFor(markdown, "Bind execution to the approved plan.");
		const replaced = markdown.replace(
			"Bind execution to the approved plan.",
			"Bind the execution run to the approved plan.",
		);
		const ok = verifyGuardedPlanBytes({
			guard,
			committed: Buffer.from(replaced, "utf8"),
		});
		expect(ok.ok).toBe(true);
		const outside = markdown.replace(
			"Keep the approved ledger.",
			"Keep another ledger.",
		);
		const rejected = verifyGuardedPlanBytes({
			guard,
			committed: Buffer.from(outside, "utf8"),
		});
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.code).toBe("PLAN_AMENDMENT_OUT_OF_SPAN");
	});

	test("rejects table, debt, addresses, heading, checklist, and design byte changes", () => {
		const markdown = plan();
		const guard = guardFor(markdown, "Bind execution to the approved plan.");
		const cases = [
			markdown.replace("| W1 | Bind | 2 |", "| W1 | Bind | 2 | "),
			markdown.replace("| - | Required |", "| P9 | Required |"),
			markdown.replace("DC0 (`intrinsic`)", "DC0 (`intrinsic`) "),
			markdown.replace("## Phase 1: Bind", "## Phase 1: Binding"),
			markdown.replace(
				"- [ ] Complete the phase",
				"- [ ] Finish something else",
			),
			markdown.replace("Keep the approved ledger.", "Keep a new design."),
		];
		for (const edited of cases) {
			const result = verifyGuardedPlanBytes({
				guard,
				committed: Buffer.from(edited, "utf8"),
			});
			expect(result.ok).toBe(false);
		}
		expect(structuralSignature(markdown)).not.toBe(
			structuralSignature(
				markdown.replace("## Phase 1: Bind", "## Phase 9: Other"),
			),
		);
	});

	test("rejects invalid bytes and allows a checkbox toggle", () => {
		const markdown = plan();
		const guard = guardFor(markdown, "Bind execution to the approved plan.");
		const invalid = verifyGuardedPlanBytes({
			guard,
			committed: Buffer.from([0xff, 0xfe, 0xfd]),
		});
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.code).toBe("PLAN_AMENDMENT_INVALID_BYTES");
		const toggled = markdown.replace(
			"- [ ] Complete the phase",
			"- [x] Complete the phase",
		);
		const ok = verifyGuardedPlanBytes({
			guard,
			committed: Buffer.from(toggled, "utf8"),
		});
		expect(ok.ok).toBe(true);
		const injected = markdown.replace(
			"- [ ] Complete the phase",
			"- Also build a whole new subsystem\n- [x] Complete the phase",
		);
		const injection = verifyGuardedPlanBytes({
			guard,
			committed: Buffer.from(injected, "utf8"),
		});
		expect(injection.ok).toBe(false);
		if (!injection.ok)
			expect(injection.code).toBe("PLAN_AMENDMENT_OUT_OF_SPAN");
		const multiline = markdown.replace(
			"- [ ] Complete the phase",
			"- [Also\nbuild] Complete the phase",
		);
		const payload = verifyGuardedPlanBytes({
			guard,
			committed: Buffer.from(multiline, "utf8"),
		});
		expect(payload.ok).toBe(false);
		if (!payload.ok) expect(payload.code).toBe("PLAN_AMENDMENT_OUT_OF_SPAN");
		const ordered = markdown.replace(
			"- [ ] Complete the phase",
			"- [ ] Complete the phase\n1. [ ] Ordered item",
		);
		const orderedGuard = guardFor(
			ordered,
			"Bind execution to the approved plan.",
		);
		const toggledOrdered = ordered.replace(
			"1. [ ] Ordered item",
			"1. [x] Ordered item",
		);
		const orderedOk = verifyGuardedPlanBytes({
			guard: orderedGuard,
			committed: Buffer.from(toggledOrdered, "utf8"),
		});
		expect(orderedOk.ok).toBe(true);
		expect(
			detectPlanDrift({
				approvedPlanBytes: ordered,
				approvedPlanHash: hashPlanBytes(ordered),
				amendments: [],
				currentPlanBytes: toggledOrdered,
			}).drifted,
		).toBe(false);
	});

	test("matches CRLF and non-ASCII anchors inside the authorized span", () => {
		const markdown = plan("Bind execution — to the approved plan.").replace(
			/\n/g,
			"\r\n",
		);
		const stale = "Bind execution — to the approved plan.";
		const guard = guardFor(markdown, stale);
		const replaced = markdown.replace(
			stale,
			"Bind execution — to that approved plan.",
		);
		const ok = verifyGuardedPlanBytes({
			guard,
			committed: Buffer.from(replaced, "utf8"),
		});
		expect(ok.ok).toBe(true);
		const outside = markdown.replace(
			"Keep the approved ledger.",
			"Keep another ledger.",
		);
		const rejected = verifyGuardedPlanBytes({
			guard,
			committed: Buffer.from(outside, "utf8"),
		});
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.code).toBe("PLAN_AMENDMENT_OUT_OF_SPAN");
	});

	test("verified lineage reaches a ready review without rebinding", () => {
		const markdown = plan();
		const stale = "Bind execution to the approved plan.";
		const guard = guardFor(markdown, stale);
		const { store, binding } = setup(markdown, guard);
		const amended = markdown.replace(
			stale,
			"Bind the execution run to the approved plan.",
		);
		const bytes = Buffer.from(amended, "utf8");
		const verified = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: bytes,
			worktreePlanBytes: bytes,
			afterCommit: "b".repeat(40),
		});
		expect(verified.status).toBe("verified");
		const active = store.getImplementationBinding("exec");
		expect(active?.id).toBe(binding.id);
		expect(active?.approvedPlanHash).toBe(binding.approvedPlanHash);
		const drift = detectPlanDrift({
			approvedPlanBytes: binding.approvedPlanBytes,
			approvedPlanHash: binding.approvedPlanHash,
			amendments: store.listImplementationTextAmendments("exec", binding.id),
			currentPlanBytes: amended,
		});
		expect(drift.drifted).toBe(false);
		expect(drift.chainValid).toBe(true);
		const closed = validateImplementationReview({
			verdict: { readiness: "ready", items: [], creditRealizations: [] },
			phase: "1",
			mode: "enforced",
			phaseIds: ["1"],
			workItemIds: ["W1"],
			approvedPlanBytes: binding.approvedPlanBytes,
			approvedPlanHash: binding.approvedPlanHash,
			amendments: store.listImplementationTextAmendments("exec", binding.id),
			hasRun: true,
		});
		expect(closed.governance?.route).toBe("complete");
		expect(closed.governance?.nextAction).toBe("complete");
	});

	test("chains a second verified edit and refuses a broken or stale guard", () => {
		const markdown = plan();
		const firstText = "Bind execution to the approved plan.";
		const secondText = "Bind the execution run to the approved plan.";
		const guard = guardFor(markdown, firstText);
		const { store, binding, recordStore } = setup(markdown, guard);
		const once = markdown.replace(firstText, secondText);
		const first = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: Buffer.from(once, "utf8"),
			worktreePlanBytes: Buffer.from(once, "utf8"),
			afterCommit: "b".repeat(40),
		});
		expect(first.status).toBe("verified");
		if (first.status !== "verified") return;
		const nextGuard = guardFor(
			once,
			secondText,
			first.amendment.id,
			"b".repeat(40),
			"guard-2",
		);
		const next = observation(binding, nextGuard, "obs-2");
		next.stepKey = { stepName: "reviewer:review", phase: "1", iteration: 1 };
		recordStore.append({
			runId: "exec",
			stream: "budget",
			idempotencyKey: implementationReviewObservationKey("exec", next.stepKey),
			payload: encodeImplementationReviewObservationPayload(next),
			createdAt: "2026-09-23 00:00:02",
			...recordedEnvelope(ORIGIN),
		});
		const twice = once.replace(
			secondText,
			"Bind that execution run to the approved plan.",
		);
		const chained = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: Buffer.from(twice, "utf8"),
			worktreePlanBytes: Buffer.from(twice, "utf8"),
			afterCommit: "c".repeat(40),
		});
		expect(chained.status).toBe("verified");
		const amendments = store.listImplementationTextAmendments(
			"exec",
			binding.id,
		);
		expect(amendments).toHaveLength(2);
		const parent = amendments[0];
		const child = amendments[1];
		if (!parent || !child) throw new Error("expected two amendments");
		expect(child.parentLineageId).toBe(parent.id);
		expect(store.getImplementationBinding("exec")?.approvedPlanHash).toBe(
			binding.approvedPlanHash,
		);
		const again = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: Buffer.from(twice, "utf8"),
			worktreePlanBytes: Buffer.from(twice, "utf8"),
			afterCommit: "d".repeat(40),
		});
		expect(again).toEqual({ status: "not_applicable" });
		expect(
			store.listImplementationTextAmendments("exec", binding.id),
		).toHaveLength(2);
	});

	test("a second author pass after one review treats the guard as consumed", () => {
		const markdown = plan();
		const stale = "Bind execution to the approved plan.";
		const guard = guardFor(markdown, stale);
		const { store, binding } = setup(markdown, guard);
		const amended = markdown.replace(
			stale,
			"Bind the execution run to the approved plan.",
		);
		const bytes = Buffer.from(amended, "utf8");
		const first = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: bytes,
			worktreePlanBytes: bytes,
			afterCommit: "b".repeat(40),
		});
		expect(first.status).toBe("verified");
		const second = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: bytes,
			worktreePlanBytes: bytes,
			afterCommit: "b".repeat(40),
		});
		expect(second).toEqual({ status: "not_applicable" });
		expect(
			store.listImplementationTextAmendments("exec", binding.id),
		).toHaveLength(1);
	});

	test("an unconsumed guard against a different lineage head is stale", () => {
		const markdown = plan();
		const guard = guardFor(
			markdown,
			"Bind execution to the approved plan.",
			"missing-parent",
		);
		const { store, binding } = setup(markdown, guard);
		const bytes = Buffer.from(markdown, "utf8");
		const stale = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: bytes,
			worktreePlanBytes: bytes,
			afterCommit: "b".repeat(40),
		});
		expect(stale).toMatchObject({
			status: "failed",
			code: "PLAN_AMENDMENT_STALE",
		});
	});

	test("a failed edit does not extend lineage and a later matching edit can restart", () => {
		const markdown = plan();
		const stale = "Bind execution to the approved plan.";
		const guard = guardFor(markdown, stale);
		const { store, binding } = setup(markdown, guard);
		const outside = Buffer.from(
			markdown.replace("Keep the approved ledger.", "Keep another ledger."),
			"utf8",
		);
		const failed = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: outside,
			worktreePlanBytes: outside,
			afterCommit: "b".repeat(40),
		});
		expect(failed).toMatchObject({
			status: "failed",
			code: "PLAN_AMENDMENT_OUT_OF_SPAN",
		});
		expect(
			store.listImplementationTextAmendments("exec", binding.id),
		).toHaveLength(0);
		const dirty = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: Buffer.from(markdown, "utf8"),
			worktreePlanBytes: Buffer.from(`${markdown}\n`, "utf8"),
			afterCommit: "b".repeat(40),
		});
		expect(dirty).toMatchObject({
			status: "failed",
			code: "PLAN_AMENDMENT_DIRTY",
		});
		const amended = markdown.replace(
			stale,
			"Bind the execution run to the approved plan.",
		);
		const bytes = Buffer.from(amended, "utf8");
		const restarted = verifyAuthorTextAmendment({
			store,
			binding,
			origin: ORIGIN,
			phase: "1",
			committedPlanBytes: bytes,
			worktreePlanBytes: bytes,
			afterCommit: "c".repeat(40),
		});
		expect(restarted.status).toBe("verified");
	});

	test("refuses new claims and credit increases and does not adopt live markdown", () => {
		const approved = ledger();
		const increased = structuredClone(approved);
		const claim = increased.workItems[0]?.debtClaim;
		if (!claim) throw new Error("missing claim");
		claim.minimalAlternativeArchitectureDelta = -3;
		expect(
			evaluateSupersedingLedger({
				approved,
				proposed: increased,
				sameSourceSnapshot: false,
				liveMarkdownMatchesProposal: false,
			}).ok,
		).toBe(false);
		const added = structuredClone(approved);
		const seed = added.workItems[0];
		if (!seed) throw new Error("missing work item");
		added.workItems.push({
			...seed,
			id: "W2",
			debtClaim: {
				...claim,
				debtClaimId: "DC1",
				minimalAlternativeArchitectureDelta: -1,
			},
		});
		const created = evaluateSupersedingLedger({
			approved,
			proposed: added,
			sameSourceSnapshot: false,
			liveMarkdownMatchesProposal: false,
		});
		expect(created.ok).toBe(false);
		if (!created.ok) expect(created.code).toBe("PLAN_AMENDMENT_CREDIT");
		const waived = structuredClone(approved);
		const waivedClaim = waived.workItems[0]?.debtClaim;
		if (!waivedClaim) throw new Error("missing claim");
		waivedClaim.minimalAlternativeArchitectureDelta = 0;
		expect(
			evaluateSupersedingLedger({
				approved,
				proposed: waived,
				sameSourceSnapshot: false,
				liveMarkdownMatchesProposal: false,
			}).ok,
		).toBe(true);
		const markdown = plan();
		const binding = bindingFor(markdown);
		expect(
			assessSupersedingApproval({
				binding,
				proposedLedger: approved,
				proposedSourceSnapshotId: binding.sourceSnapshotId,
				proposedPlanBytes: markdown,
				liveMarkdown: markdown,
			}),
		).toMatchObject({ ok: false, code: "PLAN_AMENDMENT_NOT_APPROVED" });
		expect(binding.approvedPlanHash).toBe(hashPlanBytes(markdown));
	});
});
