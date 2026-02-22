// Public API exports

export { AgentCancellationError, AgentTimeoutError } from "./agents/errors.js";
export { createAndVerifyAdapter } from "./agents/factory.js";
export { OpenCodeAdapter } from "./agents/opencode.js";
// Agents
export type {
	AdapterConfig,
	AgentAdapter,
	AuthorStatus,
	InvokeOptions,
	InvokeResult,
	InvokeStatus,
	InvokeVerdict,
	ReviewerVerdict,
	VerdictItem,
} from "./agents/types.js";
export type { FiveXConfig } from "./config.js";
export { defineConfig, loadConfig } from "./config.js";
// DB
export { closeDb, getDb, openDbReadOnly } from "./db/connection.js";
export type {
	AgentResultInput,
	AgentResultRow,
	PlanRow,
	QualityResultInput,
	QualityResultRow,
	RunEventRow,
	RunMetrics,
	RunRow,
	RunSummary,
} from "./db/operations.js";
export {
	appendRunEvent,
	createRun,
	getActiveRun,
	getAgentResults,
	getLastRunEvent,
	getLatestRun,
	getLatestStatus,
	getLatestVerdict,
	getMaxIterationForPhase,
	getPlan,
	getQualityAttemptCount,
	getQualityResults,
	getRunEvents,
	getRunHistory,
	getRunMetrics,
	getStepResult,
	hasCompletedStep,
	updateRunStatus,
	upsertAgentResult,
	upsertPlan,
	upsertQualityResult,
} from "./db/operations.js";
export { getSchemaVersion, runMigrations } from "./db/schema.js";
// Gates
export type {
	EscalationResponse,
	PhaseSummary,
} from "./gates/human.js";
export {
	escalationGate,
	phaseGate,
	resumeGate,
	staleLockGate,
} from "./gates/human.js";
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
} from "./git.js";
export type { LockInfo, LockResult } from "./lock.js";
// Lock
export {
	acquireLock,
	isLocked,
	registerLockCleanup,
	releaseLock,
} from "./lock.js";
// Orchestrator
export type {
	PhaseExecutionOptions,
	PhaseExecutionResult,
} from "./orchestrator/phase-execution-loop.js";
export { runPhaseExecutionLoop } from "./orchestrator/phase-execution-loop.js";
export type {
	EscalationEvent,
	PlanReviewLoopOptions,
	PlanReviewResult,
} from "./orchestrator/plan-review-loop.js";
export {
	resolveReviewPath,
	runPlanReviewLoop,
} from "./orchestrator/plan-review-loop.js";
export type { ChecklistItem, ParsedPlan, Phase } from "./parsers/plan.js";
export { parsePlan } from "./parsers/plan.js";
export type { ReviewSummary } from "./parsers/review.js";
export { parseReviewSummary } from "./parsers/review.js";
// Paths
export { canonicalizePlanPath } from "./paths.js";
// Project root
export { findGitRoot, resolveProjectRoot } from "./project-root.js";
export {
	AuthorStatusSchema,
	assertAuthorStatus,
	assertReviewerVerdict,
	isStructuredOutputError,
	ReviewerVerdictSchema,
} from "./protocol.js";
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
