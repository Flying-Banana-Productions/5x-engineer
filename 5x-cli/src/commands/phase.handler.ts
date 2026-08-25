/**
 * Phase finish composite — quality → protocol record → checklist.
 *
 * Framework-independent: no CLI framework imports. Calls handler cores
 * (not subprocesses) so stdout stays a single envelope and resume keys
 * match the granular primitives.
 */

import { findExistingStep } from "../db/operations-v1.js";
import { CliError, outputError, outputSuccess } from "../output.js";
import { validateRunId } from "../run-id.js";
import { type DbContext, resolveDbContext } from "./context.js";
import {
	evaluatePhaseChecklist,
	isNumericPhaseRef,
	protocolValidateCore,
	resolveRecordPhase,
} from "./protocol.handler.js";
import { runQualityCore } from "./quality-v1.handler.js";
import { resolveRunExecutionContext } from "./run-context.js";
import { REQUIRED_REMEDIATION, requireAmbientRunId } from "./run-identity.js";
import { RecordError, recordStepInternal } from "./run-v1.handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PhaseFinishParams {
	phase: string;
	iteration: number;
	step: string;
	run?: string;
	input?: string;
	recordStep?: string;
	phaseChecklistValidate?: boolean;
	startDir?: string;
	env?: NodeJS.Dict<string>;
	/** Injected DB — skips the process-wide `getDb` singleton (tests). */
	dbContext?: DbContext;
}

export type PhaseFinishStepStatus = "completed" | "failed" | "skipped";

export interface PhaseFinishStep {
	name: "quality" | "protocol" | "checklist";
	status: PhaseFinishStepStatus;
	step_id?: number;
	recorded?: boolean;
	error?: { code: string; message: string; detail?: unknown };
}

export interface PhaseFinishSuccess {
	run_id: string;
	phase: string;
	iteration: number;
	steps: PhaseFinishStep[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function remediationFor(code: string): string {
	switch (code) {
		case "QUALITY_FAILED":
			return "Fix failing quality gates and re-run `5x phase finish` with the same --phase/--iteration/--step. Successful sub-steps resume.";
		case "INVALID_STRUCTURED_OUTPUT":
		case "INVALID_JSON":
		case "INVALID_ARGS":
			return "Fix the author JSON payload and re-run `5x phase finish` with the same keys. Quality is skipped on resume if it already passed.";
		case "PHASE_CHECKLIST_INCOMPLETE":
			return "Mark all phase checklist items [x] and re-run `5x phase finish` with the same keys. Quality is skipped on resume.";
		case "PHASE_NOT_FOUND":
			return "Pass a --phase that exists in the plan, or --no-phase-checklist-validate to skip the gate.";
		case "RUN_CONTEXT_REQUIRED":
			return REQUIRED_REMEDIATION;
		case "PHASE_MISMATCH":
			return "Correct the author payload's phase field to match --phase, then re-run `5x phase finish` with the same keys. Quality is skipped on resume if it already passed.";
		default:
			return "Re-run `5x phase finish` with the same --phase/--iteration/--step after addressing the failing sub-step. Successful sub-steps resume.";
	}
}

function formatPhaseFinishText(data: PhaseFinishSuccess): void {
	for (const step of data.steps) {
		const extra =
			step.status === "completed" && step.step_id != null
				? ` (step ${step.step_id})`
				: step.status === "failed" && step.error
					? ` ${step.error.code}`
					: "";
		console.log(`${step.name} ${step.status}${extra}`);
	}
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// ignore malformed stored payloads
	}
	return null;
}

function authorResultOf(payload: unknown): string | undefined {
	if (payload && typeof payload === "object" && "result" in payload) {
		return String((payload as Record<string, unknown>).result);
	}
	return undefined;
}

function qualityPayloadSucceeded(raw: string): boolean {
	const parsed = parseJsonObject(raw);
	if (!parsed) return false;
	return parsed.passed === true || parsed.skipped === true;
}

function failForward(
	steps: PhaseFinishStep[],
	failing: PhaseFinishStep["name"],
	code: string,
	message: string,
	detail?: unknown,
): never {
	const idx = steps.findIndex((s) => s.name === failing);
	if (idx >= 0 && steps[idx]) {
		steps[idx].status = "failed";
		steps[idx].error = { code, message, detail };
	}
	for (let i = idx + 1; i < steps.length; i++) {
		const step = steps[i];
		if (step && step.status !== "completed") {
			step.status = "skipped";
		}
	}
	outputError(code, message, {
		failing_step: failing,
		steps,
		remediation: remediationFor(code),
	});
}

function failFromCaught(
	steps: PhaseFinishStep[],
	failing: PhaseFinishStep["name"],
	err: unknown,
): never {
	if (err instanceof CliError) {
		failForward(steps, failing, err.code, err.message, err.detail);
	}
	if (err instanceof RecordError) {
		failForward(steps, failing, err.code, err.message, err.detail);
	}
	const message = err instanceof Error ? err.message : String(err);
	failForward(steps, failing, "INTERNAL_ERROR", message);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function phaseFinishCore(
	params: PhaseFinishParams,
): Promise<PhaseFinishSuccess> {
	const qualityStepName = params.recordStep ?? "quality:check";
	const dbContext =
		params.dbContext ?? (await resolveDbContext({ startDir: params.startDir }));
	const { db, config, controlPlane } = dbContext;

	if (!controlPlane || controlPlane.mode === "none") {
		if (!params.run) {
			outputError("RUN_CONTEXT_REQUIRED", "No run identity resolved.", {
				remediation: REQUIRED_REMEDIATION,
			});
		}
		validateRunId(params.run);
	} else {
		params.run = requireAmbientRunId({
			explicitRun: params.run,
			startDir: params.startDir,
			env: params.env,
			db,
			controlPlane,
		});
		validateRunId(params.run);
	}

	const runId = params.run as string;
	const steps: PhaseFinishStep[] = [
		{ name: "quality", status: "skipped" },
		{ name: "protocol", status: "skipped" },
		{ name: "checklist", status: "skipped" },
	];

	let authorPayload: unknown;
	let authorResumed = false;

	// -----------------------------------------------------------------------
	// 1. Quality
	// -----------------------------------------------------------------------
	const existingQuality = findExistingStep(db, {
		run_id: runId,
		step_name: qualityStepName,
		phase: params.phase,
		iteration: params.iteration,
	});
	if (existingQuality && qualityPayloadSucceeded(existingQuality.result_json)) {
		steps[0] = {
			name: "quality",
			status: "completed",
			step_id: existingQuality.id,
			recorded: false,
		};
	} else {
		let qualityData: Awaited<ReturnType<typeof runQualityCore>>;
		try {
			qualityData = await runQualityCore(
				{
					run: runId,
					phase: params.phase,
					iteration: params.iteration,
					record: false,
					recordStep: qualityStepName,
					startDir: params.startDir,
					env: params.env,
					db,
				},
				() => {
					// Composite swallows the empty-gates warning; envelope reports skipped.
				},
			);
		} catch (err) {
			failFromCaught(steps, "quality", err);
		}

		if (!qualityData.passed) {
			failForward(steps, "quality", "QUALITY_FAILED", "Quality gates failed.");
		}

		const payload = {
			passed: qualityData.passed,
			results: qualityData.results,
			...(qualityData.skipped ? { skipped: true } : {}),
		};
		try {
			const recorded = await recordStepInternal(
				{
					run: runId,
					stepName: qualityStepName,
					result: JSON.stringify(payload),
					phase: params.phase,
					iteration: params.iteration,
					startDir: params.startDir,
				},
				{ db, config, controlPlane },
			);
			steps[0] = {
				name: "quality",
				status: "completed",
				step_id: recorded.step_id,
				recorded: recorded.recorded,
			};
		} catch (err) {
			failFromCaught(steps, "quality", err);
		}
	}

	// -----------------------------------------------------------------------
	// 2. Protocol
	// -----------------------------------------------------------------------
	const existingAuthor = findExistingStep(db, {
		run_id: runId,
		step_name: params.step,
		phase: params.phase,
		iteration: params.iteration,
	});
	if (existingAuthor) {
		authorResumed = true;
		authorPayload = parseJsonObject(existingAuthor.result_json);
		steps[1] = {
			name: "protocol",
			status: "completed",
			step_id: existingAuthor.id,
			recorded: false,
		};
	} else {
		try {
			const core = await protocolValidateCore({
				role: "author",
				input: params.input,
				phase: params.phase,
				startDir: params.startDir,
			});
			authorPayload = core.result;
			resolveRecordPhase(params.phase, authorPayload);
			for (const w of core.warnings) {
				console.error(`Warning: ${w}`);
			}
		} catch (err) {
			failFromCaught(steps, "protocol", err);
		}
		steps[1] = {
			name: "protocol",
			status: "completed",
		};
	}

	const authorComplete = authorResultOf(authorPayload) === "complete";

	// -----------------------------------------------------------------------
	// 3. Checklist
	// -----------------------------------------------------------------------
	if (authorResumed) {
		steps[2] = {
			name: "checklist",
			status: authorComplete ? "completed" : "skipped",
		};
	} else if (
		params.phaseChecklistValidate === false ||
		!isNumericPhaseRef(params.phase)
	) {
		steps[2] = { name: "checklist", status: "completed" };
	} else if (!authorComplete) {
		steps[2] = { name: "checklist", status: "skipped" };
	} else {
		let planPath: string | undefined;
		if (controlPlane) {
			const ctxResult = resolveRunExecutionContext(db, runId, {
				controlPlaneRoot: controlPlane.controlPlaneRoot,
			});
			if (ctxResult.ok) {
				planPath = ctxResult.context.effectivePlanPath;
			}
		}
		const checklist = evaluatePhaseChecklist({
			role: "author",
			run: runId,
			phase: params.phase,
			startDir: params.startDir,
			...(planPath ? { plan: planPath } : {}),
		});
		if (!checklist.ok) {
			failForward(steps, "checklist", checklist.code, checklist.message);
		}
		steps[2] = { name: "checklist", status: "completed" };
	}

	// -----------------------------------------------------------------------
	// Record author step (fresh path only; includes non-complete results)
	// -----------------------------------------------------------------------
	if (!authorResumed) {
		try {
			const recorded = await recordStepInternal(
				{
					run: runId,
					stepName: params.step,
					result: JSON.stringify(authorPayload),
					phase: params.phase,
					iteration: params.iteration,
					startDir: params.startDir,
				},
				{ db, config, controlPlane },
			);
			steps[1] = {
				name: "protocol",
				status: "completed",
				step_id: recorded.step_id,
				recorded: recorded.recorded,
			};
		} catch (err) {
			failFromCaught(steps, "protocol", err);
		}
	}

	return {
		run_id: runId,
		phase: params.phase,
		iteration: params.iteration,
		steps,
	};
}

export async function phaseFinish(params: PhaseFinishParams): Promise<void> {
	const data = await phaseFinishCore(params);
	outputSuccess(data, formatPhaseFinishText);
}
