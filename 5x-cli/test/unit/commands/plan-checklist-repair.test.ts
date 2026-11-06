import { describe, expect, test } from "bun:test";
import {
	parseRepairSelection,
	type RunRepairDeps,
	repairChecklistsForRun,
	validateRepairChecklistsInput,
} from "../../../src/commands/plan-checklist-repair.handler.js";
import {
	createMemoryRecordStore,
	type RecordOrigin,
	recordedEnvelope,
} from "../../../src/control-plane/index.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import { CliError } from "../../../src/output.js";
import {
	encodeImplementationReviewObservationPayload,
	type ImplementationBindingPayload,
	implementationBindingKey,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	ensureImplementationAdmission,
	hashPlanBytes,
} from "../../../src/review-governance/implementation-state.js";

const runId = "run-exec";
const COMMIT = "a".repeat(40);
const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "human", role: "operator" },
};

const APPROVED = `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Preview | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Model

**Completion gate:** Typed.

- Add the type
  - include the tier
- Map fields

## Phase 2: Modal

**Completion gate:** Rendered.

- Render the modal
`;

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const LEDGER = {
	estimateConfidence: "high" as const,
	workItems: [],
	surface: {
		subsystems: 1,
		productionFiles: 1,
		persistentOrExternalBoundaries: 0,
	},
};

function bindingPayload(): ImplementationBindingPayload {
	return {
		kind: "implementation-binding",
		version: 1,
		id: "binding-1",
		executionRunId: runId,
		sourceRunId: "source-run",
		sourceSnapshotId: "snapshot-1",
		sourceBaselineId: "baseline-1",
		approvedPlanCommit: COMMIT,
		approvedPlanHash: hashPlanBytes(APPROVED),
		approvedPlanBytes: APPROVED,
		b0: 2,
		governingB: 2,
		mode: "enforced",
		thresholds: DEFAULT_REVIEW_BUDGET_CONFIG,
		ledger: LEDGER,
		effectiveDecisions: [],
		phaseMap: [
			{ id: "1", heading: "Model" },
			{ id: "2", heading: "Modal" },
		],
		debtTargets: [],
		ledgerHash: hashPlanBytes(stable(LEDGER)),
		decisionsHash: hashPlanBytes(stable([])),
		createdAt: "2026-11-06T00:00:00.000Z",
	};
}

function readyObservation() {
	return encodeImplementationReviewObservationPayload({
		kind: "implementation-review",
		version: 1,
		id: "obs-1",
		runId,
		stepKey: { stepName: "reviewer:impl", phase: "1", iteration: 1 },
		bindingId: "binding-1",
		contextId: "ctx-1",
		domain: "implementation",
		phase: "1",
		originalVerdict: { readiness: "ready", items: [] },
		outcomes: [],
		route: "complete",
		nextAction: "complete",
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
		budgetInvariant: { W: 2, R: 0, B: 2, D: 0 },
		completionAuthorized: true,
		createdAt: "2026-11-06T00:00:00.000Z",
	} as Parameters<typeof encodeImplementationReviewObservationPayload>[0]);
}

function fixture(
	options: { file?: string; hook?: (b: string) => string } = {},
) {
	const recordStore = createMemoryRecordStore();
	recordStore.putRun({
		id: runId,
		plan_path: "docs/plan.md",
		config_json: null,
		created_at: "2026-11-06T00:00:00.000Z",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "test",
		format_version: 1,
		creator: origin.recorder,
	});
	const append = (key: string, payload: unknown) =>
		recordStore.append({
			runId,
			stream: "budget",
			idempotencyKey: key,
			payload,
			...recordedEnvelope(origin),
		});
	append(implementationBindingKey(runId), bindingPayload());
	append("ctx-1", {
		kind: "implementation-review-context",
		version: 1,
		id: "ctx-1",
		executionRunId: runId,
		bindingId: "binding-1",
		phase: "1",
		baseCommit: COMMIT,
		reviewedCommit: COMMIT,
		patchHash: `sha256:${"0".repeat(64)}`,
		excludedPaths: [],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-11-06T00:00:00.000Z",
	});
	append("obs-1", readyObservation());
	const store = createReviewBudgetStore(recordStore);
	const state = {
		file: options.file ?? APPROVED,
		commits: new Map<string, string>([[COMMIT, APPROVED]]),
		writes: 0,
		commitCalls: 0,
		head: COMMIT,
	};
	const deps: RunRepairDeps = {
		recordStore,
		store,
		origin,
		planPath: "/wt/docs/plan.md",
		readPlanAtCommit: async (commit) => state.commits.get(commit) ?? null,
		readPlanFile: () => state.file,
		writePlanFile: (bytes) => {
			state.writes += 1;
			state.file = bytes;
		},
		commitPlanFile: async () => {
			state.commitCalls += 1;
			const committedBytes = options.hook
				? options.hook(state.file)
				: state.file;
			if (state.commits.get(state.head) === committedBytes) {
				return { commit: state.head, committed: false };
			}
			const sha = String(state.commits.size).repeat(40).slice(0, 40);
			state.commits.set(sha, committedBytes);
			state.file = committedBytes;
			state.head = sha;
			return { commit: sha, committed: true };
		},
	};
	return { recordStore, store, state, deps };
}

const REASON = "Operator authorized checklist-format repair and continuation";

type RepairResult = Awaited<ReturnType<typeof repairChecklistsForRun>>;

function receipt(result: RepairResult) {
	return "repair" in result ? result.repair : undefined;
}

async function rejects(promise: Promise<unknown>): Promise<CliError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CliError) return error;
		throw error;
	}
	throw new Error("expected a CliError");
}

describe("repair-checklists input", () => {
	test("requires one form, one mode, and a recorded reason to apply a run", () => {
		expect(() => validateRepairChecklistsInput({ dryRun: true })).toThrow(
			"exactly one of --plan",
		);
		expect(() =>
			validateRepairChecklistsInput({ runId, dryRun: true, apply: true }),
		).toThrow("exactly one of --dry-run");
		expect(() => validateRepairChecklistsInput({ runId, apply: true })).toThrow(
			"--reason",
		);
		expect(() =>
			validateRepairChecklistsInput({ planPath: "x.md", apply: true }),
		).not.toThrow();
		expect(
			parseRepairSelection({ phases: ["Phase 2", "3"], lines: ["4-9,12"] }),
		).toEqual({
			phases: ["2", "3"],
			lines: [
				{ start: 4, end: 9 },
				{ start: 12, end: 12 },
			],
		});
	});
});

describe("repairChecklistsForRun", () => {
	test("previews, then records one paired receipt without touching evidence", async () => {
		const { deps, recordStore, store, state } = fixture();
		const before = store.readEffectiveImplementationRevision(runId);
		const preview = await repairChecklistsForRun({ runId, dryRun: true }, deps);
		expect(preview.recorded).toBe(false);
		expect(preview.completionAuthorized).toBe(false);
		expect(state.writes).toBe(0);
		expect(state.commitCalls).toBe(0);
		expect(recordStore.listLines(runId, "steps")).toHaveLength(0);
		expect(preview.next[0]).toContain(`--intent ${preview.intentDigest}`);
		expect(preview.next[0]).toContain("--reason");

		const applied = await repairChecklistsForRun(
			{ runId, apply: true, reason: REASON, intent: preview.intentDigest },
			deps,
		);
		expect(applied.created).toBe(true);
		expect(state.file).toContain("- [ ] Add the type\n  - include the tier");
		expect(state.file).toContain("- [ ] Render the modal");
		const budget = recordStore
			.listLines(runId, "budget")
			.filter(
				(line) =>
					(line.payload as { kind?: string }).kind === "plan-checklist-repair",
			);
		expect(budget).toHaveLength(1);
		const steps = recordStore.listLines(runId, "steps");
		expect(
			steps.map((line) => (line.payload as { step_name: string }).step_name),
		).toEqual(["checklist-repair"]);
		const stored = budget[0]?.payload as Record<string, unknown>;
		expect(stored.reason).toBe(REASON);
		expect(stored.bindingId).toBe("binding-1");
		expect(stored.subject).toBe("execution");
		expect("snapshotId" in stored).toBe(false);
		expect("guardId" in stored).toBe(false);

		const after = store.readEffectiveImplementationRevision(runId);
		if (!before?.ok || !after?.ok) throw new Error("fold failed");
		expect(after.currentRevisionId).toBe(before.currentRevisionId);
		expect(after.evidence).toEqual(before.evidence);
		expect(after.findings).toEqual(before.findings);
		expect(after.approvedPlanBytes).toBe(state.file);
		// Binding identity is immutable.
		expect(store.getImplementationBinding(runId)).toEqual(bindingPayload());

		// Admission now accepts the plan, including newly checked boxes.
		state.file = state.file.replace("- [ ] Map fields", "- [x] Map fields");
		const admitted = await ensureImplementationAdmission({
			store,
			recordStore,
			executionRunId: runId,
			planPath: "docs/plan.md",
			planMarkdown: state.file,
			configuredMode: "enforced",
			origin,
		});
		expect(admitted.status).toBe("bound");
	});

	test("admission reports drift with the repair command before the repair", async () => {
		const { recordStore, store } = fixture();
		const manual = APPROVED.replace("- Map fields", "- [ ] Map fields");
		const admitted = await ensureImplementationAdmission({
			store,
			recordStore,
			executionRunId: runId,
			planPath: "docs/plan.md",
			planMarkdown: manual,
			configuredMode: "enforced",
			origin,
		});
		expect(admitted.status).toBe("error");
		if (admitted.status !== "error") return;
		expect(admitted.code).toBe("IMPLEMENTATION_PLAN_DRIFT");
		expect(admitted.message).toContain(
			`5x plan repair-checklists --run ${runId} --dry-run`,
		);
		expect(admitted.detail).toMatchObject({
			repairCommand: `5x plan repair-checklists --run ${runId} --dry-run`,
		});
	});

	test("identical retry returns the stored receipt and records nothing new", async () => {
		const { deps, recordStore } = fixture();
		const first = await repairChecklistsForRun(
			{ runId, apply: true, reason: REASON },
			deps,
		);
		const second = await repairChecklistsForRun(
			{ runId, apply: true, reason: REASON },
			deps,
		);
		expect(second.created).toBe(false);
		expect(receipt(second)?.id).toBe(receipt(first)?.id);
		expect(recordStore.listLines(runId, "steps")).toHaveLength(1);
	});

	test("an interrupted record resumes against the existing repair commit", async () => {
		const { deps, recordStore, state } = fixture();
		const realAppend = recordStore.atomicAppendIfAllNew.bind(recordStore);
		let failOnce = true;
		recordStore.atomicAppendIfAllNew = (ops, expected) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("crash after commit");
			}
			return realAppend(ops, expected);
		};
		await expect(
			repairChecklistsForRun({ runId, apply: true, reason: REASON }, deps),
		).rejects.toThrow("crash after commit");
		const repairCommit = state.head;
		expect(repairCommit).not.toBe(COMMIT);
		expect(recordStore.listLines(runId, "steps")).toHaveLength(0);
		const resumed = await repairChecklistsForRun(
			{ runId, apply: true, reason: REASON },
			deps,
		);
		expect(resumed.created).toBe(true);
		expect("committed" in resumed && resumed.committed).toBe(false);
		expect(receipt(resumed)?.afterCommit).toBe(repairCommit);
		expect(state.head).toBe(repairCommit);
	});

	test("a concurrent journal write fails the precondition without partial authority", async () => {
		const { deps, recordStore } = fixture();
		const realRead = deps.readPlanFile;
		deps.readPlanFile = () => {
			recordStore.append({
				runId,
				stream: "budget",
				idempotencyKey: "concurrent",
				payload: { kind: "note" },
				...recordedEnvelope(origin),
			});
			deps.readPlanFile = realRead;
			return realRead();
		};
		const error = await rejects(
			repairChecklistsForRun({ runId, apply: true, reason: REASON }, deps),
		);
		expect(error.code).toBe("RECORD_PRECONDITION_FAILED");
		expect(
			recordStore
				.listLines(runId, "budget")
				.some(
					(line) =>
						(line.payload as { kind?: string }).kind ===
						"plan-checklist-repair",
				),
		).toBe(false);
	});

	test("an unchanged candidate reuses the preview; a changed one is re-previewed", async () => {
		const same = fixture();
		const preview = await repairChecklistsForRun(
			{ runId, dryRun: true },
			same.deps,
		);
		// A concurrent manual marker that matches the proposal keeps the intent.
		same.state.file = same.state.file.replace(
			"- Render the modal",
			"- [ ] Render the modal",
		);
		const applied = await repairChecklistsForRun(
			{ runId, apply: true, reason: REASON, intent: preview.intentDigest },
			same.deps,
		);
		expect(applied.created).toBe(true);

		const moved = fixture();
		const original = await repairChecklistsForRun(
			{ runId, dryRun: true },
			moved.deps,
		);
		await repairChecklistsForRun(
			{ runId, apply: true, reason: REASON, phases: ["2"] },
			moved.deps,
		);
		const writes = moved.state.writes;
		const error = await rejects(
			repairChecklistsForRun(
				{
					runId,
					apply: true,
					reason: REASON,
					intent: original.intentDigest,
				},
				moved.deps,
			),
		);
		expect(error.code).toBe("PLAN_CHECKLIST_REPAIR_STALE");
		const refreshed = error.detail as {
			intentDigest: string;
			edits: Array<{ after: string }>;
		};
		expect(refreshed.intentDigest).not.toBe(original.intentDigest);
		expect(refreshed.edits.map((edit) => edit.after)).toEqual([
			"- [ ] Add the type",
			"- [ ] Map fields",
		]);
		expect(moved.state.writes).toBe(writes);
	});

	test("a requirement edit is refused with no write and no record", async () => {
		const edited = APPROVED.replace("- Map fields", "- [ ] Map all fields");
		const { deps, recordStore, state } = fixture({ file: edited });
		const error = await rejects(
			repairChecklistsForRun({ runId, apply: true, reason: REASON }, deps),
		);
		expect(error.code).toBe("PLAN_CHECKLIST_REPAIR_DISALLOWED");
		expect(
			(error.detail as { disallowed: Array<{ after: string }> }).disallowed[0]
				?.after,
		).toBe("- [ ] Map all fields");
		expect(state.file).toBe(edited);
		expect(state.writes).toBe(0);
		expect(recordStore.listLines(runId, "steps")).toHaveLength(0);
	});

	test("hook-rewritten committed bytes are re-proven; a semantic rewrite records nothing", async () => {
		const benign = fixture({
			hook: (bytes) => bytes.replace("- [ ] Map fields", "- [x] Map fields"),
		});
		const error = await rejects(
			repairChecklistsForRun(
				{ runId, apply: true, reason: REASON },
				benign.deps,
			),
		);
		// An introduced checked marker is not a valid recorded repair.
		expect(error.code).toBe("PLAN_CHECKLIST_REPAIR_HOOK_CHANGED");

		const formatting = fixture({
			hook: (bytes) => bytes.replace("Rendered.", "Rendered!"),
		});
		const changed = await rejects(
			repairChecklistsForRun(
				{ runId, apply: true, reason: REASON },
				formatting.deps,
			),
		);
		expect(changed.code).toBe("PLAN_CHECKLIST_REPAIR_HOOK_CHANGED");
		expect(formatting.recordStore.listLines(runId, "steps")).toHaveLength(0);

		const narrowing = fixture({
			hook: (bytes) =>
				bytes.replace("- [ ] Render the modal", "- Render the modal"),
		});
		const recorded = await repairChecklistsForRun(
			{ runId, apply: true, reason: REASON },
			narrowing.deps,
		);
		expect(recorded.created).toBe(true);
		expect(receipt(recorded)?.edits.map((edit) => edit.after)).toEqual([
			"- [ ] Add the type",
			"- [ ] Map fields",
		]);
	});

	test("nothing to repair is reported without writing or recording", async () => {
		const { deps, state } = fixture();
		await repairChecklistsForRun({ runId, apply: true, reason: REASON }, deps);
		state.file = state.file.replace("- [ ] Map fields", "- [x] Map fields");
		const noop = await repairChecklistsForRun({ runId, dryRun: true }, deps);
		expect(noop.recorded).toBe(false);
		expect(noop.repairAvailable).toBe(false);
		expect(noop.message).toContain("Nothing to repair");
	});
});
