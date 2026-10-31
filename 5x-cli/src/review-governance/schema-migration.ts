/**
 * Schema 0 to schema 1 migration.
 *
 * Equivalent mode is a mechanical governing-line proof. Selective mode
 * confirms an operator exclusion digest. There is no reviewer snapshot.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
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
import { planSlugFromPath } from "../paths.js";
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
import { subprocess } from "../utils/subprocess.js";
import { resolveCodeCommit, workdirCodeDiffGit } from "./code-diff.js";
import {
	deliveryLedgersEqual,
	hashPlanBytes,
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
	/** Key lists captured before the subject read. Passed through to the append. */
	expectedKeys: PlanSchemaMigrationExpectedKeys;
}

export interface PlanSchemaMigrationExpectedKeys {
	steps: string[];
	budget: string[];
	decisions: string[];
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

/**
 * Remediation for a governing change, by where the migration would be
 * recorded. Amendment registration needs an execution run, so an unbound
 * approval must not be pointed at it.
 */
export function migrationGoverningChangeHelp(
	kind: SchemaMigrationSubject["kind"],
): string {
	if (kind === "source") {
		return "Migration cannot change an obligation. This approved plan-review run has no execution binding, so 5x review implementation amend does not apply. Revise the plan and have the revision approved through a fresh plan review.";
	}
	return "Migration cannot change an obligation. Use the amendment workflow: a scoped authorize_amendment, plan re-review with an exact-hash amendmentAssessment, then 5x review implementation amend --help.";
}

export interface GoverningBookkeepingLine {
	line: number;
	text: string;
}

const BOOKKEEPING_FIELD =
	/^\s*(?:[-*]\s+)?\*\*(?:Version|Status)(?:\s*:\*\*|\*\*\s*:)/iu;
const GENERATOR_COMMENT = /^\s*<!--.*-->\s*$/u;
const REVISION_HISTORY = /^(#{1,6})\s+Revision History\s*$/iu;
const HEADING = /^(#{1,6})\s/u;

/**
 * Bookkeeping lines (Version, Status, generator comments, Revision History)
 * that a schema 1 file keeps inside the contract. Advisory output only; it
 * does not enter the proposal digest or the record.
 */
export function governingBookkeepingLines(
	targetBytes: string,
): GoverningBookkeepingLine[] {
	const loaded = loadPlanDocument(targetBytes, 1);
	if (!loaded.ok) return [];
	const found: GoverningBookkeepingLine[] = [];
	let historyLevel: number | null = null;
	for (const location of loaded.document.governingLineLocations) {
		const heading = HEADING.exec(location.text);
		if (
			heading?.[1] &&
			historyLevel !== null &&
			heading[1].length <= historyLevel
		) {
			historyLevel = null;
		}
		const history = REVISION_HISTORY.exec(location.text);
		if (history?.[1]) historyLevel = history[1].length;
		if (location.text.trim() === "") continue;
		if (
			historyLevel !== null ||
			BOOKKEEPING_FIELD.test(location.text) ||
			GENERATOR_COMMENT.test(location.text)
		) {
			found.push({ line: location.lineNumber, text: location.text });
		}
	}
	return found;
}

export function bookkeepingNotice(
	mode: PlanSchemaMigrationMode,
	lines: readonly GoverningBookkeepingLine[],
	stage: "approved" | "unapproved" = "approved",
): string | undefined {
	if (lines.length === 0) return undefined;
	if (stage === "unapproved") {
		return "These bookkeeping lines stay inside the contract. Once approved, a later edit to any of them is governing drift and needs an approved amendment. Move them outside the contract before review to avoid that.";
	}
	const notice =
		"These bookkeeping lines stay inside the contract. A later edit to any of them is governing drift and needs an approved amendment. A run records one schema migration, so this boundary cannot be revised later.";
	return mode === "equivalent"
		? `${notice} Use --mode selective to move them outside the contract.`
		: notice;
}

function withBookkeeping<T extends object>(
	view: T,
	mode: PlanSchemaMigrationMode,
	targetBytes: string,
): T & {
	governingBookkeeping: GoverningBookkeepingLine[];
	notice?: string;
} {
	const governingBookkeeping = governingBookkeepingLines(targetBytes);
	const notice = bookkeepingNotice(mode, governingBookkeeping);
	return { ...view, governingBookkeeping, ...(notice ? { notice } : {}) };
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
	// A source-run migration does not attach to an execution binding that
	// already exists. Schema 1 on this binding, and a migration recorded on
	// this run, still refuse a second migration.
	if (
		input.subject.bindingPlanSchema === 1 ||
		input.subject.migrations.length > 0
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
			`The target governing ledger does not equal the approved ledger. ${migrationGoverningChangeHelp(input.subject.kind)}`,
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
				steps: input.expectedKeys.steps,
				budget: input.expectedKeys.budget,
				decisions: input.expectedKeys.decisions,
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
			`Selective migration cannot add or edit a governing line. ${migrationGoverningChangeHelp(input.subject.kind)}`,
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

/** Full steps, budget, and decisions key lists for one migration attempt. */
export function capturePlanSchemaMigrationExpectedKeys(
	recordStore: RecordStore,
	runId: string,
): PlanSchemaMigrationExpectedKeys {
	return {
		steps: recordStore
			.listLines(runId, "steps")
			.map((line) => line.idempotencyKey),
		budget: recordStore
			.listLines(runId, "budget")
			.map((line) => line.idempotencyKey),
		decisions: recordStore
			.listLines(runId, "decisions")
			.map((line) => line.idempotencyKey),
	};
}

export async function applyPlanSchemaMigration(
	input: {
		runId: string;
		commit: string;
		mode: string;
		dryRun?: boolean;
		confirmExclusions?: string;
	},
	deps: {
		recordStore: RecordStore;
		store: ReviewBudgetStore;
		origin: RecordOrigin;
		resolveCommit: (commit: string) => Promise<string>;
		readPlanAtCommit: (commit: string) => Promise<string | null>;
		readWorktree: (kind: SchemaMigrationSubject["kind"]) => {
			bytes: string | null;
			require: boolean;
		};
	},
): Promise<PlanSchemaMigrationOutput> {
	if (input.mode !== "equivalent" && input.mode !== "selective") {
		throw new CliError(
			"INVALID_ARGS",
			"--mode must be equivalent or selective.",
		);
	}
	if (!/^[0-9a-f]{40}$/u.test(input.commit)) {
		throw new CliError("INVALID_ARGS", "--commit must be a full sha.");
	}
	if (!deps.recordStore.getRun(input.runId)) {
		throw new CliError(
			"RUN_NOT_FOUND",
			`Run ${input.runId} was not found. Use 5x plan migrate for an unapproved plan file.`,
		);
	}
	// Same order as amendment registration: snapshot the three streams, then read lineage.
	// Git reads stay after the snapshot so they cannot widen the baseline.
	const expectedKeys = capturePlanSchemaMigrationExpectedKeys(
		deps.recordStore,
		input.runId,
	);
	const resolved = await deps.resolveCommit(input.commit);
	if (resolved !== input.commit) {
		throw new CliError("INVALID_ARGS", "--commit must be a full sha.");
	}
	const subjectResult = await readSchemaMigrationSubject({
		store: deps.store,
		recordStore: deps.recordStore,
		runId: input.runId,
		readPlanAtCommit: deps.readPlanAtCommit,
	});
	if (!subjectResult.ok) {
		throw new CliError(subjectResult.code, subjectResult.message);
	}
	const targetBytes = await deps.readPlanAtCommit(input.commit);
	if (targetBytes === null) {
		throw new CliError(
			"IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE",
			`Plan bytes at ${input.commit} are unavailable. A missing worktree is not an empty file.`,
		);
	}
	const worktree = deps.readWorktree(subjectResult.subject.kind);
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
			expectedKeys,
		},
		{
			recordStore: deps.recordStore,
			store: deps.store,
			origin: deps.origin,
		},
	);
	return withBookkeeping(presentMigration(result), input.mode, targetBytes);
}

export type PlanSchemaMigrationOutput = Omit<
	PlanSchemaMigrationView,
	"migration"
> & {
	migration?: Omit<PlanSchemaMigrationPayload, "authorizedPlanBytes">;
	governingBookkeeping: GoverningBookkeepingLine[];
	notice?: string;
};

export interface PlanSchemaMigrationPreparation
	extends Omit<PlanSchemaMigrationOutput, "created" | "migration"> {
	prepare: true;
	mode: PlanSchemaMigrationMode;
	planPath: string;
	/** The working-tree plan differed from the candidate before preparation. */
	targetChanged: boolean;
	/** Full sha whose plan bytes the proof ran on. Null on a dry run. */
	commit: string | null;
	committed: boolean;
	/** A migration with this proposal is already recorded. */
	recorded: boolean;
	next: string[];
}

/**
 * Prepare the schema 1 target for a recorded migration. Equivalent mode
 * writes the mechanical wrap; selective mode takes the file the operator
 * already edited. The proof runs before anything is written, then again on
 * the committed bytes. Recording authority stays with --commit.
 */
export async function preparePlanSchemaMigration(
	input: { runId: string; mode: string; dryRun?: boolean },
	deps: {
		recordStore: RecordStore;
		store: ReviewBudgetStore;
		origin: RecordOrigin;
		planPath: string;
		readPlanAtCommit: (commit: string) => Promise<string | null>;
		readPlanFile: () => string | null;
		writePlanFile: (bytes: string) => void;
		commitPlanFile: (
			message: string,
		) => Promise<{ commit: string; committed: boolean }>;
	},
): Promise<PlanSchemaMigrationPreparation> {
	if (input.mode !== "equivalent" && input.mode !== "selective") {
		throw new CliError(
			"INVALID_ARGS",
			"--mode must be equivalent or selective.",
		);
	}
	const mode: PlanSchemaMigrationMode = input.mode;
	if (!deps.recordStore.getRun(input.runId)) {
		throw new CliError(
			"RUN_NOT_FOUND",
			`Run ${input.runId} was not found. Use 5x plan migrate for an unapproved plan file.`,
		);
	}
	const expectedKeys = capturePlanSchemaMigrationExpectedKeys(
		deps.recordStore,
		input.runId,
	);
	const subjectResult = await readSchemaMigrationSubject({
		store: deps.store,
		recordStore: deps.recordStore,
		runId: input.runId,
		readPlanAtCommit: deps.readPlanAtCommit,
	});
	if (!subjectResult.ok) {
		throw new CliError(subjectResult.code, subjectResult.message);
	}
	const subject = subjectResult.subject;
	const current = deps.readPlanFile();
	if (current === null) {
		throw new CliError(
			"PLAN_NOT_FOUND",
			`Plan file not found: ${deps.planPath}. A missing file is not an empty plan.`,
		);
	}
	const target = prepareTarget(mode, current);
	const prove = (targetBytes: string) =>
		executePlanSchemaMigration(
			{
				mode,
				dryRun: true,
				// Dry runs never build a payload, so no commit is needed yet.
				afterCommit: "",
				targetBytes,
				worktreeBytes: null,
				requireWorktreeMatch: false,
				subject,
				expectedKeys,
			},
			{
				recordStore: deps.recordStore,
				store: deps.store,
				origin: deps.origin,
			},
		);
	let proof = prove(target);
	let commit: string | null = null;
	let committed = false;
	let provedBytes = target;
	if (!input.dryRun) {
		if (target !== current) deps.writePlanFile(target);
		const result = await deps.commitPlanFile(
			`5x: prepare plan schema 1 migration (${mode}) for ${input.runId}`,
		);
		commit = result.commit;
		committed = result.committed;
		const committedBytes = await deps.readPlanAtCommit(commit);
		if (committedBytes === null) {
			throw new CliError(
				"IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE",
				`Plan bytes at ${commit} are unavailable after preparation.`,
			);
		}
		// A commit hook may rewrite the file. Prove the bytes git holds.
		if (committedBytes !== target) {
			proof = prove(committedBytes);
			provedBytes = committedBytes;
		}
	}
	const { created: _created, migration, ...view } = presentMigration(proof);
	const recordCommand = [
		"5x review migrate-schema",
		`--run ${input.runId}`,
		`--commit ${commit ?? "<sha>"}`,
		`--mode ${mode}`,
	];
	const confirm =
		mode === "selective"
			? [`--confirm-exclusions ${proof.proposalDigest}`]
			: [];
	const next = input.dryRun
		? [`5x review migrate-schema --run ${input.runId} --mode ${mode} --prepare`]
		: [
				[...recordCommand, "--dry-run"].join(" "),
				[...recordCommand, ...confirm].join(" "),
			];
	return withBookkeeping(
		{
			...view,
			dryRun: Boolean(input.dryRun),
			prepare: true as const,
			mode,
			planPath: deps.planPath,
			targetChanged: target !== current,
			commit,
			committed,
			recorded: migration !== undefined,
			next,
		},
		mode,
		provedBytes,
	);
}

function prepareTarget(mode: PlanSchemaMigrationMode, current: string): string {
	const loaded = loadPlanDocument(current, "file");
	const schema1 = loaded.ok && loaded.document.schema === 1;
	if (mode === "selective") {
		if (!schema1) {
			throw new CliError(
				loaded.ok ? "PLAN_SCHEMA_INVALID" : loaded.code,
				`${loaded.ok ? "The plan file is not schema 1." : loaded.message} Selective preparation checks a schema 1 file the operator already edited: put bookkeeping outside the contract markers first, or use --mode equivalent.`,
			);
		}
		return current;
	}
	if (equivalentWrapInterior(current) !== null) return current;
	if (schema1) {
		throw new CliError(
			"PLAN_MIGRATION_NOT_EQUIVALENT",
			"Equivalent mode wraps an unversioned plan. This file is already schema 1 and is not the mechanical contract wrap. Use --mode selective.",
		);
	}
	return wrapEquivalentPlan(current);
}

export interface MigrationRecordCheckpoint {
	committed: boolean;
	commit: string | null;
	path: string;
}

export async function migratePlanSchema(
	input: {
		runId: string;
		commit?: string;
		mode: string;
		dryRun?: boolean;
		confirmExclusions?: string;
		prepare?: boolean;
		checkpoint?: boolean;
	},
	ctx: ReviewBudgetCommandContext,
): Promise<
	| PlanSchemaMigrationPreparation
	| (PlanSchemaMigrationOutput & { checkpoint?: MigrationRecordCheckpoint })
> {
	const workdir = ctx.executionContext.effectiveWorkingDirectory;
	const planPath = ctx.executionContext.run.plan_path;
	const readPlanAtCommit = (commit: string) =>
		showPlanAtCommit(workdir, commit, planPath, {
			repoRoot: ctx.executionContext.controlPlaneRoot,
		});
	const origin = ctx.originFor({ kind: "human", role: "operator" });
	if (input.prepare) {
		if (input.commit !== undefined || input.confirmExclusions !== undefined) {
			throw new CliError(
				"INVALID_ARGS",
				"--prepare creates the target commit. Pass --commit and --confirm-exclusions when recording, not when preparing.",
			);
		}
		const effectivePlanPath = ctx.executionContext.effectivePlanPath;
		return preparePlanSchemaMigration(
			{ runId: input.runId, mode: input.mode, dryRun: input.dryRun },
			{
				recordStore: ctx.recordStore,
				store: ctx.store,
				origin,
				planPath: effectivePlanPath,
				readPlanAtCommit,
				readPlanFile: () =>
					existsSync(effectivePlanPath)
						? readFileSync(effectivePlanPath, "utf8")
						: null,
				writePlanFile: (bytes) => writeFileSync(effectivePlanPath, bytes),
				commitPlanFile: (message) =>
					commitOnly(workdir, effectivePlanPath, message, {
						code: "PLAN_MIGRATION_COMMIT_FAILED",
						failure:
							"The prepared plan is written but not committed. Fix the failure, then repeat --prepare.",
					}).then(async (result) => ({
						committed: result.committed,
						commit: result.commit ?? (await headCommit(workdir)),
					})),
			},
		);
	}
	if (input.commit === undefined) {
		throw new CliError(
			"INVALID_ARGS",
			"--commit is required to record a migration. Use --prepare to create the schema 1 target commit.",
		);
	}
	const git = workdirCodeDiffGit(workdir);
	const result = await applyPlanSchemaMigration(
		{
			runId: input.runId,
			commit: input.commit,
			mode: input.mode,
			dryRun: input.dryRun,
			confirmExclusions: input.confirmExclusions,
		},
		{
			recordStore: ctx.recordStore,
			store: ctx.store,
			origin,
			resolveCommit: (commit) => resolveCodeCommit(git, commit),
			readPlanAtCommit,
			readWorktree: (kind) => worktreeMatch(ctx, kind),
		},
	);
	if (input.dryRun || input.checkpoint === false || !result.migration) {
		return result;
	}
	return {
		...result,
		checkpoint: await checkpointMigrationRecords(ctx, input.runId),
	};
}

/**
 * Commit this run's records after a recorded migration. Scoped to the run's
 * records path, so it works on a completed run without reopening it or
 * admitting any other change. An identical retry re-attempts the checkpoint.
 */
async function checkpointMigrationRecords(
	ctx: ReviewBudgetCommandContext,
	runId: string,
): Promise<MigrationRecordCheckpoint> {
	const slug = planSlugFromPath(ctx.executionContext.run.plan_path);
	const path = posix.join(ctx.recordsRelPath, slug, runId);
	if (!existsSync(join(ctx.recordsAbsPath, slug, runId))) {
		return { committed: false, commit: null, path };
	}
	const result = await commitOnly(
		ctx.executionContext.effectiveWorkingDirectory,
		path,
		`5x: record plan schema migration for ${runId}`,
		{
			code: "PLAN_MIGRATION_CHECKPOINT_FAILED",
			failure: `The migration is recorded but ${path} is not committed. Fix the failure, then repeat the same command: the identical retry returns the stored record and retries the checkpoint. Pass --no-checkpoint to commit the records yourself.`,
		},
	);
	return { ...result, path };
}

/** Stage one path and commit only it. A path with no change is a no-op. */
async function commitOnly(
	workdir: string,
	path: string,
	message: string,
	onError: { code: string; failure: string },
): Promise<{ committed: boolean; commit: string | null }> {
	const fail = (detail: { stdout: string; stderr: string }) =>
		new CliError(
			onError.code,
			`${onError.failure} ${(detail.stderr || detail.stdout).trim()}`.trim(),
		);
	const staged = await subprocess.execGit(["add", "--", path], workdir);
	if (staged.exitCode !== 0) throw fail(staged);
	const pending = await subprocess.execGit(
		["diff", "--cached", "--name-only", "-z", "--", path],
		workdir,
	);
	if (pending.exitCode !== 0) throw fail(pending);
	if (pending.stdout.split("\0").filter(Boolean).length === 0) {
		return { committed: false, commit: null };
	}
	const commit = await subprocess.execGit(
		["commit", "--only", "-m", message, "--", path],
		workdir,
	);
	if (commit.exitCode !== 0) throw fail(commit);
	return { committed: true, commit: await headCommit(workdir) };
}

async function headCommit(workdir: string): Promise<string> {
	const head = await subprocess.execGit(["rev-parse", "HEAD"], workdir);
	if (head.exitCode !== 0) {
		throw new CliError(
			"PLAN_MIGRATION_COMMIT_FAILED",
			`git rev-parse HEAD failed: ${(head.stderr || head.stdout).trim()}`,
		);
	}
	return head.stdout.trim();
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
