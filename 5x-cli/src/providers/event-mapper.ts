/**
 * OpenCode 2.x event mapper — converts `@opencode/client` stream events to
 * canonical `AgentEvent` objects.
 *
 * 2.x events are flat and typed: every subscribed session event carries
 * `data.sessionID`, except `form.created`, whose session is
 * `data.form.sessionID`. The only state the mapper keeps is the tool
 * call id → tool name map, because `session.tool.called` and the tool result
 * events carry only the call id.
 *
 * Inbox (`session.inbox.*`) and execution (`session.execution.*`) events are
 * read by the provider's turn loop for prompt ownership and settlement; apart
 * from `session.execution.failed` they produce no `AgentEvent` here.
 */

import type { OpenCodeEvent } from "@opencode/client";
import type { AgentEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-turn mapper state. */
export interface EventMapperState {
	/** Tool call id → tool name, recorded from `session.tool.input.started`. */
	toolNames: Map<string, string>;
}

/** Maximum characters of tool output carried on a `tool_end` event. */
const TOOL_OUTPUT_LIMIT = 500;

/** Create fresh mapper state. */
export function createEventMapperState(): EventMapperState {
	return { toolNames: new Map() };
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * The session an event belongs to: `data.form.sessionID` for `form.created`,
 * otherwise `data.sessionID`. Undefined for events with no session.
 */
export function eventSessionId(event: OpenCodeEvent): string | undefined {
	const ev = event as { type?: unknown; data?: unknown };
	const data = asRecord(ev.data);
	if (!data) return undefined;
	if (ev.type === "form.created") {
		const form = asRecord(data.form);
		return typeof form?.sessionID === "string" ? form.sessionID : undefined;
	}
	return typeof data.sessionID === "string" ? data.sessionID : undefined;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function firstTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		const rec = asRecord(item);
		if (rec?.type === "text" && typeof rec.text === "string") return rec.text;
	}
	return undefined;
}

function errorMessage(error: unknown): string | undefined {
	const rec = asRecord(error);
	return typeof rec?.message === "string" ? rec.message : undefined;
}

/**
 * Map one 2.x event to an `AgentEvent`, or undefined when the event has no
 * user-visible counterpart. Session filtering is the caller's job.
 */
export function mapOpenCodeEvent(
	event: OpenCodeEvent,
	state: EventMapperState,
): AgentEvent | undefined {
	const ev = event as { type?: unknown; data?: unknown };
	const data = asRecord(ev.data) ?? {};

	switch (ev.type) {
		case "session.text.delta":
			return typeof data.delta === "string" && data.delta.length > 0
				? { type: "text", delta: data.delta }
				: undefined;

		case "session.reasoning.delta":
			return typeof data.delta === "string" && data.delta.length > 0
				? { type: "reasoning", delta: data.delta }
				: undefined;

		case "session.tool.input.started": {
			if (typeof data.id === "string" && typeof data.name === "string") {
				state.toolNames.set(data.id, data.name);
			}
			return undefined;
		}

		case "session.tool.called": {
			const tool = toolName(state, data.id);
			return {
				type: "tool_start",
				tool,
				input_summary: summarizeToolInput(tool, data.input),
			};
		}

		case "session.tool.success": {
			const tool = toolName(state, data.id);
			const output = firstTextContent(data.content) ?? "";
			return {
				type: "tool_end",
				tool,
				output: output.slice(0, TOOL_OUTPUT_LIMIT),
			};
		}

		case "session.tool.failed": {
			const tool = toolName(state, data.id);
			const output =
				errorMessage(data.error) ?? firstTextContent(data.content) ?? "";
			return {
				type: "tool_end",
				tool,
				output: output.slice(0, TOOL_OUTPUT_LIMIT),
				error: true,
			};
		}

		case "session.step.failed":
			return {
				type: "error",
				message: errorMessage(data.error) ?? "OpenCode step failed",
			};

		case "session.execution.failed":
			return {
				type: "error",
				message: errorMessage(data.error) ?? "OpenCode execution failed",
			};

		default:
			return undefined;
	}
}

function toolName(state: EventMapperState, id: unknown): string {
	if (typeof id !== "string") return "unknown";
	return state.toolNames.get(id) ?? "unknown";
}

// ---------------------------------------------------------------------------
// Tool input summaries
// ---------------------------------------------------------------------------

/** Generate a short, human-readable summary of a tool's input. */
export function summarizeToolInput(tool: string, input: unknown): string {
	const obj = asRecord(input);
	if (!obj) return "";

	const str = (key: string): string | undefined =>
		typeof obj[key] === "string" ? (obj[key] as string) : undefined;

	switch (tool) {
		case "shell":
		case "bash":
			return str("command") ?? "";
		case "read":
		case "edit":
		case "write":
			return str("path") ?? str("filePath") ?? "";
		case "glob":
		case "grep":
			return str("pattern") ?? "";
		case "subagent":
			return str("agent") ?? "";
		default: {
			const keys = Object.keys(obj);
			return keys.length > 0 ? `{${keys.join(", ")}}` : "";
		}
	}
}
