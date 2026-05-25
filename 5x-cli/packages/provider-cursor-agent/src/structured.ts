export type StructuredOutputSchema = Record<string, unknown>;

export type StructuredExtractResult =
	| { ok: true; value: unknown }
	| { ok: false };

const JSON_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

function tryParseJson(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractFromFencedBlock(text: string): unknown | undefined {
	const match = JSON_FENCE_RE.exec(text);
	if (!match?.[1]) return undefined;
	return tryParseJson(match[1]);
}

/**
 * Find the last parseable JSON object in prose (e.g. agent preamble + trailing JSON).
 */
function extractLastJsonObject(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;

	// Walk backward through `{` positions and try balanced-object parses.
	let searchFrom = trimmed.length;
	while (searchFrom > 0) {
		const open = trimmed.lastIndexOf("{", searchFrom - 1);
		if (open < 0) break;
		let depth = 0;
		for (let i = open; i < trimmed.length; i++) {
			const ch = trimmed[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					const candidate = trimmed.slice(open, i + 1);
					const parsed = tryParseJson(candidate);
					if (
						parsed !== undefined &&
						typeof parsed === "object" &&
						parsed !== null &&
						!Array.isArray(parsed)
					) {
						return parsed;
					}
					break;
				}
			}
		}
		searchFrom = open;
	}
	return undefined;
}

function extractFromText(text: string): unknown | undefined {
	if (text.trim() === "") return undefined;
	return (
		tryParseJson(text) ??
		extractFromFencedBlock(text) ??
		extractLastJsonObject(text)
	);
}

/**
 * Wrap a prompt with a strict final-response JSON contract when structured output
 * is requested. The original prompt text is preserved inside the wrapper.
 */
export function wrapPromptForStructuredOutput(
	prompt: string,
	schema: StructuredOutputSchema,
): string {
	const schemaText = JSON.stringify(schema, null, 2);
	return `${prompt}

---
FINAL RESPONSE REQUIREMENTS (mandatory):
- You may use tools and edit files normally while working.
- Your final assistant message must be exactly one JSON object and nothing else.
- The JSON object must satisfy this JSON Schema:
${schemaText}
- Do not include markdown fences, prose, explanations, or any text outside the JSON object in your final message.`;
}

/**
 * Extract structured JSON from assistant output.
 *
 * Order: exact JSON from final assistant text, fenced JSON block, terminal result text.
 */
export function extractStructuredOutput(
	finalAssistantText: string,
	terminalResultText: string,
): StructuredExtractResult {
	const fromAssistant =
		extractFromText(finalAssistantText) ??
		extractFromFencedBlock(finalAssistantText);
	if (fromAssistant !== undefined) {
		return { ok: true, value: fromAssistant };
	}

	const fromTerminal =
		extractFromText(terminalResultText) ??
		extractFromFencedBlock(terminalResultText);
	if (fromTerminal !== undefined) {
		return { ok: true, value: fromTerminal };
	}

	return { ok: false };
}
