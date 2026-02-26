/**
 * SSE event formatter for real-time console output.
 *
 * Accepts an OpenCode SSE event object (from event.subscribe() stream) and
 * returns a FormattedEvent ({ text, dim }) or null to suppress the event.
 *
 * Design:
 * - Unknown event types return null (forward-compatible with future event types).
 * - No indent, no ANSI codes — caller (StreamWriter) handles presentation.
 * - No width/truncation — formatter returns semantic text only.
 * - Verbose events (permission, file-watcher, etc.) are suppressed.
 */

/** Threshold for pre-scan: skip full JSON.stringify if any string value exceeds this. */
const LARGE_STRING_THRESHOLD = 1024;

/** Max slice of tool output scanned before whitespace collapse. */
const TOOL_OUTPUT_MAX_SLICE = 500;

/** Limit for legacy safeInputSummary fallback. */
const SAFE_INPUT_LIMIT = 120;

export type FormattedEvent = { text: string; dim: boolean } | null;

// ---------------------------------------------------------------------------
// Tool-aware input summaries
// ---------------------------------------------------------------------------

/**
 * Return a human-friendly summary of tool input.
 * Known tools extract the most useful field; unknown tools show key names.
 */
function toolInputSummary(tool: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const obj = input as Record<string, unknown>;
	switch (tool) {
		case "bash":
			return typeof obj.command === "string" ? obj.command : "";
		case "file_edit":
		case "write":
			return typeof obj.filePath === "string"
				? (obj.filePath as string)
				: typeof obj.path === "string"
					? (obj.path as string)
					: "";
		case "read":
			return typeof obj.filePath === "string"
				? (obj.filePath as string)
				: typeof obj.path === "string"
					? (obj.path as string)
					: "";
		case "glob":
		case "grep":
			return typeof obj.pattern === "string" ? obj.pattern : "";
		default: {
			const keys = Object.keys(obj);
			return keys.length > 0 ? `{${keys.join(", ")}}` : "";
		}
	}
}

// ---------------------------------------------------------------------------
// Tool output collapsing (bounded)
// ---------------------------------------------------------------------------

/**
 * Collapse whitespace in a bounded slice of tool output.
 * O(k) in maxSlice, not O(n) in output.length.
 */
function collapseToolOutput(output: string, maxSlice: number): string {
	const slice = output.slice(0, maxSlice);
	return slice.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Legacy safeInputSummary — retained for backward compat legacy events
// ---------------------------------------------------------------------------

/**
 * Safely stringify a tool input for console display.
 * Non-throwing: handles circular references and other unserializable inputs.
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
		const obj = input as Record<string, unknown>;
		const keys = Object.keys(obj);

		const hasLargeString = keys.some(
			(k) =>
				typeof obj[k] === "string" &&
				(obj[k] as string).length > LARGE_STRING_THRESHOLD,
		);
		if (hasLargeString) {
			const summary =
				keys.length > 0
					? `{${keys.join(", ")}} [large values]`
					: "{} [large values]";
			return summary.length > limit ? `${summary.slice(0, limit)}...` : summary;
		}

		const s = JSON.stringify(input);
		if (s.length > limit) {
			const summary =
				keys.length > 0
					? `{${keys.join(", ")}} (${s.length} chars)`
					: `{} (${s.length} chars)`;
			return summary.length > limit ? `${summary.slice(0, limit)}...` : summary;
		}
		return s;
	} catch {
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

// ---------------------------------------------------------------------------
// Tool part formatting (OpenCode SSE)
// ---------------------------------------------------------------------------

function formatToolPart(part: Record<string, unknown>): FormattedEvent {
	const tool = (part.tool as string | undefined) ?? "unknown";
	const state = part.state as Record<string, unknown> | undefined;
	if (!state) return null;

	const status = state.status as string | undefined;

	if (status === "running") {
		const input = state.input;
		const title = state.title as string | undefined;
		const label = title ?? tool;
		const summary = toolInputSummary(tool, input);
		if (summary) {
			return { text: `${label}: ${summary}`, dim: true };
		}
		return { text: label, dim: true };
	}

	if (status === "completed") {
		const output = state.output;
		if (typeof output === "string" && output.length > 0) {
			const collapsed = collapseToolOutput(output, TOOL_OUTPUT_MAX_SLICE);
			if (collapsed.length > 0) {
				return { text: collapsed, dim: true };
			}
		}
		return null;
	}

	if (status === "error") {
		const error = state.error;
		if (typeof error === "string") {
			return { text: `! ${tool}: ${error}`, dim: false };
		}
		return null;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Format a parsed SSE event for console display. Returns null to suppress.
 */
export function formatSseEvent(event: unknown): FormattedEvent {
	if (typeof event !== "object" || event === null) return null;
	const ev = event as Record<string, unknown>;
	const type = ev.type as string | undefined;
	if (!type) return null;

	const props = ev.properties as Record<string, unknown> | undefined;

	// OpenCode SSE events have a properties field
	if (props) {
		// message.part.delta — handled upstream (inline streaming)
		if (type === "message.part.delta") return null;

		// Part updates (tool calls, text, step-finish)
		if (type === "message.part.updated") {
			const part = props.part as Record<string, unknown> | undefined;
			if (!part) return null;
			const partType = part.type as string | undefined;

			if (partType === "tool") {
				return formatToolPart(part);
			}

			// Step-finish → hidden (cost/token info remains in log files)
			if (partType === "step-finish") return null;

			// Text / reasoning parts → handled as deltas upstream
			if (partType === "text") return null;
			if (partType === "reasoning") return null;

			return null;
		}

		// Session errors
		if (type === "session.error") {
			const error = props.error as string | undefined;
			if (error) return { text: `! ${error}`, dim: false };
			return null;
		}

		// All other event types with properties → suppress
		return null;
	}

	// -------------------------------------------------------------------
	// Legacy NDJSON shapes (Claude Code format — backward compat)
	// -------------------------------------------------------------------

	// system init → hidden (model info is in log)
	if (type === "system" && ev.subtype === "init") return null;

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
				if (text) lines.push(text);
			} else if (part.type === "tool_use") {
				const name = (part.name as string | undefined) ?? "unknown";
				const inputStr = safeInputSummary(part.input, SAFE_INPUT_LIMIT);
				lines.push(`${name}: ${inputStr}`);
			}
		}
		if (lines.length === 0) return null;
		// Legacy events are not individually dim/non-dim — treat as normal text
		return { text: lines.join("\n"), dim: false };
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
					const collapsed = collapseToolOutput(text, TOOL_OUTPUT_MAX_SLICE);
					if (collapsed.length > 0) {
						lines.push(collapsed);
					}
				}
			}
		}
		if (lines.length === 0) return null;
		return { text: lines.join("\n"), dim: true };
	}

	// result → hidden (same rationale as step-finish)
	if (type === "result") return null;

	// Unknown event type — skip silently
	return null;
}
