/**
 * NDJSON event formatter for real-time console output.
 *
 * Accepts a pre-parsed Claude Code stream-json event object (as delivered by
 * the adapter's onEvent callback) and returns a formatted display string, or
 * null to suppress the event silently.
 *
 * Design:
 * - Unknown event types return null (forward-compatible with future event types).
 * - All output lines are indented with two spaces to align with orchestrator
 *   status messages.
 * - system.init.tools array is suppressed — too verbose for live display.
 */

const TOOL_INPUT_LIMIT = 120;
const TOOL_RESULT_LIMIT = 200;

/**
 * Safely stringify a tool input for console display.
 * Non-throwing: handles circular references and other unserializable inputs.
 * When the stringified form exceeds the limit, large objects fall back to a
 * key-only summary to avoid allocating huge intermediate strings.
 */
function safeInputSummary(input: unknown, limit: number): string {
	if (typeof input !== "object" || input === null) {
		try {
			const s = JSON.stringify(input) ?? "null";
			return s.length > limit ? `${s.slice(0, limit)}...` : s;
		} catch {
			return String(input).slice(0, limit);
		}
	}
	try {
		const s = JSON.stringify(input);
		if (s.length > limit) {
			// Avoid retaining the large allocation — use a key summary instead.
			const keys = Object.keys(input as object);
			const summary =
				keys.length > 0
					? `{${keys.join(", ")}} (${s.length} chars)`
					: `{} (${s.length} chars)`;
			return summary.length > limit ? `${summary.slice(0, limit)}...` : summary;
		}
		return s;
	} catch {
		// Circular reference or other unserializable input — show key names only.
		try {
			const keys = Object.keys(input as object);
			const summary =
				keys.length > 0
					? `{${keys.join(", ")}} [unserializable]`
					: "{} [unserializable]";
			return summary.length > limit ? `${summary.slice(0, limit)}...` : summary;
		} catch {
			return "[unserializable]";
		}
	}
}

/** Format a parsed NDJSON event for console display. Returns null to suppress. */
export function formatNdjsonEvent(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	const ev = event as Record<string, unknown>;

	// system init — show model, suppress verbose tools array
	if (ev.type === "system" && ev.subtype === "init") {
		const model = (ev.model as string | undefined) ?? "unknown";
		return `  [session] model=${model}`;
	}

	// assistant message — text and tool_use blocks
	if (ev.type === "assistant") {
		const message = ev.message as Record<string, unknown> | undefined;
		if (!message) return null;
		const content = message.content as
			| Array<Record<string, unknown>>
			| undefined;
		if (!Array.isArray(content)) return null;

		const lines: string[] = [];
		for (const part of content) {
			if (part.type === "text") {
				const text = part.text as string | undefined;
				if (text) {
					// Indent each line of text
					for (const line of text.split("\n")) {
						lines.push(`  ${line}`);
					}
				}
			} else if (part.type === "tool_use") {
				const name = (part.name as string | undefined) ?? "unknown";
				const inputStr = safeInputSummary(part.input, TOOL_INPUT_LIMIT);
				lines.push(`  [tool] ${name}: ${inputStr}`);
			}
		}
		return lines.length > 0 ? lines.join("\n") : null;
	}

	// user message — tool_result blocks
	if (ev.type === "user") {
		const message = ev.message as Record<string, unknown> | undefined;
		if (!message) return null;
		const content = message.content as
			| Array<Record<string, unknown>>
			| undefined;
		if (!Array.isArray(content)) return null;

		const lines: string[] = [];
		for (const part of content) {
			if (part.type === "tool_result") {
				const contentVal = part.content;
				let text = "";
				if (typeof contentVal === "string") {
					text = contentVal;
				} else if (Array.isArray(contentVal) && contentVal.length > 0) {
					const first = contentVal[0] as Record<string, unknown>;
					text = (first.text as string | undefined) ?? "";
				}
				if (text) {
					lines.push(`  [result] ${text.slice(0, TOOL_RESULT_LIMIT)}`);
				}
			}
		}
		return lines.length > 0 ? lines.join("\n") : null;
	}

	// result — completion summary
	if (ev.type === "result") {
		const subtype = (ev.subtype as string | undefined) ?? "unknown";
		const cost = ev.total_cost_usd as number | undefined;
		const duration = ev.duration_ms as number | undefined;
		const costStr = cost !== undefined ? `$${cost.toFixed(4)}` : "unknown";
		const durationStr =
			duration !== undefined ? `${(duration / 1000).toFixed(1)}s` : "unknown";
		return `  [done] ${subtype} | cost=${costStr} | ${durationStr}`;
	}

	// Unknown event type — skip silently (forward-compatible)
	return null;
}
