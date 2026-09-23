/**
 * Approved execution binding for implementation runs.
 *
 * Copies plan-review lineage into the execution run's budget stream. It does
 * not capture a baseline or rescore the plan. Phase 5 appends text-amendment
 * lines; this module replays that chain and otherwise treats it as empty.
 */

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { createReviewBudgetId } from "../control-plane/ids.js";
import type { RecordStore } from "../control-plane/record-store.js";
import {
	type RecordOrigin,
	RecordStoreError,
	type StepRecordPayload,
} from "../control-plane/record-types.js";
import type {
	ReviewBudgetSnapshotRecord,
	ReviewBudgetStore,
} from "../control-plane/review-budget-store.js";
import { gitShowFile } from "../git.js";
import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import { parsePlan } from "../parsers/plan.js";
import { planSlugFromPath } from "../paths.js";
import type { ReviewerVerdict } from "../protocol.js";
import { deriveBudget } from "../review-budget/arithmetic.js";
import {
	IMPLEMENTATION_STATE_VERSION,
	type ImplementationBindingPayload,
	type ImplementationCompatibilityPayload,
	type ImplementationCompatibilityReason,
	type ImplementationDebtTarget,
	type ImplementationPhaseMapping,
	type ImplementationTextAmendmentPayload,
} from "../review-budget/record-lines.js";
import type {
	DebtClaimEvidence,
	ParsedDeliveryBudget,
	ReviewBudgetMode,
	ReviewBudgetThresholds,
} from "../review-budget/types.js";
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

export function normalizeCheckboxState(markdown: string): string {
	return markdown.replace(/\[[ xX]\]/g, "[ ]");
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
): Promise<string | null> {
	const absolute = isAbsolute(planPath) ? planPath : resolve(workdir, planPath);
	let repoPath = relative(workdir, absolute).replace(/\\/g, "/");
	if (repoPath.startsWith("../") || repoPath === "") {
		repoPath = planPath.replace(/\\/g, "/").replace(/^\.\//, "");
	}
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
					showPlanAtCommit(input.workdir as string, commit, input.planPath)
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
		steps,
		snapshot,
		baselineB0: baseline.b0,
		thresholds: baseline.configSnapshot,
		governing,
	});
	if (!route.approvedCommit) {
		return { status: "ok", approval: null, refusal: route.refusal };
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
			approvedCommit: route.approvedCommit,
		},
	};
}

function terminalRoute(input: {
	steps: readonly { payload: unknown }[];
	snapshot: ReviewBudgetSnapshotRecord;
	baselineB0: number;
	thresholds: ReviewBudgetThresholds;
	governing: GoverningReviewState;
}): { approvedCommit: string | null; refusal: string } {
	const steps = input.steps.flatMap((line) => {
		const payload = stepPayload(line.payload);
		return payload ? [payload] : [];
	});
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
