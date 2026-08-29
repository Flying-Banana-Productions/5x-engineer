// Public API exports — v1

// Control-plane state paths
export {
	controlPlaneDbPath,
	controlPlaneStatePath,
} from "./commands/control-plane.js";
// Run identity
export type {
	AmbientRunErrorCode,
	AmbientRunRequest,
	AmbientRunResult,
	AmbientRunSource,
} from "./commands/run-identity.js";
export {
	AMBIENT_RUN_OPTION_HELP,
	AMBIENT_RUN_OPTION_HELP_WITH_RECORD,
	isLinkedWorktreeCheckout,
	listActiveRunsForCheckout,
	outputAmbientError,
	REQUIRED_REMEDIATION,
	requireAmbientRunId,
	resolveAmbientRunId,
} from "./commands/run-identity.js";
export {
	CURRENT_RUN_FILENAME,
	clearPointerIfMatch,
	currentRunPath,
	readPointer,
	writePointer,
} from "./commands/run-pointer.js";
// Config
export type { AgentConfigRole, FiveXConfig } from "./config.js";
export {
	defineConfig,
	loadConfig,
	resolveHarnessModelForRole,
} from "./config.js";
// Control plane — prompt store (SQLite is one materialization)
export type {
	AbandonReason,
	AdapterCancelResult,
	AnsweredBy,
	CancellationActor,
	CancellationAdapter,
	CancellationOutcome,
	CasResult,
	ClientInvocationState,
	CreatePromptInput,
	InvocationAbandonReason,
	InvocationCasResult,
	InvocationClientView,
	InvocationRecord,
	InvocationStatus,
	InvocationStatusEnvelope,
	InvocationStore,
	OpaqueCancellationHandle,
	PromptKind,
	PromptRecord,
	PromptStore,
	RegisterInvocationInput,
} from "./control-plane/index.js";
export {
	CANCELLATION_UNSUPPORTED,
	createInvocationId,
	createMemoryInvocationStore,
	createMemoryPromptStore,
	createPromptId,
	createSqliteInvocationStore,
	createSqlitePromptStore,
	createTestRemoteAdapter,
	getCancellationAdapter,
	getInvocationView,
	INVOCATION_HEARTBEAT_MIN_INTERVAL_MS,
	INVOCATION_INVALID_ACTOR,
	INVOCATION_NOT_FOUND,
	INVOCATION_STALE_MS,
	InvocationStoreError,
	isCancellationActor,
	listInvocationViews,
	PromptStoreError,
	parseOpaqueCancellationHandle,
	registerCancellationAdapter,
	requestInvocationCancellation,
	toClientInvocationState,
	toClientInvocationView,
	toInvocationStatusEnvelope,
	withInvocationLifecycle,
} from "./control-plane/index.js";
// DB — connection
export { closeDb, getDb, openDbReadOnly } from "./db/connection.js";
// DB — operations (valid on v4 schema: runs, plans, steps tables)
export type {
	PlanRow,
	RunMetrics,
	RunRow,
	RunSummary,
} from "./db/operations.js";
export {
	createRun,
	getActiveRun,
	getLatestRun,
	getPlan,
	getRunHistory,
	getRunMetrics,
	updateRunStatus,
	upsertPlan,
} from "./db/operations.js";
// DB — v1 step-based operations
export type {
	RecordStepInput,
	RecordStepResult,
	RunRowV1,
	RunSummaryComputed,
	RunSummaryV1,
	StepRow,
} from "./db/operations-v1.js";
export {
	completeRun,
	computeRunSummary,
	createRunV1,
	getActiveRunV1,
	getLatestStep,
	getRunV1,
	getSteps,
	getStepsByPhase,
	listRuns,
	nextIteration,
	recordStep,
	reopenRun,
} from "./db/operations-v1.js";
export {
	getMaxKnownSchemaVersion,
	getSchemaVersion,
	runMigrations,
} from "./db/schema.js";
// Gates
export type { QualityCommandResult, QualityResult } from "./gates/quality.js";
export { runQualityGates } from "./gates/quality.js";
// Git
export type { GitSafetyReport, WorktreeInfo } from "./git.js";
export {
	branchExists,
	branchNameFromPlan,
	checkGitSafety,
	checkoutBranch,
	createBranch,
	createWorktree,
	deleteBranch,
	getBranchCommits,
	getCurrentBranch,
	getLatestCommit,
	hasUncommittedChanges,
	isBranchMerged,
	isBranchRelevant,
	listWorktrees,
	removeWorktree,
	runWorktreeSetupCommand,
} from "./git.js";
// Lock
export type {
	LockDirOpts,
	LockEntry,
	LockInfo,
	LockLiveness,
	LockResult,
	ReleaseLockResult,
	RemoveCorruptLockResult,
} from "./lock.js";
export {
	acquireLock,
	forceReleaseLock,
	inspectLock,
	isLocked,
	listLocks,
	registerLockCleanup,
	releaseLock,
	removeCorruptLock,
} from "./lock.js";
// Output helpers (v1 JSON envelope)
export type { ErrorEnvelope, JsonEnvelope, SuccessEnvelope } from "./output.js";
export {
	CliError,
	formatTextError,
	jsonStringify,
	outputError,
	outputSuccess,
	remediationFromDetail,
	setPrettyPrint,
} from "./output.js";
// Parsers
export type { ChecklistItem, ParsedPlan, Phase } from "./parsers/plan.js";
export { parsePlan } from "./parsers/plan.js";
export type { ReviewSummary } from "./parsers/review.js";
export { parseReviewSummary } from "./parsers/review.js";
// Paths
export {
	canonicalizePlanPath,
	isPathUnder,
	realpathExisting,
	relativePathUnder,
} from "./paths.js";
// Project root
export { findGitRoot, resolveProjectRoot } from "./project-root.js";
// Protocol
export {
	AuthorStatusSchema,
	assertAuthorStatus,
	assertReviewerVerdict,
	isStructuredOutputError,
	ReviewerVerdictSchema,
} from "./protocol.js";
// Providers — v1
export {
	createProvider,
	InvalidProviderError,
	ProviderNotFoundError,
} from "./providers/factory.js";
export {
	AgentCancellationError,
	AgentTimeoutError,
	OpenCodeProvider,
} from "./providers/opencode.js";
export type {
	AgentEvent,
	AgentProvider,
	AgentSession,
	ProviderPlugin,
	ResumeOptions,
	RunOptions,
	RunResult,
	SessionOptions,
} from "./providers/types.js";
// Templates
export type {
	RenderedTemplate,
	TemplateMetadata,
} from "./templates/loader.js";
export {
	listTemplates,
	loadTemplate,
	renderBody,
	renderTemplate,
} from "./templates/loader.js";
