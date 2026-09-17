/**
 * Declaration-only writer-shape types frozen in Phase 1 so slice 06 can
 * compile against `originFor` / `redactedRecorder` and
 * `PreparedRecordStep.performer`. The factory that populates
 * `RecordCommandContext` lands in Phase 4; this module must not implement it.
 */

import type { Database } from "bun:sqlite";
import type { ControlPlaneResult } from "../commands/control-plane.js";
import type { RunExecutionContext } from "../commands/run-context.js";
import type { FiveXConfig } from "../config.js";
import type { RecordStore } from "./record-store.js";
import type {
	RecordOrigin,
	RecordPerformer,
	RecordRecorder,
} from "./record-types.js";

export interface RecordCommandContext {
	db: Database;
	config: FiveXConfig;
	controlPlane?: ControlPlaneResult;
	recordStore: RecordStore;
	recordsRelPath: string;
	recordsAbsPath: string;
	executionContext: RunExecutionContext;
	originFor(performer: RecordPerformer): RecordOrigin;
	redactedRecorder(): RecordRecorder;
}

export type PrepareRecordStepOutcome =
	| { outcome: "admit"; prepared: PreparedRecordStep }
	| { outcome: "duplicate"; prepared: PreparedRecordStep };

export interface PreparedRecordStep {
	runId: string;
	stepName: string;
	phase: string | undefined;
	iteration: number | undefined;
	resultJson: string;
	headCommit: string | undefined;
	sessionId?: string;
	model?: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
	durationMs?: number;
	logPath?: string;
	effectiveWorkdir: string | undefined;
	maxSteps: number;
	/** Resolved performer. Never omitted after prepare; used by `originFor` only. */
	performer: RecordPerformer;
}
