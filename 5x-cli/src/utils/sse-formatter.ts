/**
 * SSE event formatter for real-time console output.
 *
 * Accepts an OpenCode SSE event object (from event.subscribe() stream) and
 * returns a formatted display string, or null to suppress the event silently.
 *
 * Design:
 * - Unknown event types return null (forward-compatible with future event types).
 * - All output lines are indented with two spaces to align with orchestrator
 *   status messages.
 * - Verbose events (permission, file-watcher, etc.) are suppressed.
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

/**
 * Format a tool part for console display.
 * Shows tool name + input when running, output when completed, error on failure.
 */
function formatToolPart(part: Record<string, unknown>): string | null {
	const tool = (part.tool as string | undefined) ?? "unknown";
	const state = part.state as Record<string, unknown> | undefined;
	if (!state) return null;

	const status = state.status as string | undefined;

	if (status === "running") {
		const input = state.input;
		const title = state.title as string | undefined;
		const label = title ?? tool;
		if (input != null) {
			const inputStr = safeInputSummary(input, TOOL_INPUT_LIMIT);
			return `  [tool] ${label}: ${inputStr}`;
		}
		return `  [tool] ${label}`;
	}

	if (status === "completed") {
		const output = state.output;
		if (typeof output === "string" && output.length > 0) {
			return `  [result] ${output.slice(0, TOOL_RESULT_LIMIT)}`;
		}
		return null;
	}

	if (status === "error") {
		const error = state.error;
		if (typeof error === "string") {
			return `  [error] ${tool}: ${error.slice(0, TOOL_RESULT_LIMIT)}`;
		}
		return null;
	}

	return null;
}

/**
 * Format a step-finish part for console display.
 * Shows cost and token info.
 */
function formatStepFinish(part: Record<string, unknown>): string | null {
	const cost = part.cost as number | undefined;
	const tokens = part.tokens as Record<string, unknown> | undefined;
	const reason = (part.reason as string | undefined) ?? "done";

	const costStr =
		cost != null && cost > 0 ? `cost=$${cost.toFixed(4)}` : "cost=unknown";

	let tokenStr = "";
	if (tokens) {
		const input = tokens.input as number | undefined;
		const output = tokens.output as number | undefined;
		if (input != null || output != null) {
			tokenStr = ` | tokens=${input ?? "?"}→${output ?? "?"}`;
		}
	}

	return `  [done] ${reason} | ${costStr}${tokenStr}`;
}

/**
 * Format a parsed SSE event for console display. Returns null to suppress.
 *
 * Handles OpenCode SSE event shapes from event.subscribe():
 * - message.part.updated (text, tool, step-finish parts)
 * - message.part.delta (text streaming)
 * - session.error
 */
export function formatSseEvent(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	const ev = event as Record<string, unknown>;
	const type = ev.type as string | undefined;
	if (!type) return null;

	const props = ev.properties as Record<string, unknown> | undefined;

	// OpenCode SSE events have a properties field
	if (props) {
		// Text delta streaming
		if (type === "message.part.delta") {
			const delta = props.delta as string | undefined;
			if (delta) return `  ${delta}`;
			return null;
		}

		// Part updates (tool calls, text, step-finish)
		if (type === "message.part.updated") {
			const part = props.part as Record<string, unknown> | undefined;
			if (!part) return null;
			const partType = part.type as string | undefined;

			if (partType === "tool") {
				return formatToolPart(part);
			}

			if (partType === "step-finish") {
				return formatStepFinish(part);
			}

			// Text parts: use delta if available
			if (partType === "text") {
				const delta = props.delta as string | undefined;
				if (delta) return `  ${delta}`;
			}

			return null;
		}

		// Session errors
		if (type === "session.error") {
			const error = props.error as string | undefined;
			if (error) return `  [error] ${error}`;
			return null;
		}

		// All other event types with properties → suppress (forward-compatible)
		return null;
	}

	// -----------------------------------------------------------------------
	// Legacy NDJSON shapes (Claude Code format — kept for backward compat
	// with existing tests and any NDJSON log replay)
	// -----------------------------------------------------------------------

	// system init — show model, suppress verbose tools array
	if (type === "system" && ev.subtype === "init") {
		const model = (ev.model as string | undefined) ?? "unknown";
		return `  [session] model=${model}`;
	}

	// assistant message — text and tool_use blocks
	if (type === "assistant") {
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
	if (type === "user") {
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
	if (type === "result") {
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
