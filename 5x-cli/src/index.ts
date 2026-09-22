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
	AppendOp,
	AppendResult,
	AppendSnapshotInput,
	AtomicAppendIfAllNewResult,
	CancellationActor,
	CancellationAdapter,
	CancellationOutcome,
	CaptureBaselineInput,
	CaptureBaselineResult,
	CasResult,
	ClientInvocationState,
	CreatePromptInput,
	DiffSummary,
	InvocationAbandonReason,
	InvocationCasResult,
	InvocationClientView,
	InvocationRecord,
	InvocationStatus,
	InvocationStatusEnvelope,
	InvocationStore,
	OpaqueCancellationHandle,
	PreparedRecordStep,
	PrepareRecordStepOutcome,
	PromptKind,
	PromptRecord,
	PromptStore,
	RecordCommandContext,
	RecordLine,
	RecordOrigin,
	RecordPerformer,
	RecordPerformerKind,
	RecordProvenance,
	RecordRecorder,
	RecordStore,
	RecordStream,
	RegisterInvocationInput,
	ReviewBudgetBaseline,
	ReviewBudgetSnapshotRecord,
	ReviewBudgetStore,
	RunRecordSummary,
	StepIdempotencyKey,
	StepRecordPayload,
} from "./control-plane/index.js";
export {
	CANCELLATION_UNSUPPORTED,
	createInvocationId,
	createMemoryInvocationStore,
	createMemoryPromptStore,
	createMemoryRecordStore,
	createPromptId,
	createReviewBudgetId,
	createReviewBudgetStore,
	createSqliteInvocationStore,
	createSqlitePromptStore,
	createTestRemoteAdapter,
	createWorkingTreeRecordStore,
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
	RECORD_LINE_SCHEMA_VERSION,
	RecordStoreError,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	registerCancellationAdapter,
	reindexReviewBudget,
	requestInvocationCancellation,
	stepIdempotencyKey,
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
export type { GitSafetyReport, NumstatSummary, WorktreeInfo } from "./git.js";
export {
	branchExists,
	branchNameFromPlan,
	checkGitSafety,
	checkoutBranch,
	computeDiffSummary,
	computePatchId,
	createBranch,
	createWorktree,
	deleteBranch,
	fetchFiveXBranches,
	getBranchCommits,
	getCurrentBranch,
	getLatestCommit,
	gitLogLastTouching,
	gitShowFile,
	hasUncommittedChanges,
	isAncestor,
	isBranchMerged,
	isBranchRelevant,
	listFiveXRefs,
	listRemotes,
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
export type {
	DeliveryBudgetParseCode,
	DeliveryBudgetParseResult,
} from "./parsers/delivery-budget.js";
export {
	incorporatedFindingIds,
	parseDeliveryBudget,
	rawDeliveryBudgetSection,
} from "./parsers/delivery-budget.js";
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
export { deriveBudget } from "./review-budget/arithmetic.js";
export type {
	BudgetBaselinePayload,
	BudgetRecordKind,
	BudgetSnapshotPayload,
	BudgetSnapshotStepKey,
	CaptureKind,
} from "./review-budget/record-lines.js";
// Review-budget domain and authoritative record-line contracts. SQLite index
// construction deliberately remains internal; reindexReviewBudget is the
// public repair operation and always rebuilds from a RecordStore.
export type {
	ArchitectureDelta,
	BaselineAssessment,
	BaselineDirection,
	BudgetAlert,
	BudgetBand,
	CouplingClass,
	CreditAssessmentInput,
	CreditEligibility,
	DebtClaimEvidence,
	DerivedBudgetResult,
	EffortPoints,
	EstimateConfidence,
	FindingDelta,
	ParsedDeliveryBudget,
	ParsedWorkItem,
	PlanScopeClass,
	ReviewBudgetConfig,
	ReviewBudgetMode,
	ReviewBudgetThresholds,
	SurfaceSnapshot,
} from "./review-budget/types.js";
export {
	ARCHITECTURE_DELTAS,
	DEFAULT_REVIEW_BUDGET_CONFIG,
	EFFORT_POINTS,
	isArchitectureDelta,
	isCompleteDebtClaimEvidence,
	isEffortPoints,
	isValidDebtTargetPhase,
} from "./review-budget/types.js";
// Plan-review governance policy. These exports are pure structural contracts
// and policy helpers; persistence and command adapters remain internal.
export {
	assessDebtEligibility,
	validateClosureReview,
	validateDebtPolicy,
} from "./review-governance/closure.js";
export {
	decodeReviewDecisionPayload,
	encodeReviewDecisionPayload,
} from "./review-governance/codec.js";
export type {
	AcceptedRisk,
	ApprovedScope,
	ArchitectureApproval,
	DecisionAcceptance,
	GoverningReviewState,
	ReviewDecisionPayload,
} from "./review-governance/decisions.js";
export {
	applyDecisionCauseCoverage,
	classifyDecisionAcceptance,
	computeDecisionIntentHash,
	createReviewDecision,
	deriveGateId,
	foldGoverningReviewState,
	governanceCorrectionKey,
	governanceDecisionKey,
	REVIEW_DECISION_VERSION,
} from "./review-governance/decisions.js";
export { canonicalFindingFingerprint } from "./review-governance/fingerprint.js";
export { reindexReviewGovernance } from "./review-governance/sqlite-index.js";
export type {
	DerivedReviewGate,
	ResolveReviewGateInput,
	ResolveReviewGateResult,
	ReviewGovernanceStore,
} from "./review-governance/store.js";
export { createReviewGovernanceStore } from "./review-governance/store.js";
export type {
	BlockingFindingEvidence,
	ClosureDiagnostic,
	ClosureDiagnosticCode,
	ClosureValidationResult,
	CriticalSafetyEvidence,
	DebtEligibility,
	DecisionReraiseEvidence,
	FindingIdentity,
	GovernanceReviewerVerdict,
	GovernanceVerdictItem,
	IntroducedByPlanHunk,
	IntroducedHunkEvidence,
	PersistedFinding,
	PlanDiffContext,
	PlanReviewGovernanceResult,
	PlanReviewRoute,
	PriorDecisionEvidence,
	PriorFindingOutcome,
	PriorFindingStatus,
	ReviewDecision,
	ReviewDecisionChoice,
	ReviewDecisionRoute,
	ReviewGateCause,
} from "./review-governance/types.js";
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
