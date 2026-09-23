/**
 * Contextual implementation-review validation and classification.
 *
 * Structural emit/validate accepts the plan/implementation union. This module
 * selects the domain from the admitted phase and persisted binding, never from
 * an item enum or an agent-supplied review kind. Standalone callers that omit
 * the approved text anchor cannot authorize text-only spans.
 */

import {
	isImplementationScopeClass,
	isPlanScopeClass,
	type ReviewerVerdict,
	type VerdictItem,
} from "../protocol.js";
import type { ImplementationTextAmendmentPayload } from "../review-budget/record-lines.js";
import { detectPlanDrift } from "./implementation-state.js";
import type {
	ImplementationDiagnostic,
	ImplementationDiagnosticCode,
	ImplementationGovernanceResult,
	ImplementationNextAction,
	PlanReviewRoute,
	ResolvedPlanImpactSpan,
	ReviewDomain,
} from "./types.js";

const PROTECTED_SECTION_HEADINGS = new Set([
	"design decisions",
	"acceptance",
	"scope",
	"not in scope",
]);

export interface ImplementationValidationInput {
	verdict: ReviewerVerdict;
	/** Command phase. Domain resolution never reads an agent reviewKind. */
	phase?: string;
	envelopePhase?: string;
	/**
	 * Agent-supplied domain flag (`domain`, or `reviewKind` when it is
	 * `plan` / `implementation`). It is compared, never used to select.
	 */
	envelopeDomain?: string;
	mode: "off" | "advisory" | "enforced";
	/** Persisted v1 compatibility disposition. Skips implementation certification. */
	compatibility?: boolean;
	/** Binding phase ids. Omit when no binding is available to certify against. */
	phaseIds?: readonly string[];
	workItemIds?: readonly string[];
	creditClaimIds?: readonly string[];
	approvedPlanBytes?: string;
	approvedPlanHash?: string;
	amendments?: readonly ImplementationTextAmendmentPayload[];
	priorReviewCount?: number;
	/** Ignored. A fresh session does not reset the phase review round. */
	sessionId?: string;
}

export interface ImplementationValidationResult {
	valid: boolean;
	accepted: boolean;
	domain: ReviewDomain | "v1" | "standalone";
	fatalCode?: string;
	fatalMessage?: string;
	diagnostics: ImplementationDiagnostic[];
	spans: ResolvedPlanImpactSpan[];
	exemptionAuthorized: boolean;
	governance: ImplementationGovernanceResult | null;
}

interface MarkdownLine {
	text: string;
	start: number;
	end: number;
}

interface HeadingSpan {
	level: number;
	text: string;
	lineStart: number;
	lineEnd: number;
	sectionEnd: number;
}

export function canonicalPhaseId(phase: string): string | null {
	const trimmed = phase.trim();
	if (trimmed === "plan") return "plan";
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
	const prefixed = trimmed.match(/^phase[\s-]+(\d+(?:\.\d+)?)\b/i);
	return prefixed?.[1] ?? null;
}

/** Review round follows persisted observations. `sessionId` does not reset it. */
export function implementationReviewRound(
	priorReviewCount: number,
	_sessionId?: string,
): number {
	if (!Number.isInteger(priorReviewCount) || priorReviewCount < 0) {
		throw new TypeError("priorReviewCount must be a nonnegative integer");
	}
	return priorReviewCount + 1;
}

export function verdictUsesImplementationContract(
	verdict: ReviewerVerdict,
): boolean {
	if (verdict.creditRealizations !== undefined) return true;
	if (verdict.nonblocking !== undefined) return true;
	return verdict.items.some(
		(item) =>
			isImplementationScopeClass(item.scopeClass) ||
			item.planImpact !== undefined ||
			item.planWorkItemIds !== undefined ||
			item.boundaryChanges !== undefined ||
			item.mechanicalExplanation !== undefined,
	);
}

export function verdictUsesPlanContract(verdict: ReviewerVerdict): boolean {
	if (verdict.baselineAssessment !== undefined) return true;
	if (verdict.creditAssessments !== undefined) return true;
	return verdict.items.some(
		(item) =>
			isPlanScopeClass(item.scopeClass) || item.creditClaim !== undefined,
	);
}

function diagnostic(
	code: ImplementationDiagnosticCode,
	message: string,
	severity: ImplementationDiagnostic["severity"] = "error",
	itemId?: string,
): ImplementationDiagnostic {
	return { code, severity, message, ...(itemId ? { itemId } : {}) };
}

function byteOffset(text: string, charIndex: number): number {
	return Buffer.byteLength(text.slice(0, charIndex), "utf8");
}

function markdownLines(markdown: string): MarkdownLine[] {
	const rawLines = markdown.split("\n");
	const lines: MarkdownLine[] = [];
	let offset = 0;
	for (let index = 0; index < rawLines.length; index++) {
		const raw = rawLines[index] ?? "";
		const start = offset;
		const hasNewline = index < rawLines.length - 1;
		offset += raw.length + (hasNewline ? 1 : 0);
		lines.push({
			text: raw.replace(/\r$/, ""),
			start,
			end: offset,
		});
	}
	return lines;
}

function fenceMarker(line: string): string | null {
	return line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1] ?? null;
}

function headingSpans(markdown: string): HeadingSpan[] {
	const lines = markdownLines(markdown);
	const headings: Array<Omit<HeadingSpan, "sectionEnd">> = [];
	let activeFence: string | null = null;
	for (const line of lines) {
		const marker = fenceMarker(line.text);
		if (activeFence) {
			if (
				marker !== null &&
				marker[0] === activeFence[0] &&
				marker.length >= activeFence.length &&
				line.text.slice(line.text.indexOf(marker) + marker.length).trim()
					.length === 0
			) {
				activeFence = null;
			}
			continue;
		}
		if (marker) {
			activeFence = marker;
			continue;
		}
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.text);
		if (!match?.[1] || !match[2]) continue;
		headings.push({
			level: match[1].length,
			text: match[2].trim(),
			lineStart: line.start,
			lineEnd: line.end,
		});
	}
	return headings.map((heading, index) => {
		let sectionEnd = markdown.length;
		for (const later of headings.slice(index + 1)) {
			if (later.level <= heading.level) {
				sectionEnd = later.lineStart;
				break;
			}
		}
		return { ...heading, sectionEnd };
	});
}

function rangesOverlap(
	left: { start: number; end: number },
	right: { start: number; end: number },
): boolean {
	return left.start < right.end && right.start < left.end;
}

function protectedCharRanges(markdown: string): Array<{
	start: number;
	end: number;
}> {
	const lines = markdownLines(markdown);
	const headings = headingSpans(markdown);
	const ranges: Array<{ start: number; end: number }> = [];
	for (const heading of headings) {
		ranges.push({ start: heading.lineStart, end: heading.lineEnd });
		if (PROTECTED_SECTION_HEADINGS.has(heading.text.toLowerCase())) {
			ranges.push({ start: heading.lineStart, end: heading.sectionEnd });
		}
	}
	const budget = headings.find((heading) => heading.text === "Delivery Budget");
	let activeFence: string | null = null;
	for (const line of lines) {
		const marker = fenceMarker(line.text);
		if (activeFence) {
			if (
				marker !== null &&
				marker[0] === activeFence[0] &&
				marker.length >= activeFence.length &&
				line.text.slice(line.text.indexOf(marker) + marker.length).trim()
					.length === 0
			) {
				activeFence = null;
			}
			continue;
		}
		if (marker) {
			activeFence = marker;
			continue;
		}
		if (/^#{2,3}\s+Phase\s+\d/.test(line.text)) {
			ranges.push({ start: line.start, end: line.end });
		}
		if (/^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]/.test(line.text)) {
			ranges.push({ start: line.start, end: line.end });
		}
		if (
			budget &&
			line.start >= budget.lineStart &&
			line.start < budget.sectionEnd &&
			/^\s*\|/.test(line.text)
		) {
			ranges.push({ start: line.start, end: line.end });
		}
	}
	return ranges;
}

function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = [];
	if (needle.length === 0) return found;
	let from = 0;
	while (from <= haystack.length) {
		const index = haystack.indexOf(needle, from);
		if (index < 0) break;
		found.push(index);
		from = index + 1;
	}
	return found;
}

export type PlanImpactSpanResolution =
	| { status: "resolved"; spans: ResolvedPlanImpactSpan[] }
	| {
			status: "ambiguous";
			code: "PLAN_IMPACT_AMBIGUOUS";
			message: string;
			itemId?: string;
	  }
	| {
			status: "rejected";
			code: "PLAN_IMPACT_OVERLAP" | "PLAN_IMPACT_PROTECTED";
			message: string;
			itemId?: string;
	  };

export function resolvePlanImpactSpans(input: {
	anchorText: string;
	locations: ReadonlyArray<{
		itemId: string;
		heading: string;
		staleText: string;
	}>;
}): PlanImpactSpanResolution {
	const seen = new Set<string>();
	for (const location of input.locations) {
		const key = `${location.heading}\0${location.staleText}`;
		if (seen.has(key)) {
			return {
				status: "rejected",
				code: "PLAN_IMPACT_OVERLAP",
				message: `Duplicate planImpact location under '${location.heading}'.`,
				itemId: location.itemId,
			};
		}
		seen.add(key);
	}
	const headings = headingSpans(input.anchorText);
	const protectedRanges = protectedCharRanges(input.anchorText);
	const spans: Array<
		ResolvedPlanImpactSpan & { charStart: number; charEnd: number }
	> = [];
	for (const location of input.locations) {
		const matches = headings.filter(
			(heading) => heading.text === location.heading,
		);
		if (matches.length !== 1) {
			return {
				status: "ambiguous",
				code: "PLAN_IMPACT_AMBIGUOUS",
				message:
					matches.length === 0
						? `Heading '${location.heading}' does not match the approved text anchor.`
						: `Heading '${location.heading}' is ambiguous in the approved text anchor.`,
				itemId: location.itemId,
			};
		}
		const section = matches[0];
		if (!section) continue;
		const body = input.anchorText.slice(section.lineStart, section.sectionEnd);
		const hits = occurrences(body, location.staleText);
		if (hits.length !== 1) {
			return {
				status: "ambiguous",
				code: "PLAN_IMPACT_AMBIGUOUS",
				message:
					hits.length === 0
						? `staleText under '${location.heading}' does not occur in that section.`
						: `staleText under '${location.heading}' occurs ${hits.length} times; expected one.`,
				itemId: location.itemId,
			};
		}
		const charStart = section.lineStart + (hits[0] ?? 0);
		const charEnd = charStart + location.staleText.length;
		const candidate = { start: charStart, end: charEnd };
		if (protectedRanges.some((range) => rangesOverlap(candidate, range))) {
			return {
				status: "rejected",
				code: "PLAN_IMPACT_PROTECTED",
				message: `planImpact span under '${location.heading}' intersects protected table or structure.`,
				itemId: location.itemId,
			};
		}
		spans.push({
			itemId: location.itemId,
			heading: location.heading,
			staleText: location.staleText,
			start: byteOffset(input.anchorText, charStart),
			end: byteOffset(input.anchorText, charEnd),
			charStart,
			charEnd,
		});
	}
	for (let index = 0; index < spans.length; index++) {
		const left = spans[index];
		if (!left) continue;
		for (const right of spans.slice(index + 1)) {
			if (
				rangesOverlap(
					{ start: left.charStart, end: left.charEnd },
					{ start: right.charStart, end: right.charEnd },
				)
			) {
				return {
					status: "rejected",
					code: "PLAN_IMPACT_OVERLAP",
					message: "planImpact locations overlap in the approved text anchor.",
					itemId: left.itemId,
				};
			}
		}
	}
	return {
		status: "resolved",
		spans: spans.map(
			({ charStart: _charStart, charEnd: _charEnd, ...span }) => span,
		),
	};
}

function renderNonblocking(
	observations: NonNullable<ReviewerVerdict["nonblocking"]>,
	excluded: readonly VerdictItem[],
): string {
	const lines = [
		...observations.map(
			(observation) =>
				`- ${observation.id}: ${observation.title} — ${observation.reason}`,
		),
		...excluded.map((item) => `- ${item.id}: ${item.title} — ${item.reason}`),
	];
	if (lines.length === 0) return "";
	return ["## Nonblocking", ...lines].join("\n");
}

function fatal(
	domain: ImplementationValidationResult["domain"],
	code: string,
	message: string,
	diagnostics: ImplementationDiagnostic[] = [],
): ImplementationValidationResult {
	return {
		valid: false,
		accepted: false,
		domain,
		fatalCode: code,
		fatalMessage: message,
		diagnostics,
		spans: [],
		exemptionAuthorized: false,
		governance: null,
	};
}

function textOnlyLocations(verdict: ReviewerVerdict): Array<{
	itemId: string;
	heading: string;
	staleText: string;
}> {
	const locations: Array<{
		itemId: string;
		heading: string;
		staleText: string;
	}> = [];
	for (const item of verdict.items) {
		if (
			item.scopeClass !== "plan_defect" ||
			item.planImpact?.kind !== "text_only"
		) {
			continue;
		}
		for (const location of item.planImpact.locations) {
			locations.push({
				itemId: item.id,
				heading: location.heading,
				staleText: location.staleText,
			});
		}
	}
	return locations;
}

function shortcutShape(item: VerdictItem): boolean {
	return (
		item.scopeClass === "implementation_defect" &&
		item.priority === "P2" &&
		item.action === "auto_fix" &&
		item.architectureDelta === 0 &&
		item.requiresReviewerVerification !== true &&
		item.lateDiscovery === undefined
	);
}

function classify(input: {
	verdict: ReviewerVerdict;
	phase: string;
	mode: "advisory" | "enforced";
	reviewRound: number;
	spansAuthorized: boolean;
	diagnostics: ImplementationDiagnostic[];
}): ImplementationGovernanceResult {
	const actionable: VerdictItem[] = [];
	const excludedPreExisting: VerdictItem[] = [];
	let planAmendment = false;
	let alwaysHuman = false;
	let enforcedHuman = false;
	let auto = false;
	for (const item of input.verdict.items) {
		if (
			item.scopeClass === "pre_existing" &&
			item.lateDiscovery !== "critical_safety"
		) {
			excludedPreExisting.push(item);
			input.diagnostics.push(
				diagnostic(
					"PRE_EXISTING_NOT_ACTIONABLE",
					`Finding '${item.id}' is an ordinary pre-existing observation and belongs in nonblocking Markdown, not items[].`,
					"error",
					item.id,
				),
			);
			continue;
		}
		if (
			item.scopeClass === "pre_existing" &&
			item.lateDiscovery === "critical_safety"
		) {
			actionable.push(item);
			alwaysHuman = true;
			input.diagnostics.push(
				diagnostic(
					"CRITICAL_PRE_EXISTING_REQUIRES_HUMAN",
					`Finding '${item.id}' is critical pre-existing safety and routes to a human.`,
					"info",
					item.id,
				),
			);
			continue;
		}
		if (item.scopeClass === "scope_expansion") {
			actionable.push(item);
			alwaysHuman = true;
			if (item.action === "auto_fix") {
				input.diagnostics.push(
					diagnostic(
						"SCOPE_EXPANSION_NOT_AUTO",
						`Finding '${item.id}' is scope expansion and is never automatically implemented.`,
						"info",
						item.id,
					),
				);
			}
			continue;
		}
		if (item.scopeClass === "plan_defect") {
			actionable.push(item);
			const kind = item.planImpact?.kind;
			const textOnlyAuthorized = kind === "text_only" && input.spansAuthorized;
			if (!textOnlyAuthorized) {
				planAmendment = true;
				alwaysHuman = true;
			} else {
				auto = true;
			}
			continue;
		}
		if (item.scopeClass === "implementation_defect") {
			actionable.push(item);
			const boundaries = item.boundaryChanges;
			if (boundaries && boundaries.length > 0) {
				enforcedHuman = true;
				input.diagnostics.push(
					diagnostic(
						"SOURCE_OF_CORRECTION_PRECEDENCE",
						`Finding '${item.id}' changes ${boundaries.join(", ")} and is a plan or scope decision, even if it is also a bug.`,
						"error",
						item.id,
					),
				);
				continue;
			}
			if (item.action === "human_required") {
				alwaysHuman = true;
				continue;
			}
			auto = true;
			if (
				shortcutShape(item) &&
				input.verdict.items.filter(
					(candidate) => candidate.scopeClass === "implementation_defect",
				).length === 1
			) {
				if (boundaries === undefined) {
					input.diagnostics.push(
						diagnostic(
							"BOUNDARY_IMPACT_UNKNOWN",
							`Finding '${item.id}' has no explicit boundaryChanges. Unknown impact stays on normal review.`,
							"info",
							item.id,
						),
					);
				} else if (!item.mechanicalExplanation?.trim()) {
					input.diagnostics.push(
						diagnostic(
							"BOUNDARY_IMPACT_UNKNOWN",
							`Finding '${item.id}' has no mechanical explanation. The shortcut stays on normal review.`,
							"info",
							item.id,
						),
					);
				}
			}
		}
	}
	const enforcedRoute: PlanReviewRoute =
		planAmendment || alwaysHuman || enforcedHuman
			? "human_gate"
			: auto
				? "author_revision"
				: input.verdict.readiness === "ready"
					? "complete"
					: "human_gate";
	const nextAction: ImplementationNextAction = planAmendment
		? "plan_amendment"
		: enforcedRoute === "human_gate"
			? "human_gate"
			: enforcedRoute === "complete"
				? "complete"
				: "author_revision";
	const soleDefect = actionable.filter(
		(item) => item.scopeClass === "implementation_defect",
	);
	const shortcutCandidate =
		input.mode === "enforced" &&
		!planAmendment &&
		!alwaysHuman &&
		!enforcedHuman &&
		soleDefect.length === 1 &&
		soleDefect[0] !== undefined &&
		shortcutShape(soleDefect[0]) &&
		soleDefect[0].boundaryChanges?.length === 0 &&
		Boolean(soleDefect[0].mechanicalExplanation?.trim()) &&
		actionable.length === 1;
	const advisoryBlocked = alwaysHuman || planAmendment;
	const advisoryRoute: PlanReviewRoute = advisoryBlocked
		? "human_gate"
		: input.verdict.readiness === "ready" && actionable.length === 0
			? "complete"
			: actionable.some((item) => item.action === "human_required")
				? "human_gate"
				: auto || enforcedHuman
					? "author_revision"
					: input.verdict.readiness === "not_ready"
						? "human_gate"
						: "complete";
	return {
		domain: "implementation",
		phase: input.phase,
		reviewRound: input.reviewRound,
		route: input.mode === "enforced" ? enforcedRoute : advisoryRoute,
		nextAction:
			input.mode === "enforced"
				? nextAction
				: advisoryRoute === "human_gate"
					? planAmendment
						? "plan_amendment"
						: "human_gate"
					: advisoryRoute === "complete"
						? "complete"
						: "author_revision",
		...(input.mode === "advisory"
			? { hypotheticalEnforcedRoute: enforcedRoute }
			: {}),
		shortcutCandidate,
		exemptionAuthorized: input.spansAuthorized,
		actionableItems: actionable,
		nonblockingMarkdown: renderNonblocking(
			input.verdict.nonblocking ?? [],
			excludedPreExisting,
		),
		diagnostics: input.diagnostics,
	};
}

export function validateImplementationReview(
	input: ImplementationValidationInput,
): ImplementationValidationResult {
	const commandPhase = input.phase?.trim();
	const envelopePhase = input.envelopePhase?.trim();
	if (
		commandPhase &&
		envelopePhase &&
		commandPhase !== envelopePhase &&
		canonicalPhaseId(commandPhase) !== canonicalPhaseId(envelopePhase)
	) {
		return fatal(
			"standalone",
			"PHASE_CONFLICT",
			`Phase flag '${commandPhase}' conflicts with envelope phase '${envelopePhase}'.`,
		);
	}
	const phase = commandPhase ?? envelopePhase;
	const phaseId = phase ? canonicalPhaseId(phase) : null;
	const implementationContract = verdictUsesImplementationContract(
		input.verdict,
	);
	const planContract = verdictUsesPlanContract(input.verdict);
	if (
		(input.envelopeDomain === "plan" && implementationContract) ||
		(input.envelopeDomain === "implementation" && planContract) ||
		(input.envelopeDomain === "plan" &&
			phaseId !== null &&
			phaseId !== "plan") ||
		(input.envelopeDomain === "implementation" && phaseId === "plan")
	) {
		return fatal(
			phaseId === "plan" ? "plan" : "implementation",
			"PHASE_CONFLICT",
			"Phase flag, envelope domain, and review contract conflict. Domain is not taken from the agent flag.",
		);
	}
	if (phaseId === "plan" && implementationContract) {
		return fatal(
			"plan",
			"IMPLEMENTATION_CONTRACT_IN_PLAN_PHASE",
			"Implementation scope is not valid in a plan review phase.",
		);
	}
	if (phaseId === "plan" || (!implementationContract && phaseId !== null)) {
		return {
			valid: true,
			accepted: true,
			domain: phaseId === "plan" ? "plan" : "standalone",
			diagnostics: [],
			spans: [],
			exemptionAuthorized: false,
			governance: null,
		};
	}
	if (input.mode === "off" || input.compatibility) {
		return {
			valid: true,
			accepted: true,
			domain: "v1",
			diagnostics: [],
			spans: [],
			exemptionAuthorized: false,
			governance: null,
		};
	}
	if (!phase || phaseId === null) {
		return fatal(
			"implementation",
			"UNKNOWN_PHASE",
			`Phase '${phase ?? ""}' is not a known plan or implementation phase.`,
		);
	}
	const certifying = input.phaseIds !== undefined;
	if (certifying && !input.phaseIds?.includes(phaseId)) {
		return fatal(
			"implementation",
			"UNKNOWN_PHASE",
			`Phase '${phaseId}' is not in the approved plan phase map.`,
		);
	}
	if (!certifying && input.mode === "enforced") {
		return fatal(
			"implementation",
			"IMPLEMENTATION_CONTEXT_MISSING",
			"Enforced implementation review requires a persisted binding before work-item linkage or span authorization.",
		);
	}
	const diagnostics: ImplementationDiagnostic[] = [];
	if (!certifying) {
		diagnostics.push(
			diagnostic(
				"IMPLEMENTATION_CONTEXT_MISSING",
				"No persisted binding is available. Work-item linkage and span authorization are not certified.",
				"info",
			),
		);
	}
	if (certifying && planContract) {
		return fatal(
			"implementation",
			"PLAN_CONTRACT_IN_IMPLEMENTATION_PHASE",
			"Plan baseline, credit assessment, or plan scope fields are not valid in an implementation review.",
			diagnostics,
		);
	}
	if (input.workItemIds) {
		const known = new Set(input.workItemIds);
		for (const item of input.verdict.items) {
			for (const id of item.planWorkItemIds ?? []) {
				if (!known.has(id)) {
					return fatal(
						"implementation",
						"WORK_ITEM_UNKNOWN",
						`Finding '${item.id}' references unknown approved work item '${id}'.`,
						[
							...diagnostics,
							diagnostic(
								"WORK_ITEM_UNKNOWN",
								`Finding '${item.id}' references unknown approved work item '${id}'.`,
								"error",
								item.id,
							),
						],
					);
				}
			}
		}
	}
	if (input.creditClaimIds && input.verdict.creditRealizations) {
		const known = new Set(input.creditClaimIds);
		for (const realization of input.verdict.creditRealizations) {
			if (!known.has(realization.creditClaimId)) {
				return fatal(
					"implementation",
					"CREDIT_CLAIM_UNKNOWN",
					`Credit realization references unknown claim '${realization.creditClaimId}'.`,
				);
			}
		}
	}
	let spans: ResolvedPlanImpactSpan[] = [];
	let spansAuthorized = false;
	const locations = textOnlyLocations(input.verdict);
	if (locations.length > 0) {
		if (
			input.approvedPlanBytes === undefined ||
			input.approvedPlanHash === undefined
		) {
			diagnostics.push(
				diagnostic(
					"PLAN_IMPACT_NOT_AUTHORIZED",
					"Standalone validation cannot authorize text-only spans without the approved text anchor.",
					"info",
				),
			);
		} else {
			const drift = detectPlanDrift({
				approvedPlanBytes: input.approvedPlanBytes,
				approvedPlanHash: input.approvedPlanHash,
				amendments: input.amendments ?? [],
				currentPlanBytes: input.approvedPlanBytes,
			});
			if (!drift.chainValid && (input.amendments?.length ?? 0) > 0) {
				diagnostics.push(
					diagnostic(
						"PLAN_IMPACT_NOT_AUTHORIZED",
						"The text-amendment lineage is unverified. Spans are resolved against the approved bytes only.",
						"info",
					),
				);
			}
			const resolved = resolvePlanImpactSpans({
				anchorText: drift.authorizedBytes,
				locations,
			});
			if (resolved.status === "rejected") {
				return fatal("implementation", resolved.code, resolved.message, [
					...diagnostics,
					diagnostic(resolved.code, resolved.message, "error", resolved.itemId),
				]);
			}
			if (resolved.status === "ambiguous") {
				diagnostics.push(
					diagnostic(
						"PLAN_IMPACT_AMBIGUOUS",
						resolved.message,
						"error",
						resolved.itemId,
					),
				);
			} else {
				spans = resolved.spans;
				spansAuthorized = true;
			}
		}
	}
	const governance = classify({
		verdict: input.verdict,
		phase: phaseId,
		mode: input.mode,
		reviewRound: implementationReviewRound(
			input.priorReviewCount ?? 0,
			input.sessionId,
		),
		spansAuthorized,
		diagnostics,
	});
	const blocking = diagnostics.some(
		(item) => item.code === "PRE_EXISTING_NOT_ACTIONABLE",
	);
	return {
		valid: !blocking,
		accepted: !blocking,
		domain: "implementation",
		...(blocking
			? {
					fatalCode: "PRE_EXISTING_NOT_ACTIONABLE",
					fatalMessage:
						"Ordinary pre-existing observations must be retained in nonblocking Markdown, not actionable items.",
				}
			: {}),
		diagnostics,
		spans,
		exemptionAuthorized: spansAuthorized,
		governance,
	};
}

export function deriveImplementationGovernance(
	input: ImplementationValidationInput,
): ImplementationGovernanceResult {
	const validated = validateImplementationReview(input);
	if (!validated.governance) {
		throw new Error(
			validated.fatalMessage ??
				"Implementation governance requires an implementation-domain verdict.",
		);
	}
	return validated.governance;
}
