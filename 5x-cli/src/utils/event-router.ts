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
}

export function createEventRouterState(): EventRouterState {
	return {
		textPartIds: new Set(),
		reasoningPartIds: new Set(),
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

	// Register text and reasoning parts so we know which delta events to route.
	if (type === "message.part.updated" && props) {
		const part = props.part as Record<string, unknown> | undefined;
		if (part?.type === "text") {
			const pid = part.id as string | undefined;
			if (pid) state.textPartIds.add(pid);
		}
		if (part?.type === "reasoning") {
			const pid = part.id as string | undefined;
			if (pid) state.reasoningPartIds.add(pid);
		}
	}

	// Delta events: route to StreamWriter for word-wrapped streaming.
	if (type === "message.part.delta" && props) {
		const partId = props.partID as string | undefined;
		const delta = props.delta as string | undefined;
		if (partId && delta) {
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
