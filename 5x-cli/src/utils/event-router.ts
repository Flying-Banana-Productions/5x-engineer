/**
 * SSE Event Router — routes OpenCode SSE events to a StreamWriter.
 *
 * Phase 11 consolidation: This module is now a thin wrapper that:
 * 1. Maps SSE events to AgentEvent objects via event-mapper
 * 2. Renders AgentEvent objects via StreamWriter
 *
 * The actual mapping logic has been moved to event-mapper.ts.
 */

import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2";
import {
	createEventMapperState,
	type EventMapperState,
	mapSseToAgentEvent,
} from "../providers/event-mapper.js";
import type { StreamWriter } from "./stream-writer.js";

// Re-export state types for backward compatibility
export type { EventMapperState } from "../providers/event-mapper.js";

/**
 * Create a fresh event router state.
 * @deprecated Use createEventMapperState from event-mapper instead.
 */
export function createEventRouterState(): EventMapperState {
	return createEventMapperState();
}

/**
 * Route a single SSE event to the StreamWriter.
 *
 * This function maps the SSE event to an AgentEvent and then renders it.
 * Returns true if the event was rendered, false if it was suppressed.
 */
export function routeEventToWriter(
	event: unknown,
	writer: StreamWriter,
	state: EventMapperState,
	opts: { showReasoning?: boolean },
): boolean {
	const agentEvent = mapSseToAgentEvent(event as OpenCodeEvent, state);
	if (agentEvent) {
		writer.writeEvent(agentEvent, opts);
		return true;
	}
	return false;
}
