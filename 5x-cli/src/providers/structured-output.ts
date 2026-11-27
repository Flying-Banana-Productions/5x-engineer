/**
 * Prompted structured output for the OpenCode 2.x provider.
 *
 * OpenCode 2.x has no `format: json_schema` option, so the provider asks for
 * exactly one JSON object in the final message and extracts it here. Schema
 * conformance stays with the caller (`validateStructuredOutput`).
 *
 * Extraction precedence matches `packages/provider-cursor-agent/src/structured.ts`
 * (exact JSON, then a fenced block, then the last top-level object in the
 * text), but the scanner is different: it walks forward once, tracks JSON
 * string and escape state inside an open span, and only treats a `{` that
 * opens at depth 0 as a candidate. Only objects count as a result.
 */

import type { JSONSchema } from "./types.js";

export type StructuredExtractResult =
	| { ok: true; value: unknown }
	| { ok: false };

const JSON_FENCE_RE = /```(?:json)?[^\S\n]*\n([\s\S]*?)\n?```/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function fromFencedBlocks(text: string): Record<string, unknown> | undefined {
	const blocks = [...text.matchAll(JSON_FENCE_RE)];
	for (let i = blocks.length - 1; i >= 0; i--) {
		const body = blocks[i]?.[1];
		if (body === undefined) continue;
		const parsed = parseObject(body);
		if (parsed) return parsed;
	}
	return undefined;
}

/**
 * Collect the `{…}` spans that open at depth 0, in order.
 *
 * Depth counts both `{` and `[`. String and escape state are tracked only
 * inside an open span, so a stray quote in prose never flips string state,
 * and braces or brackets inside JSON strings never change depth.
 */
function topLevelObjectSpans(text: string): string[] {
	const spans: string[] = [];
	let depth = 0;
	let start = -1;
	let startsObject = false;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (depth === 0) {
			if (ch === "{" || ch === "[") {
				depth = 1;
				start = i;
				startsObject = ch === "{";
				inString = false;
				escaped = false;
			}
			continue;
		}

		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) {
				if (startsObject) spans.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return spans;
}

function fromLastTopLevelObject(
	text: string,
): Record<string, unknown> | undefined {
	const spans = topLevelObjectSpans(text);
	for (let i = spans.length - 1; i >= 0; i--) {
		const span = spans[i];
		if (span === undefined) continue;
		const parsed = parseObject(span);
		if (parsed) return parsed;
	}
	return undefined;
}

/**
 * Extract one JSON object from assistant text: exact JSON, then the last
 * fenced block that parses to an object, then the last top-level object.
 */
export function extractStructuredJson(text: string): StructuredExtractResult {
	if (text.trim() === "") return { ok: false };
	const value =
		parseObject(text) ?? fromFencedBlocks(text) ?? fromLastTopLevelObject(text);
	return value === undefined ? { ok: false } : { ok: true, value };
}

const FINAL_MESSAGE_RULE =
	"Your final message must be exactly one JSON object and nothing else.";

/** Wrap the structured summary prompt with the schema and the JSON-only rule. */
export function buildStructuredOutputPrompt(
	base: string,
	schema: JSONSchema,
): string {
	return [
		base,
		"",
		"Respond with a JSON object that satisfies this JSON Schema:",
		JSON.stringify(schema, null, 2),
		"",
		`${FINAL_MESSAGE_RULE} Do not use markdown fences, prose, or any text outside the JSON object.`,
	].join("\n");
}

/** Corrective prompt sent when the previous reply had no extractable object. */
export function buildCorrectivePrompt(schema: JSONSchema): string {
	return [
		"Your previous reply did not contain a valid JSON object.",
		"Do not call any tools. Reply again with only the JSON object, satisfying this JSON Schema:",
		JSON.stringify(schema, null, 2),
		"",
		`${FINAL_MESSAGE_RULE} Do not use markdown fences, prose, or any text outside the JSON object.`,
	].join("\n");
}
