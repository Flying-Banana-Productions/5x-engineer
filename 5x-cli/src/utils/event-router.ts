/**
 * Shared SSE event routing logic for headless console rendering.
 *
 * Extracted so the adapter (`opencode.ts`) and integration tests
 * (`opencode-rendering.test.ts`) use the same routing state machine,
 * eliminating drift risk (review P1.2).
 */

import { formatSseEvent } from "./sse-formatter.js";
import type { StreamWriter } from "./stream-writer.js";

export interface EventRouterState {
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

/**
 * Bound per-invocation dedupe state so very long sessions do not grow
 * `updatedDeltaPartIds` without limit.
 */
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

export function createEventRouterState(): EventRouterState {
	return {
		textPartIds: new Set(),
		reasoningPartIds: new Set(),
		partTextById: new Map(),
		updatedDeltaPartIds: new Set(),
		runningToolSignatureById: new Map(),
	};
}

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

/**
 * Route a single SSE event to the StreamWriter.
 *
 * Handles part registration, delta routing, and formatted event output.
 * Callers invoke this for every event; no return value — all side effects
 * go through the writer.
 */
export function routeEventToWriter(
	event: unknown,
	writer: StreamWriter,
	state: EventRouterState,
	opts: { showReasoning?: boolean },
): void {
	const ev = event as Record<string, unknown>;
	const type = ev.type as string | undefined;
	const props = ev.properties as Record<string, unknown> | undefined;

	// Register text/reasoning parts and handle inline deltas carried on
	// message.part.updated (newer OpenCode event shape).
	if (type === "message.part.updated" && props) {
		const part = props.part as Record<string, unknown> | undefined;
		const partType = part?.type;
		const pid = part?.id as string | undefined;

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
					return;
				}
				state.runningToolSignatureById.set(key, signature);
			}

			if (key && (status === "completed" || status === "error")) {
				state.runningToolSignatureById.delete(key);
			}
		}

		if (partType === "text") {
			if (pid) state.textPartIds.add(pid);
		}
		if (partType === "reasoning") {
			if (pid) state.reasoningPartIds.add(pid);
		}

		// Preferred shape: text/reasoning deltas arrive on message.part.updated
		// as properties.delta.
		const delta = props.delta as string | undefined;
		if (delta) {
			if (partType === "text") {
				if (pid) trackUpdatedDeltaPartId(state.updatedDeltaPartIds, pid);
				writer.writeText(delta);
				return;
			}
			if (partType === "reasoning") {
				if (pid) trackUpdatedDeltaPartId(state.updatedDeltaPartIds, pid);
				if (opts.showReasoning) {
					writer.writeThinking(delta);
				}
				return;
			}
		}

		// Fallback shape: message.part.updated carries full part.text without
		// properties.delta. Stream only the incremental append to avoid repeats.
		const partText = part?.text;
		if (
			pid &&
			typeof partText === "string" &&
			(partType === "text" || partType === "reasoning")
		) {
			const previous = state.partTextById.get(pid) ?? "";
			const append = incrementalAppend(previous, partText);
			state.partTextById.set(pid, partText);
			if (append.length > 0) {
				trackUpdatedDeltaPartId(state.updatedDeltaPartIds, pid);
				if (partType === "text") {
					writer.writeText(append);
					return;
				}
				if (opts.showReasoning) {
					writer.writeThinking(append);
				}
				return;
			}
		}
	}

	// Delta events: route to StreamWriter for word-wrapped streaming.
	if (type === "message.part.delta" && props) {
		const partId = props.partID as string | undefined;
		const delta = props.delta as string | undefined;
		if (partId && delta) {
			// If this part already streamed deltas via message.part.updated,
			// suppress legacy message.part.delta to avoid duplicate text.
			if (state.updatedDeltaPartIds.has(partId)) {
				return;
			}

			if (state.textPartIds.has(partId)) {
				writer.writeText(delta);
				return;
			}
			// Only route reasoning when --show-reasoning is active
			if (opts.showReasoning && state.reasoningPartIds.has(partId)) {
				writer.writeThinking(delta);
				return;
			}
		}
		// Non-text/non-reasoning delta — suppress
		return;
	}

	// Formatted events: single-line output via writeLine
	const formatted = formatSseEvent(event);
	if (formatted != null) {
		writer.writeLine(formatted.text, { dim: formatted.dim });
	}
}
