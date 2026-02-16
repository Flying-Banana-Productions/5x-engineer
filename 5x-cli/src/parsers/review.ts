export interface ReviewSummary {
	subject: string;
	readiness: string;
	p0Count: number;
	p1Count: number;
	p2Count: number;
	hasAddendums: boolean;
	latestAddendumDate?: string;
}

const P0_HEADING_RE = /^###\s+P0\.\d+/;
const P1_HEADING_RE = /^###\s+P1\.\d+/;
const P2_ITEM_RE = /^-\s+\*\*[^*]+\*\*/; // P2 items are typically bullet points with bold titles
const P2_HEADING_RE = /^###\s+P2\.\d+/;
const ADDENDUM_RE = /^##\s+Addendum\s*\(([^)]+)\)/;
const READINESS_RE = /\*\*Readiness:\*\*\s*(.+)/;

export function parseReviewSummary(markdown: string): ReviewSummary {
	const lines = markdown.split("\n");

	let subject = "";
	let readiness = "";
	let p0Count = 0;
	let p1Count = 0;
	let p2Count = 0;
	let hasAddendums = false;
	let latestAddendumDate: string | undefined;

	// Subject from first # heading
	for (const line of lines) {
		const titleMatch = line.match(/^#\s+(?:Review:\s*)?(.+)$/);
		if (titleMatch) {
			subject = titleMatch[1]?.trim() ?? "";
			break;
		}
	}

	// Track which section we're in to count P2 items correctly
	let inP2Section = false;

	for (const line of lines) {
		// Readiness (last match wins — addendums may update it)
		const readinessMatch = line.match(READINESS_RE);
		if (readinessMatch) {
			readiness = readinessMatch[1]?.trim() ?? "";
		}

		// P0 headings
		if (P0_HEADING_RE.test(line)) {
			p0Count++;
			inP2Section = false;
		}

		// P1 headings
		if (P1_HEADING_RE.test(line)) {
			p1Count++;
			inP2Section = false;
		}

		// P2 section detection
		if (/^##\s+Medium priority/.test(line)) {
			inP2Section = true;
			continue;
		}

		// P2 as headings (### P2.N)
		if (P2_HEADING_RE.test(line)) {
			p2Count++;
			inP2Section = false;
		}

		// P2 as bullet items within the Medium priority section
		if (inP2Section && P2_ITEM_RE.test(line)) {
			p2Count++;
		}

		// Exit P2 section on next ## heading
		if (inP2Section && /^##\s+[^#]/.test(line) && !/^##\s+Medium/.test(line)) {
			inP2Section = false;
		}

		// Addendums
		const addendumMatch = line.match(ADDENDUM_RE);
		if (addendumMatch) {
			hasAddendums = true;
			latestAddendumDate = addendumMatch[1]?.trim() ?? latestAddendumDate;
		}
	}

	return {
		subject,
		readiness,
		p0Count,
		p1Count,
		p2Count,
		hasAddendums,
		latestAddendumDate,
	};
}
