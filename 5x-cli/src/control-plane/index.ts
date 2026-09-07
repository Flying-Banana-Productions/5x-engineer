/**
 * Control-plane store factories and types (prompts, invocations, records).
 *
 * SQLite SQL stays in `sqlite-store.ts`. Do not re-export SQL helpers,
 * identity-file I/O, or filesystem helpers except the two RecordStore
 * factories (`createMemoryRecordStore`, `createWorkingTreeRecordStore`).
 */

export type {
	AdapterCancelResult,
	CancellationAdapter,
} from "./cancellation-adapter.js";
export {
	_resetCancellationAdaptersForTest,
	getCancellationAdapter,
	registerCancellationAdapter,
} from "./cancellation-adapter.js";
export { createInvocationId, createPromptId } from "./ids.js";
export {
	CANCELLATION_UNSUPPORTED,
	getInvocationView,
	INVOCATION_INVALID_ACTOR,
	INVOCATION_NOT_FOUND,
	listInvocationViews,
	requestInvocationCancellation,
} from "./invocation-actions.js";
export {
	INVOCATION_HEARTBEAT_MIN_INTERVAL_MS,
	INVOCATION_STALE_MS,
	withInvocationLifecycle,
} from "./invocation-lifecycle.js";
export type { MemoryInvocationStoreOptions } from "./invocation-memory.js";
export { createMemoryInvocationStore } from "./invocation-memory.js";
export { createSqliteInvocationStore } from "./invocation-sqlite.js";
export type { InvocationStore } from "./invocation-store.js";
export type {
	CancellationActor,
	CancellationOutcome,
	ClientInvocationState,
	InvocationAbandonReason,
	InvocationCasResult,
	InvocationClientView,
	InvocationRecord,
	InvocationStatus,
	InvocationStatusEnvelope,
	OpaqueCancellationHandle,
	RegisterInvocationInput,
} from "./invocation-types.js";
export {
	InvocationStoreError,
	isCancellationActor,
	parseOpaqueCancellationHandle,
} from "./invocation-types.js";
export {
	toClientInvocationState,
	toClientInvocationView,
	toInvocationStatusEnvelope,
} from "./invocation-view.js";
export { createMemoryPromptStore } from "./memory-store.js";
export { createWorkingTreeRecordStore } from "./record-fs.js";
export type { MemoryRecordStoreOptions } from "./record-memory.js";
export { createMemoryRecordStore } from "./record-memory.js";
export {
	FORBIDDEN_ORIGIN_KEYS,
	redactOrigin,
	redactRecorder,
	redactStepPayload,
} from "./record-redact.js";
export type { RecordStore } from "./record-store.js";
export type {
	AppendOp,
	AppendResult,
	DiffSummary,
	RecordLine,
	RecordOrigin,
	RecordPerformer,
	RecordPerformerKind,
	RecordProvenance,
	RecordRecorder,
	RecordStream,
	RunRecordSummary,
	StepIdempotencyKey,
	StepRecordPayload,
} from "./record-types.js";
export {
	RECORD_LINE_SCHEMA_VERSION,
	RecordStoreError,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "./record-types.js";
export type {
	PreparedRecordStep,
	PrepareRecordStepOutcome,
	RecordCommandContext,
} from "./record-writer-types.js";
export { createSqlitePromptStore } from "./sqlite-store.js";
export type { PromptStore } from "./store.js";
export type { TestRemoteAdapter } from "./test-remote-adapter.js";
export { createTestRemoteAdapter } from "./test-remote-adapter.js";
export type {
	AbandonReason,
	AnsweredBy,
	CasResult,
	CreatePromptInput,
	PromptKind,
	PromptRecord,
} from "./types.js";
export { PromptStoreError } from "./types.js";
export type { WaitForPromptAnswerOptions } from "./wait.js";
export {
	PROMPT_POLL_INTERVAL_MS,
	PromptAbandonedError,
	PromptTimeoutError,
	PromptWaitAbortedError,
	waitForPromptAnswer,
} from "./wait.js";
