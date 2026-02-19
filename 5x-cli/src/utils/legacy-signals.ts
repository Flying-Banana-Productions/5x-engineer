import { parse as parseYaml } from "yaml";
import type {
	AuthorStatus,
	ReviewerVerdict,
	VerdictItem,
} from "../protocol.js";

export type LegacyVerdict = ReviewerVerdict & {
	reviewPath?: string;
};

export type LegacyStatus = AuthorStatus & {
	planPath?: string;
	reviewPath?: string;
	phase?: number;
	summary?: string;
	context?: string;
	blockedOn?: string;
};

const VERDICT_RE = /<!--\s*5x:verdict\s*\n([\s\S]*?)-->/g;
const STATUS_RE = /<!--\s*5x:status\s*\n([\s\S]*?)-->/g;

/** Maximum size of a YAML block to parse (64 KB). Reject oversized blocks
 *  to bound memory/time when parsing untrusted agent output. */
const MAX_YAML_BLOCK_BYTES = 64 * 1024;

function extractLastBlock(text: string, regex: RegExp): string | null {
	let lastMatch: string | null = null;
	regex.lastIndex = 0;
	let match = regex.exec(text);
	while (match !== null) {
		lastMatch = match[1] ?? null;
		match = regex.exec(text);
	}
	return lastMatch;
}

export function parseVerdictBlock(text: string): LegacyVerdict | null {
	const yamlStr = extractLastBlock(text, VERDICT_RE);
	if (!yamlStr) return null;
	if (Buffer.byteLength(yamlStr, "utf8") > MAX_YAML_BLOCK_BYTES) return null;

	try {
		const parsed = parseYaml(yamlStr);
		if (!parsed || typeof parsed !== "object") return null;
		const data = parsed as Record<string, unknown>;

		const readiness = data.readiness;
		if (
			readiness !== "ready" &&
			readiness !== "ready_with_corrections" &&
			readiness !== "not_ready"
		) {
			return null;
		}

		if (!Array.isArray(data.items)) return null;

		const items: VerdictItem[] = [];
		for (const rawItem of data.items) {
			if (!rawItem || typeof rawItem !== "object") continue;
			const item = rawItem as Record<string, unknown>;
			if (typeof item.id !== "string" || typeof item.title !== "string")
				continue;
			if (item.action !== "auto_fix" && item.action !== "human_required")
				continue;

			const priority =
				item.priority === "P0" ||
				item.priority === "P1" ||
				item.priority === "P2"
					? item.priority
					: undefined;

			items.push({
				id: item.id,
				title: item.title,
				action: item.action,
				reason: typeof item.reason === "string" ? item.reason : "",
				priority,
			});
		}

		return {
			readiness,
			items,
			reviewPath:
				typeof data.reviewPath === "string" ? data.reviewPath : undefined,
			summary: typeof data.summary === "string" ? data.summary : undefined,
		};
	} catch {
		return null;
	}
}

export function parseStatusBlock(text: string): LegacyStatus | null {
	const yamlStr = extractLastBlock(text, STATUS_RE);
	if (!yamlStr) return null;
	if (Buffer.byteLength(yamlStr, "utf8") > MAX_YAML_BLOCK_BYTES) return null;

	try {
		const parsed = parseYaml(yamlStr);
		if (!parsed || typeof parsed !== "object") return null;
		const data = parsed as Record<string, unknown>;

		const parsedResult = data.result;
		const result =
			parsedResult === "completed"
				? "complete"
				: parsedResult === "complete" ||
						parsedResult === "needs_human" ||
						parsedResult === "failed"
					? parsedResult
					: null;

		if (!result) return null;

		return {
			result,
			planPath: typeof data.planPath === "string" ? data.planPath : undefined,
			reviewPath:
				typeof data.reviewPath === "string" ? data.reviewPath : undefined,
			commit: typeof data.commit === "string" ? data.commit : undefined,
			phase: typeof data.phase === "number" ? data.phase : undefined,
			summary: typeof data.summary === "string" ? data.summary : undefined,
			reason: typeof data.reason === "string" ? data.reason : undefined,
			context: typeof data.context === "string" ? data.context : undefined,
			blockedOn:
				typeof data.blockedOn === "string" ? data.blockedOn : undefined,
			notes: typeof data.notes === "string" ? data.notes : undefined,
		};
	} catch {
		return null;
	}
}
