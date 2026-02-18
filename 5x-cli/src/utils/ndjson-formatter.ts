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
				const inputStr = JSON.stringify(part.input ?? {});
				const truncated =
					inputStr.length > TOOL_INPUT_LIMIT
						? `${inputStr.slice(0, TOOL_INPUT_LIMIT)}...`
						: inputStr;
				lines.push(`  [tool] ${name}: ${truncated}`);
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
