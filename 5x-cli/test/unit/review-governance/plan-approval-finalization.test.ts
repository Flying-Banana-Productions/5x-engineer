import { describe, expect, test } from "bun:test";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import {
	decodeImplementationBindingPayload,
	decodePlanApprovalFinalizationPayload,
	encodeImplementationBindingPayload,
	encodePlanApprovalFinalizationPayload,
	type ImplementationBindingPayload,
	type PlanApprovalFinalizationPayload,
	planApprovalFinalizationKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	type FinalLedgerChangeField,
	legacyReReviewNext,
	reconcileFinalApprovalLedger,
	sameRunFinalizationNext,
} from "../../../src/review-governance/plan-approval-finalization.js";

function ledger(
	rows: string,
	options?: { confidence?: string; files?: number; preamble?: string },
) {
	const parsed = parseDeliveryBudget(`# Plan
${options?.preamble ?? ""}
## Delivery Budget

- Estimate confidence: ${options?.confidence ?? "high"}

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
${rows}

### Surface Snapshot

- Subsystems: 1
- Production files: ${options?.files ?? 1}
- Persistent/external boundaries: 0

## Phase 1: Work

- [ ] Work
`);
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.value;
}

const W1 = "| W1 | Foundation | 2 | 0 | - | - | Required |";
const W2 = "| W2 | Follow-up | 1 | 0 | - | - | Follow |";

describe("final committed ledger reconciliation", () => {
	test("accepts admitted Addresses bookkeeping and ignores nonidentity parse data", () => {
		const reviewed = ledger(`${W1}\n${W2}`);
		const final = ledger(
			`| W1 | Foundation, renamed | 2 | 0 | - | - | Rationale rewritten |\n| W2 | Follow-up | 1 | 0 | - | P1.1 | Follow |`,
			{ preamble: "\n**Status:** Approved\n" },
		);
		expect(final.workItems[1]?.line).not.toBe(reviewed.workItems[1]?.line);
		const result = reconcileFinalApprovalLedger({
			reviewed,
			final,
			admittedFindingIds: ["P1.1", "P1.2"],
		});
		expect(result).toEqual({
			ok: true,
			ledger: final,
			addressAdditions: [{ workItemId: "W2", findingIds: ["P1.1"] }],
		});
	});

	test("an ordinary ready approval must match exactly", () => {
		const reviewed = ledger(`${W1}\n${W2}`);
		expect(
			reconcileFinalApprovalLedger({
				reviewed,
				final: ledger(`${W1}\n${W2}`),
				admittedFindingIds: [],
			}),
		).toMatchObject({ ok: true, addressAdditions: [] });
		const added = reconcileFinalApprovalLedger({
			reviewed,
			final: ledger(`${W1}\n| W2 | Follow-up | 1 | 0 | - | P1.1 | Follow |`),
			admittedFindingIds: [],
		});
		expect(added.ok).toBe(false);
		if (!added.ok) {
			expect(added.changes).toEqual([
				expect.objectContaining({
					field: "addresses",
					workItemId: "W2",
					after: ["P1.1"],
				}),
			]);
			expect(added.changes[0]?.reason).toContain("did not admit");
		}
	});

	test("reports each substantive delta without accepting unrelated ledger or claim changes", () => {
		const reviewed = ledger(
			`${W1}\n| W2 | Follow-up | 1 | 0 | - | R1 | Follow |`,
		);
		const cases: Array<
			[string, ReturnType<typeof ledger>, FinalLedgerChangeField[]]
		> = [
			[
				"effort",
				ledger(
					`| W1 | Foundation | 3 | 0 | - | - | Required |\n| W2 | Follow-up | 1 | 0 | - | R1 | Follow |`,
				),
				["effort"],
			],
			[
				"architecture",
				ledger(
					`| W1 | Foundation | 2 | 1 | - | - | Required |\n| W2 | Follow-up | 1 | 0 | - | R1 | Follow |`,
				),
				["architectureDelta"],
			],
			[
				"removed address",
				ledger(`${W1}\n| W2 | Follow-up | 1 | 0 | - | P1.1 | Follow |`),
				["addresses"],
			],
			[
				"unadmitted address",
				ledger(`${W1}\n| W2 | Follow-up | 1 | 0 | - | R1, P9.9 | Follow |`),
				["addresses"],
			],
			[
				"new work item",
				ledger(
					`${W1}\n| W2 | Follow-up | 1 | 0 | - | R1 | Follow |\n| W3 | Extra | 1 | 0 | - | - | Scope |`,
				),
				["workItems"],
			],
			[
				"confidence and surface",
				ledger(`${W1}\n| W2 | Follow-up | 1 | 0 | - | R1 | Follow |`, {
					confidence: "low",
					files: 4,
				}),
				["estimateConfidence", "surface"],
			],
		];
		for (const [label, final, fields] of cases) {
			const result = reconcileFinalApprovalLedger({
				reviewed,
				final,
				admittedFindingIds: ["P1.1"],
			});
			expect({ label, ok: result.ok }).toEqual({ label, ok: false });
			if (!result.ok) {
				expect({
					label,
					fields: result.changes.map((change) => change.field),
				}).toEqual({ label, fields });
			}
		}
	});

	test("a debt-claim change is substantive even when Addresses bookkeeping is admitted", () => {
		const claim = (
			after: string,
		) => `| W1 | Bind | 2 | -1 | DC0 (\`intrinsic\`) | - | Required |

### Debt Claims

#### DC0

- Target phase: 1
- Minimal-compliant effort delta: 0
- Minimal-compliant architecture delta: -1
- Before: two authorities
- After: ${after}`;
		const result = reconcileFinalApprovalLedger({
			reviewed: ledger(claim("one binding")),
			final: ledger(claim("one binding and a cache")),
			admittedFindingIds: ["P1.1"],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.changes.map((change) => change.field)).toEqual([
				"debtClaim",
			]);
		}
	});

	test("remedies name the same run or an exact-plan re-review, never a reopened source", () => {
		expect(sameRunFinalizationNext("run_a")).toEqual([
			"5x template render reviewer-plan --run run_a",
			"5x protocol validate reviewer --run run_a --record --step <step_name from render> --phase plan --iteration <next>",
			"5x run complete --run run_a",
		]);
		const legacy = legacyReReviewNext({
			planPath: "docs/plan.md",
			executionRunId: "run_exec",
		});
		expect(legacy[0]).toBe("5x run init --plan docs/plan.md");
		expect(legacy.at(-1)).toContain("--run run_exec --source-run");
		expect(legacy.join(" ")).not.toContain("reopen");
	});
});

function finalization(): PlanApprovalFinalizationPayload {
	const final = ledger(`${W1}\n| W2 | Follow-up | 1 | 0 | - | P1.1 | Follow |`);
	return {
		kind: "plan-approval-finalization",
		version: 1,
		id: "approval-finalization:1",
		runId: "source",
		sourceSnapshotId: "snapshot-1",
		sourceBaselineId: "baseline-1",
		route: "final_corrections",
		reviewer: { stepName: "reviewer:plan", iteration: 0, commit: null },
		authorCorrection: {
			stepName: "author:process-plan-review",
			iteration: 1,
			commit: "b".repeat(40),
		},
		admittedFindingIds: ["P1.1"],
		decisionsHash: "sha256:decisions",
		completion: { stepName: "run:complete", iteration: 1 },
		finalCommit: "b".repeat(40),
		finalBlobHash: "sha256:blob",
		planSchema: 0,
		snapshotLedgerHash: "sha256:snapshot",
		ledger: final,
		ledgerHash: "sha256:ledger",
		addressAdditions: [{ workItemId: "W2", findingIds: ["P1.1"] }],
		createdAt: "2026-11-06T00:00:00.000Z",
	};
}

describe("plan-approval-finalization codec", () => {
	test("round-trips and is keyed by the committed final blob", () => {
		const payload = finalization();
		const encoded = encodePlanApprovalFinalizationPayload(payload);
		expect(encoded).not.toHaveProperty("governingHash");
		expect(decodePlanApprovalFinalizationPayload(encoded)).toEqual(payload);
		expect(planApprovalFinalizationKey("source", "b".repeat(40))).toBe(
			`budget:plan-approval-finalization:source:${"b".repeat(40)}`,
		);
	});

	test("rejects unknown fields, unpaired routes and schema 1 without a governing hash", () => {
		const payload = finalization();
		expect(() =>
			decodePlanApprovalFinalizationPayload({ ...payload, verdict: "ready" }),
		).toThrow("unknown field 'verdict'");
		expect(() =>
			decodePlanApprovalFinalizationPayload({
				...payload,
				authorCorrection: null,
			}),
		).toThrow("names its author correction");
		expect(() =>
			decodePlanApprovalFinalizationPayload({
				...payload,
				completion: { stepName: "run:abort", iteration: 1 },
			}),
		).toThrow("run:complete");
		expect(() =>
			decodePlanApprovalFinalizationPayload({ ...payload, planSchema: 1 }),
		).toThrow("governingHash");
		expect(() =>
			decodePlanApprovalFinalizationPayload({ ...payload, version: 2 }),
		).toThrow("unsupported plan approval finalization version 2");
	});

	test("binding provenance round-trips and historical bindings decode unchanged", () => {
		const base: ImplementationBindingPayload = {
			kind: "implementation-binding",
			version: 1,
			id: "binding-1",
			executionRunId: "exec",
			sourceRunId: "source",
			sourceSnapshotId: "snapshot-1",
			sourceBaselineId: "baseline-1",
			approvedPlanCommit: "b".repeat(40),
			approvedPlanHash: "sha256:blob",
			approvedPlanBytes: "# Plan\n",
			b0: 3,
			governingB: 3,
			mode: "enforced",
			thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
			ledger: finalization().ledger,
			effectiveDecisions: [],
			phaseMap: [{ id: "1", heading: "Work" }],
			debtTargets: [],
			ledgerHash: "sha256:ledger",
			decisionsHash: "sha256:decisions",
			createdAt: "2026-11-06T00:00:00.000Z",
		};
		const historical = encodeImplementationBindingPayload(base);
		expect(historical).not.toHaveProperty("approvalFinalization");
		expect(decodeImplementationBindingPayload(historical)).toEqual(base);
		const legacy: ImplementationBindingPayload = {
			...base,
			approvalFinalization: {
				derivation: "legacy_stale_addresses",
				sourceRunId: "source",
				sourceSnapshotId: "snapshot-1",
				finalCommit: "b".repeat(40),
				finalBlobHash: "sha256:blob",
				snapshotLedgerHash: "sha256:snapshot",
				admittedFindingIds: ["P1.1"],
				addressAdditions: [{ workItemId: "W2", findingIds: ["P1.1"] }],
				authorCommit: "b".repeat(40),
			},
		};
		const encoded = encodeImplementationBindingPayload(legacy);
		expect(
			(encoded as { approvalFinalization: object }).approvalFinalization,
		).not.toHaveProperty("finalizationId");
		expect(decodeImplementationBindingPayload(encoded)).toEqual(legacy);
		expect(() =>
			decodeImplementationBindingPayload({
				...(encoded as object),
				approvalFinalization: {
					...legacy.approvalFinalization,
					derivation: "recorded",
				},
			}),
		).toThrow("names its record");
	});
});
