/**
 * Control-plane prompt store factories and types.
 *
 * SQLite SQL stays in `sqlite-store.ts`. Do not re-export SQL helpers.
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
