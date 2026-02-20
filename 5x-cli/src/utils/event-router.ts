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
	/**
	 * Part IDs that already streamed deltas via message.part.updated.
	 * Used to avoid duplicate output when legacy message.part.delta
	 * events are also emitted for the same part.
	 */
	updatedDeltaPartIds: Set<string>;
}

export function createEventRouterState(): EventRouterState {
	return {
		textPartIds: new Set(),
		reasoningPartIds: new Set(),
		updatedDeltaPartIds: new Set(),
	};
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

		if (partType === "text") {
			if (pid) state.textPartIds.add(pid);
		}
		if (partType === "reasoning") {
			if (pid) state.reasoningPartIds.add(pid);
		}

		// Newer shape: text/reasoning deltas arrive on message.part.updated
		// as properties.delta.
		const delta = props.delta as string | undefined;
		if (delta) {
			if (partType === "text") {
				if (pid) state.updatedDeltaPartIds.add(pid);
				writer.writeText(delta);
				return;
			}
			if (partType === "reasoning") {
				if (pid) state.updatedDeltaPartIds.add(pid);
				if (opts.showReasoning) {
					writer.writeThinking(delta);
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
