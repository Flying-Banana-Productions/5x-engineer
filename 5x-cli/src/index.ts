// Public API exports — v1

// Config
export type { FiveXConfig } from "./config.js";
export { defineConfig, loadConfig } from "./config.js";
// DB — connection
export { closeDb, getDb, openDbReadOnly } from "./db/connection.js";
// DB — v0 operations (still valid on v4 schema: runs, plans tables)
export type { PlanRow, RunRow, RunSummary } from "./db/operations.js";
export {
	createRun,
	getActiveRun,
	getLatestRun,
	getPlan,
	getRunHistory,
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
export { getSchemaVersion, runMigrations } from "./db/schema.js";
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
export type { LockInfo, LockResult } from "./lock.js";
export {
	acquireLock,
	isLocked,
	registerLockCleanup,
	releaseLock,
} from "./lock.js";
// Parsers
export type { ChecklistItem, ParsedPlan, Phase } from "./parsers/plan.js";
export { parsePlan } from "./parsers/plan.js";
export type { ReviewSummary } from "./parsers/review.js";
export { parseReviewSummary } from "./parsers/review.js";
// Paths
export { canonicalizePlanPath } from "./paths.js";
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
