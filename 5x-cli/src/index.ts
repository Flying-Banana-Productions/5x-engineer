// Public API exports

export type { SpawnHandle } from "./agents/claude-code.js";
export {
	ClaudeCodeAdapter,
	MAX_PROMPT_LENGTH,
} from "./agents/claude-code.js";
export { createAdapter, createAndVerifyAdapter } from "./agents/factory.js";
// Agents
export type {
	AdapterConfig,
	AgentAdapter,
	AgentResult,
	InvokeOptions,
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
	getPlan,
	getQualityResults,
	getRunEvents,
	getRunHistory,
	getRunMetrics,
	hasCompletedStep,
	updateRunStatus,
	upsertAgentResult,
	upsertPlan,
	upsertQualityResult,
} from "./db/operations.js";
export { getSchemaVersion, runMigrations } from "./db/schema.js";
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
export type {
	StatusBlock,
	VerdictBlock,
	VerdictItem,
} from "./parsers/signals.js";
export { parseStatusBlock, parseVerdictBlock } from "./parsers/signals.js";
// Paths
export { canonicalizePlanPath } from "./paths.js";
// Project root
export { findGitRoot, resolveProjectRoot } from "./project-root.js";
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
