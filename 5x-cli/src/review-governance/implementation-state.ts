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
import { gitShowFile } from "../git.js";
import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import { parsePlan } from "../parsers/plan.js";
import { planSlugFromPath, relativePathUnder } from "../paths.js";
import type { ReviewerVerdict } from "../protocol.js";
import { deriveBudget } from "../review-budget/arithmetic.js";
import {
	IMPLEMENTATION_STATE_VERSION,
	type ImplementationBindingPayload,
	type ImplementationCompatibilityPayload,
	type ImplementationCompatibilityReason,
	type ImplementationDebtTarget,
	type ImplementationPhaseMapping,
	type ImplementationReviewContextPayload,
	type ImplementationReviewObservationPayload,
	type ImplementationTextAmendmentPayload,
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

/** Ignore checkbox toggles on Markdown task-list items only. */
export function normalizeCheckboxState(markdown: string): string {
	return markdown.replace(/^(\s*[-*+]\s+)\[[ xX]\]/gm, "$1[ ]");
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

export function detectPlanDrift(input: {
	approvedPlanBytes: string;
	approvedPlanHash: string;
	amendments: readonly ImplementationTextAmendmentPayload[];
	currentPlanBytes: string;
}): PlanDriftResult {
	const chain = replayTextAmendments(input);
	const authorizedBytes = chain.chainValid
		? chain.authorizedBytes
		: input.approvedPlanBytes;
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
		reason: chain.chainValid
			? "Plan bytes differ from the approved text and its verified amendment lineage, ignoring checkbox state."
			: "Plan bytes differ from the approved text. The amendment chain is unverified or malformed and does not authorize drift.",
	};
}

function replayTextAmendments(input: {
	approvedPlanBytes: string;
	approvedPlanHash: string;
	amendments: readonly ImplementationTextAmendmentPayload[];
}): { chainValid: boolean; authorizedBytes: string; authorizedHash: string } {
	if (hashPlanBytes(input.approvedPlanBytes) !== input.approvedPlanHash) {
		return {
			chainValid: false,
			authorizedBytes: input.approvedPlanBytes,
			authorizedHash: input.approvedPlanHash,
		};
	}
	let authorizedBytes = input.approvedPlanBytes;
	let authorizedHash = input.approvedPlanHash;
	let parent: string | null = null;
	for (const amendment of input.amendments) {
		const afterHash = hashPlanBytes(amendment.authorizedPlanBytes);
		const valid =
			amendment.version === IMPLEMENTATION_STATE_VERSION &&
			amendment.parentLineageId === parent &&
			amendment.beforeBlobHash === authorizedHash &&
			amendment.afterBlobHash === afterHash &&
			amendment.beforeCommit.length > 0 &&
			amendment.afterCommit.length > 0;
		if (!valid) {
			return {
				chainValid: false,
				authorizedBytes: input.approvedPlanBytes,
				authorizedHash: input.approvedPlanHash,
			};
		}
		authorizedBytes = amendment.authorizedPlanBytes;
		authorizedHash = afterHash;
		parent = amendment.id;
	}
	return { chainValid: true, authorizedBytes, authorizedHash };
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
			detail: { candidateRunIds: string[]; remediation: string };
	  }
	| { status: "error"; code: string; message: string; detail?: unknown };

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
):
	| { ok: true; amendments: ImplementationTextAmendmentPayload[] }
	| { ok: false } {
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
): string {
	if (candidateRunIds.length === 0) {
		return `No approved plan-review source matches this plan. Select one explicitly with \`5x review implementation bind --run ${executionRunId} --source-run <plan-review>\`.`;
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

	const parsed = parseDeliveryBudget(input.planMarkdown);
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
		const message = remediation(input.executionRunId, candidates.runIds);
		return {
			status: "approval_required",
			code: "IMPLEMENTATION_APPROVAL_REQUIRED",
			message,
			detail: { candidateRunIds: candidates.runIds, remediation: message },
		};
	}
	const sourceRunId = candidates.runIds[0];
	if (!sourceRunId) {
		const message = remediation(input.executionRunId, []);
		return {
			status: "approval_required",
			code: "IMPLEMENTATION_APPROVAL_REQUIRED",
			message,
			detail: { candidateRunIds: [], remediation: message },
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
			message: `Run ${input.executionRunId} is already bound to ${binding.sourceRunId}. A different source requires explicit human-approved amendment provenance.`,
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
	const amendments = loadAmendments(
		input.store,
		input.executionRunId,
		binding.id,
	);
	const drift = detectPlanDrift({
		approvedPlanBytes: binding.approvedPlanBytes,
		approvedPlanHash: binding.approvedPlanHash,
		amendments: amendments.ok ? amendments.amendments : [],
		currentPlanBytes: input.planMarkdown,
	});
	if (!amendments.ok || drift.drifted) {
		return {
			status: "error",
			code: "IMPLEMENTATION_PLAN_DRIFT",
			message:
				drift.reason ??
				"Plan bytes differ from the approved text. An unverified amendment chain does not authorize drift.",
			detail: {
				bindingId: binding.id,
				chainValid: amendments.ok && drift.chainValid,
			},
		};
	}
	return { status: "bound", binding, created: false };
}

function approvedCandidates(input: {
	recordStore: RecordStore;
	store: ReviewBudgetStore;
	planPath: string;
}):
	| { status: "ok"; runIds: string[] }
	| { status: "error"; code: string; message: string } {
	const slug = planSlugFromPath(input.planPath);
	const runs = input.recordStore
		.listRuns({ planSlug: slug })
		.filter((run) => planPathsIdentifySamePlan(run.plan_path, input.planPath));
	const runIds: string[] = [];
	for (const run of runs) {
		const assessed = assessApprovedSource({
			recordStore: input.recordStore,
			store: input.store,
			sourceRunId: run.id,
			planPath: input.planPath,
		});
		if (assessed.status === "error") return assessed;
		if (assessed.approval) runIds.push(run.id);
	}
	runIds.sort();
	return { status: "ok", runIds };
}

interface ApprovalEvidence {
	sourceRunId: string;
	baselineId: string;
	snapshotId: string;
	b0: number;
	governingB: number;
	mode: Exclude<ReviewBudgetMode, "off">;
	thresholds: ReviewBudgetThresholds;
	ledger: ParsedDeliveryBudget;
	decisions: ReviewDecisionPayload[];
	approvedCommit: string;
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
			ledger: structuredClone(snapshot.currentLedger),
			decisions: structuredClone(governing.history),
			approvedCommit: finalized.commit,
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

function terminalRoute(input: {
	steps: readonly StepRecordPayload[];
	snapshot: ReviewBudgetSnapshotRecord;
	baselineB0: number;
	thresholds: ReviewBudgetThresholds;
	governing: GoverningReviewState;
}): { approvedCommit: string | null; refusal: string } {
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
			? { approvedCommit: commit, refusal: "" }
			: {
					approvedCommit: null,
					refusal: "Completed plan review has no recorded commit",
				};
	}
	if (route === "final_corrections") {
		const author = authorCommitAfter(steps, latest.index, steps.length);
		if (!author) {
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
		return { approvedCommit: author, refusal: "" };
	}
	return {
		approvedCommit: null,
		refusal: `Source plan review route ${route ?? "missing"} is not terminal approval`,
	};
}

function authorCommitAfter(
	steps: readonly StepRecordPayload[],
	afterIndex: number,
	beforeIndex: number,
): string | null {
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
		const commit = commitOf(payload);
		if (commit) return commit;
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
	const parsed = parseDeliveryBudget(approvedBytes);
	if (!parsed.ok) {
		return {
			status: "error",
			code: "IMPLEMENTATION_SOURCE_INVALID",
			message: parsed.message,
		};
	}
	if (!ledgersMatch(parsed.value, assessed.approval.ledger)) {
		return {
			status: "error",
			code: "IMPLEMENTATION_SOURCE_INVALID",
			message:
				"Approved plan bytes do not match the source review ledger. Refusing to bind a drifted approval.",
		};
	}
	const mapped = mapApprovedPhases(approvedBytes, assessed.approval.ledger);
	if (mapped.status === "error") return mapped;
	const drift = detectPlanDrift({
		approvedPlanBytes: approvedBytes,
		approvedPlanHash: hashPlanBytes(approvedBytes),
		amendments: [],
		currentPlanBytes: input.planMarkdown,
	});
	if (drift.drifted) {
		return {
			status: "error",
			code: "IMPLEMENTATION_PLAN_DRIFT",
			message:
				drift.reason ??
				"The execution plan differs from the approved plan bytes. Checkbox-only edits are ignored; other edits require amendment.",
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
		approvedPlanCommit: assessed.approval.approvedCommit,
		approvedPlanHash: hashPlanBytes(approvedBytes),
		approvedPlanBytes: approvedBytes,
		b0: assessed.approval.b0,
		governingB: assessed.approval.governingB,
		mode: assessed.approval.mode,
		thresholds: assessed.approval.thresholds,
		ledger: assessed.approval.ledger,
		effectiveDecisions: decisions,
		phaseMap: mapped.phaseMap,
		debtTargets: mapped.debtTargets,
		ledgerHash: hashJson(assessed.approval.ledger),
		decisionsHash: hashJson(decisions),
		createdAt: now(),
	};
	const saved = input.store.saveImplementationBinding(payload, input.origin);
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

function mapApprovedPhases(
	approvedBytes: string,
	ledger: ParsedDeliveryBudget,
):
	| {
			status: "ok";
			phaseMap: ImplementationPhaseMapping[];
			debtTargets: ImplementationDebtTarget[];
	  }
	| { status: "error"; code: string; message: string } {
	const parsed = parsePlan(approvedBytes);
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
	const loaded = loadAmendments(
		input.store,
		input.binding.executionRunId,
		input.binding.id,
	);
	if (!loaded.ok) {
		return {
			status: "error",
			code: "IMPLEMENTATION_TEXT_LINEAGE_INVALID",
			message: "Existing text-amendment lineage could not be read",
		};
	}
	const replay = replayTextAmendments({
		approvedPlanBytes: input.binding.approvedPlanBytes,
		approvedPlanHash: input.binding.approvedPlanHash,
		amendments: loaded.amendments,
	});
	if (!replay.chainValid) {
		return {
			status: "error",
			code: "IMPLEMENTATION_TEXT_LINEAGE_INVALID",
			message: "Refusing to extend an unverified text-amendment chain",
		};
	}
	const parent = loaded.amendments.at(-1);
	const payload: ImplementationTextAmendmentPayload = {
		kind: "implementation-text-amendment",
		version: IMPLEMENTATION_STATE_VERSION,
		id: input.id ?? createReviewBudgetId(),
		bindingId: input.binding.id,
		executionRunId: input.binding.executionRunId,
		guardId: input.guardId,
		sourceObservationId: input.sourceObservationId,
		parentLineageId: parent?.id ?? null,
		beforeCommit: input.beforeCommit,
		afterCommit: input.afterCommit,
		beforeBlobHash: replay.authorizedHash,
		afterBlobHash: hashPlanBytes(input.authorizedPlanBytes),
		authorizedPlanBytes: input.authorizedPlanBytes,
		createdAt: now(),
	};
	const saved = input.store.saveImplementationTextAmendment(
		payload,
		input.origin,
	);
	return { status: "ok", amendment: saved.payload };
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
	const latest = prior.at(-1);
	let baseCommit = initialBase;
	let previousReviewId: string | undefined;
	if (latest && latest.reviewedCommit === reviewedCommit) {
		baseCommit = latest.baseCommit;
		previousReviewId = latest.previousReviewId;
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
	const sameRange = prior.find(
		(context) =>
			context.baseCommit === diff.baseCommit &&
			context.reviewedCommit === diff.reviewedCommit,
	);
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
