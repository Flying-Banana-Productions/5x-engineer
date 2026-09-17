import {
	type CouplingClass,
	type DebtClaimEvidence,
	type EstimateConfidence,
	isArchitectureDelta,
	isEffortPoints,
	type ParsedDeliveryBudget,
	type ParsedWorkItem,
	type SurfaceSnapshot,
} from "../review-budget/types.js";

export type DeliveryBudgetParseCode =
	| "BUDGET_SECTION_MISSING"
	| "BUDGET_TABLE_MISSING"
	| "BUDGET_TABLE_EMPTY"
	| "BUDGET_TABLE_MALFORMED"
	| "BUDGET_DUPLICATE_ID"
	| "BUDGET_INVALID_ID"
	| "BUDGET_INVALID_EFFORT"
	| "BUDGET_INVALID_ARCHITECTURE"
	| "BUDGET_DEBT_CLAIM_REQUIRED"
	| "BUDGET_INVALID_DEBT_CLAIM"
	| "BUDGET_DEBT_CLAIM_EVIDENCE_MISSING"
	| "BUDGET_DEBT_CLAIM_ORPHAN"
	| "BUDGET_DUPLICATE_DEBT_CLAIM"
	| "BUDGET_INVALID_TARGET_PHASE"
	| "BUDGET_INVALID_MINIMAL_ALTERNATIVE"
	| "BUDGET_DEBT_EVIDENCE_EMPTY"
	| "BUDGET_INVALID_CONFIDENCE"
	| "BUDGET_SNAPSHOT_MISSING"
	| "BUDGET_SNAPSHOT_INVALID";

export type DeliveryBudgetParseResult =
	| { ok: true; value: ParsedDeliveryBudget }
	| {
			ok: false;
			code: DeliveryBudgetParseCode;
			message: string;
			line?: number;
	  };

interface LocatedLine {
	text: string;
	line: number;
}

interface MarkdownLine extends LocatedLine {
	start: number;
}

interface TableClaim {
	id: string;
	coupling: CouplingClass;
	line: number;
}

const EXPECTED_HEADERS = [
	"id",
	"work item",
	"effort",
	"architecture delta",
	"debt claim",
	"addresses",
	"rationale",
] as const;
const EFFORT_SET = "{1, 2, 3, 5, 8}";
const ARCHITECTURE_SET = "{0, ±1, ±2, ±3, ±5}";
const CLAIM_CELL_RE = /^DC\d+\s+\(`(intrinsic|adjacent|unrelated)`\)$/;
const FINDING_ID_RE = /^[A-Za-z0-9._-]+$/;
const REQUIRED_SNAPSHOT_LABELS = new Set([
	"subsystems",
	"production files",
	"persistent/external boundaries",
	"persistent schemas or migrations",
	"external/platform boundaries",
]);

function failure(
	code: DeliveryBudgetParseCode,
	line: number,
	detail: string,
): DeliveryBudgetParseResult {
	return { ok: false, code, line, message: `Line ${line}: ${detail}` };
}

function splitTableRow(line: string): string[] | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
	return trimmed
		.slice(1, -1)
		.split("|")
		.map((cell) => cell.trim());
}

function isSeparatorRow(cells: readonly string[]): boolean {
	return (
		cells.length === EXPECTED_HEADERS.length &&
		cells.every((cell) => /^:?-{3,}:?$/.test(cell))
	);
}

function parseInteger(value: string): number | null {
	if (!/^-?\d+$/.test(value.trim())) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? (parsed === 0 ? 0 : parsed) : null;
}

function isNumericPhaseRef(value: string): boolean {
	return (
		/^\d+(?:\.\d+)?$/.test(value) || /^phase[\s-]+\d+(?:\.\d+)?$/i.test(value)
	);
}

function markdownLines(markdown: string): MarkdownLine[] {
	const lines: MarkdownLine[] = [];
	const pattern = /([^\r\n]*)(?:\r\n|\n|\r|$)/g;
	let match = pattern.exec(markdown);
	while (match !== null && match[0].length > 0) {
		lines.push({
			text: match[1] ?? "",
			line: lines.length + 1,
			start: match.index,
		});
		match = pattern.exec(markdown);
	}
	return lines;
}

function fenceMarker(line: string): string | null {
	return line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1] ?? null;
}

function sectionBounds(
	markdown: string,
): { lines: MarkdownLine[]; start: number; end: number } | null {
	const lines = markdownLines(markdown);
	let activeFence: string | null = null;
	let start = -1;
	let end = lines.length;

	for (let index = 0; index < lines.length; index++) {
		const text = lines[index]?.text ?? "";
		const marker = fenceMarker(text);
		if (activeFence) {
			if (
				marker !== null &&
				marker[0] === activeFence[0] &&
				marker.length >= activeFence.length &&
				text.slice(text.indexOf(marker) + marker.length).trim().length === 0
			) {
				activeFence = null;
			}
			continue;
		}
		if (marker) {
			activeFence = marker;
			continue;
		}
		if (start < 0 && /^##\s+Delivery Budget\s*$/.test(text)) {
			start = index;
			continue;
		}
		if (start >= 0 && /^#{1,2}\s+/.test(text)) {
			end = index;
			break;
		}
	}

	return start < 0 ? null : { lines, start, end };
}

function sectionLines(markdown: string): LocatedLine[] | null {
	const bounds = sectionBounds(markdown);
	if (!bounds) return null;

	let activeFence: string | null = null;
	return bounds.lines.slice(bounds.start, bounds.end).filter((entry) => {
		const marker = fenceMarker(entry.text);
		if (activeFence) {
			if (
				marker !== null &&
				marker[0] === activeFence[0] &&
				marker.length >= activeFence.length &&
				entry.text.slice(entry.text.indexOf(marker) + marker.length).trim()
					.length === 0
			) {
				activeFence = null;
			}
			return false;
		}
		if (marker) {
			activeFence = marker;
			return false;
		}
		return true;
	});
}

/** Return the Delivery Budget section without trailing inter-section whitespace. */
export function rawDeliveryBudgetSection(markdown: string): string | null {
	const bounds = sectionBounds(markdown);
	if (!bounds) return null;
	const start = bounds.lines[bounds.start]?.start ?? 0;
	const end = bounds.lines[bounds.end]?.start ?? markdown.length;
	return markdown
		.slice(start, end)
		.replace(/(?:\r\n|\n|\r)[ \t]*(?:(?:\r\n|\n|\r)[ \t]*)*$/, "");
}

export function incorporatedFindingIds(
	items: readonly ParsedWorkItem[],
): Set<string> {
	return new Set(items.flatMap((item) => item.addresses));
}

function parseAddresses(
	value: string,
	line: number,
): string[] | DeliveryBudgetParseResult {
	if (value === "-") return [];
	const tokens = value.split(",").map((token) => token.trim());
	if (
		tokens.some((token) => token.length === 0 || !FINDING_ID_RE.test(token))
	) {
		return failure(
			"BUDGET_TABLE_MALFORMED",
			line,
			"Addresses must be '-' or comma-separated finding IDs containing letters, digits, '.', '_', or '-'",
		);
	}
	return tokens;
}

function findBullet(
	lines: readonly LocatedLine[],
	label: string,
): { value: string; line: number } | null {
	const normalizedLabel = label.toLowerCase();
	for (const entry of lines) {
		const match = entry.text.match(/^\s*-\s*([^:]+):\s*(.*)$/);
		if (match?.[1]?.trim().toLowerCase() === normalizedLabel) {
			return { value: match[2]?.trim() ?? "", line: entry.line };
		}
	}
	return null;
}

function parseClaimEvidence(
	id: string,
	coupling: CouplingClass,
	block: readonly LocatedLine[],
	headingLine: number,
): DebtClaimEvidence | DeliveryBudgetParseResult {
	const target = findBullet(block, "target phase");
	if (!target || !isNumericPhaseRef(target.value)) {
		return failure(
			"BUDGET_INVALID_TARGET_PHASE",
			target?.line ?? headingLine,
			`Debt claim ${id} Target phase must be a numeric phase reference (for example 'phase-2', 'Phase 2', '2', or '2.1')`,
		);
	}

	const effort = findBullet(block, "minimal-compliant effort delta");
	const effortValue = effort ? parseInteger(effort.value) : null;
	if (
		effortValue === null ||
		effortValue < 0 ||
		(effortValue > 0 && !isEffortPoints(effortValue))
	) {
		return failure(
			"BUDGET_INVALID_MINIMAL_ALTERNATIVE",
			effort?.line ?? headingLine,
			`Debt claim ${id} minimal-compliant effort delta must be 0 or one of ${EFFORT_SET}`,
		);
	}

	const architecture = findBullet(
		block,
		"minimal-compliant architecture delta",
	);
	const architectureValue = architecture
		? parseInteger(architecture.value)
		: null;
	if (architectureValue === null || !isArchitectureDelta(architectureValue)) {
		return failure(
			"BUDGET_INVALID_MINIMAL_ALTERNATIVE",
			architecture?.line ?? headingLine,
			`Debt claim ${id} minimal-compliant architecture delta must be one of ${ARCHITECTURE_SET}`,
		);
	}

	const before = findBullet(block, "before");
	const after = findBullet(block, "after");
	for (const [label, evidence] of [
		["Before", before],
		["After", after],
	] as const) {
		if (
			!evidence ||
			evidence.value.length === 0 ||
			evidence.value === "-" ||
			evidence.value.toLowerCase() === "cleaner"
		) {
			return failure(
				"BUDGET_DEBT_EVIDENCE_EMPTY",
				evidence?.line ?? headingLine,
				`Debt claim ${id} ${label} evidence must be non-empty and concrete`,
			);
		}
	}

	return {
		debtClaimId: id,
		coupling,
		targetPhase: target.value,
		minimalAlternativeEffortDelta: effortValue,
		minimalAlternativeArchitectureDelta: architectureValue,
		before: before?.value ?? "",
		after: after?.value ?? "",
	};
}

function parseSnapshot(
	lines: readonly LocatedLine[],
	headingIndex: number,
): SurfaceSnapshot | DeliveryBudgetParseResult {
	const nextHeadingOffset = lines
		.slice(headingIndex + 1)
		.findIndex((entry) => /^#{1,6}\s+/.test(entry.text));
	const snapshotEnd =
		nextHeadingOffset < 0 ? lines.length : headingIndex + 1 + nextHeadingOffset;
	const snapshotLines = lines.slice(headingIndex + 1, snapshotEnd);
	const values = new Map<string, { value: string; line: number }>();
	for (const entry of snapshotLines) {
		const match = entry.text.match(/^\s*-\s*([^:]+):\s*(.*)$/);
		if (match?.[1]) {
			const label = match[1].trim().toLowerCase();
			if (REQUIRED_SNAPSHOT_LABELS.has(label) && values.has(label)) {
				return failure(
					"BUDGET_SNAPSHOT_INVALID",
					entry.line,
					`Surface Snapshot required label '${label}' must appear exactly once`,
				);
			}
			values.set(label, {
				value: match[2]?.trim() ?? "",
				line: entry.line,
			});
		}
	}

	const required = (label: string): number | DeliveryBudgetParseResult => {
		const entry = values.get(label);
		if (!entry)
			return failure(
				"BUDGET_SNAPSHOT_MISSING",
				lines[headingIndex]?.line ?? 1,
				`Surface Snapshot is missing '${label}'`,
			);
		const value = parseInteger(entry.value);
		if (value === null || value < 0)
			return failure(
				"BUDGET_SNAPSHOT_INVALID",
				entry.line,
				`Surface Snapshot '${label}' must be a non-negative integer`,
			);
		return value;
	};
	const optional = (
		label: string,
	): number | undefined | DeliveryBudgetParseResult => {
		const entry = values.get(label);
		if (!entry) return undefined;
		const value = parseInteger(entry.value);
		if (value === null || value < 0)
			return failure(
				"BUDGET_SNAPSHOT_INVALID",
				entry.line,
				`Surface Snapshot '${label}' must be a non-negative integer`,
			);
		return value;
	};

	const subsystems = required("subsystems");
	if (typeof subsystems !== "number") return subsystems;
	const productionFiles = required("production files");
	if (typeof productionFiles !== "number") return productionFiles;

	let boundaries: number | DeliveryBudgetParseResult;
	if (values.has("persistent/external boundaries")) {
		boundaries = required("persistent/external boundaries");
	} else {
		const persistent = values.get("persistent schemas or migrations");
		const external = values.get("external/platform boundaries");
		if (!persistent || !external) {
			return failure(
				"BUDGET_SNAPSHOT_MISSING",
				lines[headingIndex]?.line ?? 1,
				"Surface Snapshot is missing 'persistent/external boundaries'",
			);
		}
		const persistentValue = parseInteger(persistent.value);
		const externalValue = parseInteger(external.value);
		if (persistentValue === null || persistentValue < 0)
			return failure(
				"BUDGET_SNAPSHOT_INVALID",
				persistent.line,
				"Surface Snapshot 'persistent schemas or migrations' must be a non-negative integer",
			);
		if (externalValue === null || externalValue < 0)
			return failure(
				"BUDGET_SNAPSHOT_INVALID",
				external.line,
				"Surface Snapshot 'external/platform boundaries' must be a non-negative integer",
			);
		boundaries = persistentValue + externalValue;
	}
	if (typeof boundaries !== "number") return boundaries;

	const abstractions = optional("new shared abstractions or public contracts");
	if (abstractions && typeof abstractions !== "number") return abstractions;
	const schemas = optional("new persistent schemas");
	if (schemas && typeof schemas !== "number") return schemas;

	return {
		subsystems,
		productionFiles,
		persistentOrExternalBoundaries: boundaries,
		...(typeof abstractions === "number"
			? { newSharedAbstractions: abstractions }
			: {}),
		...(typeof schemas === "number" ? { newPersistentSchemas: schemas } : {}),
	};
}

export function parseDeliveryBudget(
	markdown: string,
): DeliveryBudgetParseResult {
	const lines = sectionLines(markdown);
	if (!lines)
		return failure(
			"BUDGET_SECTION_MISSING",
			1,
			"Missing exact '## Delivery Budget' section",
		);

	const firstTableIndex = lines.findIndex((entry) =>
		entry.text.trim().startsWith("|"),
	);
	const firstSubsectionIndex = lines.findIndex((entry) =>
		/^###\s+/.test(entry.text),
	);
	const confidenceEnd = Math.min(
		firstTableIndex < 0 ? lines.length : firstTableIndex,
		firstSubsectionIndex < 0 ? lines.length : firstSubsectionIndex,
	);
	const confidenceEntry = findBullet(
		lines.slice(1, confidenceEnd),
		"estimate confidence",
	);
	const confidence = confidenceEntry?.value.toLowerCase();
	if (
		confidence !== "low" &&
		confidence !== "medium" &&
		confidence !== "high"
	) {
		return failure(
			"BUDGET_INVALID_CONFIDENCE",
			confidenceEntry?.line ?? lines[0]?.line ?? 1,
			"Estimate confidence must be one of {low, medium, high}",
		);
	}

	if (firstTableIndex < 0)
		return failure(
			"BUDGET_TABLE_MISSING",
			lines[0]?.line ?? 1,
			"Delivery Budget requires a seven-column work-item table",
		);
	const header = splitTableRow(lines[firstTableIndex]?.text ?? "");
	if (
		!header ||
		header.length !== EXPECTED_HEADERS.length ||
		!header.every(
			(cell, index) => cell.toLowerCase() === EXPECTED_HEADERS[index],
		)
	) {
		return failure(
			"BUDGET_TABLE_MALFORMED",
			lines[firstTableIndex]?.line ?? 1,
			`Budget table headers must be: ${EXPECTED_HEADERS.join(" | ")}`,
		);
	}
	const separator = splitTableRow(lines[firstTableIndex + 1]?.text ?? "");
	if (!separator || !isSeparatorRow(separator))
		return failure(
			"BUDGET_TABLE_MALFORMED",
			lines[firstTableIndex + 1]?.line ?? lines[firstTableIndex]?.line ?? 1,
			"Budget table requires a valid GFM separator row",
		);

	const workItems: ParsedWorkItem[] = [];
	const claims = new Map<string, TableClaim>();
	const itemClaimIds = new Map<string, string>();
	const ids = new Set<string>();
	for (let index = firstTableIndex + 2; index < lines.length; index++) {
		const entry = lines[index];
		if (!entry || entry.text.trim() === "" || /^#{1,6}\s+/.test(entry.text))
			break;
		const cells = splitTableRow(entry.text);
		if (!cells || cells.length !== EXPECTED_HEADERS.length)
			return failure(
				"BUDGET_TABLE_MALFORMED",
				entry.line,
				"Each budget work-item row must have exactly seven cells",
			);
		const [
			id = "",
			title = "",
			effortText = "",
			architectureText = "",
			claimText = "",
			addressesText = "",
			rationale = "",
		] = cells;
		if (!/^W\d+$/.test(id))
			return failure(
				"BUDGET_INVALID_ID",
				entry.line,
				`Work-item ID '${id}' must match W<digits>`,
			);
		if (ids.has(id))
			return failure(
				"BUDGET_DUPLICATE_ID",
				entry.line,
				`Duplicate work-item ID '${id}'`,
			);
		ids.add(id);
		const effort = parseInteger(effortText);
		if (effort === null || !isEffortPoints(effort))
			return failure(
				"BUDGET_INVALID_EFFORT",
				entry.line,
				`Effort '${effortText}' must be one of ${EFFORT_SET}`,
			);
		const architectureDelta = parseInteger(architectureText);
		if (architectureDelta === null || !isArchitectureDelta(architectureDelta))
			return failure(
				"BUDGET_INVALID_ARCHITECTURE",
				entry.line,
				`Architecture delta '${architectureText}' must be one of ${ARCHITECTURE_SET}`,
			);

		let tableClaim: TableClaim | null = null;
		if (architectureDelta < 0) {
			if (claimText === "-")
				return failure(
					"BUDGET_DEBT_CLAIM_REQUIRED",
					entry.line,
					`Negative architecture row '${id}' requires a debt claim`,
				);
			const claimMatch = claimText.match(CLAIM_CELL_RE);
			if (!claimMatch)
				return failure(
					"BUDGET_INVALID_DEBT_CLAIM",
					entry.line,
					`Debt claim '${claimText}' must use DC<digits> (\`intrinsic\`|\`adjacent\`|\`unrelated\`)`,
				);
			const claimId = claimText.match(/^DC\d+/)?.[0] ?? "";
			if (claims.has(claimId))
				return failure(
					"BUDGET_DUPLICATE_DEBT_CLAIM",
					entry.line,
					`Duplicate debt claim '${claimId}'`,
				);
			tableClaim = {
				id: claimId,
				coupling: claimMatch[1] as CouplingClass,
				line: entry.line,
			};
			claims.set(claimId, tableClaim);
			itemClaimIds.set(id, claimId);
		} else if (claimText !== "-") {
			return failure(
				"BUDGET_INVALID_DEBT_CLAIM",
				entry.line,
				`Non-negative architecture row '${id}' must use '-' for Debt claim`,
			);
		}

		const addresses = parseAddresses(addressesText, entry.line);
		if (!Array.isArray(addresses)) return addresses;
		workItems.push({
			id,
			title,
			effort,
			architectureDelta,
			debtClaim: null,
			addresses,
			rationale,
			line: entry.line,
		});
	}
	if (workItems.length === 0)
		return failure(
			"BUDGET_TABLE_EMPTY",
			lines[firstTableIndex]?.line ?? 1,
			"Budget table must contain at least one work-item row",
		);

	const debtHeadingIndex = lines.findIndex((entry) =>
		/^###\s+Debt Claims\s*$/.test(entry.text),
	);
	const surfaceHeadingIndex = lines.findIndex((entry) =>
		/^###\s+Surface Snapshot\s*$/.test(entry.text),
	);
	if (debtHeadingIndex >= 0 && claims.size === 0) {
		return failure(
			"BUDGET_INVALID_DEBT_CLAIM",
			lines[debtHeadingIndex]?.line ?? 1,
			"Debt Claims subsection must be omitted when no work-item has a negative architecture delta",
		);
	}
	if (
		claims.size > 0 &&
		(debtHeadingIndex <= firstTableIndex + 1 ||
			(surfaceHeadingIndex >= 0 && debtHeadingIndex > surfaceHeadingIndex))
	) {
		return failure(
			"BUDGET_DEBT_CLAIM_EVIDENCE_MISSING",
			claims.values().next().value?.line ?? lines[0]?.line ?? 1,
			`Debt claim '${claims.keys().next().value ?? "unknown"}' requires a '### Debt Claims' evidence subsection before Surface Snapshot`,
		);
	}
	if (surfaceHeadingIndex <= firstTableIndex + 1) {
		return failure(
			"BUDGET_SNAPSHOT_MISSING",
			lines[surfaceHeadingIndex]?.line ?? lines[0]?.line ?? 1,
			"Surface Snapshot must appear after the work-item table and Debt Claims subsection",
		);
	}

	const evidence = new Map<string, DebtClaimEvidence>();
	if (debtHeadingIndex >= 0) {
		const debtEnd =
			surfaceHeadingIndex >= 0 ? surfaceHeadingIndex : lines.length;
		const blockHeadings: Array<{ id: string; index: number; line: number }> =
			[];
		for (let index = debtHeadingIndex + 1; index < debtEnd; index++) {
			const match = lines[index]?.text.match(/^####\s+(DC\d+)\s*$/);
			if (match?.[1])
				blockHeadings.push({
					id: match[1],
					index,
					line: lines[index]?.line ?? 1,
				});
		}
		const seenBlocks = new Set<string>();
		for (let blockIndex = 0; blockIndex < blockHeadings.length; blockIndex++) {
			const heading = blockHeadings[blockIndex];
			if (!heading) continue;
			if (seenBlocks.has(heading.id))
				return failure(
					"BUDGET_DUPLICATE_DEBT_CLAIM",
					heading.line,
					`Duplicate debt claim evidence block '${heading.id}'`,
				);
			seenBlocks.add(heading.id);
			const tableClaim = claims.get(heading.id);
			if (!tableClaim)
				return failure(
					"BUDGET_DEBT_CLAIM_ORPHAN",
					heading.line,
					`Debt claim evidence '${heading.id}' is not referenced by a negative work-item row`,
				);
			const nextHeadingOffset = lines
				.slice(heading.index + 1, debtEnd)
				.findIndex((entry) => /^#{1,4}\s+/.test(entry.text));
			const nextIndex =
				nextHeadingOffset < 0 ? debtEnd : heading.index + 1 + nextHeadingOffset;
			const parsed = parseClaimEvidence(
				heading.id,
				tableClaim.coupling,
				lines.slice(heading.index + 1, nextIndex),
				heading.line,
			);
			if (!("debtClaimId" in parsed)) return parsed;
			evidence.set(heading.id, parsed);
		}
		for (const claim of claims.values()) {
			if (!evidence.has(claim.id))
				return failure(
					"BUDGET_DEBT_CLAIM_EVIDENCE_MISSING",
					claim.line,
					`Debt claim '${claim.id}' has no matching '#### ${claim.id}' evidence block`,
				);
		}
	}

	for (const item of workItems) {
		if (item.architectureDelta < 0) {
			const claimId = itemClaimIds.get(item.id) ?? "";
			item.debtClaim = evidence.get(claimId) ?? null;
		}
	}
	const snapshot = parseSnapshot(lines, surfaceHeadingIndex);
	if (!("subsystems" in snapshot)) return snapshot;
	return {
		ok: true,
		value: {
			estimateConfidence: confidence as EstimateConfidence,
			workItems,
			surface: snapshot,
		},
	};
}
