// v1 Provider interface — re-exports

export type { EventMapperState } from "./event-mapper.js";
// Event mapper
export {
	createEventMapperState,
	eventSessionId,
	mapOpenCodeEvent,
	summarizeToolInput,
} from "./event-mapper.js";
// Factory
export type { OpenCodeFactoryDeps } from "./factory.js";
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
	MIN_OPENCODE_VERSION,
	OpenCodeProvider,
	parseModel,
	parseServeListenUrl,
} from "./opencode.js";
// Structured output
export type { StructuredExtractResult } from "./structured-output.js";
export {
	buildCorrectivePrompt,
	buildStructuredOutputPrompt,
	extractStructuredJson,
} from "./structured-output.js";
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
