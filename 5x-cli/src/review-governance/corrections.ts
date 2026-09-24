/**
 * Quality-backed final implementation corrections.
 *
 * Eligibility is independent of the plan-review final-correction validator:
 * there is no one-point effort ceiling. A passing attempt is proof only when
 * the CLI recorded it for this observation, commit, tree, quality digest, and
 * execution directory. `quality:check` and `phase finish` caches are not proof.
 */

import { createHash } from "node:crypto";
import { createReviewBudgetId } from "../control-plane/ids.js";
import type { RecordStore } from "../control-plane/record-store.js";
import type {
	RecordOrigin,
	StepRecordPayload,
} from "../control-plane/record-types.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import type {
	BoundaryChangeLabel,
	ReviewerVerdict,
	VerdictItem,
} from "../protocol.js";
import {
	IMPLEMENTATION_STATE_VERSION,
	type ImplementationClaimObservation,
	type ImplementationCorrectionAttemptPayload,
	type ImplementationReviewContextPayload,
	type ImplementationReviewObservationPayload,
} from "../review-budget/record-lines.js";
import {
	assertCleanCodeWorktree,
	type CodeDiffGit,
	changedCodePaths,
	isCodeAncestor,
	resolveCodeCommit,
} from "./code-diff.js";
import type { ImplementationNextAction, PlanReviewRoute } from "./types.js";

export interface CorrectionEligibility {
	status: "eligible" | "ready" | "ordinary";
	route: PlanReviewRoute;
	nextAction: ImplementationNextAction;
	reason: string;
	itemId?: string;
}

function actionableItems(items: readonly VerdictItem[]): VerdictItem[] {
	return items.filter(
		(item) =>
			!(
				item.scopeClass === "pre_existing" &&
				item.lateDiscovery !== "critical_safety"
			),
	);
}

/**
 * Pure shortcut predicate. Empty actionable items are ordinary ready.
 * Unknown boundary impact, extra defects, and plan defects are not eligible.
 */
export function evaluateImplementationCorrectionEligibility(
	verdict: ReviewerVerdict,
): CorrectionEligibility {
	const actionable = actionableItems(verdict.items);
	if (actionable.length === 0) {
		return {
			status: "ready",
			route: "complete",
			nextAction: "complete",
			reason: "no_corrections",
		};
	}
	if (verdict.items.some((item) => item.scopeClass === "plan_defect")) {
		const amendment = verdict.items.some(
			(item) =>
				item.scopeClass === "plan_defect" &&
				item.planImpact?.kind !== "text_only",
		);
		return amendment
			? {
					status: "ordinary",
					route: "human_gate",
					nextAction: "plan_amendment",
					reason: "plan_defect",
				}
			: {
					status: "ordinary",
					route: "author_revision",
					nextAction: "author_revision",
					reason: "plan_defect",
				};
	}
	const human = actionable.some(
		(item) =>
			item.action === "human_required" ||
			item.scopeClass === "scope_expansion" ||
			item.lateDiscovery === "critical_safety" ||
			(item.boundaryChanges !== undefined && item.boundaryChanges.length > 0),
	);
	if (human) {
		return {
			status: "ordinary",
			route: "human_gate",
			nextAction: "human_gate",
			reason: "human_or_boundary",
		};
	}
	const defects = actionable.filter(
		(item) => item.scopeClass === "implementation_defect",
	);
	if (defects.length !== 1 || actionable.length !== 1) {
		return {
			status: "ordinary",
			route: "author_revision",
			nextAction: "author_revision",
			reason: defects.length > 1 ? "multiple_defects" : "not_a_single_defect",
		};
	}
	const item = defects[0];
	if (!item) {
		return {
			status: "ordinary",
			route: "author_revision",
			nextAction: "author_revision",
			reason: "not_a_single_defect",
		};
	}
	if (item.priority !== "P2") {
		return {
			status: "ordinary",
			route: "author_revision",
			nextAction: "author_revision",
			reason: "priority",
		};
	}
	if (item.boundaryChanges === undefined) {
		return {
			status: "ordinary",
			route: "author_revision",
			nextAction: "author_revision",
			reason: "unknown_boundary",
		};
	}
	if (
		item.action !== "auto_fix" ||
		item.architectureDelta !== 0 ||
		!item.mechanicalExplanation?.trim() ||
		item.requiresReviewerVerification === true ||
		item.lateDiscovery !== undefined ||
		item.priorDecisionId !== undefined ||
		item.newEvidence !== undefined
	) {
		return {
			status: "ordinary",
			route: "author_revision",
			nextAction: "author_revision",
			reason: "not_mechanical",
		};
	}
	return {
		status: "eligible",
		route: "final_corrections",
		nextAction: "author_revision",
		reason: "eligible",
		itemId: item.id,
	};
}

const MANIFESTS = new Set([
	"package.json",
	"cargo.toml",
	"go.mod",
	"pyproject.toml",
	"composer.json",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"gemfile",
	"package.swift",
]);

const LOCKFILES = new Set([
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"yarn.lock",
	"pnpm-lock.yaml",
	"cargo.lock",
	"go.sum",
	"poetry.lock",
	"composer.lock",
	"gemfile.lock",
]);

export type CorrectionPathClass = "clean" | "boundary" | "uncertain";

export function classifyCorrectionPath(
	path: string,
	planRepoPath: string | null,
): CorrectionPathClass {
	const norm = path.replaceAll("\\", "/").replace(/^\.\//u, "");
	const base = norm.slice(norm.lastIndexOf("/") + 1).toLowerCase();
	if (
		planRepoPath &&
		(norm === planRepoPath || norm.endsWith(`/${planRepoPath}`))
	) {
		return "boundary";
	}
	if (MANIFESTS.has(base) || LOCKFILES.has(base)) return "boundary";
	if (
		/\.(sql|prisma|proto|graphql)$/iu.test(norm) ||
		/openapi|swagger|\/migrations?\//iu.test(norm) ||
		/schema/iu.test(base)
	) {
		return "boundary";
	}
	if (
		/(^|\/)5x\.toml$/iu.test(norm) ||
		/(^|\/)tsconfig[^/]*\.json$/iu.test(norm) ||
		/(^|\/)(index|public-api)\.[cm]?[jt]sx?$/iu.test(norm) ||
		/\/api\//iu.test(norm) ||
		/\/public\//iu.test(norm)
	) {
		return "uncertain";
	}
	return "clean";
}

function boundaryLabel(
	path: string,
	planRepoPath: string | null,
): BoundaryChangeLabel {
	const norm = path.replaceAll("\\", "/");
	const base = norm.slice(norm.lastIndexOf("/") + 1).toLowerCase();
	if (
		planRepoPath &&
		(norm === planRepoPath || norm.endsWith(`/${planRepoPath}`))
	) {
		return "plan-structure";
	}
	if (MANIFESTS.has(base) || LOCKFILES.has(base)) return "dependency";
	if (/\.(sql|prisma|proto|graphql)$/iu.test(norm) || /schema/iu.test(base)) {
		return "schema";
	}
	if (/openapi|swagger/iu.test(norm)) return "api";
	return "architecture";
}

export interface CorrectionInventory {
	changedPaths: string[];
	inventoryClean: boolean;
	boundaryUncertain: boolean;
	boundaryChanges: BoundaryChangeLabel[];
	/** Explicit zero only when the inventory authorizes a proof. */
	architectureDelta: number;
	confined: boolean;
}

export function assessCorrectionInventory(input: {
	changedPaths: readonly string[];
	reviewedPaths: readonly string[];
	planRepoPath: string | null;
}): CorrectionInventory {
	const reviewed = new Set(
		input.reviewedPaths.map((path) => path.replaceAll("\\", "/")),
	);
	const boundaryChanges: BoundaryChangeLabel[] = [];
	let uncertain = false;
	let confined = true;
	for (const path of input.changedPaths) {
		const norm = path.replaceAll("\\", "/");
		const klass = classifyCorrectionPath(norm, input.planRepoPath);
		if (!reviewed.has(norm)) confined = false;
		if (klass === "boundary") {
			const label = boundaryLabel(norm, input.planRepoPath);
			if (!boundaryChanges.includes(label)) boundaryChanges.push(label);
		} else if (klass === "uncertain" || !reviewed.has(norm)) {
			uncertain = true;
		}
	}
	const inventoryClean = confined && !uncertain && boundaryChanges.length === 0;
	return {
		changedPaths: [...input.changedPaths],
		inventoryClean,
		boundaryUncertain: uncertain,
		boundaryChanges,
		architectureDelta: inventoryClean ? 0 : 0,
		confined,
	};
}

export function qualityConfigDigest(input: {
	gates: readonly string[];
	skipQualityGates: boolean;
	executionDirectory: string;
}): string {
	const body = JSON.stringify({
		gates: [...input.gates],
		skipQualityGates: input.skipQualityGates,
		executionDirectory: input.executionDirectory,
	});
	return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/** Copy originating assessments only for a still-eligible CLI proof. */
export function carryOriginatingClaims(input: {
	claims: readonly ImplementationClaimObservation[];
	proof: boolean;
}): ImplementationClaimObservation[] {
	if (!input.proof) return [];
	return input.claims.map((claim) => ({ ...claim }));
}

export function correctionAttemptIdentity(
	attempt: Pick<
		ImplementationCorrectionAttemptPayload,
		| "observationId"
		| "authorCommit"
		| "tree"
		| "qualityConfigDigest"
		| "executionDirectory"
	>,
): string {
	return [
		attempt.observationId,
		attempt.authorCommit,
		attempt.tree,
		attempt.qualityConfigDigest,
		attempt.executionDirectory,
	].join("\0");
}

export function shortcutLatched(
	attempts: readonly Pick<
		ImplementationCorrectionAttemptPayload,
		"shortcutInvalidated"
	>[],
): boolean {
	return attempts.some((attempt) => attempt.shortcutInvalidated);
}

function numericPhaseId(phase: string): string | null {
	const trimmed = phase.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
	const prefixed = trimmed.match(/^phase[\s-]+(\d+(?:\.\d+)?)$/i);
	return prefixed?.[1] ?? null;
}

export function phaseIdsMatch(left: string, right: string): boolean {
	const a = numericPhaseId(left);
	const b = numericPhaseId(right);
	return a !== null && a === b;
}

export function authorRecordedCommit(input: {
	recordStore: RecordStore;
	runId: string;
	phase: string;
	commit: string;
}): boolean {
	for (const line of input.recordStore.listLines(input.runId, "steps")) {
		const payload = line.payload as Partial<StepRecordPayload>;
		if (
			typeof payload.step_name !== "string" ||
			!payload.step_name.startsWith("author:")
		) {
			continue;
		}
		if (
			typeof payload.phase !== "string" ||
			!phaseIdsMatch(payload.phase, input.phase)
		) {
			continue;
		}
		const result =
			payload.result_json &&
			typeof payload.result_json === "object" &&
			!Array.isArray(payload.result_json)
				? (payload.result_json as { commit?: unknown; result?: unknown })
				: null;
		const resultCommit =
			typeof result?.commit === "string" ? result.commit : null;
		if (payload.head_commit === input.commit || resultCommit === input.commit) {
			return true;
		}
	}
	return false;
}

export interface CorrectionQualityResult {
	passed: boolean;
	skipped?: boolean;
	results: Array<{
		command?: string;
		passed?: boolean;
		duration_ms?: number;
		output?: string;
	}>;
	workdir: string;
}

export interface FinishCorrectionInput {
	runId: string;
	phase: string;
	observationId: string;
	commit: string;
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	origin: RecordOrigin;
	executionDirectory: string;
	planRepoPath: string | null;
	gates: readonly string[];
	skipQualityGates: boolean;
	git: CodeDiffGit;
	runQuality: () => Promise<CorrectionQualityResult>;
	now?: () => string;
}

export type FinishCorrectionResult =
	| {
			status: "complete";
			resumed: boolean;
			route: "complete";
			nextAction: "complete";
			attempt: ImplementationCorrectionAttemptPayload;
			carriedClaims: ImplementationClaimObservation[];
	  }
	| {
			status: "reentry";
			route: "author_revision";
			nextAction: "author_revision";
			reason: string;
			attempt: ImplementationCorrectionAttemptPayload | null;
	  }
	| {
			status: "ordinary";
			route: PlanReviewRoute;
			nextAction: ImplementationNextAction;
			reason: string;
	  }
	| { status: "error"; code: string; message: string };

function reviewedPaths(context: ImplementationReviewContextPayload): string[] {
	const paths = new Set<string>();
	for (const hunk of context.hunks) {
		if (hunk.newPath) paths.add(hunk.newPath);
		if (hunk.oldPath && hunk.oldPath !== hunk.newPath) paths.add(hunk.oldPath);
	}
	return [...paths];
}

function gateTimedOut(result: { output?: string; passed?: boolean }): boolean {
	return (
		result.passed === false &&
		typeof result.output === "string" &&
		result.output.includes("[TIMEOUT]")
	);
}

function proofFrom(input: {
	passed: boolean;
	latched: boolean;
	inventory: CorrectionInventory;
	skipped: boolean;
	timedOut: boolean;
	emptyConfig: boolean;
	workdirMatches: boolean;
}): boolean {
	return (
		input.passed &&
		!input.latched &&
		!input.skipped &&
		!input.timedOut &&
		!input.emptyConfig &&
		input.workdirMatches &&
		input.inventory.inventoryClean &&
		!input.inventory.boundaryUncertain &&
		input.inventory.boundaryChanges.length === 0 &&
		input.inventory.architectureDelta === 0
	);
}

async function readTree(git: CodeDiffGit, commit: string): Promise<string> {
	const resolved = await resolveCodeCommit(git, commit);
	const tree = await git.exec(["rev-parse", `${resolved}^{tree}`]);
	if (tree.exitCode !== 0 || !tree.stdout.trim()) {
		throw new Error(tree.stderr.trim() || `Cannot resolve tree for ${commit}`);
	}
	return tree.stdout.trim();
}

function stamp(
	input: FinishCorrectionInput,
	fields: Omit<
		ImplementationCorrectionAttemptPayload,
		"kind" | "version" | "id" | "createdAt"
	>,
): ImplementationCorrectionAttemptPayload {
	return {
		kind: "implementation-correction-attempt",
		version: IMPLEMENTATION_STATE_VERSION,
		id: createReviewBudgetId(),
		createdAt: (input.now ?? (() => new Date().toISOString()))(),
		...fields,
	};
}

/**
 * Validate the recorded author commit and originating eligibility, then run
 * the full layered quality configuration. No gate override or passed flag is
 * accepted. A prior failure latches reviewer re-entry.
 */
export async function finishImplementationCorrection(
	input: FinishCorrectionInput,
): Promise<FinishCorrectionResult> {
	let observation: ImplementationReviewObservationPayload | undefined;
	try {
		observation = input.store
			.listImplementationReviews(input.runId)
			.find((candidate) => candidate.id === input.observationId);
	} catch (error) {
		return {
			status: "error",
			code: "IMPLEMENTATION_REVIEW_RECORD_CORRUPT",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	if (!observation || !phaseIdsMatch(observation.phase, input.phase)) {
		return {
			status: "error",
			code: "CORRECTION_OBSERVATION_NOT_FOUND",
			message: `Implementation observation ${input.observationId} is not recorded for phase ${input.phase}.`,
		};
	}
	const eligibility = evaluateImplementationCorrectionEligibility(
		observation.originalVerdict,
	);
	if (eligibility.status !== "eligible") {
		return {
			status: "ordinary",
			route: eligibility.route,
			nextAction: eligibility.nextAction,
			reason: eligibility.reason,
		};
	}
	if (
		!authorRecordedCommit({
			recordStore: input.recordStore,
			runId: input.runId,
			phase: input.phase,
			commit: input.commit,
		})
	) {
		return {
			status: "error",
			code: "CORRECTION_AUTHOR_COMMIT_NOT_RECORDED",
			message: `Commit ${input.commit} is not the recorded author result for phase ${input.phase}.`,
		};
	}
	const context = input.store.getImplementationReviewContext(
		input.runId,
		observation.contextId,
	);
	if (!context || context.bindingId !== observation.bindingId) {
		return {
			status: "error",
			code: "CORRECTION_CONTEXT_NOT_FOUND",
			message: `Review context ${observation.contextId} is not recorded for this observation.`,
		};
	}
	let head: string;
	let tree: string;
	try {
		const resolved = await resolveCodeCommit(input.git, input.commit);
		head = await resolveCodeCommit(input.git, "HEAD");
		if (head !== resolved) {
			return {
				status: "reentry",
				route: "author_revision",
				nextAction: "author_revision",
				reason: "commit_mismatch",
				attempt: null,
			};
		}
		if (!(await isCodeAncestor(input.git, context.reviewedCommit, resolved))) {
			return {
				status: "error",
				code: "CORRECTION_COMMIT_NOT_DESCENDANT",
				message: `Correction commit ${resolved} is not a descendant of reviewed commit ${context.reviewedCommit}.`,
			};
		}
		tree = await readTree(input.git, resolved);
		await assertCleanCodeWorktree(input.git, context.excludedPaths);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("uncommitted")) {
			return {
				status: "error",
				code: "CORRECTION_DIRTY_TREE",
				message,
			};
		}
		return {
			status: "error",
			code: "CORRECTION_GIT_ERROR",
			message,
		};
	}
	const digest = qualityConfigDigest({
		gates: input.gates,
		skipQualityGates: input.skipQualityGates,
		executionDirectory: input.executionDirectory,
	});
	let attempts: ImplementationCorrectionAttemptPayload[];
	try {
		attempts = input.store.listImplementationCorrectionAttempts(
			input.runId,
			observation.id,
		);
	} catch (error) {
		return {
			status: "error",
			code: "CORRECTION_ATTEMPT_CORRUPT",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	const latched = shortcutLatched(attempts);
	const identity = correctionAttemptIdentity({
		observationId: observation.id,
		authorCommit: input.commit,
		tree,
		qualityConfigDigest: digest,
		executionDirectory: input.executionDirectory,
	});
	const same = attempts.find(
		(attempt) => correctionAttemptIdentity(attempt) === identity,
	);
	if (
		same &&
		same.outcome === "passed" &&
		!same.shortcutInvalidated &&
		!latched &&
		same.inventoryClean &&
		!same.boundaryUncertain &&
		same.boundaryChanges.length === 0 &&
		same.architectureDelta === 0
	) {
		return {
			status: "complete",
			resumed: true,
			route: "complete",
			nextAction: "complete",
			attempt: same,
			carriedClaims: same.carriedClaims,
		};
	}
	const changed = attempts.some(
		(attempt) =>
			attempt.authorCommit !== input.commit ||
			attempt.tree !== tree ||
			attempt.qualityConfigDigest !== digest ||
			attempt.executionDirectory !== input.executionDirectory,
	);
	if (changed) {
		return {
			status: "reentry",
			route: "author_revision",
			nextAction: "author_revision",
			reason: "new_evidence",
			attempt: null,
		};
	}
	const emptyConfig = input.skipQualityGates || input.gates.length === 0;
	let quality: CorrectionQualityResult | null = null;
	if (!emptyConfig) {
		try {
			quality = await input.runQuality();
		} catch {
			return {
				status: "reentry",
				route: "author_revision",
				nextAction: "author_revision",
				reason: "quality_incomplete",
				attempt: null,
			};
		}
	}
	const timedOut = (quality?.results ?? []).some((result) =>
		gateTimedOut(result),
	);
	const skippedGate =
		emptyConfig ||
		quality?.skipped === true ||
		(quality?.results ?? []).length === 0;
	const workdirMatches =
		!quality || quality.workdir === input.executionDirectory;
	let inventory: CorrectionInventory;
	let dirtyAfter = false;
	try {
		const paths = await changedCodePaths(
			input.git,
			context.reviewedCommit,
			input.commit,
			context.excludedPaths,
		);
		inventory = assessCorrectionInventory({
			changedPaths: paths,
			reviewedPaths: reviewedPaths(context),
			planRepoPath: input.planRepoPath,
		});
		await assertCleanCodeWorktree(input.git, context.excludedPaths);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("uncommitted")) {
			return {
				status: "error",
				code: "CORRECTION_GIT_ERROR",
				message,
			};
		}
		dirtyAfter = true;
		inventory = {
			changedPaths: [],
			inventoryClean: false,
			boundaryUncertain: true,
			boundaryChanges: [],
			architectureDelta: 0,
			confined: false,
		};
	}
	const passed =
		quality?.passed === true &&
		!timedOut &&
		!skippedGate &&
		workdirMatches &&
		!dirtyAfter;
	const invalidate =
		latched ||
		!passed ||
		timedOut ||
		skippedGate ||
		!workdirMatches ||
		!inventory.inventoryClean ||
		inventory.boundaryUncertain ||
		inventory.boundaryChanges.length > 0;
	const proof = proofFrom({
		passed,
		latched,
		inventory,
		skipped: skippedGate,
		timedOut,
		emptyConfig,
		workdirMatches,
	});
	const carried = carryOriginatingClaims({
		claims: observation.claimObservations,
		proof,
	});
	const reason = dirtyAfter
		? "dirty_tree"
		: !workdirMatches
			? "wrong_workdir"
			: skippedGate
				? "quality_skipped"
				: timedOut
					? "quality_timeout"
					: quality?.passed !== true
						? "quality_failed"
						: !inventory.inventoryClean || inventory.boundaryUncertain
							? "boundary_uncertain"
							: latched
								? "shortcut_invalidated"
								: "passed";
	const qualityFailure = !passed || timedOut || skippedGate || emptyConfig;
	const attempt = stamp(input, {
		runId: input.runId,
		observationId: observation.id,
		phase: observation.phase,
		bindingId: observation.bindingId,
		authorCommit: input.commit,
		tree,
		qualityConfigDigest: digest,
		executionDirectory: input.executionDirectory,
		outcome: proof ? "passed" : qualityFailure ? "failed" : "invalidated",
		shortcutInvalidated: invalidate,
		reason,
		qualityPassed: quality?.passed === true,
		qualitySkipped: skippedGate,
		qualityTimedOut: timedOut,
		qualityResults: (quality?.results ?? []).map((result) => ({
			command: result.command ?? "",
			passed: result.passed === true,
			durationMs: result.duration_ms ?? 0,
			timedOut: gateTimedOut(result),
		})),
		architectureDelta: proof ? 0 : inventory.architectureDelta,
		boundaryChanges: proof ? [] : inventory.boundaryChanges,
		changedPaths: inventory.changedPaths,
		inventoryClean: proof,
		boundaryUncertain: inventory.boundaryUncertain || !inventory.confined,
		sourceObservationId: observation.id,
		assessedCommit: context.reviewedCommit,
		destinationCommit: input.commit,
		carriedClaims: carried,
		qualityRerun: attempts.length + 1,
	});
	const saved = input.store.saveImplementationCorrectionAttempt(
		attempt,
		input.origin,
	);
	if (proof) {
		return {
			status: "complete",
			resumed: false,
			route: "complete",
			nextAction: "complete",
			attempt: saved.payload,
			carriedClaims: saved.payload.carriedClaims,
		};
	}
	return {
		status: "reentry",
		route: "author_revision",
		nextAction: "author_revision",
		reason,
		attempt: saved.payload,
	};
}
