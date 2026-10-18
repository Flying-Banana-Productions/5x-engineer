/**
 * Shared plan Markdown structure used by span resolution and text guards.
 *
 * Heading bounds and protected ranges are defined once so a location span
 * accepted for authorization is the same span the guard will later enforce.
 */

export const PROTECTED_PLAN_SECTION_TITLES = new Set([
	"design decisions",
	"acceptance",
	"scope",
	"not in scope",
]);

/** Task-list item, including ordered-list markers (`1. [ ]`). */
export const PLAN_CHECKBOX_LINE = /^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]/;

export interface PlanMarkdownLine {
	raw: string;
	text: string;
	start: number;
	end: number;
}

export interface PlanHeadingSpan {
	level: number;
	text: string;
	lineStart: number;
	lineEnd: number;
	sectionEnd: number;
}

export function planMarkdownLines(markdown: string): PlanMarkdownLine[] {
	const rawLines = markdown.split("\n");
	const lines: PlanMarkdownLine[] = [];
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

function fenceCloses(
	line: string,
	marker: string | null,
	activeFence: string,
): boolean {
	return (
		marker !== null &&
		marker[0] === activeFence[0] &&
		marker.length >= activeFence.length &&
		line.slice(line.indexOf(marker) + marker.length).trim().length === 0
	);
}

export function planHeadingSpans(markdown: string): PlanHeadingSpan[] {
	const lines = planMarkdownLines(markdown);
	const headings: Array<Omit<PlanHeadingSpan, "sectionEnd">> = [];
	let activeFence: string | null = null;
	for (const line of lines) {
		const marker = fenceMarker(line.text);
		if (activeFence) {
			if (fenceCloses(line.text, marker, activeFence)) activeFence = null;
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

/**
 * Character offsets that neither span resolution nor the text guard may
 * authorize. Headings, protected sections, checklist lines, and Delivery
 * Budget table rows are included. Fenced examples are not structure.
 */
export function protectedPlanCharRanges(
	markdown: string,
): Array<{ start: number; end: number }> {
	const lines = planMarkdownLines(markdown);
	const headings = planHeadingSpans(markdown);
	const ranges: Array<{ start: number; end: number }> = [];
	for (const heading of headings) {
		ranges.push({ start: heading.lineStart, end: heading.lineEnd });
		if (PROTECTED_PLAN_SECTION_TITLES.has(heading.text.toLowerCase())) {
			ranges.push({ start: heading.lineStart, end: heading.sectionEnd });
		}
	}
	const budget = headings.find(
		(heading) => heading.text.toLowerCase() === "delivery budget",
	);
	let activeFence: string | null = null;
	for (const line of lines) {
		const marker = fenceMarker(line.text);
		if (activeFence) {
			if (fenceCloses(line.text, marker, activeFence)) activeFence = null;
			continue;
		}
		if (marker) {
			activeFence = marker;
			continue;
		}
		if (PLAN_CHECKBOX_LINE.test(line.text)) {
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

/** UTF-8 byte offsets for the same ranges as `protectedPlanCharRanges`. */
export function protectedPlanByteRanges(
	markdown: string,
): Array<{ start: number; end: number }> {
	return protectedPlanCharRanges(markdown).map((range) => ({
		start: Buffer.byteLength(markdown.slice(0, range.start), "utf8"),
		end: Buffer.byteLength(markdown.slice(0, range.end), "utf8"),
	}));
}
