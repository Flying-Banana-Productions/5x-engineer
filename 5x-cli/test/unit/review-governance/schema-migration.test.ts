import { describe, expect, test } from "bun:test";
import { createMemoryRecordStore } from "../../../src/control-plane/record-memory.js";
import {
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
} from "../../../src/control-plane/record-types.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import { CliError } from "../../../src/output.js";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import { loadPlanDocument } from "../../../src/plan-schema/document.js";
import {
	decodePlanSchemaMigrationPayload,
	encodePlanSchemaMigrationPayload,
	IMPLEMENTATION_STATE_VERSION,
	type ImplementationTextAmendmentPayload,
	implementationTextAmendmentKey,
	type PlanSchemaMigrationPayload,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import { foldGoverningReviewState } from "../../../src/review-governance/decisions.js";
import {
	bindImplementationExecution,
	deliveryLedgersEqual,
	detectPlanDrift,
	hashPlanBytes,
	PLAN_DRIFT_RECOVERY_HELP,
	resolveRecordedPlanSchema,
} from "../../../src/review-governance/implementation-state.js";
import {
	applyPlanSchemaMigration,
	capturePlanSchemaMigrationExpectedKeys,
	diffPlanSchemaMigration,
	type ExecutePlanSchemaMigrationInput,
	executePlanSchemaMigration,
	planSchemaProposalDigest,
	wrapEquivalentPlan,
} from "../../../src/review-governance/schema-migration.js";

const ORIGIN: RecordOrigin = {
	recorder: { installation_id: "00000000-0000-4000-8000-000000000001" },
	performer: { kind: "human", role: "operator" },
};
const PLAN_PATH = "docs/development/plans/gov.md";
const APPROVED_COMMIT = "a".repeat(40);
const MIGRATED_COMMIT = "c".repeat(40);

function plan(status = true): string {
	const statusLine = status ? "\n**Status:** Draft\n" : "\n";
	return `# Plan
${statusLine}
## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Bind | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0

## Phase 1: Bind

**Completion gate:** bound

- [ ] Bind execution
`;
}

function ledgerOf(markdown: string) {
	const parsed = parseDeliveryBudget(markdown);
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.value;
}

function selectiveTarget(approved: string): string {
	const interior = approved
		.replace("**Status:** Draft\n", "")
		.replace("- [ ]", "- [x]");
	const body = interior.endsWith("\n") ? interior : `${interior}\n`;
	return `<!-- 5x:plan-schema:1 -->\n**Status:** Revised\n\n<!-- 5x:contract:start -->\n${body}<!-- 5x:contract:end -->\n`;
}

function setup() {
	const recordStore = createMemoryRecordStore();
	const store = createReviewBudgetStore(recordStore);
	recordStore.putRun({
		id: "exec",
		plan_path: PLAN_PATH,
		config_json: null,
		created_at: "2026-09-23 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "0.0.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: ORIGIN.recorder,
	});
	return { recordStore, store };
}

function subjectFor(
	markdown: string,
	options?: {
		bindingPlanSchema?: 0 | 1;
		migrations?: PlanSchemaMigrationPayload[];
		kind?: "execution" | "source";
		bindingId?: string;
	},
): ExecutePlanSchemaMigrationInput["subject"] {
	return {
		kind: options?.kind ?? "execution",
		runId: "exec",
		bindingId:
			options?.bindingId ?? (options?.kind === "source" ? null : "binding-1"),
		...(options?.bindingPlanSchema !== undefined
			? { bindingPlanSchema: options.bindingPlanSchema }
			: {}),
		sourceBytes: markdown,
		beforeBlobHash: hashPlanBytes(markdown),
		beforeCommit: APPROVED_COMMIT,
		priorApprovalCommit: APPROVED_COMMIT,
		parentLineageId: null,
		ledger: ledgerOf(markdown),
		migrations: options?.migrations ?? [],
	};
}

function runMigration(
	ctx: ReturnType<typeof setup>,
	approved: string,
	target: string,
	options?: Partial<ExecutePlanSchemaMigrationInput> & {
		subject?: ExecutePlanSchemaMigrationInput["subject"];
	},
) {
	const subject = options?.subject ?? subjectFor(approved);
	return executePlanSchemaMigration(
		{
			mode: options?.mode ?? "selective",
			dryRun: options?.dryRun,
			confirmExclusions: options?.confirmExclusions,
			afterCommit: options?.afterCommit ?? MIGRATED_COMMIT,
			targetBytes: target,
			worktreeBytes: options?.worktreeBytes ?? target,
			requireWorktreeMatch: options?.requireWorktreeMatch ?? true,
			subject,
			expectedKeys:
				options?.expectedKeys ??
				capturePlanSchemaMigrationExpectedKeys(ctx.recordStore, subject.runId),
		},
		{ recordStore: ctx.recordStore, store: ctx.store, origin: ORIGIN },
	);
}

function migrationCount(ctx: ReturnType<typeof setup>, runId = "exec"): number {
	return ctx.recordStore
		.listLines(runId, "budget")
		.filter(
			(line) =>
				(line.payload as { kind?: string } | null)?.kind ===
				"plan-schema-migration",
		).length;
}

function caught(fn: () => void): CliError {
	try {
		fn();
	} catch (error) {
		if (error instanceof CliError) return error;
		throw error;
	}
	throw new Error("expected CliError");
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<CliError> {
	try {
		await fn();
	} catch (error) {
		if (error instanceof CliError) return error;
		throw error;
	}
	throw new Error("expected CliError");
}

function putActiveRun(ctx: ReturnType<typeof setup>, id: string) {
	ctx.recordStore.putRun({
		id,
		plan_path: PLAN_PATH,
		config_json: null,
		created_at: "2026-09-23 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "0.0.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: ORIGIN.recorder,
	});
}

function migrationIo(
	ctx: ReturnType<typeof setup>,
	readPlanAtCommit: (commit: string) => Promise<string | null>,
	readWorktree: () => { bytes: string | null; require: boolean },
) {
	return {
		recordStore: ctx.recordStore,
		store: ctx.store,
		origin: ORIGIN,
		resolveCommit: async (commit: string) => commit,
		readPlanAtCommit,
		readWorktree: () => readWorktree(),
	};
}

async function bindExecution(
	ctx: ReturnType<typeof setup>,
	executionRunId: string,
	markdown: string,
	readPlanAtCommit: (commit: string) => Promise<string | null>,
) {
	const bound = await bindImplementationExecution({
		store: ctx.store,
		recordStore: ctx.recordStore,
		executionRunId,
		sourceRunId: "source",
		planPath: PLAN_PATH,
		planMarkdown: markdown,
		origin: ORIGIN,
		readPlanAtCommit,
	});
	if (bound.status !== "bound") {
		throw new Error(
			bound.status === "error"
				? `${bound.code}: ${bound.message}`
				: bound.status,
		);
	}
	return bound.binding;
}

function lineageDrift(
	ctx: ReturnType<typeof setup>,
	runId: string,
	bindingId: string,
	markdown: string,
) {
	const amendments = ctx.store.listImplementationTextAmendments(
		runId,
		bindingId,
	);
	const drift = detectPlanDrift({
		approvedPlanBytes: markdown,
		approvedPlanHash: hashPlanBytes(markdown),
		amendments,
		currentPlanBytes: markdown,
		recordedSchema: 0,
	});
	return { amendments, chainValid: drift.chainValid };
}

describe("plan schema migration", () => {
	test("round-trips the codec and rejects reviewer authority", () => {
		const approved = plan();
		const target = wrapEquivalentPlan(approved);
		const diff = diffPlanSchemaMigration({
			sourceBytes: approved,
			targetBytes: target,
			mode: "equivalent",
		});
		if (!diff.ok) throw new Error(diff.message);
		const payload: PlanSchemaMigrationPayload = {
			kind: "plan-schema-migration",
			version: 1,
			id: "schema-migration:1",
			runId: "exec",
			bindingId: null,
			fromSchema: 0,
			toSchema: 1,
			authority: "verified_equivalent",
			parentLineageId: null,
			priorApprovalCommit: APPROVED_COMMIT,
			beforeCommit: APPROVED_COMMIT,
			afterCommit: MIGRATED_COMMIT,
			beforeBlobHash: hashPlanBytes(approved),
			afterBlobHash: diff.afterBlobHash,
			authorizedPlanBytes: target,
			governingHash: diff.governingHash,
			proposalDigest: "sha256:abc",
			exclusions: diff.exclusions,
			nonGoverningText: diff.nonGoverningText,
			createdAt: "2026-10-30T00:00:00.000Z",
		};
		const decoded = decodePlanSchemaMigrationPayload(
			encodePlanSchemaMigrationPayload(payload),
		);
		expect(decoded).toEqual(payload);
		expect("snapshotId" in decoded).toBe(false);
		expect(decoded.exclusions.some((entry) => "currentText" in entry)).toBe(
			false,
		);
		expect(() =>
			decodePlanSchemaMigrationPayload({ ...payload, authority: "reviewer" }),
		).toThrow(/authority/);
		expect(() =>
			decodePlanSchemaMigrationPayload({
				...payload,
				exclusions: [
					{
						id: "L1",
						approvedLine: 1,
						approvedText: "kept",
						approvedTextHash: "sha256:kept",
						currentText: "now",
					},
				],
			}),
		).not.toThrow();
		const ignored = decodePlanSchemaMigrationPayload({
			...payload,
			snapshotId: "snap",
			exclusions: [
				{
					id: "L1",
					approvedLine: 1,
					approvedText: "kept",
					approvedTextHash: "sha256:kept",
					currentText: "now",
					currentTextHash: "sha256:no",
				},
			],
		});
		expect("snapshotId" in ignored).toBe(false);
		expect(ignored.exclusions.some((entry) => "currentText" in entry)).toBe(
			false,
		);
	});

	test("folds one migration and still skips an unknown budget kind", () => {
		const ctx = setup();
		ctx.recordStore.append({
			runId: "exec",
			stream: "budget",
			idempotencyKey: "budget:future",
			payload: { kind: "future-budget-kind", version: 1 },
			...recordedEnvelope(ORIGIN),
		});
		const approved = plan(false);
		const target = wrapEquivalentPlan(approved);
		const first = runMigration(ctx, approved, target, { mode: "equivalent" });
		expect(first.created).toBe(true);
		const again = ctx.recordStore.append({
			runId: "exec",
			stream: "budget",
			idempotencyKey: `budget:plan-schema-migration:exec:${first.proposalDigest}`,
			payload: encodePlanSchemaMigrationPayload(
				first.migration as PlanSchemaMigrationPayload,
			),
			...recordedEnvelope(ORIGIN),
		});
		expect(again.created).toBe(false);
		const listed = ctx.store.listImplementationTextAmendments(
			"exec",
			"binding-1",
		);
		expect(
			listed.filter((entry) => entry.kind === "plan-schema-migration"),
		).toHaveLength(1);
		expect(
			listed.some(
				(entry) => (entry as { kind?: string }).kind === "future-budget-kind",
			),
		).toBe(false);
		expect(ctx.store.listPlanSchemaMigrations("exec")).toHaveLength(1);
	});

	test("equivalent wrap is a mechanical proof and keeps the ledger", () => {
		const ctx = setup();
		const approved = plan(false);
		const target = wrapEquivalentPlan(approved);
		const diff = diffPlanSchemaMigration({
			sourceBytes: approved,
			targetBytes: target,
			mode: "equivalent",
		});
		if (!diff.ok) throw new Error(diff.message);
		expect(diff.exclusions).toEqual([]);
		expect(diff.insertions).toEqual([]);
		const result = runMigration(ctx, approved, target, { mode: "equivalent" });
		expect(result.authority).toBe("verified_equivalent");
		expect(result.completionAuthorized).toBe(false);
		expect(result.migration?.authority).toBe("verified_equivalent");
		expect(result.migration && "snapshotId" in result.migration).toBe(false);
		const targetLedger = parseDeliveryBudget(
			loadPlanDocument(target, 1).ok
				? (
						loadPlanDocument(target, 1) as {
							ok: true;
							document: { authorityMarkdown: string };
						}
					).document.authorityMarkdown
				: "",
		);
		expect(targetLedger.ok).toBe(true);
		if (targetLedger.ok) {
			expect(deliveryLedgersEqual(targetLedger.value, ledgerOf(approved))).toBe(
				true,
			);
		}
		const loaded = ctx.store.listPlanSchemaMigrations("exec");
		expect(loaded).toHaveLength(1);
		expect(
			resolveRecordedPlanSchema({
				approvedPlanBytes: approved,
				approvedPlanHash: hashPlanBytes(approved),
				amendments: loaded,
			}),
		).toBe(1);
	});

	test("repeated blank lines keep stable exclusion ids and dry-run shows nonGoverningText", () => {
		const approved = plan(false).replace("# Plan\n\n##", "# Plan\n\n\n##");
		const interior = approved.replace("# Plan\n\n\n##", "# Plan\n\n##");
		const target = `<!-- 5x:plan-schema:1 -->\noutside\n<!-- 5x:contract:start -->\n${interior}<!-- 5x:contract:end -->\n`;
		const first = diffPlanSchemaMigration({
			sourceBytes: approved,
			targetBytes: target,
			mode: "selective",
		});
		const second = diffPlanSchemaMigration({
			sourceBytes: approved,
			targetBytes: target,
			mode: "selective",
		});
		if (!first.ok || !second.ok) throw new Error("diff failed");
		expect(first.exclusions.map((entry) => entry.id)).toEqual(
			second.exclusions.map((entry) => entry.id),
		);
		expect(first.exclusions.map((entry) => entry.approvedText)).toEqual([""]);
		expect(first.exclusions[0]?.id).toBe("L3");
		expect(first.nonGoverningText.map((entry) => entry.text)).toContain(
			"outside",
		);
		const ctx = setup();
		const digest = planSchemaProposalDigest({
			runId: "exec",
			beforeBlobHash: hashPlanBytes(approved),
			afterBlobHash: first.afterBlobHash,
			parentLineageId: null,
			exclusions: first.exclusions,
			nonGoverningText: first.nonGoverningText,
		});
		const dry = runMigration(ctx, approved, target, {
			dryRun: true,
			subject: subjectFor(approved, {}),
		});
		expect(dry.nonGoverningText).toEqual(first.nonGoverningText);
		expect(dry.proposalDigest).toBe(digest);
		expect(dry.authority).toBeUndefined();
		expect(dry.completionAuthorized).toBe(false);
		expect(migrationCount(ctx)).toBe(0);
		const changed = target.replace("outside", "outside-again");
		const changedDiff = diffPlanSchemaMigration({
			sourceBytes: approved,
			targetBytes: changed,
			mode: "selective",
		});
		if (!changedDiff.ok) throw new Error(changedDiff.message);
		expect(changedDiff.afterBlobHash).not.toBe(first.afterBlobHash);
		const stale = caught(() =>
			runMigration(ctx, approved, changed, { confirmExclusions: digest }),
		);
		expect(stale.code).toBe("PLAN_MIGRATION_STALE");
		expect(migrationCount(ctx)).toBe(0);
	});

	test("rejects a retained governing edit and a ledger mismatch", () => {
		const approved = plan(false);
		const edited = wrapEquivalentPlan(
			approved.replace("Bind execution", "Bind later"),
		);
		const ctx = setup();
		const governing = caught(() =>
			runMigration(ctx, approved, edited, { mode: "selective", dryRun: true }),
		);
		expect(governing.code).toBe("PLAN_MIGRATION_GOVERNING_CHANGE");
		expect(governing.message).toContain(PLAN_DRIFT_RECOVERY_HELP);
		expect(governing.message).toContain("recover-plan");
		expect(migrationCount(ctx)).toBe(0);
		const wrapped = wrapEquivalentPlan(approved);
		const mismatched = subjectFor(approved);
		mismatched.ledger = {
			...mismatched.ledger,
			workItems: mismatched.ledger.workItems.map((item) => ({
				...item,
				effort: 5,
			})),
		};
		const ledger = caught(() =>
			runMigration(ctx, approved, wrapped, {
				mode: "equivalent",
				subject: mismatched,
			}),
		);
		expect(ledger.code).toBe("PLAN_MIGRATION_GOVERNING_CHANGE");
		expect(migrationCount(ctx)).toBe(0);
	});

	test("identical retry returns the stored winner before a schema 1 refusal", () => {
		const ctx = setup();
		const approved = plan();
		const target = selectiveTarget(approved);
		const dry = runMigration(ctx, approved, target, { dryRun: true });
		expect(dry.exclusions.map((entry) => entry.approvedText)).toEqual([
			"**Status:** Draft",
		]);
		expect(dry.nonGoverningText.map((entry) => entry.text)).toContain(
			"**Status:** Revised",
		);
		const recorded = runMigration(ctx, approved, target, {
			confirmExclusions: dry.proposalDigest,
		});
		expect(recorded.created).toBe(true);
		expect(recorded.authority).toBe("operator");
		expect(recorded.completionAuthorized).toBe(false);
		const stored = ctx.store.listPlanSchemaMigrations("exec");
		expect(stored).toHaveLength(1);
		const retry = runMigration(ctx, approved, target, {
			confirmExclusions: dry.proposalDigest,
			subject: subjectFor(approved, {
				bindingPlanSchema: 1,
				migrations: stored,
			}),
		});
		expect(retry.created).toBe(false);
		expect(retry.migration?.id).toBe(recorded.migration?.id);
		expect(migrationCount(ctx)).toBe(1);
		const distinct = caught(() =>
			runMigration(ctx, approved, `${target}\n`, {
				confirmExclusions: dry.proposalDigest,
				subject: subjectFor(approved, {
					bindingPlanSchema: 1,
					migrations: stored,
				}),
			}),
		);
		expect(distinct.code).toBe("PLAN_MIGRATION_CONFLICT");
		expect(migrationCount(ctx)).toBe(1);
		const alreadySchema1 = caught(() =>
			runMigration(ctx, approved, target, {
				confirmExclusions: "sha256:other",
				subject: subjectFor(approved, { bindingPlanSchema: 1 }),
			}),
		);
		expect(alreadySchema1.code).toBe("PLAN_MIGRATION_CONFLICT");
	});

	test("includes decisions in expectedKeys and writes nothing on precondition failure", () => {
		const ctx = setup();
		ctx.recordStore.append({
			runId: "exec",
			stream: "decisions",
			idempotencyKey: "decisions:existing",
			payload: { kind: "note" },
			...recordedEnvelope(ORIGIN),
		});
		const seen: Array<Record<string, string[] | undefined>> = [];
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops, expected) => {
			seen.push(expected ?? {});
			return original(ops, expected);
		};
		const approved = plan(false);
		const target = wrapEquivalentPlan(approved);
		runMigration(ctx, approved, target, { mode: "equivalent" });
		expect(seen[0]?.decisions).toEqual(["decisions:existing"]);
		expect(seen[0]?.budget).toEqual([]);
		expect(seen[0]?.steps).toEqual([]);
		const step = ctx.recordStore
			.listLines("exec", "steps")
			.find(
				(line) =>
					(line.payload as { step_name?: string }).step_name ===
					"schema-migration",
			);
		expect(step?.payload).toMatchObject({
			step_name: "schema-migration",
			phase: null,
			iteration: 0,
		});
		expect(step?.idempotencyKey).toContain("sha256:");
		const other = setup();
		const otherOriginal = other.recordStore.atomicAppendIfAllNew.bind(
			other.recordStore,
		);
		const raced = caught(() => {
			other.recordStore.atomicAppendIfAllNew = (ops, expected) => {
				other.recordStore.append({
					runId: "exec",
					stream: "decisions",
					idempotencyKey: "decisions:race",
					payload: { kind: "race" },
					...recordedEnvelope(ORIGIN),
				});
				return otherOriginal(ops, expected);
			};
			runMigration(other, approved, target, { mode: "equivalent" });
		});
		expect(raced.code).toBe("RECORD_PRECONDITION_FAILED");
		expect(raced.message).toContain("repeat the dry-run");
		expect(migrationCount(other)).toBe(0);
	});

	test("rejects a migration whose target is not schema 1 and does not fall back", () => {
		const approved = plan(false);
		const bad = "# still schema 0\n";
		const ctx = setup();
		const payload: PlanSchemaMigrationPayload = {
			kind: "plan-schema-migration",
			version: 1,
			id: "bad",
			runId: "exec",
			bindingId: "binding-1",
			fromSchema: 0,
			toSchema: 1,
			authority: "operator",
			parentLineageId: null,
			priorApprovalCommit: APPROVED_COMMIT,
			beforeCommit: APPROVED_COMMIT,
			afterCommit: MIGRATED_COMMIT,
			beforeBlobHash: hashPlanBytes(approved),
			afterBlobHash: hashPlanBytes(bad),
			authorizedPlanBytes: bad,
			governingHash: hashPlanBytes("nope"),
			proposalDigest: "sha256:bad",
			exclusions: [],
			nonGoverningText: [],
			createdAt: "2026-10-30T00:00:00.000Z",
		};
		ctx.recordStore.append({
			runId: "exec",
			stream: "budget",
			idempotencyKey: "budget:plan-schema-migration:exec:sha256:bad",
			payload: encodePlanSchemaMigrationPayload(payload),
			...recordedEnvelope(ORIGIN),
		});
		const amendments = ctx.store.listImplementationTextAmendments(
			"exec",
			"binding-1",
		);
		expect(amendments).toHaveLength(1);
		const drift = detectPlanDrift({
			approvedPlanBytes: approved,
			approvedPlanHash: hashPlanBytes(approved),
			amendments,
			currentPlanBytes: approved,
			recordedSchema: 0,
		});
		expect(drift.chainValid).toBe(false);
		expect(drift.authorizedBytes).toBe(approved);
		expect(
			resolveRecordedPlanSchema({
				approvedPlanBytes: approved,
				approvedPlanHash: hashPlanBytes(approved),
				amendments,
			}),
		).toBe(0);
	});

	test("recovers a status sentence and fails closed when markers disappear", () => {
		const ctx = setup();
		const approved = plan();
		const target = selectiveTarget(approved);
		const dry = runMigration(ctx, approved, target, { dryRun: true });
		runMigration(ctx, approved, target, {
			confirmExclusions: dry.proposalDigest,
		});
		const amendments = ctx.store.listImplementationTextAmendments(
			"exec",
			"binding-1",
		);
		const recordedSchema = resolveRecordedPlanSchema({
			approvedPlanBytes: approved,
			approvedPlanHash: hashPlanBytes(approved),
			amendments,
		});
		expect(recordedSchema).toBe(1);
		const governingHash = amendments.find(
			(entry) => entry.kind === "plan-schema-migration",
		);
		const hash =
			governingHash?.kind === "plan-schema-migration"
				? governingHash.governingHash
				: undefined;
		const admitted = detectPlanDrift({
			approvedPlanBytes: approved,
			approvedPlanHash: hashPlanBytes(approved),
			amendments,
			currentPlanBytes: target,
			recordedSchema,
			...(hash ? { governingHash: hash } : {}),
		});
		expect(admitted.drifted).toBe(false);
		expect(admitted.chainValid).toBe(true);
		const statusEdited = target.replace(
			"**Status:** Revised",
			"**Status:** Later",
		);
		const still = detectPlanDrift({
			approvedPlanBytes: approved,
			approvedPlanHash: hashPlanBytes(approved),
			amendments,
			currentPlanBytes: statusEdited,
			recordedSchema,
			...(hash ? { governingHash: hash } : {}),
		});
		expect(still.drifted).toBe(false);
		const stripped = detectPlanDrift({
			approvedPlanBytes: approved,
			approvedPlanHash: hashPlanBytes(approved),
			amendments,
			currentPlanBytes: approved,
			recordedSchema,
			...(hash ? { governingHash: hash } : {}),
		});
		expect(stripped.drifted).toBe(true);
		expect(stripped.reason).toContain("PLAN_SCHEMA_INVALID");
		expect(stripped.reason).toContain("not a legacy fallback");
		const unmigrated = detectPlanDrift({
			approvedPlanBytes: approved,
			approvedPlanHash: hashPlanBytes(approved),
			amendments: [],
			currentPlanBytes: approved.replace(
				"**Status:** Draft",
				"**Status:** Later",
			),
			recordedSchema: 0,
		});
		expect(unmigrated.drifted).toBe(true);
		expect(unmigrated.chainValid).toBe(true);
	});
});

function putSource(
	ctx: ReturnType<typeof setup>,
	id: string,
	markdown: string,
) {
	ctx.recordStore.putRun({
		id,
		plan_path: PLAN_PATH,
		config_json: null,
		created_at: "2026-09-23 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "0.0.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: ORIGIN.recorder,
	});
	const parsed = ledgerOf(markdown);
	const baseline = ctx.store.captureBaseline({
		runId: id,
		captureKind: "initial",
		parsed,
		configSnapshot: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		mode: "enforced",
		origin: ORIGIN,
	});
	const snapshot = ctx.store.appendSnapshot({
		runId: id,
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: parsed,
		findings: [],
		assessments: [],
		origin: ORIGIN,
	});
	const appendStep = (
		stepName: string,
		phase: string | null,
		iteration: number,
		result: unknown,
		head: string | null,
		key: string,
	) => {
		ctx.recordStore.append({
			runId: id,
			stream: "steps",
			idempotencyKey: key,
			payload: {
				step_name: stepName,
				phase,
				iteration,
				result_json: result,
				head_commit: head,
				patch_id: null,
				diff_summary: null,
				duration_ms: null,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
				model: null,
			},
			...recordedEnvelope(ORIGIN),
		});
	};
	appendStep(
		"reviewer:plan",
		"plan",
		1,
		{ readiness: "ready", items: [], governance: { route: "complete" } },
		APPROVED_COMMIT,
		`step:${id}:reviewer:plan:plan:1`,
	);
	appendStep(
		"run:complete",
		"plan",
		1,
		{ status: "completed", reason: null },
		APPROVED_COMMIT,
		`step:${id}:run:complete:plan:1`,
	);
	const summary = ctx.recordStore.getRun(id);
	if (!summary) throw new Error("missing source");
	ctx.recordStore.putRun({
		...summary,
		status: "completed",
		sealed_at: "2026-09-23T00:00:02.000Z",
		final_head_commit: APPROVED_COMMIT,
		sealer: ORIGIN.recorder,
	});
	return { baseline: baseline.baseline, snapshot };
}

describe("source migration and completed-run steps", () => {
	test("a schema-migration step after run:complete leaves approval in place", async () => {
		const ctx = setup();
		const markdown = plan(false);
		putSource(ctx, "source", markdown);
		const stepsBefore = ctx.recordStore.listLines("source", "steps");
		const budgetBefore = ctx.recordStore.listLines("source", "budget");
		const before = foldGoverningReviewState({
			b0: 2,
			decisions: [],
			steps: stepsBefore,
			budget: budgetBefore,
		});
		ctx.recordStore.append({
			runId: "source",
			stream: "steps",
			idempotencyKey: `step:source:schema-migration::0:sha256:abc`,
			payload: {
				step_name: "schema-migration",
				phase: null,
				iteration: 0,
				result_json: { proposalDigest: "sha256:abc" },
				head_commit: "b".repeat(40),
				patch_id: null,
				diff_summary: null,
				duration_ms: null,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
				model: null,
			},
			...recordedEnvelope(ORIGIN),
		});
		const after = foldGoverningReviewState({
			b0: 2,
			decisions: [],
			steps: ctx.recordStore.listLines("source", "steps"),
			budget: ctx.recordStore.listLines("source", "budget"),
		});
		expect(after).toEqual(before);
		ctx.recordStore.putRun({
			id: "exec",
			plan_path: PLAN_PATH,
			config_json: null,
			created_at: "2026-09-23 00:00:00",
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: "0.0.0",
			format_version: RUN_RECORD_FORMAT_VERSION,
			creator: ORIGIN.recorder,
		});
		const bound = await bindImplementationExecution({
			store: ctx.store,
			recordStore: ctx.recordStore,
			executionRunId: "exec",
			sourceRunId: "source",
			planPath: PLAN_PATH,
			planMarkdown: markdown,
			origin: ORIGIN,
			readPlanAtCommit: async () => markdown,
		});
		expect(bound.status).toBe("bound");
		if (bound.status !== "bound") return;
		expect(bound.binding.approvedPlanCommit).toBe(APPROVED_COMMIT);
		expect(bound.binding.planSchema).toBeUndefined();
	});

	test("bind copies one source migration and leaves an existing execution binding", async () => {
		const ctx = setup();
		const markdown = plan(false);
		const approved = putSource(ctx, "source", markdown);
		const target = wrapEquivalentPlan(markdown);
		ctx.recordStore.putRun({
			id: "source-only",
			plan_path: PLAN_PATH,
			config_json: null,
			created_at: "2026-09-23 00:00:00",
			sealed_at: null,
			status: "completed",
			final_head_commit: APPROVED_COMMIT,
			cli_version: "0.0.0",
			format_version: RUN_RECORD_FORMAT_VERSION,
			creator: ORIGIN.recorder,
		});
		const sourceSubject = subjectFor(markdown, { kind: "source" });
		sourceSubject.runId = "source";
		const migrated = runMigration(ctx, markdown, target, {
			mode: "equivalent",
			afterCommit: MIGRATED_COMMIT,
			subject: sourceSubject,
		});
		expect(migrated.created).toBe(true);
		const read = async (commit: string) => {
			if (commit === MIGRATED_COMMIT) return target;
			if (commit === APPROVED_COMMIT) return markdown;
			return null;
		};
		const bound = await bindImplementationExecution({
			store: ctx.store,
			recordStore: ctx.recordStore,
			executionRunId: "exec",
			sourceRunId: "source",
			planPath: PLAN_PATH,
			planMarkdown: target,
			origin: ORIGIN,
			readPlanAtCommit: read,
		});
		expect(bound.status).toBe("bound");
		if (bound.status !== "bound") return;
		expect(bound.binding.planSchema).toBe(1);
		expect(bound.binding.governingHash).toBe(migrated.migration?.governingHash);
		expect(bound.binding.schemaMigrationId).toBe(migrated.migration?.id);
		expect(bound.binding.predecessorPlanCommit).toBe(APPROVED_COMMIT);
		expect(bound.binding.approvedPlanCommit).toBe(MIGRATED_COMMIT);
		expect(bound.binding.sourceSnapshotId).toBe(approved.snapshot.id);
		expect(bound.binding.sourceBaselineId).toBe(approved.baseline.id);
		expect(bound.binding.approvedPlanBytes).toBe(target);
		const again = await bindImplementationExecution({
			store: ctx.store,
			recordStore: ctx.recordStore,
			executionRunId: "exec",
			sourceRunId: "source",
			planPath: PLAN_PATH,
			planMarkdown: target,
			origin: ORIGIN,
			readPlanAtCommit: read,
		});
		expect(again.status).toBe("bound");
		if (again.status !== "bound") return;
		expect(again.created).toBe(false);
		expect(again.binding.approvedPlanCommit).toBe(MIGRATED_COMMIT);
	});

	test("an execution bound before the source migration can migrate on its own", async () => {
		const ctx = setup();
		const markdown = plan(false);
		const approved = putSource(ctx, "source", markdown);
		const target = wrapEquivalentPlan(markdown);
		const read = async (commit: string) => {
			if (commit === MIGRATED_COMMIT) return target;
			if (commit === APPROVED_COMMIT) return markdown;
			return null;
		};
		const binding = await bindExecution(
			ctx,
			"exec",
			markdown,
			async () => markdown,
		);
		expect(binding.planSchema).toBeUndefined();
		expect(binding.schemaMigrationId).toBeUndefined();
		expect(binding.approvedPlanCommit).toBe(APPROVED_COMMIT);
		expect(binding.sourceSnapshotId).toBe(approved.snapshot.id);

		const sourceSubject = subjectFor(markdown, { kind: "source" });
		sourceSubject.runId = "source";
		const sourceMigration = runMigration(ctx, markdown, target, {
			mode: "equivalent",
			afterCommit: MIGRATED_COMMIT,
			subject: sourceSubject,
		});
		expect(sourceMigration.created).toBe(true);
		const afterSource = ctx.store.getImplementationBinding("exec");
		expect(afterSource?.planSchema).toBeUndefined();
		expect(afterSource?.schemaMigrationId).toBeUndefined();
		expect(afterSource?.predecessorPlanCommit).toBeUndefined();
		expect(afterSource?.approvedPlanCommit).toBe(APPROVED_COMMIT);
		expect(afterSource?.approvedPlanBytes).toBe(markdown);
		expect(afterSource?.sourceSnapshotId).toBe(approved.snapshot.id);
		expect(afterSource?.sourceBaselineId).toBe(approved.baseline.id);

		const migrated = await applyPlanSchemaMigration(
			{ runId: "exec", commit: MIGRATED_COMMIT, mode: "equivalent" },
			migrationIo(ctx, read, () => ({ bytes: target, require: true })),
		);
		expect(migrated.created).toBe(true);
		expect(migrated.authority).toBe("verified_equivalent");
		expect(migrated.completionAuthorized).toBe(false);
		expect(ctx.store.listPlanSchemaMigrations("exec")).toHaveLength(1);
		expect(ctx.store.listPlanSchemaMigrations("source")).toHaveLength(1);
		const afterExec = ctx.store.getImplementationBinding("exec");
		expect(afterExec?.planSchema).toBeUndefined();
		expect(afterExec?.schemaMigrationId).toBeUndefined();
		expect(afterExec?.approvedPlanCommit).toBe(APPROVED_COMMIT);
		expect(afterExec?.approvedPlanBytes).toBe(markdown);

		const retry = await applyPlanSchemaMigration(
			{ runId: "exec", commit: MIGRATED_COMMIT, mode: "equivalent" },
			migrationIo(ctx, read, () => ({ bytes: target, require: true })),
		);
		expect(retry.created).toBe(false);
		expect(retry.migration?.id).toBe(migrated.migration?.id);
		expect(ctx.store.listPlanSchemaMigrations("exec")).toHaveLength(1);

		const distinctBytes = selectiveTarget(markdown);
		const distinctCommit = "d".repeat(40);
		const distinct = await caughtAsync(() =>
			applyPlanSchemaMigration(
				{ runId: "exec", commit: distinctCommit, mode: "equivalent" },
				migrationIo(
					ctx,
					async (commit) =>
						commit === distinctCommit ? distinctBytes : read(commit),
					() => ({ bytes: distinctBytes, require: true }),
				),
			),
		);
		expect(distinct.code).toBe("PLAN_MIGRATION_CONFLICT");
		expect(ctx.store.listPlanSchemaMigrations("exec")).toHaveLength(1);

		const sourceDistinct = await caughtAsync(() =>
			applyPlanSchemaMigration(
				{ runId: "source", commit: "e".repeat(40), mode: "equivalent" },
				migrationIo(
					ctx,
					async (commit) => {
						if (commit === APPROVED_COMMIT) return markdown;
						if (commit === "e".repeat(40)) return distinctBytes;
						return read(commit);
					},
					() => ({ bytes: null, require: false }),
				),
			),
		);
		expect(sourceDistinct.code).toBe("PLAN_MIGRATION_CONFLICT");
		expect(ctx.store.listPlanSchemaMigrations("source")).toHaveLength(1);

		putActiveRun(ctx, "exec-2");
		const later = await bindExecution(ctx, "exec-2", target, read);
		expect(later.planSchema).toBe(1);
		expect(later.schemaMigrationId).toBe(sourceMigration.migration?.id);
		const schema1 = await caughtAsync(() =>
			applyPlanSchemaMigration(
				{ runId: "exec-2", commit: MIGRATED_COMMIT, mode: "equivalent" },
				migrationIo(ctx, read, () => ({ bytes: target, require: true })),
			),
		);
		expect(schema1.code).toBe("PLAN_MIGRATION_CONFLICT");
		expect(ctx.store.listPlanSchemaMigrations("exec-2")).toHaveLength(0);
		expect(ctx.store.getImplementationBinding("exec-2")?.planSchema).toBe(1);
		expect(ctx.store.getImplementationBinding("exec")?.approvedPlanCommit).toBe(
			APPROVED_COMMIT,
		);
	});
});

describe("schema migration expectedKeys snapshot", () => {
	async function raceEquivalent(
		ctx: ReturnType<typeof setup>,
		markdown: string,
		intervene: () => Promise<void> | void,
	) {
		const target = wrapEquivalentPlan(markdown);
		let intervened = false;
		return applyPlanSchemaMigration(
			{ runId: "exec", commit: MIGRATED_COMMIT, mode: "equivalent" },
			migrationIo(
				ctx,
				async () => {
					if (!intervened) {
						intervened = true;
						await intervene();
					}
					return target;
				},
				() => ({ bytes: target, require: true }),
			),
		);
	}

	test("a distinct migration after the subject read leaves one valid winner", async () => {
		const ctx = setup();
		const markdown = plan();
		putSource(ctx, "source", markdown);
		const binding = await bindExecution(
			ctx,
			"exec",
			markdown,
			async () => markdown,
		);
		const winnerCommit = "b".repeat(40);
		const error = await caughtAsync(() =>
			raceEquivalent(ctx, markdown, () => {
				expect(ctx.store.listPlanSchemaMigrations("exec")).toHaveLength(0);
				const winnerTarget = selectiveTarget(markdown);
				const subject = subjectFor(markdown, { bindingId: binding.id });
				const deps = {
					recordStore: ctx.recordStore,
					store: ctx.store,
					origin: ORIGIN,
				};
				const expectedKeys = capturePlanSchemaMigrationExpectedKeys(
					ctx.recordStore,
					"exec",
				);
				const dry = executePlanSchemaMigration(
					{
						mode: "selective",
						dryRun: true,
						afterCommit: winnerCommit,
						targetBytes: winnerTarget,
						worktreeBytes: winnerTarget,
						requireWorktreeMatch: true,
						subject,
						expectedKeys,
					},
					deps,
				);
				const saved = executePlanSchemaMigration(
					{
						mode: "selective",
						confirmExclusions: dry.proposalDigest,
						afterCommit: winnerCommit,
						targetBytes: winnerTarget,
						worktreeBytes: winnerTarget,
						requireWorktreeMatch: true,
						subject,
						expectedKeys,
					},
					deps,
				);
				expect(saved.created).toBe(true);
			}),
		);
		expect(error.code).toBe("RECORD_PRECONDITION_FAILED");
		expect(error.message).toContain("repeat the dry-run");
		const migrations = ctx.store.listPlanSchemaMigrations("exec");
		expect(migrations).toHaveLength(1);
		expect(migrations[0]?.afterCommit).toBe(winnerCommit);
		const chain = lineageDrift(ctx, "exec", binding.id, markdown);
		expect(chain.chainValid).toBe(true);
		expect(
			chain.amendments.filter(
				(entry) => entry.kind === "plan-schema-migration",
			),
		).toHaveLength(1);
		expect(
			resolveRecordedPlanSchema({
				approvedPlanBytes: markdown,
				approvedPlanHash: hashPlanBytes(markdown),
				amendments: chain.amendments,
			}),
		).toBe(1);
		expect(
			ctx.recordStore
				.listLines("exec", "steps")
				.filter(
					(line) =>
						(line.payload as { step_name?: string }).step_name ===
						"schema-migration",
				),
		).toHaveLength(1);
	});

	test("a text amendment after the subject read rejects and keeps one valid amendment", async () => {
		const ctx = setup();
		const markdown = plan(false);
		putSource(ctx, "source", markdown);
		const binding = await bindExecution(
			ctx,
			"exec",
			markdown,
			async () => markdown,
		);
		const amended = `${markdown}outside\n`;
		const payload: ImplementationTextAmendmentPayload = {
			kind: "implementation-text-amendment",
			version: IMPLEMENTATION_STATE_VERSION,
			id: "amendment-race",
			bindingId: binding.id,
			executionRunId: "exec",
			guardId: "guard-race",
			sourceObservationId: "observation-race",
			parentLineageId: null,
			beforeCommit: APPROVED_COMMIT,
			afterCommit: "d".repeat(40),
			beforeBlobHash: hashPlanBytes(markdown),
			afterBlobHash: hashPlanBytes(amended),
			authorizedPlanBytes: amended,
			createdAt: "2026-10-30T00:00:00.000Z",
		};
		const error = await caughtAsync(() =>
			raceEquivalent(ctx, markdown, () => {
				ctx.recordStore.append({
					runId: "exec",
					stream: "budget",
					idempotencyKey: implementationTextAmendmentKey(
						binding.id,
						payload.id,
					),
					payload,
					...recordedEnvelope(ORIGIN),
				});
			}),
		);
		expect(error.code).toBe("RECORD_PRECONDITION_FAILED");
		expect(migrationCount(ctx)).toBe(0);
		const chain = lineageDrift(ctx, "exec", binding.id, markdown);
		expect(chain.chainValid).toBe(true);
		expect(chain.amendments).toHaveLength(1);
		expect(chain.amendments[0]?.kind).toBe("implementation-text-amendment");
		expect(
			ctx.recordStore
				.listLines("exec", "steps")
				.some(
					(line) =>
						(line.payload as { step_name?: string }).step_name ===
						"schema-migration",
				),
		).toBe(false);
	});

	test("a decision after the subject read rejects and writes no migration", async () => {
		const ctx = setup();
		const markdown = plan(false);
		putSource(ctx, "source", markdown);
		const binding = await bindExecution(
			ctx,
			"exec",
			markdown,
			async () => markdown,
		);
		const error = await caughtAsync(() =>
			raceEquivalent(ctx, markdown, () => {
				ctx.recordStore.append({
					runId: "exec",
					stream: "decisions",
					idempotencyKey: "decisions:race",
					payload: { kind: "race" },
					...recordedEnvelope(ORIGIN),
				});
			}),
		);
		expect(error.code).toBe("RECORD_PRECONDITION_FAILED");
		expect(migrationCount(ctx)).toBe(0);
		expect(lineageDrift(ctx, "exec", binding.id, markdown).chainValid).toBe(
			true,
		);
		expect(
			lineageDrift(ctx, "exec", binding.id, markdown).amendments,
		).toHaveLength(0);
		expect(
			ctx.recordStore
				.listLines("exec", "decisions")
				.map((line) => line.idempotencyKey),
		).toEqual(["decisions:race"]);
		expect(
			ctx.recordStore
				.listLines("exec", "steps")
				.some(
					(line) =>
						(line.payload as { step_name?: string }).step_name ===
						"schema-migration",
				),
		).toBe(false);
	});
});
