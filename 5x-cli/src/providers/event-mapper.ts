/**
 * SSE Event Mapper — converts provider-native events to canonical AgentEvent objects.
 *
 * Phase 11 consolidation: This module centralizes the SSE→AgentEvent mapping
 * that was previously split between opencode.ts and event-router.ts.
 *
 * The mapper maintains state for:
 * - Part registration (text/reasoning part IDs)
 * - Delta deduplication (avoiding duplicate output from legacy events)
 * - Session ID resolution across related events
 */

import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2";
import type { AgentEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for resolving session IDs across related events. */
export interface SessionResolveContext {
	partToSession: Map<string, string>;
	messageToSession: Map<string, string>;
}

/** State for the event mapper (deduplication and part tracking). */
export interface EventMapperState {
	textPartIds: Set<string>;
	reasoningPartIds: Set<string>;
	/** Last seen full text by part id (for full-text update fallback). */
	partTextById: Map<string, string>;
	/**
	 * Part IDs that already streamed deltas via message.part.updated.
	 * Used to avoid duplicate output when legacy message.part.delta
	 * events are also emitted for the same part.
	 */
	updatedDeltaPartIds: Set<string>;
	/**
	 * Last seen running tool signature by part/call id.
	 * Suppresses repeated identical `status=running` updates that only differ
	 * by transient metadata/output snapshots.
	 */
	runningToolSignatureById: Map<string, string>;
}

/** Options for the event mapper. */
export interface EventMapperOptions {
	/** Maximum size of updatedDeltaPartIds set to prevent unbounded growth. */
	maxTrackedDeltaPartIds?: number;
}

// ---------------------------------------------------------------------------
// State Management
// ---------------------------------------------------------------------------

/** Bound per-invocation dedupe state so very long sessions do not grow without limit. */
export const MAX_TRACKED_DELTA_PART_IDS = 4096;

function trackUpdatedDeltaPartId(
	set: Set<string>,
	partId: string,
	maxSize: number = MAX_TRACKED_DELTA_PART_IDS,
): void {
	if (set.has(partId)) {
		set.delete(partId);
	}
	set.add(partId);

	if (set.size <= maxSize) return;

	const oldest = set.values().next().value as string | undefined;
	if (oldest) {
		set.delete(oldest);
	}
}

/** Create fresh mapper state. */
export function createEventMapperState(): EventMapperState {
	return {
		textPartIds: new Set(),
		reasoningPartIds: new Set(),
		partTextById: new Map(),
		updatedDeltaPartIds: new Set(),
		runningToolSignatureById: new Map(),
	};
}

/** Create fresh session resolve context. */
export function createSessionResolveContext(): SessionResolveContext {
	return {
		partToSession: new Map(),
		messageToSession: new Map(),
	};
}

// ---------------------------------------------------------------------------
// Session ID Resolution
// ---------------------------------------------------------------------------

/**
 * Extract session ID from an OpenCode SSE event (best-effort).
 * Ported from v0 `getEventSessionId()`.
 */
export function getEventSessionId(event: OpenCodeEvent): string | undefined {
	const ev = event as Record<string, unknown>;
	const type = typeof ev.type === "string" ? ev.type : undefined;
	const props = ev.properties as Record<string, unknown> | undefined;
	if (!props) return undefined;

	if (typeof props.sessionID === "string") return props.sessionID;
	if (typeof props.sessionId === "string") return props.sessionId;

	const info = props.info as Record<string, unknown> | undefined;
	if (info && typeof info.sessionID === "string") return info.sessionID;
	if (info && typeof info.sessionId === "string") return info.sessionId;

	if (type?.startsWith("session.") && info && typeof info.id === "string") {
		return info.id;
	}

	const part = props.part as Record<string, unknown> | undefined;
	if (part && typeof part.sessionID === "string") return part.sessionID;
	if (part && typeof part.sessionId === "string") return part.sessionId;

	// Deep fallback
	return findSessionIdDeep(props);
}

function findSessionIdDeep(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): string | undefined {
	if (depth > 4 || value == null || typeof value !== "object") return undefined;
	if (seen.has(value)) return undefined;
	seen.add(value);

	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findSessionIdDeep(item, depth + 1, seen);
			if (found) return found;
		}
		return undefined;
	}

	const obj = value as Record<string, unknown>;
	if (typeof obj.sessionID === "string") return obj.sessionID;
	if (typeof obj.sessionId === "string") return obj.sessionId;

	for (const nested of Object.values(obj)) {
		const found = findSessionIdDeep(nested, depth + 1, seen);
		if (found) return found;
	}
	return undefined;
}

/**
 * Resolve session ID with context tracking.
 * Maintains mappings between part IDs, message IDs, and session IDs.
 */
export function resolveSessionIdWithContext(
	event: OpenCodeEvent,
	ctx: SessionResolveContext,
): string | undefined {
	const direct = getEventSessionId(event);
	const ev = event as Record<string, unknown>;
	const type = ev.type as string | undefined;
	const props = ev.properties as Record<string, unknown> | undefined;
	const info = props?.info as Record<string, unknown> | undefined;
	const part = props?.part as Record<string, unknown> | undefined;

	const getStr = (obj: Record<string, unknown> | undefined, key: string) => {
		const v = obj?.[key];
		return typeof v === "string" ? v : undefined;
	};
	const getStrAny = (
		obj: Record<string, unknown> | undefined,
		keys: readonly string[],
	) => {
		for (const k of keys) {
			const v = getStr(obj, k);
			if (v) return v;
		}
		return undefined;
	};

	if (direct) {
		const messageId =
			getStr(info, "id") ?? getStrAny(part, ["messageID", "messageId"]);
		if (messageId) ctx.messageToSession.set(messageId, direct);

		const partId = getStr(part, "id");
		if (partId) ctx.partToSession.set(partId, direct);
		return direct;
	}

	if (type === "message.part.delta" && props) {
		const partId = getStrAny(props, ["partID", "partId"]);
		if (partId) {
			const fromPart = ctx.partToSession.get(partId);
			if (fromPart) return fromPart;
		}
		const messageId = getStrAny(props, ["messageID", "messageId"]);
		if (messageId) {
			const fromMessage = ctx.messageToSession.get(messageId);
			if (fromMessage) return fromMessage;
		}
	}

	if (type === "message.part.updated" && part) {
		const messageId = getStrAny(part, ["messageID", "messageId"]);
		if (messageId) {
			const fromMessage = ctx.messageToSession.get(messageId);
			if (fromMessage) {
				const partId = getStr(part, "id");
				if (partId) ctx.partToSession.set(partId, fromMessage);
				return fromMessage;
			}
		}
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Tool Input Summarization
// ---------------------------------------------------------------------------

/**
 * Return a human-friendly summary of tool input.
 * Known tools extract the most useful field; unknown tools show key names.
 */
export function summarizeToolInput(tool: string, input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;

	switch (tool) {
		case "bash":
		case "shell":
			return typeof obj.command === "string" ? obj.command : "";
		case "edit":
		case "file_edit":
		case "write":
			return typeof obj.filePath === "string"
				? obj.filePath
				: typeof obj.path === "string"
					? obj.path
					: "";
		case "read":
			return typeof obj.filePath === "string"
				? obj.filePath
				: typeof obj.path === "string"
					? obj.path
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
// Helpers
// ---------------------------------------------------------------------------

function toolDedupKey(part: Record<string, unknown>): string | undefined {
	const id = part.id;
	if (typeof id === "string" && id.length > 0) return id;
	const callID = part.callID;
	if (typeof callID === "string" && callID.length > 0) return callID;
	return undefined;
}

function stableToolSignature(part: Record<string, unknown>): string {
	const tool = typeof part.tool === "string" ? part.tool : "unknown";
	const state = (part.state as Record<string, unknown> | undefined) ?? {};
	const status = typeof state.status === "string" ? state.status : "";
	const input = state.input;
	return `${tool}:${status}:${JSON.stringify(input)}`;
}

function incrementalAppend(previous: string, next: string): string {
	if (next.length === 0) return "";
	if (previous.length === 0) return next;
	if (next.startsWith(previous) && next.length > previous.length) {
		return next.slice(previous.length);
	}
	return "";
}

// ---------------------------------------------------------------------------
// Main Mapper
// ---------------------------------------------------------------------------

/**
 * Map an OpenCode SSE event to an AgentEvent.
 * Returns undefined for events that should be skipped (non-content events).
 *
 * This mapper maintains state for part tracking and deduplication.
 * The state object should be reused across all events in a session.
 */
export function mapSseToAgentEvent(
	event: OpenCodeEvent,
	state: EventMapperState,
): AgentEvent | undefined {
	const ev = event as Record<string, unknown>;
	const type = ev.type as string | undefined;
	const props = ev.properties as Record<string, unknown> | undefined;

	// Handle message.part.updated events (preferred shape)
	if (type === "message.part.updated" && props) {
		const part = props.part as Record<string, unknown> | undefined;
		const partType = part?.type;
		const pid = part?.id as string | undefined;

		// Tool event handling with deduplication
		if (partType === "tool" && part) {
			const key = toolDedupKey(part);
			const status =
				typeof (part.state as Record<string, unknown> | undefined)?.status ===
				"string"
					? ((part.state as Record<string, unknown>).status as string)
					: undefined;

			if (key && status === "running") {
				const signature = stableToolSignature(part);
				if (state.runningToolSignatureById.get(key) === signature) {
					return undefined; // Duplicate running update
				}
				state.runningToolSignatureById.set(key, signature);
			}

			if (key && (status === "completed" || status === "error")) {
				state.runningToolSignatureById.delete(key);
			}

			// Map to AgentEvent
			const tool = typeof part.tool === "string" ? part.tool : "unknown";
			const partState = part.state as Record<string, unknown> | undefined;
			const partStatus = partState?.status as string | undefined;
			const input = partState?.input;

			if (partStatus === "running") {
				const inputSummary = summarizeToolInput(tool, input);
				return { type: "tool_start", tool, input_summary: inputSummary };
			}

			if (partStatus === "completed" || partStatus === "error") {
				const output =
					typeof partState?.output === "string"
						? (partState.output as string)
						: JSON.stringify(partState?.output ?? "");
				return {
					type: "tool_end",
					tool,
					output: output.slice(0, 500),
					error: partStatus === "error",
				};
			}
		}

		// Text part registration and delta handling
		if (partType === "text") {
			if (pid) state.textPartIds.add(pid);

			// Preferred: delta on properties
			const delta = props.delta as string | undefined;
			if (delta) {
				if (pid) trackUpdatedDeltaPartId(state.updatedDeltaPartIds, pid);
				return { type: "text", delta };
			}

			// Fallback: full text on part.text
			const partText = part?.text;
			if (pid && typeof partText === "string" && partText.length > 0) {
				const previous = state.partTextById.get(pid) ?? "";
				const append = incrementalAppend(previous, partText);
				state.partTextById.set(pid, partText);
				if (append.length > 0) {
					trackUpdatedDeltaPartId(state.updatedDeltaPartIds, pid);
					return { type: "text", delta: append };
				}
			}
		}

		// Reasoning part registration and delta handling
		if (partType === "reasoning") {
			if (pid) state.reasoningPartIds.add(pid);

			const delta = props.delta as string | undefined;
			if (delta) {
				if (pid) trackUpdatedDeltaPartId(state.updatedDeltaPartIds, pid);
				return { type: "reasoning", delta };
			}

			const partText = part?.text;
			if (pid && typeof partText === "string" && partText.length > 0) {
				const previous = state.partTextById.get(pid) ?? "";
				const append = incrementalAppend(previous, partText);
				state.partTextById.set(pid, partText);
				if (append.length > 0) {
					trackUpdatedDeltaPartId(state.updatedDeltaPartIds, pid);
					return { type: "reasoning", delta: append };
				}
			}
		}
	}

	// Legacy delta events
	if (type === "message.part.delta" && props) {
		// Check both partID (legacy) and partId (camelCase) properties
		const partId =
			typeof props.partID === "string"
				? props.partID
				: typeof props.partId === "string"
					? props.partId
					: undefined;
		const delta = props.delta as string | undefined;
		if (partId && delta) {
			// Skip if already handled via message.part.updated
			if (state.updatedDeltaPartIds.has(partId)) {
				return undefined;
			}

			if (state.textPartIds.has(partId)) {
				return { type: "text", delta };
			}
			if (state.reasoningPartIds.has(partId)) {
				return { type: "reasoning", delta };
			}
		}
	}

	// Session error events
	if (type === "session.error" && props) {
		const error = props.error as string | undefined;
		if (error) {
			return { type: "error", message: error };
		}
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Batch/Event Stream Processing
// ---------------------------------------------------------------------------

/**
 * Process a stream of OpenCode events and yield AgentEvents.
 * Maintains internal state for the duration of the stream.
 */
export async function* mapSseStreamToAgentEvents(
	events: AsyncIterable<OpenCodeEvent>,
): AsyncIterable<AgentEvent> {
	const state = createEventMapperState();

	for await (const event of events) {
		const agentEvent = mapSseToAgentEvent(event, state);
		if (agentEvent) {
			yield agentEvent;
		}
	}
}
