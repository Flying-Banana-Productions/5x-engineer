/**
 * Schema 0 to schema 1 migration.
 *
 * Equivalent mode is a mechanical governing-line proof. Selective mode
 * confirms an operator exclusion digest. There is no reviewer snapshot.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ReviewBudgetCommandContext } from "../commands/review-budget-context.js";
import { createReviewBudgetId } from "../control-plane/ids.js";
import type { RecordStore } from "../control-plane/record-store.js";
import {
	type RecordOrigin,
	RecordStoreError,
	recordedEnvelope,
	type StepRecordPayload,
} from "../control-plane/record-types.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import { CliError } from "../output.js";
import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import { loadPlanDocument } from "../plan-schema/document.js";
import {
	decodePlanSchemaMigrationPayload,
	encodePlanSchemaMigrationPayload,
	type PlanSchemaExclusion,
	type PlanSchemaMigrationPayload,
	type PlanSchemaNonGoverningLine,
	planSchemaMigrationKey,
	planSchemaMigrationStepKey,
} from "../review-budget/record-lines.js";
import type { ParsedDeliveryBudget } from "../review-budget/types.js";
import { resolveCodeCommit, workdirCodeDiffGit } from "./code-diff.js";
import {
	deliveryLedgersEqual,
	hashPlanBytes,
	PLAN_DRIFT_RECOVERY_HELP,
	readSchemaMigrationSubject,
	type SchemaMigrationSubject,
	showPlanAtCommit,
} from "./implementation-state.js";

export type PlanSchemaMigrationMode = "equivalent" | "selective";

export interface ExecutePlanSchemaMigrationInput {
	mode: PlanSchemaMigrationMode;
	dryRun?: boolean;
	confirmExclusions?: string;
	afterCommit: string;
	targetBytes: string;
	worktreeBytes: string | null;
	requireWorktreeMatch: boolean;
	subject: SchemaMigrationSubject;
}

export interface PlanSchemaMigrationView {
	created: boolean;
	dryRun: boolean;
	completionAuthorized: false;
	proposalDigest: string;
	authority?: PlanSchemaMigrationPayload["authority"];
	exclusions: PlanSchemaExclusion[];
	nonGoverningText: PlanSchemaNonGoverningLine[];
	ledgerSummary: {
		estimateConfidence: ParsedDeliveryBudget["estimateConfidence"];
		workItemIds: string[];
	};
	migration?: PlanSchemaMigrationPayload;
}

const EQUIVALENT_PREFIX =
	"<!-- 5x:plan-schema:1 -->\n<!-- 5x:contract:start -->\n";
const EQUIVALENT_SUFFIX = "<!-- 5x:contract:end -->\n";

export function wrapEquivalentPlan(raw: string): string {
	const interior = raw.endsWith("\n") || raw.endsWith("\r") ? raw : `${raw}\n`;
	return `${EQUIVALENT_PREFIX}${interior}${EQUIVALENT_SUFFIX}`;
}

/** Interior of a mechanical equivalent wrap, or null when the file is not one. */
export function equivalentWrapInterior(raw: string): string | null {
	if (!raw.startsWith(EQUIVALENT_PREFIX) || !raw.endsWith(EQUIVALENT_SUFFIX)) {
		return null;
	}
	const interior = raw.slice(
		EQUIVALENT_PREFIX.length,
		raw.length - EQUIVALENT_SUFFIX.length,
	);
	if (!interior.endsWith("\n") && !interior.endsWith("\r")) return null;
	if (wrapEquivalentPlan(interior) !== raw) return null;
	const loaded = loadPlanDocument(raw, "file");
	if (!loaded.ok || loaded.document.schema !== 1) return null;
	return interior;
}

export function nonGoverningLines(
	raw: string,
	governingLineNumbers: ReadonlySet<number>,
): PlanSchemaNonGoverningLine[] {
	return splitRawLines(raw).filter(
		(line) => !governingLineNumbers.has(line.line),
	);
}

export function diffPlanSchemaMigration(input: {
	sourceBytes: string;
	targetBytes: string;
	mode: PlanSchemaMigrationMode;
}):
	| {
			ok: true;
			exclusions: PlanSchemaExclusion[];
			insertions: string[];
			nonGoverningText: PlanSchemaNonGoverningLine[];
			governingHash: string;
			afterBlobHash: string;
	  }
	| {
			ok: false;
			code: "PLAN_SCHEMA_INVALID" | "PLAN_SCHEMA_UNSUPPORTED";
			message: string;
	  } {
	const approved = loadPlanDocument(input.sourceBytes, 0);
	if (!approved.ok) {
		return {
			ok: false,
			code: approved.code,
			message: approved.message,
		};
	}
	const target = loadPlanDocument(input.targetBytes, 1);
	if (!target.ok) {
		return {
			ok: false,
			code: target.code,
			message: target.message.includes("not a legacy fallback")
				? target.message
				: `${target.message} This is not a legacy fallback.`,
		};
	}
	const approvedLines = [...approved.document.governingLines];
	let targetLines = [...target.document.governingLines];
	if (input.mode === "equivalent") {
		targetLines = applyTrailingNewlineAllowance(approvedLines, targetLines);
	}
	const { deletions, insertions } = earliestMatchDiff(
		approvedLines,
		targetLines,
	);
	const exclusions = deletions.map((index) => {
		const approvedText = approvedLines[index] ?? "";
		return {
			id: `L${index + 1}`,
			approvedLine: index + 1,
			approvedText,
			approvedTextHash: hashPlanBytes(approvedText),
		};
	});
	const governingNumbers = new Set(
		target.document.governingLineLocations.map((line) => line.lineNumber),
	);
	return {
		ok: true,
		exclusions,
		insertions: insertions.map((index) => targetLines[index] ?? ""),
		nonGoverningText: nonGoverningLines(input.targetBytes, governingNumbers),
		governingHash: hashPlanBytes(target.document.comparisonBytes),
		afterBlobHash: hashPlanBytes(input.targetBytes),
	};
}

export function planSchemaProposalDigest(input: {
	runId: string;
	beforeBlobHash: string;
	afterBlobHash: string;
	parentLineageId: string | null;
	exclusions: readonly Pick<PlanSchemaExclusion, "id" | "approvedTextHash">[];
	nonGoverningText: readonly PlanSchemaNonGoverningLine[];
}): string {
	const nonGoverningTextHash = hashPlanBytes(
		canonicalJson(input.nonGoverningText),
	);
	return hashPlanBytes(
		canonicalJson({
			runId: input.runId,
			beforeBlobHash: input.beforeBlobHash,
			afterBlobHash: input.afterBlobHash,
			parentLineageId: input.parentLineageId,
			exclusions: input.exclusions.map((exclusion) => ({
				id: exclusion.id,
				approvedTextHash: exclusion.approvedTextHash,
			})),
			nonGoverningTextHash,
		}),
	);
}

export function executePlanSchemaMigration(
	input: ExecutePlanSchemaMigrationInput,
	deps: {
		recordStore: RecordStore;
		store: ReviewBudgetStore;
		origin: RecordOrigin;
	},
): PlanSchemaMigrationView {
	if (input.requireWorktreeMatch) {
		if (input.worktreeBytes === null) {
			throw new CliError(
				"PLAN_MIGRATION_CONFLICT",
				"The mapped worktree plan is missing. Refusing to treat that as an empty file.",
			);
		}
		if (input.worktreeBytes !== input.targetBytes) {
			throw new CliError(
				"PLAN_MIGRATION_CONFLICT",
				"Worktree plan must exactly match the supplied commit, including checkbox state.",
			);
		}
	}
	const diff = diffPlanSchemaMigration({
		sourceBytes: input.subject.sourceBytes,
		targetBytes: input.targetBytes,
		mode: input.mode,
	});
	if (!diff.ok) {
		throw new CliError(diff.code, diff.message);
	}
	const proposalDigest = planSchemaProposalDigest({
		runId: input.subject.runId,
		beforeBlobHash: input.subject.beforeBlobHash,
		afterBlobHash: diff.afterBlobHash,
		parentLineageId: input.subject.parentLineageId,
		exclusions: diff.exclusions,
		nonGoverningText: diff.nonGoverningText,
	});
	const identical = input.subject.migrations.find(
		(migration) =>
			migration.proposalDigest === proposalDigest &&
			migration.afterBlobHash === diff.afterBlobHash,
	);
	const ledgerSummary = ledgerSummaryOf(input.subject.ledger);
	if (identical) {
		return {
			created: false,
			dryRun: Boolean(input.dryRun),
			completionAuthorized: false,
			proposalDigest,
			authority: identical.authority,
			exclusions: identical.exclusions,
			nonGoverningText: identical.nonGoverningText,
			ledgerSummary,
			migration: identical,
		};
	}
	if (
		input.subject.bindingPlanSchema === 1 ||
		input.subject.migrations.length > 0 ||
		(input.subject.kind === "execution" &&
			input.subject.sourceMigrations.length > 0)
	) {
		throw new CliError(
			"PLAN_MIGRATION_CONFLICT",
			"A schema migration is already recorded for this run. A distinct migration writes nothing.",
		);
	}
	const targetDocument = loadPlanDocument(input.targetBytes, 1);
	if (!targetDocument.ok) {
		throw new CliError(
			targetDocument.code,
			targetDocument.message.includes("not a legacy fallback")
				? targetDocument.message
				: `${targetDocument.message} This is not a legacy fallback.`,
		);
	}
	const targetLedger = parseDeliveryBudget(
		targetDocument.document.authorityMarkdown,
	);
	if (
		!targetLedger.ok ||
		!deliveryLedgersEqual(targetLedger.value, input.subject.ledger)
	) {
		throw new CliError(
			"PLAN_MIGRATION_GOVERNING_CHANGE",
			`The target governing ledger does not equal the approved ledger. ${PLAN_DRIFT_RECOVERY_HELP}`,
		);
	}
	const authority = resolveAuthority(input, diff, proposalDigest);
	if (input.dryRun) {
		return {
			created: false,
			dryRun: true,
			completionAuthorized: false,
			proposalDigest,
			exclusions: diff.exclusions,
			nonGoverningText: diff.nonGoverningText,
			ledgerSummary,
		};
	}
	const payload: PlanSchemaMigrationPayload = {
		kind: "plan-schema-migration",
		version: 1,
		id: `schema-migration:${createReviewBudgetId()}`,
		runId: input.subject.runId,
		bindingId: input.subject.bindingId,
		fromSchema: 0,
		toSchema: 1,
		authority,
		parentLineageId: input.subject.parentLineageId,
		priorApprovalCommit: input.subject.priorApprovalCommit,
		beforeCommit: input.subject.beforeCommit,
		afterCommit: input.afterCommit,
		beforeBlobHash: input.subject.beforeBlobHash,
		afterBlobHash: diff.afterBlobHash,
		authorizedPlanBytes: input.targetBytes,
		governingHash: diff.governingHash,
		proposalDigest,
		exclusions: diff.exclusions,
		nonGoverningText: diff.nonGoverningText,
		createdAt: new Date().toISOString(),
	};
	const step: StepRecordPayload = {
		step_name: "schema-migration",
		phase: null,
		iteration: 0,
		result_json: {
			migrationId: payload.id,
			proposalDigest: payload.proposalDigest,
			afterCommit: payload.afterCommit,
			authority: payload.authority,
		},
		head_commit: payload.afterCommit,
		patch_id: null,
		diff_summary: null,
		duration_ms: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		model: null,
	};
	const steps = deps.recordStore.listLines(input.subject.runId, "steps");
	const budget = deps.recordStore.listLines(input.subject.runId, "budget");
	const decisions = deps.recordStore.listLines(
		input.subject.runId,
		"decisions",
	);
	let appended: ReturnType<RecordStore["atomicAppendIfAllNew"]>;
	try {
		appended = deps.recordStore.atomicAppendIfAllNew(
			[
				{
					runId: input.subject.runId,
					stream: "budget",
					idempotencyKey: planSchemaMigrationKey(
						input.subject.runId,
						proposalDigest,
					),
					payload: encodePlanSchemaMigrationPayload(payload),
					createdAt: payload.createdAt,
					...recordedEnvelope(deps.origin),
				},
				{
					runId: input.subject.runId,
					stream: "steps",
					idempotencyKey: planSchemaMigrationStepKey(
						input.subject.runId,
						proposalDigest,
					),
					payload: step,
					createdAt: payload.createdAt,
					...recordedEnvelope(deps.origin),
				},
			],
			{
				steps: steps.map((line) => line.idempotencyKey),
				budget: budget.map((line) => line.idempotencyKey),
				decisions: decisions.map((line) => line.idempotencyKey),
			},
		);
	} catch (error) {
		if (
			error instanceof RecordStoreError &&
			error.code === "RECORD_PRECONDITION_FAILED"
		) {
			throw new CliError(
				"RECORD_PRECONDITION_FAILED",
				"Run history changed; repeat the dry-run.",
			);
		}
		throw error;
	}
	if (!appended.created) {
		const winner = appended.duplicates
			.map((entry) => entry.line.payload)
			.find(
				(candidate) =>
					(candidate as { kind?: unknown } | null)?.kind ===
					"plan-schema-migration",
			);
		const stored = winner
			? decodePlanSchemaMigrationPayload(winner)
			: undefined;
		if (
			stored &&
			stored.proposalDigest === proposalDigest &&
			stored.afterBlobHash === diff.afterBlobHash
		) {
			return {
				created: false,
				dryRun: false,
				completionAuthorized: false,
				proposalDigest,
				authority: stored.authority,
				exclusions: stored.exclusions,
				nonGoverningText: stored.nonGoverningText,
				ledgerSummary,
				migration: stored,
			};
		}
		throw new CliError(
			"PLAN_MIGRATION_CONFLICT",
			"A concurrent schema migration won this attempt. Inspect the stored record.",
		);
	}
	return {
		created: true,
		dryRun: false,
		completionAuthorized: false,
		proposalDigest,
		authority,
		exclusions: diff.exclusions,
		nonGoverningText: diff.nonGoverningText,
		ledgerSummary,
		migration: payload,
	};
}

function resolveAuthority(
	input: ExecutePlanSchemaMigrationInput,
	diff: {
		exclusions: PlanSchemaExclusion[];
		insertions: string[];
	},
	proposalDigest: string,
): PlanSchemaMigrationPayload["authority"] {
	if (input.mode === "equivalent") {
		if (diff.exclusions.length > 0 || diff.insertions.length > 0) {
			throw new CliError(
				"PLAN_MIGRATION_NOT_EQUIVALENT",
				"Equivalent migration requires every governing line to match, including the one trailing-newline allowance. Exclusions and added governing lines are refused.",
			);
		}
		return "verified_equivalent";
	}
	if (diff.insertions.length > 0) {
		throw new CliError(
			"PLAN_MIGRATION_GOVERNING_CHANGE",
			`Selective migration cannot add or edit a governing line. ${PLAN_DRIFT_RECOVERY_HELP}`,
		);
	}
	if (diff.exclusions.length === 0) {
		throw new CliError(
			"PLAN_MIGRATION_NOT_EQUIVALENT",
			"Selective migration requires a non-empty exclusion list. Use --mode equivalent when every governing line is retained.",
		);
	}
	if (
		!input.dryRun ||
		(input.confirmExclusions !== undefined &&
			input.confirmExclusions !== proposalDigest)
	) {
		if (input.confirmExclusions !== proposalDigest) {
			throw new CliError(
				"PLAN_MIGRATION_STALE",
				"The exclusion confirmation does not match this proposal. Repeat the dry-run.",
			);
		}
	}
	return "operator";
}

export async function migratePlanSchema(
	input: {
		runId: string;
		commit: string;
		mode: string;
		dryRun?: boolean;
		confirmExclusions?: string;
	},
	ctx: ReviewBudgetCommandContext,
): Promise<
	Omit<PlanSchemaMigrationView, "migration"> & {
		migration?: Omit<PlanSchemaMigrationPayload, "authorizedPlanBytes">;
	}
> {
	if (input.mode !== "equivalent" && input.mode !== "selective") {
		throw new CliError(
			"INVALID_ARGS",
			"--mode must be equivalent or selective.",
		);
	}
	if (!/^[0-9a-f]{40}$/u.test(input.commit)) {
		throw new CliError("INVALID_ARGS", "--commit must be a full sha.");
	}
	const workdir = ctx.executionContext.effectiveWorkingDirectory;
	const git = workdirCodeDiffGit(workdir);
	const resolved = await resolveCodeCommit(git, input.commit);
	if (resolved !== input.commit) {
		throw new CliError("INVALID_ARGS", "--commit must be a full sha.");
	}
	const planPath = ctx.executionContext.run.plan_path;
	const subjectResult = await readSchemaMigrationSubject({
		store: ctx.store,
		recordStore: ctx.recordStore,
		runId: input.runId,
		readPlanAtCommit: (commit) =>
			showPlanAtCommit(workdir, commit, planPath, {
				repoRoot: ctx.executionContext.controlPlaneRoot,
			}),
	});
	if (!subjectResult.ok) {
		throw new CliError(subjectResult.code, subjectResult.message);
	}
	const targetBytes = await showPlanAtCommit(workdir, input.commit, planPath, {
		repoRoot: ctx.executionContext.controlPlaneRoot,
	});
	if (targetBytes === null) {
		throw new CliError(
			"IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE",
			`Plan bytes at ${input.commit} are unavailable. A missing worktree is not an empty file.`,
		);
	}
	const worktree = worktreeMatch(ctx, subjectResult.subject.kind);
	const result = executePlanSchemaMigration(
		{
			mode: input.mode,
			dryRun: input.dryRun,
			confirmExclusions: input.confirmExclusions,
			afterCommit: input.commit,
			targetBytes,
			worktreeBytes: worktree.bytes,
			requireWorktreeMatch: worktree.require,
			subject: subjectResult.subject,
		},
		{
			recordStore: ctx.recordStore,
			store: ctx.store,
			origin: ctx.originFor({ kind: "human", role: "operator" }),
		},
	);
	return presentMigration(result);
}

function worktreeMatch(
	ctx: ReviewBudgetCommandContext,
	kind: SchemaMigrationSubject["kind"],
): { bytes: string | null; require: boolean } {
	const execution = ctx.executionContext;
	const linked = execution.mappedWorktreePath !== null;
	if (kind === "source" && !linked) return { bytes: null, require: false };
	if (!existsSync(execution.effectivePlanPath)) {
		throw new CliError(
			"PLAN_MIGRATION_CONFLICT",
			"The mapped worktree plan is missing. Refusing to treat that as an empty file.",
		);
	}
	return {
		bytes: readFileSync(execution.effectivePlanPath, "utf8"),
		require: true,
	};
}

function presentMigration(result: PlanSchemaMigrationView): Omit<
	PlanSchemaMigrationView,
	"migration"
> & {
	migration?: Omit<PlanSchemaMigrationPayload, "authorizedPlanBytes">;
} {
	if (!result.migration) return result;
	const { authorizedPlanBytes: _bytes, ...migration } = result.migration;
	return { ...result, migration };
}

function ledgerSummaryOf(ledger: ParsedDeliveryBudget): {
	estimateConfidence: ParsedDeliveryBudget["estimateConfidence"];
	workItemIds: string[];
} {
	return {
		estimateConfidence: ledger.estimateConfidence,
		workItemIds: ledger.workItems.map((item) => item.id),
	};
}

function applyTrailingNewlineAllowance(
	approved: readonly string[],
	target: readonly string[],
): string[] {
	const trailing = (lines: readonly string[]) => {
		let count = 0;
		for (
			let index = lines.length - 1;
			index >= 0 && lines[index] === "";
			index--
		) {
			count += 1;
		}
		return count;
	};
	if (trailing(target) === trailing(approved) + 1) return target.slice(0, -1);
	return [...target];
}

function earliestMatchDiff(
	approved: readonly string[],
	target: readonly string[],
): { deletions: number[]; insertions: number[] } {
	const rowCount = approved.length;
	const columnCount = target.length;
	const dp: number[][] = Array.from({ length: rowCount + 1 }, () =>
		Array<number>(columnCount + 1).fill(0),
	);
	for (let i = rowCount - 1; i >= 0; i--) {
		const row = dp[i];
		const next = dp[i + 1];
		if (!row || !next) continue;
		for (let j = columnCount - 1; j >= 0; j--) {
			row[j] =
				approved[i] === target[j]
					? (next[j + 1] ?? 0) + 1
					: Math.max(next[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const deletions: number[] = [];
	const insertions: number[] = [];
	let i = 0;
	let j = 0;
	while (i < rowCount || j < columnCount) {
		if (i < rowCount && j < columnCount && approved[i] === target[j]) {
			i += 1;
			j += 1;
			continue;
		}
		const current = dp[i]?.[j] ?? 0;
		const afterDelete = dp[i + 1]?.[j] ?? 0;
		if (i < rowCount && afterDelete === current) {
			deletions.push(i);
			i += 1;
			continue;
		}
		if (j < columnCount) {
			insertions.push(j);
			j += 1;
			continue;
		}
		deletions.push(i);
		i += 1;
	}
	return { deletions, insertions };
}

function splitRawLines(raw: string): PlanSchemaNonGoverningLine[] {
	const lines: PlanSchemaNonGoverningLine[] = [];
	let start = 0;
	let lineNumber = 1;
	for (let index = 0; index < raw.length; index++) {
		const unit = raw.charAt(index);
		if (unit !== "\n" && unit !== "\r") continue;
		const ending =
			unit === "\r" && raw.charAt(index + 1) === "\n" ? "\r\n" : unit;
		lines.push({ line: lineNumber, text: raw.slice(start, index) });
		index += ending.length - 1;
		start = index + 1;
		lineNumber += 1;
	}
	if (start < raw.length || lines.length === 0) {
		lines.push({ line: lineNumber, text: raw.slice(start) });
	}
	return lines;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
