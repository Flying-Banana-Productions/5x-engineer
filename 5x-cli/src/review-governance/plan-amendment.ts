/**
 * Guarded text-only plan amendments.
 *
 * A text_only plan defect becomes an ordinary author correction only when
 * each location is a unique span on the approved text anchor. The guard is
 * snapshotted before author delegation. Verification compares raw buffers
 * and allows edits only inside those spans, plus checkbox toggles. Budget
 * table bytes and structural sections take precedence over that authorization.
 */

import { createHash } from "node:crypto";
import type { PlanImpactKind } from "../protocol.js";
import type { ParsedDeliveryBudget } from "../review-budget/types.js";
import type { ResolvedPlanImpactSpan } from "./types.js";

const PROTECTED_SECTION_TITLES = new Set([
	"design decisions",
	"acceptance",
	"scope",
	"not in scope",
]);

export interface TextAmendmentGuard {
	id: string;
	anchorCommit: string;
	anchorBlobHash: string;
	parentLineageId: string | null;
	/** Exact Delivery Budget table bytes, including newlines and trailing spaces. */
	tableBytes: string;
	allowedSpans: ResolvedPlanImpactSpan[];
	structuralSignature: string;
	/** Approved text anchor the spans were resolved against. */
	anchorBytes: string;
}

export type PlanAmendmentFailureCode =
	| "PLAN_AMENDMENT_AMBIGUOUS"
	| "PLAN_AMENDMENT_TABLE"
	| "PLAN_AMENDMENT_STRUCTURE"
	| "PLAN_AMENDMENT_PROTECTED"
	| "PLAN_AMENDMENT_OUT_OF_SPAN"
	| "PLAN_AMENDMENT_INVALID_BYTES"
	| "PLAN_AMENDMENT_DIRTY"
	| "PLAN_AMENDMENT_GUARD_MISSING"
	| "PLAN_AMENDMENT_STALE"
	| "PLAN_AMENDMENT_LINEAGE"
	| "PLAN_AMENDMENT_NOT_APPROVED"
	| "PLAN_AMENDMENT_CREDIT";

export interface PlanAmendmentFailure {
	ok: false;
	code: PlanAmendmentFailureCode;
	message: string;
}

interface MarkdownLine {
	raw: string;
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

function hashBytes(bytes: string): string {
	return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

export function planImpactDisposition(input: {
	kind: PlanImpactKind | undefined;
	spansAuthorized: boolean;
}): "author_revision" | "plan_amendment" {
	if (input.kind === "text_only" && input.spansAuthorized) {
		return "author_revision";
	}
	return "plan_amendment";
}

/** Every plan defect stays on ordinary review. None qualify for the shortcut. */
export function planDefectBlocksShortcut(
	items: readonly { scopeClass?: string }[],
): boolean {
	return items.some((item) => item.scopeClass === "plan_defect");
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
			raw,
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

function budgetHeading(
	markdown: string,
): { ok: true; heading: HeadingSpan } | PlanAmendmentFailure {
	const matches = headingSpans(markdown).filter(
		(heading) => heading.text.toLowerCase() === "delivery budget",
	);
	if (matches.length === 0) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_TABLE",
			message: "The approved text anchor has no Delivery Budget section.",
		};
	}
	if (matches.length > 1) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_TABLE",
			message:
				"The approved text anchor has more than one Delivery Budget section.",
		};
	}
	const heading = matches[0];
	if (!heading) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_TABLE",
			message: "The Delivery Budget section bounds are ambiguous.",
		};
	}
	return { ok: true, heading };
}

/**
 * Exact pipe-table bytes inside Delivery Budget. Missing, duplicate, or
 * non-contiguous tables fail closed. Parsed ledger equality is not used.
 */
export function extractBudgetTableBytes(
	markdown: string,
): { ok: true; tableBytes: string } | PlanAmendmentFailure {
	const budget = budgetHeading(markdown);
	if (!budget.ok) return budget;
	const lines = markdownLines(markdown).filter(
		(line) =>
			line.start >= budget.heading.lineStart &&
			line.start < budget.heading.sectionEnd,
	);
	const blocks: MarkdownLine[][] = [];
	let current: MarkdownLine[] = [];
	for (const line of lines) {
		if (/^\s*\|/.test(line.text)) {
			current.push(line);
			continue;
		}
		if (current.length > 0) {
			blocks.push(current);
			current = [];
		}
	}
	if (current.length > 0) blocks.push(current);
	if (blocks.length === 0) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_TABLE",
			message: "The Delivery Budget section has no table.",
		};
	}
	if (blocks.length > 1) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_TABLE",
			message: "The Delivery Budget section has more than one table.",
		};
	}
	const block = blocks[0];
	if (!block || block.length === 0) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_STRUCTURE",
			message: "The Delivery Budget table bounds are ambiguous.",
		};
	}
	const start = block[0]?.start;
	const end = block[block.length - 1]?.end;
	if (start === undefined || end === undefined || end < start) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_STRUCTURE",
			message: "The Delivery Budget table bounds are ambiguous.",
		};
	}
	return { ok: true, tableBytes: markdown.slice(start, end) };
}

const CHECKBOX_MARKER_SOURCE = String.raw`^(\s*(?:[-*+]|\d+\.)\s+)\[[ xX]\]`;

/**
 * Collapse `[ ]`, `[x]`, and `[X]` to `[ ]` without changing byte length.
 * Other bytes, including text injected in place of a marker, stay intact.
 */
export function normalizeCheckboxMarkers(markdown: string): string {
	return markdown.replace(new RegExp(CHECKBOX_MARKER_SOURCE, "gm"), "$1[ ]");
}

function checkboxIdentity(line: string): string {
	return line.replace(new RegExp(CHECKBOX_MARKER_SOURCE), "$1[ ]");
}

/** Phase headings, checklist identities, and protected section bytes. */
export function structuralSignature(markdown: string): string {
	const headings = headingSpans(markdown);
	const parts: string[] = [];
	for (const heading of headings) {
		if (/^phase\s+\d/i.test(heading.text)) {
			parts.push(`phase:${markdown.slice(heading.lineStart, heading.lineEnd)}`);
		}
		if (PROTECTED_SECTION_TITLES.has(heading.text.toLowerCase())) {
			parts.push(
				`section:${heading.text.toLowerCase()}:${markdown.slice(heading.lineStart, heading.sectionEnd)}`,
			);
		}
	}
	for (const line of markdownLines(markdown)) {
		if (/^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]/.test(line.text)) {
			parts.push(`check:${checkboxIdentity(line.raw)}`);
		}
	}
	return hashBytes(parts.join("\n"));
}

function protectedByteRanges(markdown: string): Array<{
	start: number;
	end: number;
}> {
	const encoder = new TextEncoder();
	const ranges: Array<{ start: number; end: number }> = [];
	const headings = headingSpans(markdown);
	const budget = headings.find(
		(heading) => heading.text.toLowerCase() === "delivery budget",
	);
	for (const heading of headings) {
		if (/^phase\s+\d/i.test(heading.text)) {
			ranges.push({ start: heading.lineStart, end: heading.lineEnd });
		}
		if (PROTECTED_SECTION_TITLES.has(heading.text.toLowerCase())) {
			ranges.push({ start: heading.lineStart, end: heading.sectionEnd });
		}
	}
	for (const line of markdownLines(markdown)) {
		if (
			budget &&
			line.start >= budget.lineStart &&
			line.start < budget.sectionEnd &&
			/^\s*\|/.test(line.text)
		) {
			ranges.push({ start: line.start, end: line.end });
		}
		const checkbox = /^(\s*(?:[-*+]|\d+\.)\s+)\[[ xX]\]/.exec(line.text);
		if (!checkbox?.[1]) continue;
		const markerStart = line.start + checkbox[1].length;
		ranges.push({ start: line.start, end: markerStart });
		ranges.push({ start: markerStart + 3, end: line.end });
	}
	return ranges.map((range) => ({
		start: encoder.encode(markdown.slice(0, range.start)).length,
		end: encoder.encode(markdown.slice(0, range.end)).length,
	}));
}

function rangesOverlap(
	left: { start: number; end: number },
	right: { start: number; end: number },
): boolean {
	return left.start < right.end && right.start < left.end;
}

function mergeSpans(
	spans: readonly { start: number; end: number }[],
): Array<{ start: number; end: number }> {
	const ordered = [...spans]
		.filter((span) => span.end > span.start)
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: Array<{ start: number; end: number }> = [];
	for (const span of ordered) {
		const last = merged.at(-1);
		if (!last || span.start > last.end) {
			merged.push({ start: span.start, end: span.end });
			continue;
		}
		last.end = Math.max(last.end, span.end);
	}
	return merged;
}

function indexOfBuffer(haystack: Buffer, needle: Buffer, from: number): number {
	if (needle.length === 0) return from;
	return haystack.indexOf(needle, from);
}

/**
 * Fixed segments outside the allowed spans must appear in order. Replacements
 * may change length. Bytes after the final fixed segment are an out-of-span edit.
 */
export function fixedSegmentsMatch(
	before: Buffer,
	after: Buffer,
	spans: readonly { start: number; end: number }[],
): boolean {
	const merged = mergeSpans(spans);
	for (const span of merged) {
		if (span.start < 0 || span.end > before.length) return false;
	}
	const pieces: Buffer[] = [];
	let cursor = 0;
	for (const span of merged) {
		pieces.push(before.subarray(cursor, span.start));
		cursor = span.end;
	}
	pieces.push(before.subarray(cursor));

	const fit = (pieceIndex: number, pos: number): boolean => {
		if (pieceIndex === pieces.length) return pos === after.length;
		const piece = pieces[pieceIndex];
		if (!piece) return false;
		if (piece.length === 0) {
			if (pieceIndex === pieces.length - 1) return true;
			return fit(pieceIndex + 1, pos);
		}
		if (pieceIndex === 0) {
			if (
				pos + piece.length > after.length ||
				!after.subarray(pos, pos + piece.length).equals(piece)
			) {
				return false;
			}
			return fit(1, pos + piece.length);
		}
		let from = pos;
		while (from <= after.length - piece.length) {
			const found = indexOfBuffer(after, piece, from);
			if (found < 0) return false;
			if (fit(pieceIndex + 1, found + piece.length)) return true;
			from = found + 1;
		}
		return false;
	};
	return fit(0, 0);
}

export function isValidUtf8(bytes: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

export function prepareTextAmendmentGuard(input: {
	id: string;
	anchorBytes: string;
	anchorCommit: string;
	parentLineageId: string | null;
	allowedSpans: readonly ResolvedPlanImpactSpan[];
}): { ok: true; guard: TextAmendmentGuard } | PlanAmendmentFailure {
	if (input.allowedSpans.length === 0) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_AMBIGUOUS",
			message:
				"Text-only authorization requires at least one resolved location span.",
		};
	}
	const table = extractBudgetTableBytes(input.anchorBytes);
	if (!table.ok) return table;
	const protectedRanges = protectedByteRanges(input.anchorBytes);
	for (const span of input.allowedSpans) {
		if (protectedRanges.some((range) => rangesOverlap(span, range))) {
			return {
				ok: false,
				code: "PLAN_AMENDMENT_PROTECTED",
				message:
					"A text-only span intersects the budget table or protected plan structure.",
			};
		}
	}
	return {
		ok: true,
		guard: {
			id: input.id,
			anchorCommit: input.anchorCommit,
			anchorBlobHash: hashBytes(input.anchorBytes),
			parentLineageId: input.parentLineageId,
			tableBytes: table.tableBytes,
			allowedSpans: input.allowedSpans.map((span) => ({ ...span })),
			structuralSignature: structuralSignature(input.anchorBytes),
			anchorBytes: input.anchorBytes,
		},
	};
}

export function verifyGuardedPlanBytes(input: {
	guard: TextAmendmentGuard;
	committed: Buffer;
}): { ok: true; authorizedPlanBytes: string } | PlanAmendmentFailure {
	if (!isValidUtf8(input.committed)) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_INVALID_BYTES",
			message: "The committed plan blob is not valid UTF-8.",
		};
	}
	if (hashBytes(input.guard.anchorBytes) !== input.guard.anchorBlobHash) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_STALE",
			message: "The text-amendment guard does not match its anchor bytes.",
		};
	}
	const after = new TextDecoder("utf-8", { fatal: true }).decode(
		input.committed,
	);
	// Checkbox markers are not free-replacement spans. Only an exact toggle
	// (`[ ]`, `[x]`, `[X]`) disappears under normalization; any other bytes
	// written over a marker remain and fail the fixed-segment match.
	const before = Buffer.from(
		normalizeCheckboxMarkers(input.guard.anchorBytes),
		"utf8",
	);
	const committed = Buffer.from(normalizeCheckboxMarkers(after), "utf8");
	const protectedRanges = protectedByteRanges(input.guard.anchorBytes);
	for (const span of input.guard.allowedSpans) {
		if (protectedRanges.some((range) => rangesOverlap(span, range))) {
			return {
				ok: false,
				code: "PLAN_AMENDMENT_PROTECTED",
				message:
					"Table, phase, debt, design, and acceptance protections take precedence over location authorization.",
			};
		}
	}
	if (!fixedSegmentsMatch(before, committed, input.guard.allowedSpans)) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_OUT_OF_SPAN",
			message:
				"The committed plan changes bytes outside the authorized text spans and checkbox toggles.",
		};
	}
	const table = extractBudgetTableBytes(after);
	if (!table.ok) return table;
	if (table.tableBytes !== input.guard.tableBytes) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_TABLE",
			message:
				"The Delivery Budget table bytes changed. Parsed equality does not authorize a budget edit.",
		};
	}
	if (structuralSignature(after) !== input.guard.structuralSignature) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_STRUCTURE",
			message:
				"Phase headings, checklist identity, or a protected design, acceptance, or scope section changed.",
		};
	}
	return { ok: true, authorizedPlanBytes: after };
}

export function worktreeMatchesCommit(input: {
	worktree: Buffer | null;
	committed: Buffer | null;
}): { ok: true } | PlanAmendmentFailure {
	if (!input.worktree || !input.committed) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_DIRTY",
			message:
				"The committed plan blob and the mapped worktree plan must both be readable.",
		};
	}
	if (!input.worktree.equals(input.committed)) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_DIRTY",
			message:
				"Uncommitted plan changes cannot authorize a text amendment. Commit the plan blob first.",
		};
	}
	return { ok: true };
}

function claimCredit(delta: number | undefined): number {
	if (delta === undefined || delta >= 0) return 0;
	return -delta;
}

/**
 * A later approved snapshot may reduce or waive existing claims. It cannot
 * add a claim or increase credit, and live Markdown is not that snapshot.
 */
export function evaluateSupersedingLedger(input: {
	approved: ParsedDeliveryBudget;
	proposed: ParsedDeliveryBudget;
	sameSourceSnapshot: boolean;
	liveMarkdownMatchesProposal: boolean;
}): { ok: true } | PlanAmendmentFailure {
	if (input.sameSourceSnapshot || input.liveMarkdownMatchesProposal) {
		return {
			ok: false,
			code: "PLAN_AMENDMENT_NOT_APPROVED",
			message:
				"Current Markdown does not replace the approved binding. A superseding binding requires a new approved source snapshot.",
		};
	}
	const approvedClaims = new Map(
		input.approved.workItems.flatMap((item) =>
			item.debtClaim
				? [[item.debtClaim.debtClaimId, item.debtClaim] as const]
				: [],
		),
	);
	for (const item of input.proposed.workItems) {
		const claim = item.debtClaim;
		if (!claim) continue;
		const prior = approvedClaims.get(claim.debtClaimId);
		if (!prior) {
			return {
				ok: false,
				code: "PLAN_AMENDMENT_CREDIT",
				message: `Claim ${claim.debtClaimId} is new and cannot be added in this execution lineage.`,
			};
		}
		if (
			claimCredit(claim.minimalAlternativeArchitectureDelta) >
			claimCredit(prior.minimalAlternativeArchitectureDelta)
		) {
			return {
				ok: false,
				code: "PLAN_AMENDMENT_CREDIT",
				message: `Claim ${claim.debtClaimId} increases approved credit. Reductions and waivers are the only claim edits in this lineage.`,
			};
		}
	}
	return { ok: true };
}
