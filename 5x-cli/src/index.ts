// Public API exports
export { loadConfig, defineConfig } from "./config.js";
export type { FiveXConfig } from "./config.js";
export { parsePlan } from "./parsers/plan.js";
export type { ParsedPlan, Phase, ChecklistItem } from "./parsers/plan.js";
export { parseVerdictBlock, parseStatusBlock } from "./parsers/signals.js";
export type { VerdictBlock, VerdictItem, StatusBlock } from "./parsers/signals.js";
export { parseReviewSummary } from "./parsers/review.js";
export type { ReviewSummary } from "./parsers/review.js";

// DB
export { getDb, closeDb } from "./db/connection.js";
export { runMigrations, getSchemaVersion } from "./db/schema.js";
export {
  upsertPlan,
  getPlan,
  createRun,
  updateRunStatus,
  getActiveRun,
  getLatestRun,
  appendRunEvent,
  getRunEvents,
  upsertAgentResult,
  getAgentResults,
  getLatestVerdict,
  getLatestStatus,
  hasCompletedStep,
  upsertQualityResult,
  getQualityResults,
  getRunHistory,
  getRunMetrics,
} from "./db/operations.js";
export type {
  PlanRow,
  RunRow,
  RunEventRow,
  AgentResultRow,
  QualityResultRow,
  RunSummary,
  RunMetrics,
} from "./db/operations.js";

// Lock
export { acquireLock, releaseLock, isLocked, registerLockCleanup } from "./lock.js";
export type { LockInfo, LockResult } from "./lock.js";
