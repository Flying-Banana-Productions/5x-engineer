/**
 * Approved execution binding for implementation runs.
 *
 * Copies plan-review lineage into the execution run's budget stream. It does
 * not capture a baseline or rescore the plan. Phase 5 appends text-amendment
 * lines; this module replays that chain and otherwise treats it as empty.
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { createReviewBudgetId } from "../control-plane/ids.js";
import type { RecordStore } from "../control-plane/record-store.js";
import {
	type RecordOrigin,
	RecordStoreError,
	recordedEnvelope,
	type StepRecordPayload,
	stepIdempotencyKey,
} from "../control-plane/record-types.js";
import type {
	ReviewBudgetSnapshotRecord,
	ReviewBudgetStore,
} from "../control-plane/review-budget-store.js";
import { gitShowFile, gitShowFileBytes } from "../git.js";
import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import { planSlugFromPath, relativePathUnder } from "../paths.js";
import {
	authoritativePlan,
	readAuthoritativeBudget,
	readAuthoritativePlan,
} from "../plan-schema/authority.js";
import {
	diagnosePlanExecutability,
	type PlanExecutabilityDiagnostic,
	verifyRecordedChecklistRepair,
} from "../plan-schema/checklist-repair.js";
import {
	type ExpectedPlanSchema,
	loadPlanDocument,
	type PlanSchema,
} from "../plan-schema/document.js";
import type { ReviewerVerdict, VerdictItem } from "../protocol.js";
import { deriveBudget } from "../review-budget/arithmetic.js";
import { executabilityRepairCommands } from "../review-budget/plan-repair.js";
import {
	type BindingApprovalFinalization,
	encodeImplementationBindingPayload,
	encodePlanApprovalFinalizationPayload,
	encodePlanChecklistRepairPayload,
	IMPLEMENTATION_STATE_VERSION,
	type ImplementationBindingPayload,
	type ImplementationCompatibilityPayload,
	type ImplementationCompatibilityReason,
	type ImplementationCorrectionAttemptPayload,
	type ImplementationCreditReconciliationPayload,
	type ImplementationDebtTarget,
	type ImplementationLineagePayload,
	type ImplementationPhaseMapping,
	type ImplementationPlanAmendmentPayload,
	type ImplementationReviewContextPayload,
	type ImplementationReviewObservationPayload,
	type ImplementationTextAmendmentPayload,
	implementationBindingKey,
	type PlanApprovalFinalizationPayload,
	type PlanApprovalStepRef,
	type PlanChecklistRepairPayload,
	type PlanSchemaMigrationPayload,
	planApprovalFinalizationKey,
	planChecklistRepairKey,
} from "../review-budget/record-lines.js";
import type {
	DebtClaimEvidence,
	ParsedDeliveryBudget,
	ReviewBudgetMode,
	ReviewBudgetThresholds,
} from "../review-budget/types.js";
import {
	assertCleanCodeWorktree,
	assertNoInterveningCode,
	buildCodeDiff,
	type CodeDiffContext,
	CodeDiffError,
	type CodeDiffGit,
	changedCodePaths,
	commitParents,
	isCodeAncestor,
	readHeadCommit,
	resolveCodeCommit,
	workdirCodeDiffGit,
} from "./code-diff.js";
import {
	foldGoverningReviewState,
	type GoverningReviewState,
	listGovernanceDecisions,
	type ReviewDecisionPayload,
	validateReviewDecision,
} from "./decisions.js";
import type { EffectiveExecution } from "./implementation-amendment.js";
import {
	evaluateSupersedingLedger,
	normalizeCheckboxMarkers,
	rebaseTextAmendmentGuard,
	type TextAmendmentGuard,
	verifyGuardedPlanBytes,
	worktreeMatchesCommit,
} from "./plan-amendment.js";
import {
	describeFinalLedgerChanges,
	type FinalCorrectionBudget,
	legacyReReviewNext,
	reconcileFinalApprovalLedger,
	sameRunFinalizationNext,
} from "./plan-approval-finalization.js";
import { routeAfterDecision } from "./routing.js";
import { createReviewGovernanceStore } from "./store.js";
import type { PlanReviewRoute, ReviewDecisionRoute } from "./types.js";

const IMPLEMENTATION_AUTHOR_TEMPLATES = new Set([
	"author-next-phase",
	"author-process-impl-review",
]);

export function isImplementationAuthorTemplate(templateName: string): boolean {
	const base = templateName.replace(/-continued$/, "");
	return IMPLEMENTATION_AUTHOR_TEMPLATES.has(base);
}

export function isImplementationAuthorAdmission(
	stepName: string,
	phase: string | null | undefined,
): boolean {
	if (!stepName.startsWith("author:")) return false;
	if (!phase || phase === "plan") return false;
	return /^\d+(?:\.\d+)?$/.test(phase) || /^phase-\d+(?:\.\d+)?$/i.test(phase);
}

export function hashPlanBytes(bytes: string): string {
	return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function hashJson(value: unknown): string {
	return hashPlanBytes(stableStringify(value));
}

/** Ignore checkbox toggles, including ordered-list markers. */
export function normalizeCheckboxState(markdown: string): string {
	return normalizeCheckboxMarkers(markdown);
}

/**
 * Repo-relative plan path for `git show`. Canonical plan paths are relativized
 * against the control-plane root. A path that escapes that root is unavailable;
 * worktree-absolute paths are not rewritten into `../` git specs.
 */
export function planRepoPath(
	planPath: string,
	repoRoot: string,
): string | null {
	if (isAbsolute(planPath)) {
		const rel = relativePathUnder(planPath, repoRoot);
		if (!rel) return null;
		const normalized = rel.replace(/\\/g, "/");
		if (normalized === "" || normalized.split("/").includes("..")) return null;
		return normalized;
	}
	const normalized = planPath.replace(/\\/g, "/").replace(/^\.\//, "");
	if (
		normalized === "" ||
		normalized.startsWith("../") ||
		normalized.split("/").includes("..")
	) {
		return null;
	}
	return normalized;
}

export function planPathsIdentifySamePlan(
	left: string,
	right: string,
): boolean {
	const norm = (value: string) =>
		value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	const a = norm(left);
	const b = norm(right);
	if (a === b) return true;
	const baseA = a.slice(a.lastIndexOf("/") + 1);
	const baseB = b.slice(b.lastIndexOf("/") + 1);
	if (baseA !== baseB) return false;
	return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Map a debt target onto one parsed numeric phase id. */
export function mapDebtTargetToPhaseId(
	label: string,
	phaseIds: readonly string[],
):
	| { ok: true; phaseId: string }
	| { ok: false; reason: "unmatched" | "ambiguous" } {
	const trimmed = label.trim();
	const prefixed = trimmed.match(/^phase[\s-]+(\d+(?:\.\d+)?)$/i);
	const phaseId =
		prefixed?.[1] ?? (/^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : null);
	if (!phaseId) return { ok: false, reason: "unmatched" };
	const matches = phaseIds.filter((id) => id === phaseId);
	if (matches.length === 1) return { ok: true, phaseId };
	if (matches.length === 0) return { ok: false, reason: "unmatched" };
	return { ok: false, reason: "ambiguous" };
}

export interface PlanDriftResult {
	drifted: boolean;
	chainValid: boolean;
	authorizedBytes: string;
	reason?: string;
}

/**
 * A lineage record written by schema migration. Replay switches authorized
 * bytes to schema 1 only when the target is valid schema 1. An invalid
 * record does not install the migration target.
 */
export interface ReplayablePlanSchemaMigration {
	kind: "plan-schema-migration";
	version: 1;
	id: string;
	fromSchema: 0;
	toSchema: 1;
	parentLineageId: string | null;
	beforeBlobHash: string;
	afterBlobHash: string;
	authorizedPlanBytes: string;
	governingHash: string;
}

export type ReplayableLineageRecord =
	| ImplementationPlanAmendmentPayload
	| ReplayablePlanSchemaMigration
	| PlanChecklistRepairPayload;

const SCHEMA0_DRIFT_REASON =
	"Plan bytes differ from the approved text and its verified amendment lineage, ignoring checkbox state.";
const SCHEMA0_CHAIN_REASON =
	"Plan bytes differ from the approved text. The amendment chain is unverified or malformed and does not authorize drift.";

const PLAN_AMENDMENT_HELP =
	"5x review implementation amend after a scoped authorize_amendment and an exact-hash amendmentAssessment. Rationale prose is not scope. 5x review implementation bind does not repair drift. Older CLIs must not execute an amended run.";

export const PLAN_DRIFT_RECOVERY_HELP = `${PLAN_AMENDMENT_HELP} Legacy schema 0 behavior remains supported. 5x review migrate-schema --help and the 5x-plan-migration skill can record a schema transition.`;

export const PLAN_SCHEMA1_DRIFT_RECOVERY_HELP = `Governing schema 1 edits need an approved amendment: ${PLAN_AMENDMENT_HELP} Missing schema 1 markers are malformed input, not a legacy fallback. See 5x review migrate-schema --help and the 5x-plan-migration skill. Schema 1 runs and migrated runs need a CLI that records \`planSchema\`.`;

export function planDriftRecoveryHelp(
	recordedSchema: 0 | 1,
	_reason?: string,
): string {
	if (recordedSchema === 0) return PLAN_DRIFT_RECOVERY_HELP;
	return PLAN_SCHEMA1_DRIFT_RECOVERY_HELP;
}

export function detectPlanDrift(input: {
	approvedPlanBytes: string;
	approvedPlanHash: string;
	amendments: readonly ReplayableLineageRecord[];
	currentPlanBytes: string;
	recordedSchema: 0 | 1;
	governingHash?: string;
	/** Bytes `governingHash` was recorded for, when lineage has since moved on. */
	governingAnchorBytes?: string;
}): PlanDriftResult {
	const chain = replayTextAmendments(input);
	const authorizedBytes = chain.chainValid
		? chain.authorizedBytes
		: input.approvedPlanBytes;
	if (input.recordedSchema === 0) {
		const drifted =
			normalizeCheckboxState(input.currentPlanBytes) !==
			normalizeCheckboxState(authorizedBytes);
		if (!drifted) {
			return { drifted: false, chainValid: chain.chainValid, authorizedBytes };
		}
		return {
			drifted: true,
			chainValid: chain.chainValid,
			authorizedBytes,
			reason: chain.chainValid ? SCHEMA0_DRIFT_REASON : SCHEMA0_CHAIN_REASON,
		};
	}
	const governingHash =
		input.governingHash ??
		(chain.chainValid ? chain.migrationGoverningHash : undefined);
	const approved = loadPlanDocument(
		input.governingAnchorBytes ?? input.approvedPlanBytes,
		1,
	);
	if (approved.ok) {
		if (
			!governingHash ||
			governingHash !== hashPlanBytes(approved.document.comparisonBytes)
		) {
			return {
				drifted: true,
				chainValid: chain.chainValid,
				authorizedBytes,
				reason:
					"Recorded governingHash does not match the approved document comparison hash. This is not a legacy fallback.",
			};
		}
	} else if (!(chain.chainValid && chain.schema === 1)) {
		return {
			drifted: true,
			chainValid: chain.chainValid,
			authorizedBytes,
			reason: schemaDriftReason(approved),
		};
	} else if (
		!governingHash ||
		!chain.migrationGoverningHash ||
		governingHash !== chain.migrationGoverningHash
	) {
		return {
			drifted: true,
			chainValid: chain.chainValid,
			authorizedBytes,
			reason:
				"Recorded governingHash does not match the migrated document comparison hash. This is not a legacy fallback.",
		};
	}
	const current = loadPlanDocument(input.currentPlanBytes, 1);
	if (!current.ok) {
		return {
			drifted: true,
			chainValid: chain.chainValid,
			authorizedBytes,
			reason: schemaDriftReason(current),
		};
	}
	const authorized = loadPlanDocument(authorizedBytes, 1);
	if (!authorized.ok) {
		return {
			drifted: true,
			chainValid: chain.chainValid,
			authorizedBytes,
			reason: schemaDriftReason(authorized),
		};
	}
	const drifted =
		current.document.comparisonBytes !== authorized.document.comparisonBytes;
	if (!drifted) {
		return { drifted: false, chainValid: chain.chainValid, authorizedBytes };
	}
	return {
		drifted: true,
		chainValid: chain.chainValid,
		authorizedBytes,
		reason: chain.chainValid
			? "Governing plan bytes differ from the approved projection and its verified amendment lineage. This is not a legacy fallback."
			: "Governing plan bytes differ from the approved projection. The amendment chain is unverified or malformed and does not authorize drift. This is not a legacy fallback.",
	};
}

function schemaDriftReason(
	loaded: Extract<ReturnType<typeof loadPlanDocument>, { ok: false }>,
): string {
	const base = loaded.message.includes("not a legacy fallback")
		? `${loaded.code}: ${loaded.message}`
		: `${loaded.code}: ${loaded.message} This is not a legacy fallback.`;
	if (
		base.includes("5x review migrate-schema --help") &&
		base.includes("5x-plan-migration")
	) {
		return base;
	}
	return `${base} See 5x review migrate-schema --help and the 5x-plan-migration skill.`;
}

interface ReplayResult {
	chainValid: boolean;
	authorizedBytes: string;
	authorizedHash: string;
	schema: PlanSchema;
	migrationGoverningHash?: string;
}

function replayTextAmendments(input: {
	approvedPlanBytes: string;
	approvedPlanHash: string;
	amendments: readonly ReplayableLineageRecord[];
}): ReplayResult {
	const invalid = (): ReplayResult => ({
		chainValid: false,
		authorizedBytes: input.approvedPlanBytes,
		authorizedHash: input.approvedPlanHash,
		schema: 0,
	});
	if (hashPlanBytes(input.approvedPlanBytes) !== input.approvedPlanHash) {
		return invalid();
	}
	let authorizedBytes = input.approvedPlanBytes;
	let authorizedHash = input.approvedPlanHash;
	let parent: string | null = null;
	let schema: PlanSchema = 0;
	let migrationGoverningHash: string | undefined;
	let sawMigration = false;
	for (const amendment of input.amendments) {
		if (amendment.kind === "plan-schema-migration") {
			if (sawMigration) return invalid();
			const afterHash = hashPlanBytes(amendment.authorizedPlanBytes);
			const target = loadPlanDocument(amendment.authorizedPlanBytes, 1);
			const valid =
				amendment.version === 1 &&
				amendment.fromSchema === 0 &&
				amendment.toSchema === 1 &&
				amendment.parentLineageId === parent &&
				amendment.beforeBlobHash === authorizedHash &&
				amendment.afterBlobHash === afterHash &&
				target.ok &&
				hashPlanBytes(target.document.comparisonBytes) ===
					amendment.governingHash;
			if (!valid) return invalid();
			authorizedBytes = amendment.authorizedPlanBytes;
			authorizedHash = afterHash;
			parent = amendment.id;
			schema = 1;
			migrationGoverningHash = amendment.governingHash;
			sawMigration = true;
			continue;
		}
		if (amendment.kind === "plan-checklist-repair") {
			const afterHash = hashPlanBytes(amendment.authorizedPlanBytes);
			const valid =
				amendment.version === 1 &&
				amendment.parentLineageId === parent &&
				amendment.beforeBlobHash === authorizedHash &&
				amendment.afterBlobHash === afterHash &&
				(!sawMigration || amendment.planSchema === 1) &&
				verifyRecordedChecklistRepair({
					beforeBytes: authorizedBytes,
					afterBytes: amendment.authorizedPlanBytes,
					schema: amendment.planSchema,
					edits: amendment.edits,
				}).ok;
			if (!valid) return invalid();
			authorizedBytes = amendment.authorizedPlanBytes;
			authorizedHash = afterHash;
			parent = amendment.id;
			continue;
		}
		const afterHash = hashPlanBytes(amendment.authorizedPlanBytes);
		const valid =
			amendment.version === IMPLEMENTATION_STATE_VERSION &&
			amendment.parentLineageId === parent &&
			amendment.beforeBlobHash === authorizedHash &&
			amendment.afterBlobHash === afterHash &&
			amendment.beforeCommit.length > 0 &&
			amendment.afterCommit.length > 0;
		if (!valid) return invalid();
		authorizedBytes = amendment.authorizedPlanBytes;
		authorizedHash = afterHash;
		parent = amendment.id;
	}
	return {
		chainValid: true,
		authorizedBytes,
		authorizedHash,
		schema,
		...(migrationGoverningHash ? { migrationGoverningHash } : {}),
	};
}

/** Binding schema wins. Otherwise a valid replayed migration selects schema 1. */
export function resolveRecordedPlanSchema(input: {
	planSchema?: 0 | 1;
	approvedPlanBytes: string;
	approvedPlanHash: string;
	amendments: readonly ReplayableLineageRecord[];
}): 0 | 1 {
	if (input.planSchema === 0 || input.planSchema === 1) return input.planSchema;
	const chain = replayTextAmendments(input);
	return chain.chainValid && chain.schema === 1 ? 1 : 0;
}

export function recordedPlanSchemaFromBinding(
	binding: ImplementationBindingPayload,
	amendments: readonly ReplayableLineageRecord[],
): { recordedSchema: 0 | 1; governingHash?: string } {
	const recordedSchema = resolveRecordedPlanSchema({
		planSchema: binding.planSchema,
		approvedPlanBytes: binding.approvedPlanBytes,
		approvedPlanHash: binding.approvedPlanHash,
		amendments,
	});
	const chain = replayTextAmendments({
		approvedPlanBytes: binding.approvedPlanBytes,
		approvedPlanHash: binding.approvedPlanHash,
		amendments,
	});
	const governingHash =
		binding.governingHash ??
		(chain.chainValid ? chain.migrationGoverningHash : undefined);
	return {
		recordedSchema,
		...(governingHash ? { governingHash } : {}),
	};
}

/**
 * Drift inputs from the fold. The governing hash stays checked against the
 * bytes it was recorded for; later lineage only moves the authorized anchor.
 */
export function effectivePlanSchema(folded: EffectiveExecution): {
	recordedSchema: 0 | 1;
	governingHash?: string;
	governingAnchorBytes?: string;
} {
	return {
		recordedSchema: folded.planSchema,
		...(folded.governingHash === undefined
			? {}
			: { governingHash: folded.governingHash }),
		...(folded.governingAnchorBytes === undefined
			? {}
			: { governingAnchorBytes: folded.governingAnchorBytes }),
	};
}

/** No binding means file mode. A binding uses its recorded schema. */
export function expectedSchemaForStore(
	store: ReviewBudgetStore,
	runId: string,
): ExpectedPlanSchema {
	const binding = readImplementationBinding(store, runId);
	if (!binding) return "file";
	const folded = store.readEffectiveImplementationRevision(runId);
	if (folded?.ok) return folded.planSchema;
	const amendments = store.listImplementationTextAmendments(runId, binding.id);
	return resolveRecordedPlanSchema({
		planSchema: binding.planSchema,
		approvedPlanBytes: binding.approvedPlanBytes,
		approvedPlanHash: binding.approvedPlanHash,
		amendments,
	});
}

/** Binding decode and store failures stay typed. Absence is not an error. */
export function describeBindingReadError(error: unknown): {
	code: string;
	message: string;
} {
	if (error instanceof RecordStoreError) {
		return { code: error.code, message: error.message };
	}
	return {
		code: "IMPLEMENTATION_BINDING_UNREADABLE",
		message:
			error instanceof Error
				? error.message
				: "Implementation binding could not be read",
	};
}

export type ImplementationAdmissionResult =
	| { status: "not_applicable" }
	| {
			status: "v1";
			disposition: ImplementationCompatibilityPayload;
			created: boolean;
	  }
	| {
			status: "bound";
			binding: ImplementationBindingPayload;
			created: boolean;
	  }
	| {
			status: "approval_required";
			code: "IMPLEMENTATION_APPROVAL_REQUIRED";
			message: string;
			detail: {
				candidateRunIds: string[];
				rejectedSources: RejectedApprovalSource[];
				remediation: string;
			};
	  }
	| { status: "error"; code: string; message: string; detail?: unknown };

/** A same-plan run that auto-selection considered and refused, with why. */
export interface RejectedApprovalSource {
	runId: string;
	reason: string;
}

export async function showPlanAtCommit(
	workdir: string,
	commit: string,
	planPath: string,
	options?: { repoRoot?: string },
): Promise<string | null> {
	const repoPath = planRepoPath(planPath, options?.repoRoot ?? workdir);
	if (!repoPath) return null;
	try {
		return await gitShowFile(workdir, commit, repoPath, {
			strict: true,
			exact: true,
		});
	} catch {
		return null;
	}
}

/** Raw `git show` bytes. Invalid UTF-8 is preserved for the amendment guard. */
export async function showPlanBlobAtCommit(
	workdir: string,
	commit: string,
	planPath: string,
	options?: { repoRoot?: string },
): Promise<Buffer | null> {
	const repoPath = planRepoPath(planPath, options?.repoRoot ?? workdir);
	if (!repoPath) return null;
	try {
		return await gitShowFileBytes(workdir, commit, repoPath);
	} catch {
		return null;
	}
}

function now(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function readBinding(
	store: ReviewBudgetStore,
	runId: string,
):
	| { status: "missing" }
	| { status: "ok"; binding: ImplementationBindingPayload }
	| { status: "error"; code: string; message: string } {
	try {
		const binding = store.getImplementationBinding(runId);
		if (!binding) return { status: "missing" };
		if (!bindingHashesMatch(binding)) {
			return {
				status: "error",
				code: "IMPLEMENTATION_BINDING_UNREADABLE",
				message: `Implementation binding ${binding.id} failed lineage hash verification`,
			};
		}
		validateCopiedDecisions(binding.effectiveDecisions);
		return { status: "ok", binding };
	} catch (error) {
		if (isMissingRun(error)) return { status: "missing" };
		return {
			status: "error",
			code: "IMPLEMENTATION_BINDING_UNREADABLE",
			message:
				error instanceof Error
					? error.message
					: "Implementation binding could not be read",
		};
	}
}

function isMissingRun(error: unknown): boolean {
	return error instanceof RecordStoreError && error.code === "RUN_NOT_FOUND";
}

/** Null when the run has no binding, including legacy runs absent from the record store. */
export function readImplementationBinding(
	store: ReviewBudgetStore,
	runId: string,
): ImplementationBindingPayload | null {
	try {
		return store.getImplementationBinding(runId);
	} catch (error) {
		if (isMissingRun(error)) return null;
		throw error;
	}
}

function bindingHashesMatch(binding: ImplementationBindingPayload): boolean {
	return (
		binding.approvedPlanHash === hashPlanBytes(binding.approvedPlanBytes) &&
		binding.ledgerHash === hashJson(binding.ledger) &&
		binding.decisionsHash === hashJson(binding.effectiveDecisions)
	);
}

function validateCopiedDecisions(value: unknown[]): ReviewDecisionPayload[] {
	return value.map((entry) =>
		validateReviewDecision(entry as ReviewDecisionPayload),
	);
}

function loadAmendments(
	store: ReviewBudgetStore,
	runId: string,
	bindingId: string,
): { ok: true; amendments: ImplementationLineagePayload[] } | { ok: false } {
	try {
		return {
			ok: true,
			amendments: store.listImplementationTextAmendments(runId, bindingId),
		};
	} catch {
		return { ok: false };
	}
}

function remediation(
	executionRunId: string,
	candidateRunIds: readonly string[],
	rejected: readonly RejectedApprovalSource[] = [],
): string {
	if (candidateRunIds.length === 0) {
		const reasons = rejected
			.map((entry) => ` ${entry.runId}: ${entry.reason.replace(/\.$/, "")}.`)
			.join("");
		return `No approved plan-review source matches this plan.${reasons ? ` Rejected:${reasons}` : ""} Select one explicitly with \`5x review implementation bind --run ${executionRunId} --source-run <plan-review>\`.`;
	}
	return `Multiple approved plan-review sources match this plan (${candidateRunIds.join(", ")}). Select one explicitly with \`5x review implementation bind --run ${executionRunId} --source-run <plan-review>\`.`;
}

export async function ensureImplementationAdmission(input: {
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	executionRunId: string;
	planPath: string;
	planMarkdown: string | null;
	configuredMode: ReviewBudgetMode;
	origin: RecordOrigin;
	explicitSourceRunId?: string;
	workdir?: string;
	/** Control-plane root used to relativize the canonical plan path. */
	controlPlaneRoot?: string;
	readPlanAtCommit?: (commit: string) => Promise<string | null>;
}): Promise<ImplementationAdmissionResult> {
	const existing = readBinding(input.store, input.executionRunId);
	if (existing.status === "error") return existing;
	if (existing.status === "ok") {
		return admitExistingBinding(input, existing.binding);
	}

	let compatibility: ImplementationCompatibilityPayload | null = null;
	try {
		compatibility = input.store.getImplementationCompatibility(
			input.executionRunId,
		);
	} catch (error) {
		if (!isMissingRun(error)) {
			return {
				status: "error",
				code: "IMPLEMENTATION_BINDING_UNREADABLE",
				message:
					error instanceof Error
						? error.message
						: "Implementation compatibility disposition could not be read",
			};
		}
	}
	if (compatibility && input.explicitSourceRunId === undefined) {
		return { status: "v1", disposition: compatibility, created: false };
	}

	if (input.planMarkdown === null) {
		return input.explicitSourceRunId
			? {
					status: "error",
					code: "PLAN_NOT_FOUND",
					message: "The execution plan could not be read",
				}
			: { status: "not_applicable" };
	}

	const budgetRead = readAuthoritativeBudget(input.planMarkdown, "file");
	if (!budgetRead.ok) {
		return {
			status: "error",
			code: budgetRead.code,
			message: budgetRead.message.includes("not a legacy fallback")
				? budgetRead.message
				: `${budgetRead.message} This is not a legacy fallback.`,
		};
	}
	const parsed = budgetRead.parsed;
	if (!parsed.ok && parsed.code !== "BUDGET_SECTION_MISSING") {
		return {
			status: "error",
			code: "IMPLEMENTATION_PLAN_INVALID",
			message: parsed.message,
		};
	}
	const hasBudget = parsed.ok;
	if (
		!input.explicitSourceRunId &&
		(!hasBudget || input.configuredMode === "off")
	) {
		const reason: ImplementationCompatibilityReason = hasBudget
			? "mode_off"
			: "no_budget";
		return persistCompatibility(input, reason);
	}

	const readAtCommit =
		input.readPlanAtCommit ??
		(input.workdir
			? (commit: string) =>
					showPlanAtCommit(input.workdir as string, commit, input.planPath, {
						...(input.controlPlaneRoot
							? { repoRoot: input.controlPlaneRoot }
							: {}),
					})
			: undefined);
	if (!readAtCommit) {
		return {
			status: "error",
			code: "IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE",
			message: "Approved plan bytes could not be read for this execution",
		};
	}

	if (input.explicitSourceRunId) {
		return bindImplementationExecution({
			...input,
			sourceRunId: input.explicitSourceRunId,
			planMarkdown: input.planMarkdown,
			readPlanAtCommit: readAtCommit,
		});
	}

	const candidates = approvedCandidates(input);
	if (candidates.status === "error") return candidates;
	if (candidates.runIds.length !== 1) {
		const message = remediation(
			input.executionRunId,
			candidates.runIds,
			candidates.rejected,
		);
		return {
			status: "approval_required",
			code: "IMPLEMENTATION_APPROVAL_REQUIRED",
			message,
			detail: {
				candidateRunIds: candidates.runIds,
				rejectedSources: candidates.rejected,
				remediation: message,
			},
		};
	}
	const sourceRunId = candidates.runIds[0];
	if (!sourceRunId) {
		const message = remediation(input.executionRunId, [], candidates.rejected);
		return {
			status: "approval_required",
			code: "IMPLEMENTATION_APPROVAL_REQUIRED",
			message,
			detail: {
				candidateRunIds: [],
				rejectedSources: candidates.rejected,
				remediation: message,
			},
		};
	}
	return bindImplementationExecution({
		...input,
		sourceRunId,
		planMarkdown: input.planMarkdown,
		readPlanAtCommit: readAtCommit,
	});
}

function persistCompatibility(
	input: {
		store: ReviewBudgetStore;
		executionRunId: string;
		configuredMode: ReviewBudgetMode;
		origin: RecordOrigin;
	},
	reason: ImplementationCompatibilityReason,
): ImplementationAdmissionResult {
	if (!input.store.getImplementationCompatibility) {
		return { status: "not_applicable" };
	}
	const payload: ImplementationCompatibilityPayload = {
		kind: "implementation-compatibility",
		version: IMPLEMENTATION_STATE_VERSION,
		id: createReviewBudgetId(),
		executionRunId: input.executionRunId,
		reason,
		observedMode: input.configuredMode,
		createdAt: now(),
	};
	try {
		const saved = input.store.saveImplementationCompatibility(
			payload,
			input.origin,
		);
		return { status: "v1", disposition: saved.payload, created: saved.created };
	} catch (error) {
		if (!isMissingRun(error)) throw error;
		// SQLite-only legacy runs have no records directory. A no-budget or
		// mode-off admission stays v1 without inventing a record home.
		return { status: "v1", disposition: payload, created: false };
	}
}

async function admitExistingBinding(
	input: {
		store: ReviewBudgetStore;
		executionRunId: string;
		planMarkdown: string | null;
		explicitSourceRunId?: string;
	},
	binding: ImplementationBindingPayload,
): Promise<ImplementationAdmissionResult> {
	if (
		input.explicitSourceRunId !== undefined &&
		input.explicitSourceRunId !== binding.sourceRunId
	) {
		return {
			status: "error",
			code: "IMPLEMENTATION_BINDING_CONFLICT",
			message: `Run ${input.executionRunId} is already bound to source ${binding.sourceRunId}. \`5x review implementation bind\` attaches that initial source and cannot replace it. A semantic change requires structured amendmentScope on authorize_amendment, an amendmentAssessment of the exact plan hash, then \`5x review implementation amend\`. Rationale prose is not scope. Registration does not approve implementation completion. Older CLIs must not execute an amended run.`,
			detail: {
				bindingId: binding.id,
				sourceRunId: binding.sourceRunId,
				requestedSourceRunId: input.explicitSourceRunId,
			},
		};
	}
	if (input.planMarkdown === null) {
		return {
			status: "error",
			code: "PLAN_NOT_FOUND",
			message:
				"The execution plan could not be read to check approved-plan drift",
		};
	}
	const folded = input.store.readEffectiveImplementationRevision(
		input.executionRunId,
	);
	if (folded && !folded.ok) {
		return {
			status: "error",
			code: "IMPLEMENTATION_PLAN_DRIFT",
			message: folded.diagnostic.message,
			detail: {
				bindingId: binding.id,
				chainValid: false,
				amendmentHelp:
					"5x review implementation amend after a scoped authorize_amendment and an exact-hash amendmentAssessment. 5x review implementation bind is only the initial source attachment. Older CLIs must not execute an amended run.",
			},
		};
	}
	const amendments = folded?.ok
		? { ok: true as const, amendments: [] }
		: loadAmendments(input.store, input.executionRunId, binding.id);
	const recorded = folded?.ok
		? effectivePlanSchema(folded)
		: recordedPlanSchemaFromBinding(
				binding,
				amendments.ok ? amendments.amendments : [],
			);
	const drift = detectPlanDrift({
		approvedPlanBytes: folded?.ok
			? folded.approvedPlanBytes
			: binding.approvedPlanBytes,
		approvedPlanHash: folded?.ok
			? folded.approvedPlanHash
			: binding.approvedPlanHash,
		amendments: amendments.ok ? amendments.amendments : [],
		currentPlanBytes: input.planMarkdown,
		...recorded,
	});
	if (!amendments.ok || drift.drifted) {
		const chainValid = amendments.ok && drift.chainValid;
		return {
			status: "error",
			code: "IMPLEMENTATION_PLAN_DRIFT",
			message: `${
				drift.reason ??
				"Plan bytes differ from the approved text. An unverified amendment chain does not authorize drift."
			}${chainValid ? ` ${checklistRepairHint(input.executionRunId)}` : ""}`,
			detail: {
				bindingId: binding.id,
				chainValid,
				amendmentHelp: planDriftRecoveryHelp(recorded.recordedSchema),
				...(chainValid
					? { repairCommand: checklistRepairCommand(input.executionRunId) }
					: {}),
			},
		};
	}
	return { status: "bound", binding, created: false };
}

function approvedCandidates(input: {
	recordStore: RecordStore;
	store: ReviewBudgetStore;
	planPath: string;
	executionRunId: string;
}):
	| { status: "ok"; runIds: string[]; rejected: RejectedApprovalSource[] }
	| { status: "error"; code: string; message: string } {
	const slug = planSlugFromPath(input.planPath);
	const runs = input.recordStore
		.listRuns({ planSlug: slug })
		.filter((run) => planPathsIdentifySamePlan(run.plan_path, input.planPath));
	const runIds: string[] = [];
	const rejected: RejectedApprovalSource[] = [];
	for (const run of runs) {
		const assessed = assessApprovedSource({
			recordStore: input.recordStore,
			store: input.store,
			sourceRunId: run.id,
			planPath: input.planPath,
		});
		if (assessed.status === "error") return assessed;
		if (assessed.approval) runIds.push(run.id);
		else if (run.id !== input.executionRunId)
			rejected.push({
				runId: run.id,
				reason: assessed.refusal ?? "Source run is not an approved plan review",
			});
	}
	runIds.sort();
	rejected.sort((a, b) => a.runId.localeCompare(b.runId));
	return { status: "ok", runIds, rejected };
}

interface ApprovalEvidence {
	sourceRunId: string;
	baselineId: string;
	snapshotId: string;
	b0: number;
	governingB: number;
	mode: Exclude<ReviewBudgetMode, "off">;
	thresholds: ReviewBudgetThresholds;
	/** Effective approved ledger: the finalization record's, else the snapshot's. */
	ledger: ParsedDeliveryBudget;
	/** The approving reviewer snapshot's ledger. Never rewritten. */
	snapshotLedger: ParsedDeliveryBudget;
	decisions: ReviewDecisionPayload[];
	approvedCommit: string;
	/** The paired finalization record consumed for this approval. */
	finalization: PlanApprovalFinalizationPayload | null;
	route: TerminalRouteDetail | null;
}

function assessApprovedSource(input: {
	recordStore: RecordStore;
	store: ReviewBudgetStore;
	sourceRunId: string;
	planPath: string;
}):
	| { status: "ok"; approval: ApprovalEvidence | null; refusal?: string }
	| { status: "error"; code: string; message: string; detail?: unknown } {
	const summary = input.recordStore.getRun(input.sourceRunId);
	if (!summary) {
		return {
			status: "ok",
			approval: null,
			refusal: `Source run ${input.sourceRunId} was not found`,
		};
	}
	if (!planPathsIdentifySamePlan(summary.plan_path, input.planPath)) {
		return {
			status: "ok",
			approval: null,
			refusal: `Source run ${input.sourceRunId} is not the canonical plan ${input.planPath}`,
		};
	}
	const baseline = input.store.getBaseline(input.sourceRunId);
	const snapshot = input.store.latestSnapshot(input.sourceRunId);
	if (!baseline || !snapshot) {
		return {
			status: "ok",
			approval: null,
			refusal: `Source run ${input.sourceRunId} has no approved plan-review baseline`,
		};
	}
	const listed = listGovernanceDecisions(input.recordStore, input.sourceRunId);
	if (listed.diagnostics.length > 0) {
		return {
			status: "error",
			code: "IMPLEMENTATION_SOURCE_INVALID",
			message: `Source run ${input.sourceRunId} has unreadable review decisions`,
			detail: { diagnostics: listed.diagnostics },
		};
	}
	const steps = input.recordStore.listLines(input.sourceRunId, "steps");
	const parsedSteps = steps.flatMap((line) => {
		const payload = stepPayload(line.payload);
		return payload ? [payload] : [];
	});
	const budget = input.recordStore.listLines(input.sourceRunId, "budget");
	const governing = foldGoverningReviewState({
		b0: baseline.b0,
		decisions: listed.decisions,
		steps,
		budget,
	});
	if (governing.aborted) {
		return {
			status: "ok",
			approval: null,
			refusal: `Source run ${input.sourceRunId} was aborted`,
		};
	}
	// Advisory sources never have an open gate; they are judged by their
	// recorded v1 route below.
	const openGate = createReviewGovernanceStore(
		input.recordStore,
	).deriveOpenGate(input.sourceRunId);
	if (openGate && !openGate.resolved) {
		return {
			status: "ok",
			approval: null,
			refusal: `Source run ${input.sourceRunId} has an open review gate`,
		};
	}
	const route = terminalRoute({
		steps: parsedSteps,
		snapshot,
		baselineB0: baseline.b0,
		thresholds: baseline.configSnapshot,
		governing,
	});
	if (!route.approvedCommit) {
		return { status: "ok", approval: null, refusal: route.refusal };
	}
	const finalized = resolveFinalizedPlanCommit(summary, parsedSteps);
	if (!finalized.commit) {
		return { status: "ok", approval: null, refusal: finalized.refusal };
	}
	const recorded = recordedFinalization({
		store: input.store,
		sourceRunId: input.sourceRunId,
		snapshot,
		decisions: governing.history,
		finalCommit: finalized.commit,
		steps: parsedSteps,
		route: route.detail ?? null,
	});
	if (recorded.status === "invalid") {
		return { status: "ok", approval: null, refusal: recorded.refusal };
	}
	const record = recorded.status === "ok" ? recorded.record : null;
	return {
		status: "ok",
		approval: {
			sourceRunId: input.sourceRunId,
			baselineId: baseline.id,
			snapshotId: snapshot.id,
			b0: baseline.b0,
			governingB: governing.governingBaseline,
			mode: baseline.mode,
			thresholds: structuredClone(baseline.configSnapshot),
			ledger: structuredClone(record ? record.ledger : snapshot.currentLedger),
			snapshotLedger: structuredClone(snapshot.currentLedger),
			decisions: structuredClone(governing.history),
			approvedCommit: finalized.commit,
			finalization: record ? structuredClone(record) : null,
			route: route.detail ? structuredClone(route.detail) : null,
		},
	};
}

/**
 * The paired finalization record for the sealed plan commit, re-proved
 * against the source's snapshot, decisions, completion step and route. A
 * source with no record is a legacy source (`none`).
 */
function recordedFinalization(input: {
	store: ReviewBudgetStore;
	sourceRunId: string;
	snapshot: ReviewBudgetSnapshotRecord;
	decisions: readonly ReviewDecisionPayload[];
	finalCommit: string;
	steps: readonly StepRecordPayload[];
	route: TerminalRouteDetail | null;
}):
	| { status: "none" }
	| { status: "ok"; record: PlanApprovalFinalizationPayload }
	| { status: "invalid"; refusal: string } {
	let records: PlanApprovalFinalizationPayload[];
	try {
		records = input.store.listPlanApprovalFinalizations(input.sourceRunId);
	} catch (error) {
		return {
			status: "invalid",
			refusal: `Source run ${input.sourceRunId} has an unreadable plan-approval finalization: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (records.length === 0) return { status: "none" };
	const record = records
		.filter((entry) => entry.finalCommit === input.finalCommit)
		.at(-1);
	const refuse = (reason: string) => ({
		status: "invalid" as const,
		refusal: `Source run ${input.sourceRunId} plan-approval finalization ${reason}. Refusing to bind an inconsistent approval.`,
	});
	if (!record) {
		return refuse(
			`does not name the sealed plan commit ${input.finalCommit}; a later HEAD is not approval`,
		);
	}
	const completion = input.steps.find(
		(step) =>
			step.step_name === "run:complete" &&
			step.iteration === record.completion.iteration &&
			commitOf(step) === record.finalCommit,
	);
	if (!completion) return refuse("is not paired with its run:complete step");
	if (
		record.sourceSnapshotId !== input.snapshot.id ||
		record.snapshotLedgerHash !== hashJson(input.snapshot.currentLedger)
	) {
		return refuse("does not name the approving reviewer snapshot");
	}
	if (record.decisionsHash !== hashJson(input.decisions)) {
		return refuse("does not match the source decisions");
	}
	if (record.ledgerHash !== hashJson(record.ledger)) {
		return refuse("ledger hash does not match its ledger");
	}
	const route = input.route;
	if (
		!route ||
		record.route !== route.route ||
		record.reviewer.stepName !== route.reviewer.stepName ||
		record.reviewer.iteration !== route.reviewer.iteration ||
		(record.authorCorrection?.commit ?? null) !==
			(route.correction?.author.commit ?? null) ||
		JSON.stringify([...record.admittedFindingIds].sort()) !==
			JSON.stringify(route.correction?.admittedFindingIds ?? []) ||
		JSON.stringify(record.correctionBudget ?? null) !==
			JSON.stringify(route.correction?.budget ?? null)
	) {
		return refuse("does not match the recorded reviewer route");
	}
	const proof = reconcileFinalApprovalLedger({
		reviewed: input.snapshot.currentLedger,
		final: record.ledger,
		admittedFindingIds: record.admittedFindingIds,
		correctionBudget: record.correctionBudget ?? null,
	});
	if (
		!proof.ok ||
		JSON.stringify(proof.addressAdditions) !==
			JSON.stringify(record.addressAdditions) ||
		JSON.stringify(proof.effortCorrections) !==
			JSON.stringify(record.effortCorrections ?? [])
	) {
		return refuse("ledger is not admitted correction bookkeeping");
	}
	return { status: "ok", record };
}

/**
 * The effective approved ledger for the source's committed plan bytes.
 *
 * A recorded finalization is consumed when the blob hash matches. A legacy
 * source without one keeps the snapshot ledger when consistent; for the
 * stale-`Addresses` case its final-corrections evidence and the same proof
 * derive the committed ledger, with provenance for the binding. Any other
 * delta returns an exact-plan re-review path; nothing is silently accepted
 * and the sealed source is never rewritten.
 */
function resolveSourceApprovalLedger(input: {
	approval: ApprovalEvidence;
	approvedBytes: string;
	planPath: string;
	executionRunId: string | null;
}):
	| {
			status: "ok";
			ledger: ParsedDeliveryBudget;
			provenance: BindingApprovalFinalization | null;
	  }
	| { status: "error"; code: string; message: string; detail?: unknown } {
	const approval = input.approval;
	const blobHash = hashPlanBytes(input.approvedBytes);
	const record = approval.finalization;
	if (record) {
		if (record.finalBlobHash !== blobHash) {
			return {
				status: "error",
				code: "IMPLEMENTATION_SOURCE_INVALID",
				message: `Plan bytes at ${approval.approvedCommit} do not match the recorded plan-approval finalization blob. Refusing to bind a drifted approval.`,
			};
		}
		return {
			status: "ok",
			ledger: structuredClone(record.ledger),
			provenance: {
				derivation: "recorded",
				finalizationId: record.id,
				sourceRunId: approval.sourceRunId,
				sourceSnapshotId: approval.snapshotId,
				finalCommit: record.finalCommit,
				finalBlobHash: record.finalBlobHash,
				snapshotLedgerHash: record.snapshotLedgerHash,
				admittedFindingIds: [...record.admittedFindingIds],
				addressAdditions: structuredClone(record.addressAdditions),
				...(record.effortCorrections
					? { effortCorrections: structuredClone(record.effortCorrections) }
					: {}),
				authorCommit: record.authorCorrection?.commit ?? null,
			},
		};
	}
	const unchanged = {
		status: "ok" as const,
		ledger: structuredClone(approval.snapshotLedger),
		provenance: null,
	};
	const read = readAuthoritativeBudget(input.approvedBytes, "file");
	// Unparseable bytes keep the legacy path; its own checks report them.
	if (!read.ok || !read.parsed.ok) return unchanged;
	if (ledgersMatch(read.parsed.value, approval.snapshotLedger)) {
		return unchanged;
	}
	const correction = approval.route?.correction ?? null;
	const proof = reconcileFinalApprovalLedger({
		reviewed: approval.snapshotLedger,
		final: read.parsed.value,
		admittedFindingIds: correction?.admittedFindingIds ?? [],
	});
	if (correction && proof.ok) {
		return {
			status: "ok",
			ledger: proof.ledger,
			provenance: {
				derivation: "legacy_stale_addresses",
				sourceRunId: approval.sourceRunId,
				sourceSnapshotId: approval.snapshotId,
				finalCommit: approval.approvedCommit,
				finalBlobHash: blobHash,
				snapshotLedgerHash: hashJson(approval.snapshotLedger),
				admittedFindingIds: [...correction.admittedFindingIds],
				addressAdditions: proof.addressAdditions,
				authorCommit: correction.author.commit,
			},
		};
	}
	const changes = proof.ok ? [] : proof.changes;
	const next = legacyReReviewNext({
		planPath: input.planPath,
		executionRunId: input.executionRunId ?? "<execution-run>",
	});
	return {
		status: "error",
		code: "IMPLEMENTATION_SOURCE_INVALID",
		message: `Approved plan bytes do not match the source review ledger. Refusing to bind a drifted approval. ${
			changes.length > 0
				? `${describeFinalLedgerChanges(changes)} `
				: "The recorded route admitted no final corrections. "
		}The sealed source ${approval.sourceRunId} is not reopened; re-review the exact committed plan in a new plan-review run and bind from it (${next.join("; ")}).`,
		detail: {
			sourceRunId: approval.sourceRunId,
			approvedCommit: approval.approvedCommit,
			changes,
			next,
		},
	};
}

/**
 * Approved plan bytes are the source run's sealed plan commit, which includes
 * the workflow status update recorded before `run:complete`. Terminal approval
 * is validated separately. A later git HEAD is not an approval anchor.
 */
function resolveFinalizedPlanCommit(
	summary: { status: string; final_head_commit: string | null },
	steps: readonly StepRecordPayload[],
): { commit: string | null; refusal: string } {
	if (summary.status !== "completed" || !summary.final_head_commit) {
		return {
			commit: null,
			refusal:
				"Source plan review has no finalized plan commit. Terminal approval alone is not an approved plan byte anchor.",
		};
	}
	const complete = [...steps]
		.reverse()
		.find((payload) => payload.step_name === "run:complete");
	const recorded = complete ? commitOf(complete) : null;
	if (!recorded || recorded !== summary.final_head_commit) {
		return {
			commit: null,
			refusal:
				"Source plan review final_head_commit does not match the recorded run:complete commit. Later HEAD is not approval.",
		};
	}
	return { commit: summary.final_head_commit, refusal: "" };
}

/** The approving reviewer and, for one-pass corrections, its author step. */
interface TerminalRouteDetail {
	route: "complete" | "final_corrections";
	reviewer: PlanApprovalStepRef;
	/** Recorded final-corrections author step and the findings it admitted. */
	correction: {
		author: PlanApprovalStepRef & { commit: string };
		admittedFindingIds: string[];
		/** The admitted corrections' recorded effort and the route's ceiling. */
		budget: FinalCorrectionBudget;
	} | null;
}

/**
 * Effort evidence for a recorded final-corrections route: the approving
 * verdict's admitted corrections with their recorded `effortDelta`, and the
 * effective ceiling derived as the route derived it (snapshot ledger and the
 * admitted findings under the governing baseline).
 */
function finalCorrectionBudget(input: {
	items: readonly VerdictItem[];
	snapshot: ReviewBudgetSnapshotRecord;
	baselineB0: number;
	thresholds: ReviewBudgetThresholds;
	governing: GoverningReviewState;
}): FinalCorrectionBudget {
	const admitted = new Set(input.items.map((item) => item.id));
	const corrections = [...admitted].sort().map((findingId) => ({
		findingId,
		effortDelta: input.items
			.filter((item) => item.id === findingId)
			.reduce((total, item) => total + (item.effortDelta ?? 0), 0),
	}));
	let effectiveCeiling: number;
	try {
		effectiveCeiling = deriveBudget({
			B0: input.baselineB0,
			B: input.governing.governingBaseline,
			I: input.snapshot.baselineAssessment?.independentEffortEstimate ?? null,
			workItems: input.snapshot.currentLedger.workItems,
			findings: input.snapshot.findings.filter((finding) =>
				admitted.has(finding.id),
			),
			assessments: input.snapshot.assessments,
			config: input.thresholds,
			semanticHumanRequired: false,
		}).E;
	} catch {
		// Without a derivable ceiling no correction effort is admitted.
		effectiveCeiling = input.snapshot.currentLedger.workItems.reduce(
			(total, item) => total + item.effort,
			0,
		);
	}
	return { corrections, effectiveCeiling };
}

function terminalRoute(input: {
	steps: readonly StepRecordPayload[];
	snapshot: ReviewBudgetSnapshotRecord;
	baselineB0: number;
	thresholds: ReviewBudgetThresholds;
	governing: GoverningReviewState;
}): {
	approvedCommit: string | null;
	refusal: string;
	detail?: TerminalRouteDetail;
} {
	const steps = input.steps;
	const reviewers = steps.flatMap((payload, index) => {
		if (
			payload.phase !== "plan" ||
			!payload.step_name.startsWith("reviewer:")
		) {
			return [];
		}
		if (
			payload.step_name !== input.snapshot.stepName ||
			(payload.phase ?? null) !== input.snapshot.phase ||
			payload.iteration !== input.snapshot.iteration
		) {
			return [{ payload, index, route: routeOf(payload), matched: false }];
		}
		return [{ payload, index, route: routeOf(payload), matched: true }];
	});
	const latest = reviewers.filter((entry) => entry.matched).at(-1);
	if (!latest) {
		return {
			approvedCommit: null,
			refusal: "Latest budget snapshot has no coupled plan reviewer step",
		};
	}
	let route: ReviewDecisionRoute | null = latest.route;
	const decision = input.governing.history.at(-1);
	if (decision && decision.snapshotId === input.snapshot.id) {
		const verdict = latest.payload.result_json;
		if (verdict && typeof verdict === "object") {
			try {
				const derived = deriveBudget({
					B0: input.baselineB0,
					B: input.governing.governingBaseline,
					I:
						input.snapshot.baselineAssessment?.independentEffortEstimate ??
						null,
					workItems: input.snapshot.currentLedger.workItems,
					findings: input.snapshot.findings,
					assessments: input.snapshot.assessments,
					config: input.thresholds,
					semanticHumanRequired:
						Array.isArray((verdict as ReviewerVerdict).items) &&
						(verdict as ReviewerVerdict).items.some(
							(item) => item.action === "human_required",
						),
				});
				route = routeAfterDecision({
					latestVerdict: verdict as ReviewerVerdict,
					latestBudgetSnapshot: { ...input.snapshot, derived },
					newGoverningState: input.governing,
					decision,
				});
			} catch (error) {
				return {
					approvedCommit: null,
					refusal:
						error instanceof Error
							? error.message
							: "Source post-decision route could not be derived",
				};
			}
		}
	}
	if (route === "complete") {
		const finalCorrection = [...reviewers]
			.reverse()
			.find(
				(entry) =>
					entry.route === "final_corrections" && entry.index < latest.index,
			);
		if (finalCorrection) {
			const author = authorCommitAfter(
				steps,
				finalCorrection.index,
				latest.index,
			);
			if (!author) {
				return {
					approvedCommit: null,
					refusal:
						"Final-correction approval requires the recorded final author commit before the completed plan review",
				};
			}
		}
		const commit = commitOf(latest.payload);
		return commit
			? {
					approvedCommit: commit,
					refusal: "",
					detail: {
						route: "complete",
						reviewer: stepRef(latest.payload),
						correction: null,
					},
				}
			: {
					approvedCommit: null,
					refusal: "Completed plan review has no recorded commit",
				};
	}
	if (route === "final_corrections") {
		const authorStep = authorStepAfter(steps, latest.index, steps.length);
		const author = authorStep ? commitOf(authorStep) : null;
		if (!authorStep || !author) {
			return {
				approvedCommit: null,
				refusal:
					"A final_corrections route is not approval without the recorded final author commit and completed plan-review lifecycle",
			};
		}
		const laterReviewer = reviewers.some((entry) => entry.index > latest.index);
		if (laterReviewer) {
			return {
				approvedCommit: null,
				refusal:
					"Plan review continued after final corrections without a completed route",
			};
		}
		const verdict = latest.payload.result_json as ReviewerVerdict | null;
		const admittedItems = Array.isArray(verdict?.items)
			? verdict.items.filter((item) => item.action === "auto_fix")
			: [];
		const admittedFindingIds = [
			...new Set(admittedItems.map((item) => item.id)),
		].sort();
		return {
			approvedCommit: author,
			refusal: "",
			detail: {
				route: "final_corrections",
				reviewer: stepRef(latest.payload),
				correction: {
					author: { ...stepRef(authorStep), commit: author },
					admittedFindingIds,
					budget: finalCorrectionBudget({
						items: admittedItems,
						snapshot: input.snapshot,
						baselineB0: input.baselineB0,
						thresholds: input.thresholds,
						governing: input.governing,
					}),
				},
			},
		};
	}
	return {
		approvedCommit: null,
		refusal: `Source plan review route ${route ?? "missing"} is not terminal approval`,
	};
}

function stepRef(payload: StepRecordPayload): PlanApprovalStepRef {
	return {
		stepName: payload.step_name,
		iteration: payload.iteration,
		commit: commitOf(payload),
	};
}

function authorCommitAfter(
	steps: readonly StepRecordPayload[],
	afterIndex: number,
	beforeIndex: number,
): string | null {
	const step = authorStepAfter(steps, afterIndex, beforeIndex);
	return step ? commitOf(step) : null;
}

/** First completed plan author step with a commit in the open interval. */
function authorStepAfter(
	steps: readonly StepRecordPayload[],
	afterIndex: number,
	beforeIndex: number,
): StepRecordPayload | null {
	for (let index = afterIndex + 1; index < beforeIndex; index++) {
		const payload = steps[index];
		if (!payload) continue;
		if (payload.phase !== "plan" || !payload.step_name.startsWith("author:")) {
			continue;
		}
		const result = payload.result_json;
		if (
			!result ||
			typeof result !== "object" ||
			(result as { result?: unknown }).result !== "complete"
		) {
			continue;
		}
		if (commitOf(payload)) return payload;
	}
	return null;
}

function commitOf(payload: StepRecordPayload): string | null {
	const result = payload.result_json;
	const claimed =
		result &&
		typeof result === "object" &&
		typeof (result as { commit?: unknown }).commit === "string"
			? (result as { commit: string }).commit
			: null;
	const head =
		typeof payload.head_commit === "string" && payload.head_commit.length > 0
			? payload.head_commit
			: null;
	if (claimed && head && claimed !== head) return null;
	return head ?? (claimed && claimed.length > 0 ? claimed : null);
}

function routeOf(payload: StepRecordPayload): PlanReviewRoute | null {
	const result = payload.result_json;
	if (!result || typeof result !== "object") return null;
	const route = (result as { governance?: { route?: unknown } }).governance
		?.route;
	if (
		route === "complete" ||
		route === "author_revision" ||
		route === "final_corrections" ||
		route === "human_gate"
	) {
		return route;
	}
	return null;
}

function stepPayload(payload: unknown): StepRecordPayload | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const value = payload as Partial<StepRecordPayload>;
	if (
		typeof value.step_name !== "string" ||
		typeof value.iteration !== "number"
	) {
		return null;
	}
	return value as StepRecordPayload;
}

export interface SchemaMigrationSubject {
	kind: "execution" | "source";
	runId: string;
	bindingId: string | null;
	bindingPlanSchema?: 0 | 1;
	sourceBytes: string;
	beforeBlobHash: string;
	beforeCommit: string;
	priorApprovalCommit: string;
	parentLineageId: string | null;
	ledger: ParsedDeliveryBudget;
	migrations: PlanSchemaMigrationPayload[];
}

function preparedMigrationHint(runId: string): string {
	return `Prepare the schema 1 target with 5x review migrate-schema --run ${runId} --mode equivalent|selective --prepare --dry-run, then follow the 5x-plan-migration skill.`;
}

/** Null when this plan file has no binding and no completed approval. */
export function planFileGovernedReason(input: {
	recordStore: RecordStore;
	store: ReviewBudgetStore;
	planPath: string;
}): string | null {
	const slug = planSlugFromPath(input.planPath);
	const runs = input.recordStore
		.listRuns({ planSlug: slug })
		.filter((run) => planPathsIdentifySamePlan(run.plan_path, input.planPath));
	for (const run of runs) {
		let binding: ImplementationBindingPayload | null = null;
		try {
			binding = input.store.getImplementationBinding(run.id);
		} catch (error) {
			if (!isMissingRun(error)) {
				return `Run ${run.id} has an unreadable implementation binding. Use 5x review migrate-schema --help and the 5x-plan-migration skill for a recorded transition.`;
			}
		}
		if (binding) {
			return `Plan ${input.planPath} already has implementation binding ${binding.id} on run ${run.id}. ${preparedMigrationHint(run.id)}`;
		}
		const assessed = assessApprovedSource({
			recordStore: input.recordStore,
			store: input.store,
			sourceRunId: run.id,
			planPath: run.plan_path,
		});
		if (assessed.status === "error") {
			return `${assessed.message} Use 5x review migrate-schema --help and the 5x-plan-migration skill for a recorded transition.`;
		}
		if (assessed.approval) {
			return `Plan ${input.planPath} has a completed plan-review approval on run ${run.id}. ${preparedMigrationHint(run.id)}`;
		}
	}
	return null;
}

/**
 * Bound execution, or an approved plan-review with no binding on this run.
 * Source bytes are the pre-migration authorized lineage.
 */
export async function readSchemaMigrationSubject(input: {
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	runId: string;
	readPlanAtCommit: (commit: string) => Promise<string | null>;
}): Promise<
	| { ok: true; subject: SchemaMigrationSubject }
	| { ok: false; code: string; message: string }
> {
	const summary = input.recordStore.getRun(input.runId);
	if (!summary) {
		return {
			ok: false,
			code: "RUN_NOT_FOUND",
			message: `Run ${input.runId} was not found. Use 5x plan migrate for an unapproved plan file.`,
		};
	}
	const binding = readBinding(input.store, input.runId);
	if (binding.status === "error") {
		return { ok: false, code: binding.code, message: binding.message };
	}
	if (binding.status === "ok") {
		const lineage = input.store.listImplementationTextAmendments(
			input.runId,
			binding.binding.id,
		);
		const semantic = input.store.listImplementationSemanticAmendments(
			input.runId,
			binding.binding.id,
		);
		const recorded = lineage.find(
			(entry) => entry.kind === "plan-schema-migration",
		);
		// The fold replays every lineage kind, including semantic amendments.
		// A recorded migration keeps the subject it was proposed against.
		const folded = recorded
			? null
			: input.store.readEffectiveImplementationRevision(input.runId);
		if (folded && !folded.ok) {
			return {
				ok: false,
				code: "IMPLEMENTATION_TEXT_LINEAGE_INVALID",
				message: `Refusing to migrate an unverified plan lineage. ${folded.diagnostic.message}`,
			};
		}
		const parentLineageId = recorded
			? recorded.parentLineageId
			: (folded?.lineageParentId ?? null);
		const beforeBlobHash = recorded
			? recorded.beforeBlobHash
			: (folded?.approvedPlanHash ?? binding.binding.approvedPlanHash);
		const parent = [...lineage, ...semantic].find(
			(entry) => entry.id === parentLineageId,
		);
		const sourceBytes = [
			binding.binding.approvedPlanBytes,
			...lineage.map((entry) => entry.authorizedPlanBytes),
			...semantic.map((entry) => entry.approvedPlanBytes),
		].find((bytes) => hashPlanBytes(bytes) === beforeBlobHash);
		if (sourceBytes === undefined || (parentLineageId !== null && !parent)) {
			return {
				ok: false,
				code: "IMPLEMENTATION_TEXT_LINEAGE_INVALID",
				message: "Refusing to migrate an unverified plan lineage.",
			};
		}
		let ledger = binding.binding.ledger;
		if (sourceBytes !== binding.binding.approvedPlanBytes) {
			const parsed = parseDeliveryBudget(sourceBytes);
			if (!parsed.ok) {
				return {
					ok: false,
					code: "IMPLEMENTATION_TEXT_LINEAGE_INVALID",
					message: `The effective approved ledger could not be parsed. ${parsed.message}`,
				};
			}
			ledger = parsed.value;
		}
		return {
			ok: true,
			subject: {
				kind: "execution",
				runId: input.runId,
				bindingId: binding.binding.id,
				...(binding.binding.planSchema !== undefined
					? { bindingPlanSchema: binding.binding.planSchema }
					: {}),
				sourceBytes,
				beforeBlobHash,
				beforeCommit: recorded
					? recorded.beforeCommit
					: (parent?.afterCommit ?? binding.binding.approvedPlanCommit),
				priorApprovalCommit: binding.binding.approvedPlanCommit,
				parentLineageId,
				ledger,
				migrations: input.store.listPlanSchemaMigrations(input.runId),
			},
		};
	}
	const assessed = assessApprovedSource({
		recordStore: input.recordStore,
		store: input.store,
		sourceRunId: input.runId,
		planPath: summary.plan_path,
	});
	if (assessed.status === "error") {
		return { ok: false, code: assessed.code, message: assessed.message };
	}
	if (!assessed.approval) {
		return {
			ok: false,
			code: "PLAN_MIGRATION_UNAPPROVED",
			message: `${assessed.refusal ?? "This run is not a bound execution or an approved plan review."} Use 5x plan migrate for an unapproved working-tree file.`,
		};
	}
	if (
		input.store
			.listPlanChecklistRepairs(input.runId)
			.some((repair) => repair.subject === "source")
	) {
		return {
			ok: false,
			code: "PLAN_MIGRATION_CONFLICT",
			message:
				"This source already records a checklist repair against its schema. Bind an execution run from it and migrate there, or migrate before repairing.",
		};
	}
	const sourceBytes = await input.readPlanAtCommit(
		assessed.approval.approvedCommit,
	);
	if (sourceBytes === null) {
		return {
			ok: false,
			code: "IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE",
			message: `Approved plan bytes at ${assessed.approval.approvedCommit} are unavailable`,
		};
	}
	const effective = resolveSourceApprovalLedger({
		approval: assessed.approval,
		approvedBytes: sourceBytes,
		planPath: summary.plan_path,
		executionRunId: null,
	});
	if (effective.status === "error") {
		return { ok: false, code: effective.code, message: effective.message };
	}
	const migrations = input.store.listPlanSchemaMigrations(input.runId);
	return {
		ok: true,
		subject: {
			kind: "source",
			runId: input.runId,
			bindingId: null,
			sourceBytes,
			beforeBlobHash: hashPlanBytes(sourceBytes),
			beforeCommit: assessed.approval.approvedCommit,
			priorApprovalCommit: assessed.approval.approvedCommit,
			parentLineageId: null,
			ledger: effective.ledger,
			migrations,
		},
	};
}

async function resolveSourceSchemaMigration(input: {
	store: ReviewBudgetStore;
	sourceRunId: string;
	approvedBytes: string;
	approvedCommit: string;
	ledger: ParsedDeliveryBudget;
	readPlanAtCommit: (commit: string) => Promise<string | null>;
}): Promise<
	| { status: "none" }
	| {
			status: "migrated";
			bytes: string;
			commit: string;
			fields: {
				planSchema: 1;
				governingHash: string;
				schemaMigrationId: string;
				predecessorPlanCommit: string;
			};
	  }
	| { status: "error"; code: string; message: string }
> {
	const migrations = input.store.listPlanSchemaMigrations(input.sourceRunId);
	if (migrations.length === 0) return { status: "none" };
	const chain = replayTextAmendments({
		approvedPlanBytes: input.approvedBytes,
		approvedPlanHash: hashPlanBytes(input.approvedBytes),
		amendments: migrations,
	});
	const migration = migrations.length === 1 ? migrations[0] : undefined;
	if (!chain.chainValid || chain.schema !== 1 || !migration) {
		return {
			status: "error",
			code: "PLAN_MIGRATION_CONFLICT",
			message:
				"Source run has a conflicting schema migration. Refusing to choose a binding baseline.",
		};
	}
	const atCommit = await input.readPlanAtCommit(migration.afterCommit);
	if (atCommit === null) {
		return {
			status: "error",
			code: "IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE",
			message: `Migrated plan bytes at ${migration.afterCommit} are unavailable`,
		};
	}
	if (
		atCommit !== migration.authorizedPlanBytes ||
		hashPlanBytes(atCommit) !== migration.afterBlobHash
	) {
		return {
			status: "error",
			code: "PLAN_MIGRATION_CONFLICT",
			message:
				"Source schema migration does not match the plan blob at its after commit.",
		};
	}
	const loaded = loadPlanDocument(atCommit, 1);
	if (!loaded.ok) {
		return {
			status: "error",
			code: loaded.code,
			message: loaded.message.includes("not a legacy fallback")
				? loaded.message
				: `${loaded.message} This is not a legacy fallback.`,
		};
	}
	if (
		hashPlanBytes(loaded.document.comparisonBytes) !== migration.governingHash
	) {
		return {
			status: "error",
			code: "PLAN_MIGRATION_CONFLICT",
			message:
				"Source schema migration governingHash does not match the migrated plan. This is not a legacy fallback.",
		};
	}
	const parsed = parseDeliveryBudget(loaded.document.authorityMarkdown);
	if (!parsed.ok || !ledgersMatch(parsed.value, input.ledger)) {
		return {
			status: "error",
			code: "IMPLEMENTATION_SOURCE_INVALID",
			message:
				"Migrated plan ledger does not match the source review ledger. Refusing to bind a drifted approval.",
		};
	}
	return {
		status: "migrated",
		bytes: atCommit,
		commit: migration.afterCommit,
		fields: {
			planSchema: 1,
			governingHash: migration.governingHash,
			schemaMigrationId: migration.id,
			predecessorPlanCommit: input.approvedCommit,
		},
	};
}

/**
 * Completed-source checklist repairs, replayed from the binding bytes and
 * carried onto the new binding as execution lineage. The binding keeps the
 * original approval commit, source, policy and ledger; only the authorized
 * anchor moves. Repairs recorded after a binding exists are never carried.
 */
async function replaySourceChecklistRepairs(input: {
	store: ReviewBudgetStore;
	sourceRunId: string;
	baseBytes: string;
	baseParentId: string | null;
	schema: 0 | 1;
	readPlanAtCommit: (commit: string) => Promise<string | null>;
}): Promise<
	| {
			status: "ok";
			repairs: PlanChecklistRepairPayload[];
			bytes: string;
			parentId: string | null;
			afterCommit: string | null;
	  }
	| { status: "error"; code: string; message: string }
> {
	const repairs = input.store
		.listPlanChecklistRepairs(input.sourceRunId)
		.filter((repair) => repair.subject === "source");
	let bytes = input.baseBytes;
	let parentId = input.baseParentId;
	let afterCommit: string | null = null;
	for (const repair of repairs) {
		const proof = verifyRecordedChecklistRepair({
			beforeBytes: bytes,
			afterBytes: repair.authorizedPlanBytes,
			schema: input.schema,
			edits: repair.edits,
		});
		const atCommit = await input.readPlanAtCommit(repair.afterCommit);
		if (
			repair.parentLineageId !== parentId ||
			repair.beforeBlobHash !== hashPlanBytes(bytes) ||
			repair.afterBlobHash !== hashPlanBytes(repair.authorizedPlanBytes) ||
			repair.planSchema !== input.schema ||
			!proof.ok ||
			atCommit !== repair.authorizedPlanBytes
		) {
			return {
				status: "error",
				code: "PLAN_CHECKLIST_REPAIR_INVALID",
				message: `Source checklist repair ${repair.id} does not replay from the approved plan${proof.ok ? "" : `: ${proof.message}`}. Refusing to choose a binding anchor.`,
			};
		}
		bytes = repair.authorizedPlanBytes;
		parentId = repair.id;
		afterCommit = repair.afterCommit;
	}
	return { status: "ok", repairs, bytes, parentId, afterCommit };
}

/**
 * Completed-source checklist repairs, replayed from the binding bytes and
 * carried onto the new binding as execution lineage. The binding keeps the
 * original approval commit, source, policy and ledger; only the authorized
 * anchor moves. Repairs recorded after a binding exists are never carried.
 */
async function resolveSourceChecklistRepairs(input: {
	store: ReviewBudgetStore;
	sourceRunId: string;
	executionRunId: string;
	baseBytes: string;
	baseParentId: string | null;
	schema: 0 | 1;
	readPlanAtCommit: (commit: string) => Promise<string | null>;
}): Promise<
	| {
			status: "ok";
			carry: (bindingId: string) => PlanChecklistRepairPayload[];
	  }
	| { status: "error"; code: string; message: string }
> {
	const replayed = await replaySourceChecklistRepairs(input);
	if (replayed.status === "error") return replayed;
	const repairs = replayed.repairs;
	return {
		status: "ok",
		carry: (bindingId) => {
			let carriedParent: string | null = null;
			return repairs.map((repair) => {
				const copy: PlanChecklistRepairPayload = {
					...structuredClone(repair),
					id: `checklist-repair:${createReviewBudgetId()}`,
					runId: input.executionRunId,
					subject: "execution",
					bindingId,
					carriedFrom: { runId: input.sourceRunId, repairId: repair.id },
					parentLineageId: carriedParent,
				};
				carriedParent = copy.id;
				return copy;
			});
		},
	};
}

/** The authorized anchor a checklist repair on this run is proven against. */
export interface ChecklistRepairSubject {
	kind: "execution" | "source";
	runId: string;
	bindingId: string | null;
	anchorBytes: string;
	anchorHash: string;
	anchorCommit: string;
	parentLineageId: string | null;
	schema: 0 | 1;
	/** Repairs already recorded for this subject on this run, journal order. */
	repairs: PlanChecklistRepairPayload[];
	/** Execution only: the fold this repair must leave unchanged. */
	evidence?: {
		revisionId: string;
		applicableEvidence: number;
		pendingFindings: number;
		invalidatedContextIds: string[];
		invalidatedObservationIds: string[];
	};
}

/**
 * Bound execution, or a completed plan-review approval with no binding
 * drawn from it. Reads the effective authorized anchor, not the working
 * tree. Callable while admission would report drift.
 */
export async function readChecklistRepairSubject(input: {
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	runId: string;
	readPlanAtCommit: (commit: string) => Promise<string | null>;
}): Promise<
	| { ok: true; subject: ChecklistRepairSubject }
	| { ok: false; code: string; message: string; detail?: unknown }
> {
	const summary = input.recordStore.getRun(input.runId);
	if (!summary) {
		return {
			ok: false,
			code: "RUN_NOT_FOUND",
			message: `Run ${input.runId} was not found. Use 5x plan repair-checklists --plan <path> for an unapproved draft.`,
		};
	}
	const binding = readBinding(input.store, input.runId);
	if (binding.status === "error") {
		return { ok: false, code: binding.code, message: binding.message };
	}
	if (binding.status === "ok") {
		const folded = input.store.readEffectiveImplementationRevision(input.runId);
		if (!folded?.ok) {
			return {
				ok: false,
				code: "IMPLEMENTATION_TEXT_LINEAGE_INVALID",
				message:
					`Refusing to repair against an unverified plan lineage. ${folded ? folded.diagnostic.message : ""}`.trim(),
			};
		}
		const lineage = input.store.listImplementationTextAmendments(
			input.runId,
			binding.binding.id,
		);
		const semantic = input.store.listImplementationSemanticAmendments(
			input.runId,
			binding.binding.id,
		);
		const parent = [...lineage, ...semantic].find(
			(entry) => entry.id === folded.lineageParentId,
		);
		return {
			ok: true,
			subject: {
				kind: "execution",
				runId: input.runId,
				bindingId: binding.binding.id,
				anchorBytes: folded.approvedPlanBytes,
				anchorHash: folded.approvedPlanHash,
				anchorCommit: parent?.afterCommit ?? binding.binding.approvedPlanCommit,
				parentLineageId: folded.lineageParentId,
				schema: folded.planSchema,
				repairs: lineage.filter(
					(entry): entry is PlanChecklistRepairPayload =>
						entry.kind === "plan-checklist-repair",
				),
				evidence: {
					revisionId: folded.currentRevisionId,
					applicableEvidence: folded.evidence.filter(
						(entry) => entry.applicability === "applicable",
					).length,
					pendingFindings: folded.findings.filter(
						(entry) => entry.status === "pending",
					).length,
					invalidatedContextIds: [...folded.invalidatedContextIds],
					invalidatedObservationIds: [...folded.invalidatedObservationIds],
				},
			},
		};
	}
	const bound = bindingsFromSource({
		recordStore: input.recordStore,
		store: input.store,
		sourceRunId: input.runId,
		planPath: summary.plan_path,
	});
	if (bound.length > 0) {
		const executionRunId = bound[0] as string;
		return {
			ok: false,
			code: "PLAN_CHECKLIST_REPAIR_BOUND",
			message: `Source run ${input.runId} already has implementation binding(s) on ${bound.join(", ")}. Repair the binding on its execution run: ${checklistRepairCommand(executionRunId)}. A later source repair cannot change an existing binding.`,
			detail: {
				executionRunIds: bound,
				next: [checklistRepairCommand(executionRunId)],
			},
		};
	}
	const assessed = assessApprovedSource({
		recordStore: input.recordStore,
		store: input.store,
		sourceRunId: input.runId,
		planPath: summary.plan_path,
	});
	if (assessed.status === "error") {
		return { ok: false, code: assessed.code, message: assessed.message };
	}
	if (!assessed.approval) {
		return {
			ok: false,
			code: "PLAN_CHECKLIST_REPAIR_UNAPPROVED",
			message: `${assessed.refusal ?? "This run is not a bound execution or a completed plan-review approval."} An unapproved draft is repaired with 5x plan repair-checklists --plan <path>, then reviewed normally.`,
		};
	}
	const approvedBytes = await input.readPlanAtCommit(
		assessed.approval.approvedCommit,
	);
	if (approvedBytes === null) {
		return {
			ok: false,
			code: "IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE",
			message: `Approved plan bytes at ${assessed.approval.approvedCommit} are unavailable`,
		};
	}
	const effective = resolveSourceApprovalLedger({
		approval: assessed.approval,
		approvedBytes,
		planPath: summary.plan_path,
		executionRunId: null,
	});
	if (effective.status === "error") {
		return {
			ok: false,
			code: effective.code,
			message: effective.message,
			detail: effective.detail,
		};
	}
	const migrated = await resolveSourceSchemaMigration({
		store: input.store,
		sourceRunId: input.runId,
		approvedBytes,
		approvedCommit: assessed.approval.approvedCommit,
		ledger: effective.ledger,
		readPlanAtCommit: input.readPlanAtCommit,
	});
	if (migrated.status === "error") {
		return { ok: false, code: migrated.code, message: migrated.message };
	}
	const baseBytes =
		migrated.status === "migrated" ? migrated.bytes : approvedBytes;
	const loaded = loadPlanDocument(
		baseBytes,
		migrated.status === "migrated" ? 1 : "file",
	);
	if (!loaded.ok) {
		return { ok: false, code: loaded.code, message: loaded.message };
	}
	const schema = loaded.document.schema;
	const replayed = await replaySourceChecklistRepairs({
		store: input.store,
		sourceRunId: input.runId,
		baseBytes,
		baseParentId:
			migrated.status === "migrated" ? migrated.fields.schemaMigrationId : null,
		schema,
		readPlanAtCommit: input.readPlanAtCommit,
	});
	if (replayed.status === "error") {
		return { ok: false, code: replayed.code, message: replayed.message };
	}
	return {
		ok: true,
		subject: {
			kind: "source",
			runId: input.runId,
			bindingId: null,
			anchorBytes: replayed.bytes,
			anchorHash: hashPlanBytes(replayed.bytes),
			anchorCommit:
				replayed.afterCommit ??
				(migrated.status === "migrated"
					? migrated.commit
					: assessed.approval.approvedCommit),
			parentLineageId: replayed.parentId,
			schema,
			repairs: replayed.repairs,
		},
	};
}

/** Execution runs whose binding was drawn from this source run. */
function bindingsFromSource(input: {
	recordStore: RecordStore;
	store: ReviewBudgetStore;
	sourceRunId: string;
	planPath: string;
}): string[] {
	const slug = planSlugFromPath(input.planPath);
	const out: string[] = [];
	for (const run of input.recordStore.listRuns({ planSlug: slug })) {
		if (run.id === input.sourceRunId) continue;
		if (!planPathsIdentifySamePlan(run.plan_path, input.planPath)) continue;
		const binding = readBinding(input.store, run.id);
		if (
			binding.status === "ok" &&
			binding.binding.sourceRunId === input.sourceRunId
		) {
			out.push(run.id);
		}
	}
	return out.sort();
}

/**
 * The run whose authority governs this plan file, preferring an execution
 * binding over its completed source. Null for an unapproved draft.
 */
export function planFileGoverningRun(input: {
	recordStore: RecordStore;
	store: ReviewBudgetStore;
	planPath: string;
}): { runId: string; kind: "execution" | "source" } | null {
	const slug = planSlugFromPath(input.planPath);
	const runs = input.recordStore
		.listRuns({ planSlug: slug })
		.filter((run) => planPathsIdentifySamePlan(run.plan_path, input.planPath));
	let source: string | null = null;
	const executions: Array<{ id: string; active: boolean }> = [];
	for (const run of runs) {
		const binding = readBinding(input.store, run.id);
		if (binding.status === "ok") {
			executions.push({ id: run.id, active: run.status === "active" });
			continue;
		}
		if (source !== null) continue;
		const assessed = assessApprovedSource({
			recordStore: input.recordStore,
			store: input.store,
			sourceRunId: run.id,
			planPath: run.plan_path,
		});
		if (assessed.status === "ok" && assessed.approval) source = run.id;
	}
	const execution =
		executions.find((entry) => entry.active) ?? executions.at(-1);
	if (execution) return { runId: execution.id, kind: "execution" };
	return source ? { runId: source, kind: "source" } : null;
}

export async function bindImplementationExecution(input: {
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	executionRunId: string;
	sourceRunId: string;
	planPath: string;
	planMarkdown: string;
	origin: RecordOrigin;
	readPlanAtCommit: (commit: string) => Promise<string | null>;
}): Promise<ImplementationAdmissionResult> {
	const existing = readBinding(input.store, input.executionRunId);
	if (existing.status === "error") return existing;
	if (existing.status === "ok") {
		return admitExistingBinding(
			{
				store: input.store,
				executionRunId: input.executionRunId,
				planMarkdown: input.planMarkdown,
				explicitSourceRunId: input.sourceRunId,
			},
			existing.binding,
		);
	}
	const assessed = assessApprovedSource({
		recordStore: input.recordStore,
		store: input.store,
		sourceRunId: input.sourceRunId,
		planPath: input.planPath,
	});
	if (assessed.status === "error") return assessed;
	if (!assessed.approval) {
		return {
			status: "error",
			code: "IMPLEMENTATION_PLAN_UNAPPROVED",
			message:
				assessed.refusal ??
				`Source run ${input.sourceRunId} is not an approved plan review`,
		};
	}
	const approvedBytes = await input.readPlanAtCommit(
		assessed.approval.approvedCommit,
	);
	if (approvedBytes === null) {
		return {
			status: "error",
			code: "IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE",
			message: `Approved plan bytes at ${assessed.approval.approvedCommit} are unavailable`,
		};
	}
	const effective = resolveSourceApprovalLedger({
		approval: assessed.approval,
		approvedBytes,
		planPath: input.planPath,
		executionRunId: input.executionRunId,
	});
	if (effective.status === "error") return effective;
	const approvedLedger = effective.ledger;
	const migrated = await resolveSourceSchemaMigration({
		store: input.store,
		sourceRunId: input.sourceRunId,
		approvedBytes,
		approvedCommit: assessed.approval.approvedCommit,
		ledger: approvedLedger,
		readPlanAtCommit: input.readPlanAtCommit,
	});
	if (migrated.status === "error") return migrated;
	const bindingBytes =
		migrated.status === "migrated" ? migrated.bytes : approvedBytes;
	const bindingCommit =
		migrated.status === "migrated"
			? migrated.commit
			: assessed.approval.approvedCommit;
	const approvedDocument = authoritativePlan(
		bindingBytes,
		migrated.status === "migrated" ? 1 : "file",
	);
	if (!approvedDocument.ok) {
		return {
			status: "error",
			code: approvedDocument.code,
			message: approvedDocument.message.includes("not a legacy fallback")
				? approvedDocument.message
				: `${approvedDocument.message} This is not a legacy fallback.`,
		};
	}
	const parsed = parseDeliveryBudget(
		approvedDocument.document.authorityMarkdown,
	);
	if (!parsed.ok) {
		return {
			status: "error",
			code: "IMPLEMENTATION_SOURCE_INVALID",
			message: parsed.message,
		};
	}
	if (!ledgersMatch(parsed.value, approvedLedger)) {
		return {
			status: "error",
			code: "IMPLEMENTATION_SOURCE_INVALID",
			message:
				"Approved plan bytes do not match the source review ledger. Refusing to bind a drifted approval.",
		};
	}
	const mapped = mapApprovedPhases(approvedDocument.document, approvedLedger);
	if (mapped.status === "error") return mapped;
	const governingHash =
		migrated.status === "migrated"
			? migrated.fields.governingHash
			: approvedDocument.document.schema === 1
				? hashPlanBytes(approvedDocument.document.comparisonBytes)
				: undefined;
	const repairs = await resolveSourceChecklistRepairs({
		store: input.store,
		sourceRunId: assessed.approval.sourceRunId,
		executionRunId: input.executionRunId,
		baseBytes: bindingBytes,
		baseParentId:
			migrated.status === "migrated" ? migrated.fields.schemaMigrationId : null,
		schema: approvedDocument.document.schema,
		readPlanAtCommit: input.readPlanAtCommit,
	});
	if (repairs.status === "error") return repairs;
	const drift = detectPlanDrift({
		approvedPlanBytes: bindingBytes,
		approvedPlanHash: hashPlanBytes(bindingBytes),
		amendments: repairs.carry("pending"),
		currentPlanBytes: input.planMarkdown,
		recordedSchema: approvedDocument.document.schema,
		...(governingHash ? { governingHash } : {}),
	});
	if (drift.drifted) {
		return {
			status: "error",
			code: "IMPLEMENTATION_PLAN_DRIFT",
			message: `${
				drift.reason ??
				"The execution plan differs from the approved plan bytes. Checkbox-only edits are ignored. `5x review implementation bind` only attaches the initial source; semantic edits require an amendmentAssessment after that binding exists."
			} ${checklistRepairHint(assessed.approval.sourceRunId)}`,
			detail: {
				repairCommand: checklistRepairCommand(assessed.approval.sourceRunId),
			},
		};
	}
	const decisions = assessed.approval.decisions;
	const payload: ImplementationBindingPayload = {
		kind: "implementation-binding",
		version: IMPLEMENTATION_STATE_VERSION,
		id: createReviewBudgetId(),
		executionRunId: input.executionRunId,
		sourceRunId: assessed.approval.sourceRunId,
		sourceSnapshotId: assessed.approval.snapshotId,
		sourceBaselineId: assessed.approval.baselineId,
		approvedPlanCommit: bindingCommit,
		approvedPlanHash: hashPlanBytes(bindingBytes),
		approvedPlanBytes: bindingBytes,
		b0: assessed.approval.b0,
		governingB: assessed.approval.governingB,
		mode: assessed.approval.mode,
		thresholds: assessed.approval.thresholds,
		ledger: approvedLedger,
		effectiveDecisions: decisions,
		phaseMap: mapped.phaseMap,
		debtTargets: mapped.debtTargets,
		ledgerHash: hashJson(approvedLedger),
		decisionsHash: hashJson(decisions),
		createdAt: now(),
		...(migrated.status === "migrated"
			? migrated.fields
			: approvedDocument.document.schema === 1 && governingHash
				? { planSchema: 1 as const, governingHash }
				: {}),
		...(effective.provenance
			? { approvalFinalization: effective.provenance }
			: {}),
	};
	const carried = repairs.carry(payload.id);
	const saved =
		carried.length === 0
			? input.store.saveImplementationBinding(payload, input.origin)
			: saveBindingWithCarriedRepairs({
					recordStore: input.recordStore,
					payload,
					carried,
					origin: input.origin,
				});
	if (!saved.created) {
		const again = readBinding(input.store, input.executionRunId);
		if (again.status === "ok") {
			return admitExistingBinding(
				{
					store: input.store,
					executionRunId: input.executionRunId,
					planMarkdown: input.planMarkdown,
					explicitSourceRunId: input.sourceRunId,
				},
				again.binding,
			);
		}
		return again.status === "error"
			? again
			: {
					status: "error",
					code: "IMPLEMENTATION_BINDING_CONFLICT",
					message:
						"An implementation binding already exists and could not be re-read",
				};
	}
	return { status: "bound", binding: saved.payload, created: true };
}

/** A committed-blob checklist defect and its run-form repair commands. */
export interface CommittedPlanRepair {
	executable: false;
	finalCommit: string;
	diagnostics: PlanExecutabilityDiagnostic[];
	next: string[];
}

export type SourceApprovalFinalization =
	| { status: "not_applicable" }
	| {
			status: "ready";
			/** `completion.iteration` is set when the record is paired. */
			payload: PlanApprovalFinalizationPayload;
			/** An identical record for this commit is already paired. */
			existing: boolean;
			/**
			 * The committed blob has a checklist defect with a mechanical or
			 * line-selected repair, applied on the completed source before
			 * binding.
			 */
			executability?: CommittedPlanRepair;
	  }
	| { status: "error"; code: string; message: string; detail?: unknown };

/**
 * Final committed approval for a plan-review run about to complete.
 *
 * Applies only to an approved terminal route with no binding. Reads the
 * committed plan at `finalCommit` (never the working tree), validates those
 * exact bytes with the shared executability result, proves their ledger
 * against the approving snapshot under the recorded route's admitted
 * corrections and correction effort, and returns the record to pair with
 * `run:complete`. An author-required executability defect or a substantive
 * delta returns an error: the caller leaves the run active with the
 * same-run remedy rather than sealing an unusable approval. A checklist
 * defect with a deterministic repair finalizes with that run-form repair.
 */
export async function prepareSourceApprovalFinalization(input: {
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	runId: string;
	finalCommit: string | null;
	readPlanAtCommit: (commit: string) => Promise<string | null>;
}): Promise<SourceApprovalFinalization> {
	const notApplicable = { status: "not_applicable" as const };
	if (!input.recordStore.getRun(input.runId)) return notApplicable;
	if (readBinding(input.store, input.runId).status !== "missing") {
		return notApplicable;
	}
	const baseline = input.store.getBaseline(input.runId);
	const snapshot = input.store.latestSnapshot(input.runId);
	if (!baseline || !snapshot) return notApplicable;
	const listed = listGovernanceDecisions(input.recordStore, input.runId);
	if (listed.diagnostics.length > 0) return notApplicable;
	const steps = input.recordStore.listLines(input.runId, "steps");
	const parsedSteps = steps.flatMap((line) => {
		const payload = stepPayload(line.payload);
		return payload ? [payload] : [];
	});
	const governing = foldGoverningReviewState({
		b0: baseline.b0,
		decisions: listed.decisions,
		steps,
		budget: input.recordStore.listLines(input.runId, "budget"),
	});
	if (governing.aborted) return notApplicable;
	const openGate = createReviewGovernanceStore(
		input.recordStore,
	).deriveOpenGate(input.runId);
	if (openGate && !openGate.resolved) return notApplicable;
	const route = terminalRoute({
		steps: parsedSteps,
		snapshot,
		baselineB0: baseline.b0,
		thresholds: baseline.configSnapshot,
		governing,
	});
	if (!route.approvedCommit || !route.detail || !input.finalCommit) {
		return notApplicable;
	}
	const detail = route.detail;
	const finalCommit = input.finalCommit;
	const next = sameRunFinalizationNext(input.runId);
	const bytes = await input.readPlanAtCommit(finalCommit);
	if (bytes === null) {
		return {
			status: "error",
			code: "PLAN_APPROVAL_FINALIZATION_UNAVAILABLE",
			message: `The plan is not committed at ${finalCommit}. Commit the approved plan (a working-tree file is not an approval anchor), then repeat \`5x run complete --run ${input.runId}\`. The run stays active.`,
			detail: { finalCommit },
		};
	}
	const executability = committedPlanExecutability({
		bytes,
		finalCommit,
		runId: input.runId,
	});
	if (executability?.status === "blocked") return executability.error;
	const repair =
		executability?.status === "repairable"
			? { executability: executability.repair }
			: {};
	const read = readAuthoritativeBudget(bytes, "file");
	if (!read.ok || !read.parsed.ok) {
		return {
			status: "error",
			code: read.ok ? "PLAN_APPROVAL_FINALIZATION_DELTA" : read.code,
			message: `The committed plan at ${finalCommit} has no readable Delivery Budget (${read.ok ? (read.parsed as { message: string }).message : read.message}). The run stays active; correct and review the plan on this run, then complete it.`,
			detail: { finalCommit, next },
		};
	}
	const admittedFindingIds = detail.correction?.admittedFindingIds ?? [];
	const correctionBudget = detail.correction?.budget ?? null;
	const proof = reconcileFinalApprovalLedger({
		reviewed: snapshot.currentLedger,
		final: read.parsed.value,
		admittedFindingIds,
		correctionBudget,
	});
	if (!proof.ok) {
		return {
			status: "error",
			code: "PLAN_APPROVAL_FINALIZATION_DELTA",
			message: `The committed plan at ${finalCommit} changes the approved ledger beyond the recorded ${detail.route} route: ${describeFinalLedgerChanges(proof.changes)} The run stays active and nothing was sealed. Review the corrected plan on this run (or revert the change), then complete it again.`,
			detail: {
				finalCommit,
				route: detail.route,
				admittedFindingIds,
				changes: proof.changes,
				next,
			},
		};
	}
	const payload: PlanApprovalFinalizationPayload = {
		kind: "plan-approval-finalization",
		version: 1,
		id: `approval-finalization:${createReviewBudgetId()}`,
		runId: input.runId,
		sourceSnapshotId: snapshot.id,
		sourceBaselineId: baseline.id,
		route: detail.route,
		reviewer: { ...detail.reviewer },
		authorCorrection: detail.correction
			? { ...detail.correction.author }
			: null,
		admittedFindingIds: [...admittedFindingIds],
		decisionsHash: hashJson(governing.history),
		completion: { stepName: "run:complete", iteration: 0 },
		finalCommit,
		finalBlobHash: hashPlanBytes(bytes),
		planSchema: read.document.schema,
		...(read.document.schema === 1
			? { governingHash: hashPlanBytes(read.document.comparisonBytes) }
			: {}),
		snapshotLedgerHash: hashJson(snapshot.currentLedger),
		ledger: proof.ledger,
		ledgerHash: hashJson(proof.ledger),
		addressAdditions: proof.addressAdditions,
		...(correctionBudget
			? { correctionBudget: structuredClone(correctionBudget) }
			: {}),
		...(proof.effortCorrections.length > 0
			? { effortCorrections: proof.effortCorrections }
			: {}),
		createdAt: now(),
	};
	let prior: PlanApprovalFinalizationPayload | undefined;
	try {
		prior = input.store
			.listPlanApprovalFinalizations(input.runId)
			.find((entry) => entry.finalCommit === finalCommit);
	} catch (error) {
		return {
			status: "error",
			code: "PLAN_APPROVAL_FINALIZATION_CONFLICT",
			message: `An existing plan-approval finalization on ${input.runId} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (prior) {
		const same =
			prior.sourceSnapshotId === payload.sourceSnapshotId &&
			prior.finalBlobHash === payload.finalBlobHash &&
			prior.ledgerHash === payload.ledgerHash &&
			prior.decisionsHash === payload.decisionsHash;
		if (!same) {
			return {
				status: "error",
				code: "PLAN_APPROVAL_FINALIZATION_CONFLICT",
				message: `Run ${input.runId} already records a different plan-approval finalization for ${finalCommit}. Inspect the run's budget records before completing.`,
				detail: { finalizationId: prior.id },
			};
		}
		return { status: "ready", payload: prior, existing: true, ...repair };
	}
	return { status: "ready", payload, existing: false, ...repair };
}

/**
 * The shared executability result over the exact committed finalization
 * bytes. Warnings (such as prose gates beside executable items) never
 * block. Author-required defects (no phases, duplicate phase ids, a phase
 * with no list to convert) block: sealing would publish an approval that no
 * deterministic repair can make executable, so the run stays active for
 * author work reviewed on this run. A defect with only a mechanical or
 * line-selected checklist repair keeps the approved path: the approval
 * finalizes and the completed source is repaired with the run form before
 * binding, so the committed-blob diagnostic is returned with that repair.
 */
function committedPlanExecutability(input: {
	bytes: string;
	finalCommit: string;
	runId: string;
}):
	| {
			status: "blocked";
			error: Extract<SourceApprovalFinalization, { status: "error" }>;
	  }
	| { status: "repairable"; repair: CommittedPlanRepair }
	| null {
	const diagnosed = diagnosePlanExecutability(input.bytes, "file");
	// Schema errors are reported by the Delivery Budget read that follows.
	if (!diagnosed.ok || diagnosed.result.executable) return null;
	const errors = diagnosed.result.diagnostics.filter(
		(entry) => entry.severity === "error",
	);
	if (errors.every((entry) => entry.repair !== "author")) {
		return {
			status: "repairable",
			repair: {
				executable: false,
				finalCommit: input.finalCommit,
				diagnostics: errors,
				next: executabilityRepairCommands(errors, {
					kind: "run",
					runId: input.runId,
				}),
			},
		};
	}
	const remediation =
		"Have the author restore executable phases and checklist items (or revert the breaking correction), commit the plan, review it on this run, then complete the run again. No new run is needed.";
	return {
		status: "blocked",
		error: {
			status: "error",
			code: "PLAN_REPAIR_REQUIRED",
			message: `The committed plan at ${input.finalCommit} is not executable [PLAN_NOT_EXECUTABLE]: ${errors.map((entry) => entry.message).join(" ")} The run stays active and nothing was sealed. ${remediation}`,
			detail: {
				finalCommit: input.finalCommit,
				reviewRoute: "author_revision",
				executability: diagnosed.result,
				diagnostics: errors,
				next: sameRunFinalizationNext(input.runId),
				remediation,
				runPreserved: true,
			},
		},
	};
}

/** Budget-line op pairing a finalization record with its `run:complete` step. */
export function planApprovalFinalizationOp(input: {
	payload: PlanApprovalFinalizationPayload;
	completionIteration: number;
	completionHead: string | null;
}): {
	stream: "budget";
	idempotencyKey: string;
	payload: unknown;
} {
	if (input.completionHead !== input.payload.finalCommit) {
		throw new RecordStoreError(
			"RECORD_PRECONDITION_FAILED",
			`HEAD moved from ${input.payload.finalCommit} to ${input.completionHead ?? "none"} during completion. Nothing was sealed; repeat \`5x run complete --run ${input.payload.runId}\`.`,
		);
	}
	return {
		stream: "budget",
		idempotencyKey: planApprovalFinalizationKey(
			input.payload.runId,
			input.payload.finalCommit,
		),
		payload: encodePlanApprovalFinalizationPayload({
			...input.payload,
			completion: {
				stepName: "run:complete",
				iteration: input.completionIteration,
			},
		}),
	};
}

function saveBindingWithCarriedRepairs(input: {
	recordStore: RecordStore;
	payload: ImplementationBindingPayload;
	carried: readonly PlanChecklistRepairPayload[];
	origin: RecordOrigin;
}): { created: boolean; payload: ImplementationBindingPayload } {
	const runId = input.payload.executionRunId;
	const result = input.recordStore.atomicAppendIfAllNew([
		{
			runId,
			stream: "budget",
			idempotencyKey: implementationBindingKey(runId),
			payload: encodeImplementationBindingPayload(input.payload),
			createdAt: input.payload.createdAt,
			...recordedEnvelope(input.origin),
		},
		...input.carried.map((repair) => ({
			runId,
			stream: "budget" as const,
			idempotencyKey: planChecklistRepairKey(runId, repair.intentDigest),
			payload: encodePlanChecklistRepairPayload(repair),
			createdAt: input.payload.createdAt,
			...recordedEnvelope(input.origin),
		})),
	]);
	return { created: result.created, payload: input.payload };
}

/** Next command for a mechanical checklist repair on this run. */
export function checklistRepairCommand(runId: string): string {
	return `5x plan repair-checklists --run ${runId} --dry-run`;
}

/** Appended to drift and missing-checklist failures. */
export function checklistRepairHint(runId: string): string {
	return `If the only governing change is introduced checklist markers, or a phase has no executable checklist, preview the operator-authorized mechanical repair with \`${checklistRepairCommand(runId)}\`; it needs no reviewer finding, gate, or new run.`;
}

function mapApprovedPhases(
	document: {
		raw: string;
		schema: 0 | 1;
		authorityMarkdown: string;
	},
	ledger: ParsedDeliveryBudget,
):
	| {
			status: "ok";
			phaseMap: ImplementationPhaseMapping[];
			debtTargets: ImplementationDebtTarget[];
	  }
	| { status: "error"; code: string; message: string } {
	const read = readAuthoritativePlan(document.raw, document.schema);
	if (!read.ok) {
		return { status: "error", code: read.code, message: read.message };
	}
	const parsed = read.plan;
	const ids = parsed.phases.map((phase) => phase.number);
	const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
	if (duplicate) {
		return {
			status: "error",
			code: "IMPLEMENTATION_PHASE_UNRESOLVED",
			message: `Approved plan phase ${duplicate} is ambiguous`,
		};
	}
	const phaseMap = parsed.phases.map((phase) => ({
		id: phase.number,
		heading: phase.heading,
	}));
	const debtTargets: ImplementationDebtTarget[] = [];
	for (const item of ledger.workItems) {
		const claim = item.debtClaim;
		if (!claim) continue;
		const mapped = mapDebtTargetToPhaseId(claim.targetPhase, ids);
		if (!mapped.ok) {
			return {
				status: "error",
				code: "IMPLEMENTATION_PHASE_UNRESOLVED",
				message: `Debt claim ${claim.debtClaimId} target '${claim.targetPhase}' is ${mapped.reason} against parsed phase ids [${ids.join(", ")}]. Numeric sort is not used.`,
			};
		}
		debtTargets.push({
			claimId: claim.debtClaimId,
			sourceLabel: claim.targetPhase,
			phaseId: mapped.phaseId,
		});
	}
	return { status: "ok", phaseMap, debtTargets };
}

/** Ledger identity ignores parse line numbers, titles, and rationale. */
export function deliveryLedgersEqual(
	parsed: ParsedDeliveryBudget,
	approved: ParsedDeliveryBudget,
): boolean {
	return ledgersMatch(parsed, approved);
}

function ledgersMatch(
	parsed: ParsedDeliveryBudget,
	approved: ParsedDeliveryBudget,
): boolean {
	return (
		hashJson(ledgerIdentity(parsed)) === hashJson(ledgerIdentity(approved))
	);
}

function ledgerIdentity(ledger: ParsedDeliveryBudget): unknown {
	return {
		estimateConfidence: ledger.estimateConfidence,
		surface: ledger.surface,
		workItems: ledger.workItems.map((item) => ({
			id: item.id,
			effort: item.effort,
			architectureDelta: item.architectureDelta,
			addresses: [...item.addresses].sort(),
			debtClaim: claimIdentity(item.debtClaim),
		})),
	};
}

function claimIdentity(claim: DebtClaimEvidence | null): unknown {
	if (!claim) return null;
	return {
		debtClaimId: claim.debtClaimId,
		coupling: claim.coupling,
		targetPhase: claim.targetPhase,
		minimalAlternativeEffortDelta: claim.minimalAlternativeEffortDelta,
		minimalAlternativeArchitectureDelta:
			claim.minimalAlternativeArchitectureDelta,
		before: claim.before,
		after: claim.after,
	};
}

export function recordVerifiedTextAmendment(input: {
	store: ReviewBudgetStore;
	binding: ImplementationBindingPayload;
	origin: RecordOrigin;
	guardId: string;
	sourceObservationId: string;
	beforeCommit: string;
	afterCommit: string;
	authorizedPlanBytes: string;
	id?: string;
}):
	| { status: "ok"; amendment: ImplementationTextAmendmentPayload }
	| { status: "error"; code: string; message: string } {
	const folded = input.store.readEffectiveImplementationRevision(
		input.binding.executionRunId,
	);
	if (!folded?.ok) {
		return {
			status: "error",
			code: "IMPLEMENTATION_TEXT_LINEAGE_INVALID",
			message: folded
				? folded.diagnostic.message
				: "Refusing to extend an unverified text-amendment chain",
		};
	}
	if (folded.invalidatedObservationIds.includes(input.sourceObservationId)) {
		return {
			status: "error",
			code: "IMPLEMENTATION_TEXT_LINEAGE_INVALID",
			message:
				"The text guard's observation does not certify the current revision.",
		};
	}
	const payload: ImplementationTextAmendmentPayload = {
		kind: "implementation-text-amendment",
		version: IMPLEMENTATION_STATE_VERSION,
		id: input.id ?? createReviewBudgetId(),
		bindingId: input.binding.id,
		executionRunId: input.binding.executionRunId,
		guardId: input.guardId,
		sourceObservationId: input.sourceObservationId,
		parentLineageId: folded.lineageParentId,
		beforeCommit: input.beforeCommit,
		afterCommit: input.afterCommit,
		beforeBlobHash: folded.approvedPlanHash,
		afterBlobHash: hashPlanBytes(input.authorizedPlanBytes),
		authorizedPlanBytes: input.authorizedPlanBytes,
		...(folded.currentRevisionId === folded.initialRevisionId
			? {}
			: { revisionId: folded.currentRevisionId }),
		createdAt: now(),
	};
	const saved = input.store.saveImplementationTextAmendment(
		payload,
		input.origin,
	);
	return { status: "ok", amendment: saved.payload };
}

export type AuthorTextAmendmentResult =
	| { status: "not_applicable" }
	| { status: "unchanged" }
	| { status: "verified"; amendment: ImplementationTextAmendmentPayload }
	| {
			status: "failed";
			code: string;
			message: string;
			blocking: boolean;
	  };

/**
 * Verify the guard snapshotted on the latest same-phase observation against
 * the author's committed plan blob. Success appends text-amendment lineage
 * and does not change the binding's approved hash.
 */
export function verifyAuthorTextAmendment(input: {
	store: ReviewBudgetStore;
	binding: ImplementationBindingPayload;
	origin: RecordOrigin;
	phase: string;
	committedPlanBytes: Buffer | null;
	worktreePlanBytes: Buffer | null;
	afterCommit: string;
}): AuthorTextAmendmentResult {
	const blocking = input.binding.mode === "enforced";
	const phaseId = numericPhaseId(input.phase);
	if (!phaseId) return { status: "not_applicable" };
	let observations: ImplementationReviewObservationPayload[];
	try {
		observations = input.store
			.listImplementationReviews(input.binding.executionRunId)
			.filter((observation) => observation.phase === phaseId);
	} catch (error) {
		return {
			status: "failed",
			code: "IMPLEMENTATION_REVIEW_RECORD_CORRUPT",
			message:
				error instanceof Error
					? error.message
					: "Implementation review history could not be read",
			blocking,
		};
	}
	const latest = observations.at(-1);
	if (!latest?.textGuard) {
		const textOnly = latest?.originalVerdict.items.some(
			(item) =>
				item.scopeClass === "plan_defect" &&
				item.planImpact?.kind === "text_only",
		);
		if (textOnly && latest?.nextAction === "author_revision") {
			return {
				status: "failed",
				code: "PLAN_AMENDMENT_GUARD_MISSING",
				message:
					"The text-only correction has no durable guard, so the exemption cannot be consumed.",
				blocking,
			};
		}
		return { status: "not_applicable" };
	}
	const folded = input.store.readEffectiveImplementationRevision(
		input.binding.executionRunId,
	);
	if (!folded?.ok) {
		return {
			status: "failed",
			code: "PLAN_AMENDMENT_LINEAGE",
			message: folded
				? folded.diagnostic.message
				: "Refusing to consume a guard against an unverified text-amendment chain",
			blocking,
		};
	}
	if (folded.invalidatedObservationIds.includes(latest.id)) {
		return {
			status: "failed",
			code: "PLAN_AMENDMENT_STALE",
			message:
				"The text guard does not certify the current revision. A new review is required.",
			blocking,
		};
	}
	const loaded = loadAmendments(
		input.store,
		input.binding.executionRunId,
		input.binding.id,
	);
	if (!loaded.ok) {
		return {
			status: "failed",
			code: "PLAN_AMENDMENT_LINEAGE",
			message: "Existing text-amendment lineage could not be read",
			blocking,
		};
	}
	const recordedGuard = latest.textGuard;
	if (
		loaded.amendments.some(
			(amendment) =>
				amendment.kind !== "plan-schema-migration" &&
				amendment.kind !== "plan-checklist-repair" &&
				amendment.guardId === recordedGuard.id,
		)
	) {
		return { status: "not_applicable" };
	}
	let guard: TextAmendmentGuard = recordedGuard;
	if (
		recordedGuard.parentLineageId !== folded.lineageParentId ||
		recordedGuard.anchorBlobHash !== folded.approvedPlanHash
	) {
		// Only proven mechanical checklist repairs may sit between the guard
		// and the current anchor. The recorded guard stays immutable; its spans
		// are re-proven on the repaired anchor for this consumption.
		const rebased = rebaseTextAmendmentGuard({
			guard: recordedGuard,
			repairs: loaded.amendments.flatMap((amendment) =>
				amendment.kind === "plan-checklist-repair" &&
				amendment.bindingId === input.binding.id
					? [amendment]
					: [],
			),
			target: {
				parentLineageId: folded.lineageParentId,
				blobHash: folded.approvedPlanHash,
			},
			recordedSchema: folded.planSchema,
		});
		if (!rebased.ok) {
			return {
				status: "failed",
				code: "PLAN_AMENDMENT_STALE",
				message:
					rebased.code === "PLAN_AMENDMENT_STALE"
						? rebased.message
						: `The text guard cannot be carried across the checklist repair. ${rebased.message} A new review is required.`,
				blocking,
			};
		}
		guard = rebased.guard;
	}
	const clean = worktreeMatchesCommit({
		worktree: input.worktreePlanBytes,
		committed: input.committedPlanBytes,
	});
	if (!clean.ok) {
		return { status: "failed", ...clean, blocking };
	}
	if (!input.committedPlanBytes) {
		return {
			status: "failed",
			code: "PLAN_AMENDMENT_DIRTY",
			message: "The committed plan blob is unavailable.",
			blocking,
		};
	}
	const recordedSchema = { recordedSchema: folded.planSchema };
	const verified = verifyGuardedPlanBytes({
		guard,
		committed: input.committedPlanBytes,
		recordedSchema: recordedSchema.recordedSchema,
	});
	if (!verified.ok) {
		return { status: "failed", ...verified, blocking };
	}
	const committedComparison = loadPlanDocument(
		verified.authorizedPlanBytes,
		recordedSchema.recordedSchema,
	);
	const anchorComparison = loadPlanDocument(
		guard.anchorBytes,
		recordedSchema.recordedSchema,
	);
	if (
		committedComparison.ok &&
		anchorComparison.ok &&
		committedComparison.document.comparisonBytes ===
			anchorComparison.document.comparisonBytes
	) {
		return { status: "unchanged" };
	}
	const recorded = recordVerifiedTextAmendment({
		store: input.store,
		binding: input.binding,
		origin: input.origin,
		guardId: guard.id,
		sourceObservationId: latest.id,
		beforeCommit: guard.anchorCommit,
		afterCommit: input.afterCommit,
		authorizedPlanBytes: verified.authorizedPlanBytes,
	});
	if (recorded.status !== "ok") {
		return {
			status: "failed",
			code: recorded.code,
			message: recorded.message,
			blocking,
		};
	}
	return { status: "verified", amendment: recorded.amendment };
}

/**
 * Author admission reads the committed blob as raw bytes. The worktree copy
 * must match it. The author's recorded commit is the blob to verify; HEAD is
 * used only when that result omits a commit.
 */
export async function admitAuthorTextAmendmentFromGit(input: {
	store: ReviewBudgetStore;
	binding: ImplementationBindingPayload;
	origin: RecordOrigin;
	phase: string;
	workdir: string;
	planPath: string;
	repoRoot?: string;
	worktreePlanBytes: Buffer | null;
	authorCommit?: string;
}): Promise<AuthorTextAmendmentResult> {
	let afterCommit = input.authorCommit?.trim() ?? "";
	if (afterCommit.length === 0) {
		try {
			afterCommit = await readHeadCommit(workdirCodeDiffGit(input.workdir));
		} catch (error) {
			return {
				status: "failed",
				code:
					error instanceof CodeDiffError ? error.code : "CODE_DIFF_GIT_ERROR",
				message: error instanceof Error ? error.message : String(error),
				blocking: input.binding.mode === "enforced",
			};
		}
	}
	const committed = await showPlanBlobAtCommit(
		input.workdir,
		afterCommit,
		input.planPath,
		input.repoRoot ? { repoRoot: input.repoRoot } : undefined,
	);
	return verifyAuthorTextAmendment({
		store: input.store,
		binding: input.binding,
		origin: input.origin,
		phase: input.phase,
		committedPlanBytes: committed,
		worktreePlanBytes: input.worktreePlanBytes,
		afterCommit,
	});
}

export function assessSupersedingApproval(input: {
	binding: ImplementationBindingPayload;
	proposedLedger: ParsedDeliveryBudget;
	proposedSourceSnapshotId: string;
	proposedPlanBytes: string;
	liveMarkdown?: string;
}): { ok: true } | { ok: false; code: string; message: string } {
	return evaluateSupersedingLedger({
		approved: input.binding.ledger,
		proposed: input.proposedLedger,
		sameSourceSnapshot:
			input.proposedSourceSnapshotId === input.binding.sourceSnapshotId,
		liveMarkdownMatchesProposal:
			input.liveMarkdown !== undefined &&
			input.liveMarkdown === input.proposedPlanBytes &&
			input.proposedSourceSnapshotId === input.binding.sourceSnapshotId,
	});
}

/** Durable step that freezes pre-delegation HEAD for one binding and phase. */
export const PRE_AUTHOR_STEP_NAME = "implementation:pre-author";

export interface PhaseAuthorAdmission {
	kind: "phase-author-admission";
	version: typeof IMPLEMENTATION_STATE_VERSION;
	bindingId: string;
	phase: string;
	preAuthorCommit: string;
	createdAt: string;
}

export type ImplementationContextResult<T> =
	| ({ status: "ok" } & T)
	| { status: "error"; code: string; message: string };

function numericPhaseId(phase: string): string | null {
	const trimmed = phase.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
	const prefixed = trimmed.match(/^phase[\s-]+(\d+(?:\.\d+)?)$/i);
	return prefixed?.[1] ?? null;
}

function samePhase(
	phase: string | null | undefined,
	expected: string,
): boolean {
	if (!phase) return false;
	const left = numericPhaseId(phase);
	const right = numericPhaseId(expected);
	return left !== null && left === right;
}

function gitFailure(error: unknown): {
	status: "error";
	code: string;
	message: string;
} {
	if (error instanceof CodeDiffError) {
		return { status: "error", code: error.code, message: error.message };
	}
	return {
		status: "error",
		code: "CODE_DIFF_GIT_ERROR",
		message: error instanceof Error ? error.message : String(error),
	};
}

function listRunSteps(
	recordStore: RecordStore,
	runId: string,
): StepRecordPayload[] {
	const steps: StepRecordPayload[] = [];
	for (const line of recordStore.listLines(runId, "steps")) {
		const payload = line.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			continue;
		}
		const step = payload as Partial<StepRecordPayload>;
		if (
			typeof step.step_name !== "string" ||
			typeof step.iteration !== "number"
		) {
			continue;
		}
		steps.push(step as StepRecordPayload);
	}
	return steps;
}

function decodeAdmission(
	payload: StepRecordPayload,
): PhaseAuthorAdmission | null {
	const raw = payload.result_json;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw as Partial<PhaseAuthorAdmission>;
	if (
		value.kind !== "phase-author-admission" ||
		value.version !== IMPLEMENTATION_STATE_VERSION ||
		typeof value.bindingId !== "string" ||
		typeof value.phase !== "string" ||
		typeof value.preAuthorCommit !== "string"
	) {
		return null;
	}
	return {
		kind: "phase-author-admission",
		version: IMPLEMENTATION_STATE_VERSION,
		bindingId: value.bindingId,
		phase: value.phase,
		preAuthorCommit: value.preAuthorCommit,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
	};
}

export function readPhaseAuthorAdmission(
	recordStore: RecordStore,
	runId: string,
	phase: string,
):
	| { status: "missing" }
	| { status: "found"; admission: PhaseAuthorAdmission }
	| { status: "error"; code: string; message: string } {
	const phaseId = numericPhaseId(phase);
	if (!phaseId) {
		return {
			status: "error",
			code: "UNKNOWN_PHASE",
			message: `Phase '${phase}' is not a numeric implementation phase.`,
		};
	}
	const matches = listRunSteps(recordStore, runId).filter(
		(step) =>
			step.step_name === PRE_AUTHOR_STEP_NAME && samePhase(step.phase, phaseId),
	);
	const step = matches[0];
	if (!step) return { status: "missing" };
	const admission = decodeAdmission(step);
	if (!admission || admission.preAuthorCommit !== step.head_commit) {
		return {
			status: "error",
			code: "IMPLEMENTATION_PRE_AUTHOR_UNREADABLE",
			message: `Phase ${phaseId} has an unreadable pre-author admission.`,
		};
	}
	return { status: "found", admission };
}

/**
 * Record pre-delegation HEAD once per binding and phase. Later renders,
 * sessions, and quality retries reuse the stored commit.
 */
export function capturePhaseAuthorAdmission(input: {
	recordStore: RecordStore;
	origin: RecordOrigin;
	executionRunId: string;
	bindingId: string;
	phase: string;
	preAuthorCommit: string;
}):
	| { status: "captured" | "reused"; admission: PhaseAuthorAdmission }
	| { status: "skipped" }
	| { status: "error"; code: string; message: string } {
	const phase = numericPhaseId(input.phase);
	if (!phase) {
		return {
			status: "error",
			code: "UNKNOWN_PHASE",
			message: `Phase '${input.phase}' is not a numeric implementation phase.`,
		};
	}
	if (!/^[0-9a-f]{40}$/u.test(input.preAuthorCommit)) {
		return {
			status: "error",
			code: "CODE_DIFF_BAD_REF",
			message: "Pre-author HEAD must be a full commit SHA.",
		};
	}
	const existing = readPhaseAuthorAdmission(
		input.recordStore,
		input.executionRunId,
		phase,
	);
	if (existing.status === "error") return existing;
	if (existing.status === "found") {
		if (existing.admission.bindingId !== input.bindingId) {
			return {
				status: "error",
				code: "IMPLEMENTATION_PRE_AUTHOR_CONFLICT",
				message: `Phase ${phase} already captured pre-author commit ${existing.admission.preAuthorCommit} for binding ${existing.admission.bindingId}.`,
			};
		}
		return { status: "reused", admission: existing.admission };
	}
	// A phase that already admitted work has no durable pre-author base.
	// Stamping current HEAD would hide those commits or reject them as
	// non-ancestors. Leave capture absent so the legacy earliest-commit
	// parent is used instead.
	const alreadyAdmitted = listRunSteps(
		input.recordStore,
		input.executionRunId,
	).some(
		(step) => samePhase(step.phase, phase) && admittedCommitRef(step) !== null,
	);
	if (alreadyAdmitted) return { status: "skipped" };
	const admission: PhaseAuthorAdmission = {
		kind: "phase-author-admission",
		version: IMPLEMENTATION_STATE_VERSION,
		bindingId: input.bindingId,
		phase,
		preAuthorCommit: input.preAuthorCommit,
		createdAt: now(),
	};
	const payload: StepRecordPayload = {
		step_name: PRE_AUTHOR_STEP_NAME,
		phase,
		iteration: 0,
		result_json: admission,
		head_commit: input.preAuthorCommit,
		patch_id: null,
		diff_summary: null,
		duration_ms: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		model: null,
	};
	input.recordStore.append({
		runId: input.executionRunId,
		stream: "steps",
		idempotencyKey: stepIdempotencyKey({
			runId: input.executionRunId,
			stepName: PRE_AUTHOR_STEP_NAME,
			phase,
			iteration: 0,
		}),
		payload,
		createdAt: admission.createdAt,
		...recordedEnvelope(input.origin),
	});
	return { status: "captured", admission };
}

function admittedCommitRef(step: StepRecordPayload): string | null {
	if (step.step_name === "git:commit") return step.head_commit;
	if (!step.step_name.startsWith("author:")) return null;
	const result = step.result_json;
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
	const commit = (result as { commit?: unknown }).commit;
	return typeof commit === "string" && commit.length > 0 ? commit : null;
}

export async function resolveLegacyPreAuthorBase(input: {
	steps: readonly StepRecordPayload[];
	phase: string;
	git: CodeDiffGit;
	reviewedCommit: string;
}): Promise<
	| { status: "ok"; baseCommit: string }
	| { status: "error"; code: string; message: string }
> {
	const commits = input.steps.filter(
		(step) =>
			step.step_name === "git:commit" &&
			samePhase(step.phase, input.phase) &&
			Boolean(step.head_commit),
	);
	const earliest = commits[0];
	if (!earliest?.head_commit) {
		return {
			status: "error",
			code: "CODE_DIFF_MISSING_BASE",
			message:
				"No pre-author HEAD was captured, and this phase has no git:commit to recover one from. Current HEAD was not stamped as a pre-author base.",
		};
	}
	let commit: string;
	try {
		commit = await resolveCodeCommit(input.git, earliest.head_commit);
	} catch (error) {
		return gitFailure(error);
	}
	let parents: string[];
	try {
		parents = await commitParents(input.git, commit);
	} catch (error) {
		return gitFailure(error);
	}
	if (parents.length !== 1) {
		return {
			status: "error",
			code: "CODE_DIFF_AMBIGUOUS_BASE",
			message:
				parents.length === 0
					? `Earliest git:commit ${commit} is a root commit and has no parent to use as the review base.`
					: `Earliest git:commit ${commit} is a merge and has no single parent to use as the review base.`,
		};
	}
	const baseCommit = parents[0] as string;
	try {
		if (!(await isCodeAncestor(input.git, baseCommit, input.reviewedCommit))) {
			return {
				status: "error",
				code: "CODE_DIFF_NOT_ANCESTOR",
				message: `Legacy base ${baseCommit} is not an ancestor of reviewed commit ${input.reviewedCommit}.`,
			};
		}
	} catch (error) {
		return gitFailure(error);
	}
	return { status: "ok", baseCommit };
}

async function admittedCommits(input: {
	steps: readonly StepRecordPayload[];
	phase: string;
	git: CodeDiffGit;
}): Promise<
	| { status: "ok"; commits: string[] }
	| { status: "error"; code: string; message: string }
> {
	const refs = input.steps
		.filter((step) => samePhase(step.phase, input.phase))
		.map(admittedCommitRef)
		.filter((commit): commit is string => Boolean(commit));
	try {
		const commits: string[] = [];
		for (const ref of refs) {
			commits.push(await resolveCodeCommit(input.git, ref));
		}
		return { status: "ok", commits };
	} catch (error) {
		return gitFailure(error);
	}
}

/**
 * The reviewed end is the latest admitted commit that changes a non-excluded
 * path. Review-document commits stay in history but do not move the range.
 */
async function advanceReviewedCommit(input: {
	git: CodeDiffGit;
	commits: readonly string[];
	start: string;
	excludedPaths: readonly string[];
}): Promise<
	| { status: "ok"; reviewedCommit: string }
	| { status: "error"; code: string; message: string }
> {
	let reviewed = input.start;
	try {
		for (const commit of input.commits) {
			if (commit === reviewed) continue;
			if (!(await isCodeAncestor(input.git, reviewed, commit))) {
				return {
					status: "error",
					code: "CODE_DIFF_NOT_ANCESTOR",
					message: `Recorded commit ${commit} is not a descendant of review base ${reviewed}.`,
				};
			}
			const paths = await changedCodePaths(
				input.git,
				reviewed,
				commit,
				input.excludedPaths,
			);
			if (paths.length > 0) reviewed = commit;
		}
		return { status: "ok", reviewedCommit: reviewed };
	} catch (error) {
		return gitFailure(error);
	}
}

function contextGit(input: {
	git?: CodeDiffGit;
	workdir?: string;
}): CodeDiffGit | { status: "error"; code: string; message: string } {
	if (input.git) return input.git;
	if (input.workdir) return workdirCodeDiffGit(input.workdir);
	return {
		status: "error",
		code: "CODE_DIFF_GIT_ERROR",
		message: "Code review context requires a workdir or git adapter.",
	};
}

export async function prepareImplementationReviewContext(input: {
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	origin: RecordOrigin;
	executionRunId: string;
	bindingId: string;
	phase: string;
	excludedPaths: readonly string[];
	git?: CodeDiffGit;
	workdir?: string;
}): Promise<
	| {
			status: "ready";
			context: ImplementationReviewContextPayload;
			diff: CodeDiffContext;
			created: boolean;
	  }
	| { status: "error"; code: string; message: string }
> {
	const phase = numericPhaseId(input.phase);
	if (!phase) {
		return {
			status: "error",
			code: "UNKNOWN_PHASE",
			message: `Phase '${input.phase}' is not a numeric implementation phase.`,
		};
	}
	const git = contextGit(input);
	if ("status" in git) return git;
	const excludedPaths = [
		...new Set(input.excludedPaths.filter(Boolean)),
	].sort();
	let head = "";
	try {
		await assertCleanCodeWorktree(git, excludedPaths);
		head = await readHeadCommit(git);
	} catch (error) {
		return gitFailure(error);
	}
	const steps = listRunSteps(input.recordStore, input.executionRunId);
	const admission = readPhaseAuthorAdmission(
		input.recordStore,
		input.executionRunId,
		phase,
	);
	if (admission.status === "error") return admission;
	const admitted = await admittedCommits({ steps, phase, git });
	if (admitted.status === "error") return admitted;
	let initialBase: string;
	if (admission.status === "found") {
		initialBase = admission.admission.preAuthorCommit;
	} else if (
		!steps.some(
			(step) =>
				step.step_name === "git:commit" &&
				samePhase(step.phase, phase) &&
				Boolean(step.head_commit),
		)
	) {
		return {
			status: "error",
			code: "CODE_DIFF_MISSING_BASE",
			message:
				"No pre-author HEAD was captured, and this phase has no git:commit to recover one from. Current HEAD was not stamped as a pre-author base.",
		};
	} else {
		const legacy = await resolveLegacyPreAuthorBase({
			steps,
			phase,
			git,
			reviewedCommit: admitted.commits.at(-1) ?? head,
		});
		if (legacy.status === "error") return legacy;
		initialBase = legacy.baseCommit;
	}
	const advanced = await advanceReviewedCommit({
		git,
		commits: admitted.commits,
		start: initialBase,
		excludedPaths,
	});
	if (advanced.status === "error") return advanced;
	const reviewedCommit = advanced.reviewedCommit;
	try {
		if (!(await isCodeAncestor(git, reviewedCommit, head))) {
			return {
				status: "error",
				code: "CODE_DIFF_STALE",
				message: `Recorded commit ${reviewedCommit} is not an ancestor of HEAD. Prepare a new review after the recorded history is reachable.`,
			};
		}
		const between = await changedCodePaths(
			git,
			reviewedCommit,
			head,
			excludedPaths,
		);
		if (between.length > 0) {
			return {
				status: "error",
				code: "CODE_DIFF_INTERVENING",
				message: `Code changed after the admitted commit (${between.join(", ")}). Record the correction, then prepare a new review context.`,
			};
		}
		if (!(await isCodeAncestor(git, initialBase, reviewedCommit))) {
			return {
				status: "error",
				code: "CODE_DIFF_NOT_ANCESTOR",
				message: `Review base ${initialBase} is not an ancestor of ${reviewedCommit}.`,
			};
		}
	} catch (error) {
		return gitFailure(error);
	}
	const prior = input.store
		.listImplementationReviewContexts(input.executionRunId, input.bindingId)
		.filter((context) => context.phase === phase);
	const folded = input.store.readEffectiveImplementationRevision(
		input.executionRunId,
	);
	if (folded && !folded.ok) {
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_CONTEXT_STALE",
			message: folded.diagnostic.message,
		};
	}
	const invalidated = new Set(folded?.ok ? folded.invalidatedContextIds : []);
	const currentRevisionId = folded?.ok ? folded.currentRevisionId : undefined;
	const latest = prior.at(-1);
	let baseCommit = initialBase;
	let previousReviewId: string | undefined;
	if (latest && latest.reviewedCommit === reviewedCommit) {
		baseCommit = latest.baseCommit;
		previousReviewId = latest.id;
	} else if (latest) {
		baseCommit = latest.reviewedCommit;
		previousReviewId = latest.id;
	}
	let diff: CodeDiffContext;
	try {
		diff = await buildCodeDiff({
			git,
			baseCommit,
			reviewedCommit,
			excludedPaths,
		});
	} catch (error) {
		return gitFailure(error);
	}
	const sameRange = prior.find((context) => {
		if (invalidated.has(context.id)) return false;
		if (
			context.baseCommit !== diff.baseCommit ||
			context.reviewedCommit !== diff.reviewedCommit
		) {
			return false;
		}
		if (!currentRevisionId || !folded?.ok) return true;
		const recorded = context.revisionId ?? folded.initialRevisionId;
		return recorded === currentRevisionId;
	});
	if (sameRange) {
		if (sameRange.patchHash !== diff.patchHash) {
			return {
				status: "error",
				code: "CODE_DIFF_STALE",
				message: `Review context ${sameRange.id} no longer matches ${diff.baseCommit}..${diff.reviewedCommit}. Rebase or rewritten objects require a newly prepared review.`,
			};
		}
		return { status: "ready", context: sameRange, diff, created: false };
	}
	const context: ImplementationReviewContextPayload = {
		kind: "implementation-review-context",
		version: IMPLEMENTATION_STATE_VERSION,
		id: createReviewBudgetId(),
		executionRunId: input.executionRunId,
		bindingId: input.bindingId,
		phase,
		...(previousReviewId ? { previousReviewId } : {}),
		baseCommit: diff.baseCommit,
		reviewedCommit: diff.reviewedCommit,
		patchHash: diff.patchHash,
		excludedPaths: diff.excludedPaths,
		hunks: diff.hunks,
		binaryPaths: diff.binaryPaths,
		...(folded?.ok && folded.currentRevisionId !== folded.initialRevisionId
			? { revisionId: folded.currentRevisionId }
			: {}),
		createdAt: now(),
	};
	const saved = input.store.saveImplementationReviewContext(
		context,
		input.origin,
	);
	return {
		status: "ready",
		context: saved.payload,
		diff,
		created: saved.created,
	};
}

export async function verifyImplementationReviewContext(input: {
	store: ReviewBudgetStore;
	executionRunId: string;
	bindingId: string;
	phase: string;
	reviewContextId: string;
	git?: CodeDiffGit;
	workdir?: string;
}): Promise<
	| {
			status: "ok";
			context: ImplementationReviewContextPayload;
			diff: CodeDiffContext;
	  }
	| { status: "error"; code: string; message: string }
> {
	const phase = numericPhaseId(input.phase);
	if (!phase) {
		return {
			status: "error",
			code: "UNKNOWN_PHASE",
			message: `Phase '${input.phase}' is not a numeric implementation phase.`,
		};
	}
	const context = input.store.getImplementationReviewContext(
		input.executionRunId,
		input.reviewContextId,
	);
	if (!context) {
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_CONTEXT_NOT_FOUND",
			message: `Review context ${input.reviewContextId} was not prepared for run ${input.executionRunId}. Render the reviewer template instead of manufacturing endpoints.`,
		};
	}
	const folded = input.store.readEffectiveImplementationRevision(
		input.executionRunId,
	);
	if (folded && !folded.ok) {
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_CONTEXT_STALE",
			message: folded.diagnostic.message,
		};
	}
	const recordedRevision =
		context.revisionId ?? (folded?.ok ? folded.initialRevisionId : undefined);
	if (
		(folded?.ok && folded.invalidatedContextIds.includes(context.id)) ||
		(folded?.ok && recordedRevision !== folded.currentRevisionId)
	) {
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_CONTEXT_STALE",
			message:
				"This context predates the current plan revision. Render a fresh reviewer context; retain the original review history and prior findings.",
		};
	}
	if (
		context.executionRunId !== input.executionRunId ||
		context.bindingId !== input.bindingId ||
		context.phase !== phase
	) {
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_CONTEXT_REUSE",
			message: `Review context ${context.id} belongs to binding ${context.bindingId} phase ${context.phase} and cannot be reused here.`,
		};
	}
	const git = contextGit(input);
	if ("status" in git) return git;
	try {
		await assertCleanCodeWorktree(git, context.excludedPaths);
		const head = await readHeadCommit(git);
		await assertNoInterveningCode({
			git,
			reviewedCommit: context.reviewedCommit,
			headCommit: head,
			excludedPaths: context.excludedPaths,
		});
		const diff = await buildCodeDiff({
			git,
			baseCommit: context.baseCommit,
			reviewedCommit: context.reviewedCommit,
			excludedPaths: context.excludedPaths,
		});
		if (diff.patchHash !== context.patchHash) {
			return {
				status: "error",
				code: "CODE_DIFF_STALE",
				message: `Review context ${context.id} does not match the recomputed patch. Prepare a new context instead of accepting an equivalent end.`,
			};
		}
		return { status: "ok", context, diff };
	} catch (error) {
		return gitFailure(error);
	}
}

/**
 * Authoritative implementation observations. Plan snapshot readers never see
 * these lines, and a rebuilt store reads the same record order.
 */
export function listRecordedImplementationReviews(
	store: Pick<ReviewBudgetStore, "listImplementationReviews">,
	runId: string,
): ImplementationReviewObservationPayload[] {
	return store.listImplementationReviews(runId);
}

export function listCorrectionAttempts(
	store: Pick<ReviewBudgetStore, "listImplementationCorrectionAttempts">,
	runId: string,
	observationId?: string,
): ImplementationCorrectionAttemptPayload[] {
	return store.listImplementationCorrectionAttempts(runId, observationId);
}

export function recordCorrectionAttempt(input: {
	store: Pick<ReviewBudgetStore, "saveImplementationCorrectionAttempt">;
	payload: ImplementationCorrectionAttemptPayload;
	origin: RecordOrigin;
}): { created: boolean; payload: ImplementationCorrectionAttemptPayload } {
	return input.store.saveImplementationCorrectionAttempt(
		input.payload,
		input.origin,
	);
}

export function listCreditReconciliations(
	store: Pick<ReviewBudgetStore, "listImplementationCreditReconciliations">,
	runId: string,
): ImplementationCreditReconciliationPayload[] {
	return store.listImplementationCreditReconciliations(runId);
}

/**
 * Append a reconciliation observation. A later restoration is a new record
 * with `supersedesId`; this write does not erase the predecessor.
 */
export function recordCreditReconciliation(input: {
	store: Pick<ReviewBudgetStore, "saveImplementationCreditReconciliation">;
	payload: ImplementationCreditReconciliationPayload;
	origin: RecordOrigin;
}): { created: boolean; payload: ImplementationCreditReconciliationPayload } {
	return input.store.saveImplementationCreditReconciliation(
		input.payload,
		input.origin,
	);
}
