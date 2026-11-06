/**
 * Mechanical checklist repair: candidate and proof.
 *
 * A repair converts plain list markers in identified completion-gate lists
 * into recognized unchecked task markers. The proof accepts only those
 * list-prefix changes plus existing checkbox-state toggles. Requirement
 * text, nesting, list order, headings, budget, schema and every other
 * governing byte must be unchanged. Pure: no I/O, no hashing of records.
 */

import { createHash } from "node:crypto";
import {
	type PhaseSectionRange,
	parsePlan,
	phaseSectionRanges,
} from "../parsers/plan.js";
import {
	type ExpectedPlanSchema,
	type LoadedPlanDocument,
	loadPlanDocument,
	type PlanSchema,
} from "./document.js";

/** `indent marker ws rest`, where rest is not a task marker. */
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\S.*)$/;
/** `indent marker ws [s] ws rest`. */
const TASK_ITEM =
	/^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\]([ \t]+)(\S.*)$/;
const TASK_PREFIX = /^\[[ xX]\]/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const COMPLETION_GATE = /^\*\*Completion gate:\*\*/;
const GATE_LABEL =
	/^(?:completion gate|completion criteria|exit criteria|checklist|tasks?|task list|deliverables|work items?|steps|implementation steps|acceptance criteria|acceptance|definition of done|done when|to ?do)\b/i;

export interface ChecklistRepairSelection {
	/** Phase ids to repair. Overrides the default zero-item/mixed selection. */
	phases?: readonly string[];
	/** Inclusive raw line ranges. Only list items inside these ranges change. */
	lines?: ReadonlyArray<{ start: number; end: number }>;
}

/** One proposed or proven list-prefix edit. */
export interface ChecklistRepairEdit {
	/** 1-based raw line in the repaired bytes. */
	line: number;
	/** 1-based raw line in the anchor bytes. */
	anchorLine: number;
	phase: string;
	before: string;
	after: string;
	/** True when the parser counts this item (column 0). */
	topLevel: boolean;
}

/** An introduced checked marker, normalized to unchecked in the target. */
export interface ChecklistCheckedReset {
	line: number;
	phase: string;
	proposed: string;
	repaired: string;
}

/** An existing task marker whose recorded state is retained. */
export interface ChecklistToggle {
	line: number;
	phase: string | null;
	before: string;
	after: string;
}

export interface ChecklistDisallowedChange {
	anchorLine: number | null;
	line: number | null;
	before: string | null;
	after: string | null;
	reason: string;
}

export interface ChecklistCandidateBlock {
	phase: string;
	startLine: number;
	endLine: number;
	label: string | null;
	plainTopLevelItems: number;
}

export type ChecklistPhaseIssueKind =
	| "ambiguous"
	| "needs_author"
	| "duplicate_phase_id";

/** A phase the deterministic candidate did not repair. */
export interface ChecklistPhaseIssue {
	phase: string;
	line: number;
	kind: ChecklistPhaseIssueKind;
	message: string;
	candidates: ChecklistCandidateBlock[];
}

export interface ChecklistPhaseSummary {
	id: string;
	title: string;
	line: number;
	itemsBefore: number;
	itemsAfter: number;
	checkedAfter: number;
}

export type ChecklistProofResult =
	| {
			ok: true;
			schema: PlanSchema;
			edits: ChecklistRepairEdit[];
			/** Introduced markers in a checked state. Strict proofs refuse them. */
			checkedIntroductions: ChecklistRepairEdit[];
			toggles: ChecklistToggle[];
	  }
	| {
			ok: false;
			code: "CHECKLIST_REPAIR_DISALLOWED" | "PLAN_SCHEMA_INVALID";
			message: string;
			disallowed: ChecklistDisallowedChange[];
	  };

export type ChecklistRepairPlanResult =
	| {
			ok: true;
			schema: PlanSchema;
			targetBytes: string;
			edits: ChecklistRepairEdit[];
			resetChecked: ChecklistCheckedReset[];
			toggles: ChecklistToggle[];
			phases: ChecklistPhaseSummary[];
			unresolved: ChecklistPhaseIssue[];
			/** Plain nested child bullets left as part of their parent item. */
			nestedPreserved: number;
	  }
	| {
			ok: false;
			code:
				| "CHECKLIST_REPAIR_DISALLOWED"
				| "CHECKLIST_REPAIR_SELECTION_INVALID"
				| "PLAN_SCHEMA_INVALID"
				| "PLAN_SCHEMA_UNSUPPORTED";
			message: string;
			disallowed?: ChecklistDisallowedChange[];
			unresolved?: ChecklistPhaseIssue[];
	  };

interface RawLine {
	text: string;
	ending: string;
}

interface LineInfo {
	phase: string | null;
	inFence: boolean;
	governing: boolean;
}

interface ListBlock {
	phase: string;
	startIndex: number;
	endIndex: number;
	label: string | null;
	gate: boolean;
	items: number[];
}

/** Split into lines keeping each ending. A trailing ending adds no empty line. */
export function splitLinesWithEndings(raw: string): RawLine[] {
	const lines: RawLine[] = [];
	let start = 0;
	for (let index = 0; index < raw.length; index++) {
		const unit = raw.charAt(index);
		if (unit !== "\n" && unit !== "\r") continue;
		const ending =
			unit === "\r" && raw.charAt(index + 1) === "\n" ? "\r\n" : unit;
		lines.push({ text: raw.slice(start, index), ending });
		index += ending.length - 1;
		start = index + 1;
	}
	if (start < raw.length) lines.push({ text: raw.slice(start), ending: "" });
	return lines;
}

function joinLines(lines: readonly RawLine[]): string {
	return lines.map((line) => line.text + line.ending).join("");
}

function plainItem(text: string): RegExpMatchArray | null {
	const match = text.match(LIST_ITEM);
	if (!match) return null;
	if (TASK_PREFIX.test(match[4] ?? "")) return null;
	return match;
}

/** The canonical recognized unchecked form of a plain list item. */
export function introduceUncheckedMarker(text: string): string | null {
	const match = plainItem(text);
	if (!match) return null;
	const [, indent = "", marker = "", , rest = ""] = match;
	const canonical = /^\d/.test(marker) ? `${marker.slice(0, -1)}.` : "-";
	return `${indent}${canonical} [ ] ${rest}`;
}

function markerCompatible(before: string, after: string): boolean {
	if (before === after) return true;
	if (/^\d/.test(before)) return after === `${before.slice(0, -1)}.`;
	return after === "-";
}

/** True when `after` is `before` with only a task marker introduced. */
function isIntroduction(
	before: string,
	after: string,
): { checked: boolean } | null {
	const plain = plainItem(before);
	const task = after.match(TASK_ITEM);
	if (!plain || !task) return null;
	if (plain[1] !== task[1]) return null;
	if (!markerCompatible(plain[2] ?? "", task[2] ?? "")) return null;
	if (plain[4] !== task[6]) return null;
	return { checked: task[4] !== " " };
}

/** True when both lines are the same task item apart from its state. */
function isToggle(before: string, after: string): boolean {
	const left = before.match(TASK_ITEM);
	const right = after.match(TASK_ITEM);
	if (!left || !right) return false;
	return (
		left[1] === right[1] &&
		left[2] === right[2] &&
		left[3] === right[3] &&
		left[5] === right[5] &&
		left[6] === right[6]
	);
}

function loadForRepair(
	raw: string,
	schema: ExpectedPlanSchema,
):
	| { ok: true; document: LoadedPlanDocument }
	| {
			ok: false;
			code: "PLAN_SCHEMA_INVALID" | "PLAN_SCHEMA_UNSUPPORTED";
			message: string;
	  } {
	const loaded = loadPlanDocument(raw, schema);
	if (!loaded.ok) return loaded;
	return { ok: true, document: loaded.document };
}

function lineInfo(document: LoadedPlanDocument): {
	lines: RawLine[];
	info: LineInfo[];
	ranges: PhaseSectionRange[];
} {
	const lines = splitLinesWithEndings(document.raw);
	const governing =
		document.schema === 1
			? new Set(
					document.governingLineLocations.map(
						(location) => location.lineNumber,
					),
				)
			: null;
	const ranges = phaseSectionRanges(document.authorityMarkdown);
	const authority = splitLinesWithEndings(document.authorityMarkdown);
	const info: LineInfo[] = [];
	let fence: string | null = null;
	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		const text = authority[index]?.text ?? "";
		const opener = text.match(FENCE)?.[1] ?? null;
		let inFence = fence !== null;
		if (fence !== null) {
			if (
				opener &&
				opener[0] === fence[0] &&
				opener.length >= fence.length &&
				text.trim() === opener
			) {
				fence = null;
			}
		} else if (opener) {
			fence = opener;
			inFence = true;
		}
		const range = ranges.find(
			(entry) => lineNumber > entry.startLine && lineNumber <= entry.endLine,
		);
		info.push({
			phase: range?.number ?? null,
			inFence,
			governing: governing ? governing.has(lineNumber) : true,
		});
	}
	return { lines, info, ranges };
}

function labelOf(text: string): string | null {
	const trimmed = text.trim();
	if (COMPLETION_GATE.test(trimmed)) return "Completion gate";
	const heading = trimmed.match(/^#{3,6}\s+(.+?)\s*#*$/);
	const bold = trimmed.match(/^\*\*(.+?)\*\*:?$/);
	const plain = trimmed.match(/^([^-*+\d#|>].*?):$/);
	const label = (heading?.[1] ?? bold?.[1] ?? plain?.[1] ?? "")
		.replace(/:$/, "")
		.trim();
	return label.length > 0 ? label : null;
}

function listBlocks(
	authority: readonly RawLine[],
	info: readonly LineInfo[],
): ListBlock[] {
	const blocks: ListBlock[] = [];
	let index = 0;
	while (index < authority.length) {
		const at = info[index];
		const text = authority[index]?.text ?? "";
		if (!at?.phase || at.inFence || !LIST_ITEM.test(text)) {
			index += 1;
			continue;
		}
		const phase = at.phase;
		const startIndex = index;
		const items: number[] = [];
		let endIndex = index;
		let cursor = index;
		while (cursor < authority.length) {
			const current = info[cursor];
			const line = authority[cursor]?.text ?? "";
			if (current?.phase !== phase || current.inFence) break;
			if (LIST_ITEM.test(line)) {
				items.push(cursor);
				endIndex = cursor;
				cursor += 1;
				continue;
			}
			if (line.trim().length === 0) {
				let next = cursor + 1;
				while (
					next < authority.length &&
					(authority[next]?.text ?? "").trim().length === 0
				) {
					next += 1;
				}
				const nextText = authority[next]?.text ?? "";
				if (
					next - cursor === 1 &&
					info[next]?.phase === phase &&
					!info[next]?.inFence &&
					(LIST_ITEM.test(nextText) || /^[ \t]+\S/.test(nextText))
				) {
					cursor = next;
					continue;
				}
				break;
			}
			if (/^[ \t]+\S/.test(line)) {
				endIndex = cursor;
				cursor += 1;
				continue;
			}
			break;
		}
		let labelIndex = startIndex - 1;
		while (
			labelIndex >= 0 &&
			(authority[labelIndex]?.text ?? "").trim().length === 0
		) {
			labelIndex -= 1;
		}
		const labelLine =
			labelIndex >= 0 && info[labelIndex]?.phase === phase
				? (authority[labelIndex]?.text ?? "")
				: "";
		const label = labelOf(labelLine);
		blocks.push({
			phase,
			startIndex,
			endIndex,
			label,
			gate: label !== null && GATE_LABEL.test(label),
			items,
		});
		index = endIndex + 1;
	}
	return blocks;
}

function topLevel(text: string): boolean {
	return /^\S/.test(text);
}

/**
 * Prove that `afterBytes` differs from `beforeBytes` only by introduced task
 * markers on eligible phase list items and by existing checkbox toggles.
 * Both sides are read under the same schema. Schema 1 compares governing
 * lines only; non-governing text may differ.
 */
export function proveChecklistRepair(input: {
	beforeBytes: string;
	afterBytes: string;
	schema: ExpectedPlanSchema;
}): ChecklistProofResult {
	const before = loadForRepair(input.beforeBytes, input.schema);
	if (!before.ok) {
		return {
			ok: false,
			code: "PLAN_SCHEMA_INVALID",
			message: `The anchor plan could not be read. ${before.message}`,
			disallowed: [],
		};
	}
	const schema = before.document.schema;
	const after = loadForRepair(input.afterBytes, schema);
	if (!after.ok) {
		return {
			ok: false,
			code: "PLAN_SCHEMA_INVALID",
			message: `The repaired plan could not be read as schema ${schema}. ${after.message}`,
			disallowed: [],
		};
	}
	const anchor = lineInfo(before.document);
	const target = splitLinesWithEndings(after.document.raw);
	const pairs: Array<{ anchorIndex: number; targetIndex: number }> = [];
	const disallowed: ChecklistDisallowedChange[] = [];
	if (schema === 0) {
		if (anchor.lines.length !== target.length) {
			disallowed.push({
				anchorLine: null,
				line: null,
				before: null,
				after: null,
				reason: `Line count changed from ${anchor.lines.length} to ${target.length}. A mechanical repair edits list prefixes only.`,
			});
		} else {
			for (let index = 0; index < target.length; index++) {
				if (anchor.lines[index]?.ending !== target[index]?.ending) {
					disallowed.push({
						anchorLine: index + 1,
						line: index + 1,
						before: anchor.lines[index]?.text ?? null,
						after: target[index]?.text ?? null,
						reason: "Line ending changed.",
					});
					continue;
				}
				pairs.push({ anchorIndex: index, targetIndex: index });
			}
		}
	} else {
		const left = before.document.governingLineLocations;
		const right = after.document.governingLineLocations;
		if (left.length !== right.length) {
			disallowed.push({
				anchorLine: null,
				line: null,
				before: null,
				after: null,
				reason: `Governing line count changed from ${left.length} to ${right.length}. A mechanical repair edits list prefixes only.`,
			});
		} else {
			for (let index = 0; index < left.length; index++) {
				const l = left[index];
				const r = right[index];
				if (!l || !r) continue;
				pairs.push({
					anchorIndex: l.lineNumber - 1,
					targetIndex: r.lineNumber - 1,
				});
			}
		}
	}
	const edits: ChecklistRepairEdit[] = [];
	const checkedIntroductions: ChecklistRepairEdit[] = [];
	const toggles: ChecklistToggle[] = [];
	for (const pair of pairs) {
		const left = anchor.lines[pair.anchorIndex]?.text ?? "";
		const right = target[pair.targetIndex]?.text ?? "";
		if (left === right) continue;
		const at = anchor.info[pair.anchorIndex];
		if (isToggle(left, right)) {
			toggles.push({
				line: pair.targetIndex + 1,
				phase: at?.phase ?? null,
				before: left,
				after: right,
			});
			continue;
		}
		const introduced = isIntroduction(left, right);
		const eligible =
			at?.phase !== null &&
			at?.phase !== undefined &&
			!at.inFence &&
			at.governing;
		if (introduced && eligible) {
			const edit: ChecklistRepairEdit = {
				line: pair.targetIndex + 1,
				anchorLine: pair.anchorIndex + 1,
				phase: at.phase as string,
				before: left,
				after: right,
				topLevel: topLevel(left),
			};
			edits.push(edit);
			if (introduced.checked) checkedIntroductions.push(edit);
			continue;
		}
		disallowed.push({
			anchorLine: pair.anchorIndex + 1,
			line: pair.targetIndex + 1,
			before: left,
			after: right,
			reason: introduced
				? at?.inFence
					? "Fenced example text cannot gain an executable marker."
					: "Only list items inside a phase section can gain a task marker."
				: "Changes text beyond a list-prefix marker.",
		});
	}
	if (disallowed.length > 0) {
		return {
			ok: false,
			code: "CHECKLIST_REPAIR_DISALLOWED",
			message: `The candidate changes ${disallowed.length} governing line(s) beyond a mechanical checklist-prefix repair. Requirement, heading, budget and other governing text must stay byte-identical.`,
			disallowed,
		};
	}
	return { ok: true, schema, edits, checkedIntroductions, toggles };
}

function resetCheckedIntroductions(
	raw: string,
	introductions: readonly ChecklistRepairEdit[],
): { bytes: string; resets: ChecklistCheckedReset[] } {
	if (introductions.length === 0) return { bytes: raw, resets: [] };
	const lines = splitLinesWithEndings(raw);
	const resets: ChecklistCheckedReset[] = [];
	for (const edit of introductions) {
		const line = lines[edit.line - 1];
		if (!line) continue;
		const repaired = line.text.replace(
			TASK_ITEM,
			(_match, indent, marker, ws, _state, ws2, rest) =>
				`${indent}${marker}${ws}[ ]${ws2}${rest}`,
		);
		resets.push({
			line: edit.line,
			phase: edit.phase,
			proposed: line.text,
			repaired,
		});
		line.text = repaired;
	}
	return { bytes: joinLines(lines), resets };
}

function inSelectedLines(
	lineNumber: number,
	selection: ChecklistRepairSelection | undefined,
): boolean {
	if (!selection?.lines || selection.lines.length === 0) return true;
	return selection.lines.some(
		(range) => lineNumber >= range.start && lineNumber <= range.end,
	);
}

function describeBlock(
	block: ListBlock,
	authority: readonly RawLine[],
): ChecklistCandidateBlock {
	return {
		phase: block.phase,
		startLine: block.startIndex + 1,
		endLine: block.endIndex + 1,
		label: block.label,
		plainTopLevelItems: block.items.filter((index) => {
			const text = authority[index]?.text ?? "";
			return topLevel(text) && plainItem(text) !== null;
		}).length,
	};
}

/**
 * Deterministic candidate over already-normalized bytes. Default selection:
 * gate-labelled lists in phases with zero executable items, and gate lists
 * that mix task and plain top-level items. Explicit phases or lines replace
 * the default. Only plain top-level items change; nested bullets stay plain.
 */
function generateCandidate(
	document: LoadedPlanDocument,
	selection: ChecklistRepairSelection | undefined,
):
	| {
			ok: true;
			bytes: string;
			unresolved: ChecklistPhaseIssue[];
			nestedPreserved: number;
	  }
	| { ok: false; message: string } {
	const { lines, info, ranges } = lineInfo(document);
	const authority = splitLinesWithEndings(document.authorityMarkdown);
	const plan = parsePlan(document.authorityMarkdown);
	const blocks = listBlocks(authority, info);
	const counts = new Map<string, number>();
	for (const range of ranges) {
		counts.set(range.number, (counts.get(range.number) ?? 0) + 1);
	}
	const explicitPhases = selection?.phases ?? [];
	for (const id of explicitPhases) {
		if (!counts.has(id)) {
			return {
				ok: false,
				message: `Phase ${id} is not a phase heading in the plan.`,
			};
		}
	}
	const explicitLines = selection?.lines ?? [];
	for (const range of explicitLines) {
		if (
			!Number.isInteger(range.start) ||
			!Number.isInteger(range.end) ||
			range.start < 1 ||
			range.end < range.start
		) {
			return {
				ok: false,
				message: `Line range ${range.start}-${range.end} is invalid.`,
			};
		}
	}
	const explicit = explicitPhases.length > 0 || explicitLines.length > 0;
	const unresolved: ChecklistPhaseIssue[] = [];
	const selected: ListBlock[] = [];
	for (let position = 0; position < ranges.length; position++) {
		const range = ranges[position];
		if (!range) continue;
		const phaseBlocks = blocks.filter(
			(block) =>
				block.phase === range.number &&
				block.startIndex + 1 > range.startLine &&
				block.endIndex + 1 <= range.endLine,
		);
		const withPlain = phaseBlocks.filter(
			(block) => describeBlock(block, authority).plainTopLevelItems > 0,
		);
		const parsed = plan.phases[position];
		const items = parsed?.items.length ?? 0;
		const duplicate = (counts.get(range.number) ?? 0) > 1;
		if (explicit) {
			const byLines =
				explicitLines.length > 0
					? withPlain.filter((block) =>
							explicitLines.some(
								(r) =>
									r.start <= block.endIndex + 1 &&
									r.end >= block.startIndex + 1,
							),
						)
					: [];
			if (explicitPhases.includes(range.number)) {
				if (duplicate) {
					unresolved.push({
						phase: range.number,
						line: range.startLine,
						kind: "duplicate_phase_id",
						message: `Phase id ${range.number} is repeated. Select the list with --lines.`,
						candidates: withPlain.map((block) =>
							describeBlock(block, authority),
						),
					});
					selected.push(...byLines);
					continue;
				}
				const gates = withPlain.filter((block) => block.gate);
				if (byLines.length > 0) selected.push(...byLines);
				else if (gates.length > 0) selected.push(...gates);
				else if (withPlain.length === 1 && withPlain[0])
					selected.push(withPlain[0]);
				else
					unresolved.push(
						withPlain.length === 0
							? needsAuthor(range, phaseBlocks, authority)
							: ambiguous(range, withPlain, authority),
					);
				continue;
			}
			selected.push(...byLines);
			continue;
		}
		const gates = withPlain.filter((block) => block.gate);
		if (items === 0) {
			if (duplicate) {
				unresolved.push({
					phase: range.number,
					line: range.startLine,
					kind: "duplicate_phase_id",
					message: `Phase id ${range.number} is repeated. Select the list with --lines.`,
					candidates: withPlain.map((block) => describeBlock(block, authority)),
				});
			} else if (gates.length > 0) {
				selected.push(...gates);
			} else if (withPlain.length > 0) {
				unresolved.push(ambiguous(range, withPlain, authority));
			} else {
				unresolved.push(needsAuthor(range, phaseBlocks, authority));
			}
			continue;
		}
		for (const block of gates) {
			const hasTask = block.items.some((index) => {
				const text = authority[index]?.text ?? "";
				return topLevel(text) && TASK_ITEM.test(text);
			});
			if (hasTask) selected.push(block);
		}
	}
	let nestedPreserved = 0;
	const out = lines.map((line) => ({ ...line }));
	for (const block of selected) {
		for (const index of block.items) {
			const text = authority[index]?.text ?? "";
			if (!plainItem(text)) continue;
			if (!inSelectedLines(index + 1, selection)) continue;
			if (!topLevel(text)) {
				nestedPreserved += 1;
				continue;
			}
			const rawLine = out[index];
			if (!rawLine) continue;
			const introduced = introduceUncheckedMarker(rawLine.text);
			if (introduced !== null) rawLine.text = introduced;
		}
	}
	return { ok: true, bytes: joinLines(out), unresolved, nestedPreserved };
}

function ambiguous(
	range: PhaseSectionRange,
	withPlain: readonly ListBlock[],
	authority: readonly RawLine[],
): ChecklistPhaseIssue {
	return {
		phase: range.number,
		line: range.startLine,
		kind: "ambiguous",
		message: `Phase ${range.number} has no executable checklist items and no list identified as its completion-gate list. Select the list once with --phase ${range.number} --lines <start>-<end>.`,
		candidates: withPlain.map((block) => describeBlock(block, authority)),
	};
}

function needsAuthor(
	range: PhaseSectionRange,
	phaseBlocks: readonly ListBlock[],
	authority: readonly RawLine[],
): ChecklistPhaseIssue {
	const nestedOnly = phaseBlocks.length > 0;
	return {
		phase: range.number,
		line: range.startLine,
		kind: "needs_author",
		message: nestedOnly
			? `Phase ${range.number} lists only nested items. Adding a top-level item changes nesting, so this needs author work.`
			: `Phase ${range.number} has no list to convert. Missing requirements need author work, not a mechanical repair.`,
		candidates: phaseBlocks.map((block) => describeBlock(block, authority)),
	};
}

function phaseSummaries(
	anchor: LoadedPlanDocument,
	target: LoadedPlanDocument,
): ChecklistPhaseSummary[] {
	const before = parsePlan(anchor.authorityMarkdown);
	const after = parsePlan(target.authorityMarkdown);
	return after.phases.map((phase, index) => ({
		id: phase.number,
		title: phase.title,
		line: phase.line,
		itemsBefore: before.phases[index]?.items.length ?? 0,
		itemsAfter: phase.items.length,
		checkedAfter: phase.items.filter((item) => item.checked).length,
	}));
}

/**
 * Plan a mechanical repair of `currentBytes` against the authorized anchor.
 * Manual prefix edits already in `currentBytes` are verified against the
 * anchor, not against themselves. Introduced checked markers are reset to
 * unchecked. Existing checkbox progress and schema 1 non-governing text are
 * retained. Disallowed edits produce no candidate.
 */
export function planChecklistRepair(input: {
	anchorBytes: string;
	currentBytes: string;
	schema: ExpectedPlanSchema;
	selection?: ChecklistRepairSelection;
}): ChecklistRepairPlanResult {
	const anchor = loadForRepair(input.anchorBytes, input.schema);
	if (!anchor.ok) return anchor;
	const schema = anchor.document.schema;
	const lenient = proveChecklistRepair({
		beforeBytes: input.anchorBytes,
		afterBytes: input.currentBytes,
		schema,
	});
	if (!lenient.ok) return lenient;
	const normalized = resetCheckedIntroductions(
		input.currentBytes,
		lenient.checkedIntroductions,
	);
	const normalizedDocument = loadForRepair(normalized.bytes, schema);
	if (!normalizedDocument.ok) return normalizedDocument;
	const candidate = generateCandidate(
		normalizedDocument.document,
		input.selection,
	);
	if (!candidate.ok) {
		return {
			ok: false,
			code: "CHECKLIST_REPAIR_SELECTION_INVALID",
			message: candidate.message,
		};
	}
	const strict = proveChecklistRepair({
		beforeBytes: input.anchorBytes,
		afterBytes: candidate.bytes,
		schema,
	});
	if (!strict.ok) return strict;
	const targetDocument = loadForRepair(candidate.bytes, schema);
	if (!targetDocument.ok) return targetDocument;
	return {
		ok: true,
		schema,
		targetBytes: candidate.bytes,
		edits: strict.edits,
		resetChecked: normalized.resets,
		toggles: strict.toggles,
		phases: phaseSummaries(anchor.document, targetDocument.document),
		unresolved: candidate.unresolved,
		nestedPreserved: candidate.nestedPreserved,
	};
}

/**
 * Replay check for a recorded repair: the authorized bytes must be a strict
 * prefix-only repair of the predecessor with the same edit map and no
 * introduced checked markers.
 */
export function verifyRecordedChecklistRepair(input: {
	beforeBytes: string;
	afterBytes: string;
	schema: PlanSchema;
	edits: ReadonlyArray<{ line: number; before: string; after: string }>;
}): { ok: true } | { ok: false; message: string } {
	const proof = proveChecklistRepair({
		beforeBytes: input.beforeBytes,
		afterBytes: input.afterBytes,
		schema: input.schema,
	});
	if (!proof.ok) return { ok: false, message: proof.message };
	if (proof.schema !== input.schema) {
		return { ok: false, message: "The repair changed the plan schema." };
	}
	if (proof.edits.length === 0) {
		return { ok: false, message: "The repair introduces no task marker." };
	}
	if (proof.checkedIntroductions.length > 0) {
		return {
			ok: false,
			message: "A repair cannot introduce a checked task marker.",
		};
	}
	const recorded = canonicalEdits(input.edits);
	const proven = canonicalEdits(proof.edits);
	if (recorded !== proven) {
		return {
			ok: false,
			message: "The recorded edit map does not match the proven edits.",
		};
	}
	return { ok: true };
}

function canonicalEdits(
	edits: ReadonlyArray<{ line: number; before: string; after: string }>,
): string {
	return JSON.stringify(
		edits.map((edit) => [edit.line, edit.before, edit.after]),
	);
}

/** Deterministic identity of a proposed repair. */
export function checklistRepairDigest(input: {
	scope: string;
	beforeBlobHash: string;
	afterBlobHash: string;
	parentLineageId: string | null;
	edits: ReadonlyArray<{ line: number; before: string; after: string }>;
}): string {
	const body = JSON.stringify([
		"plan-checklist-repair:v1",
		input.scope,
		input.beforeBlobHash,
		input.afterBlobHash,
		input.parentLineageId,
		canonicalEdits(input.edits),
	]);
	return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
