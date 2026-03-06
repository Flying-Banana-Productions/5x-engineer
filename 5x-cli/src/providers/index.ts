// v1 Provider interface — re-exports

export type {
	EventMapperOptions,
	EventMapperState,
	SessionResolveContext,
} from "./event-mapper.js";
// Event mapper
export {
	createEventMapperState,
	createSessionResolveContext,
	getEventSessionId,
	MAX_TRACKED_DELTA_PART_IDS,
	mapSseStreamToAgentEvents,
	mapSseToAgentEvent,
	resolveSessionIdWithContext,
	summarizeToolInput,
} from "./event-mapper.js";
// Factory
export {
	createProvider,
	InvalidProviderError,
	ProviderNotFoundError,
} from "./factory.js";
export type {
	LogEntry,
	LogWriterOptions,
	SessionStartEntry,
} from "./log-writer.js";
// Log writer
export {
	appendLogLine,
	appendLogLines,
	appendSessionStart,
	createBufferLogWriter,
	createLogWriter,
	nextLogSequence,
	prepareLogPath,
} from "./log-writer.js";
// OpenCode provider
export {
	AgentCancellationError,
	AgentTimeoutError,
	anySignal,
	OpenCodeProvider,
	parseModel,
} from "./opencode.js";
// Types
export type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	JSONSchema,
	ProviderPlugin,
	ResumeOptions,
	RunOptions,
	RunResult,
	SessionOptions,
} from "./types.js";
