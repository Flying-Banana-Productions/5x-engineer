/**
 * Protocol command handler — business logic for `5x protocol validate`.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Phase 1 (014-harness-native-subagent-orchestration):
 * Standalone structured-result validation so native subagent orchestration
 * can validate and record author/reviewer results without invoking a provider.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { outputError, outputSuccess } from "../output.js";
import { parsePlan } from "../parsers/plan.js";
import { validateRunId } from "../run-id.js";
import { DB_FILENAME, resolveControlPlaneRoot } from "./control-plane.js";
import { validateStructuredOutputOrThrow } from "./protocol-helpers.js";
import { resolveRunExecutionContext } from "./run-context.js";
import { RecordError, recordStepInternal } from "./run-v1.handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProtocolRole = "author" | "reviewer";

export interface ProtocolValidateParams {
	role: ProtocolRole;
	input?: string;
	requireCommit?: boolean;
	run?: string;
	record?: boolean;
	step?: string;
	phase?: string;
	iteration?: number;
	plan?: string;
	phaseChecklistValidate?: boolean;
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/**
 * Read input JSON from the specified source.
 * - If `input` is provided, treat as a file path.
 * - Otherwise read from stdin.
 */
async function readInput(input: string | undefined): Promise<string> {
	if (input) {
		const filePath = resolve(input);
		try {
			return readFileSync(filePath, "utf-8").trim();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			outputError("INVALID_ARGS", `Failed to read input file: ${msg}`);
		}
	}

	// Read from stdin
	const chunks: Buffer[] = [];
	for await (const chunk of Bun.stdin.stream()) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8").trim();
}

function stripOptionalJsonFence(input: string): string {
	const trimmed = input.trim();
	const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
	if (!match) return input;
	return (match[1] ?? "").trim();
}

/**
 * Auto-detect input format and extract the structured result.
 *
 * If the parsed JSON contains an `ok` field, treat it as an `outputSuccess()`
 * envelope and unwrap `.data.result`. Otherwise treat it as raw structured JSON
 * (direct native subagent output).
 */
function extractResult(parsed: unknown): unknown {
	if (
		parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		"ok" in parsed
	) {
		// outputSuccess envelope — unwrap .data.result
		const envelope = parsed as Record<string, unknown>;
		const data = envelope.data as Record<string, unknown> | undefined;
		if (data && typeof data === "object" && "result" in data) {
			return data.result;
		}
		// Envelope without .data.result — fall through to treat as-is
		// This covers edge cases like error envelopes accidentally passed
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Checklist gate
// ---------------------------------------------------------------------------

/**
 * Check whether a phase value could reference a numeric plan phase.
 *
 * The plan parser's `PHASE_HEADING_RE` requires `Phase <number>` headings.
 * This function recognizes the forms that could match a parsed phase:
 *
 * - Pure numeric: `"1"`, `"2.1"` (matches `String(p.number)`)
 * - Phase-prefixed: `"Phase 1"`, `"phase-1"`, `"Phase 2: Setup"`
 * - Markdown heading: `"## Phase 1: Setup"`
 *
 * Semantic identifiers like `"plan"`, `"review"`, `"setup-v2"`, or
 * `"review-2026"` return `false` — they cannot match any plan parser
 * phase heading and should skip the checklist gate.
 */
export function isNumericPhaseRef(phase: string): boolean {
	// Pure numeric: "1", "2.1", "12"
	if (/^\d+(?:\.\d+)?$/.test(phase)) return true;
	// Phase-prefixed (case-insensitive, separator is space or dash):
	// "Phase 1", "phase-1", "Phase 2.1: Title", "Phase 2.1"
	if (/^phase[\s-]+\d/i.test(phase)) return true;
	// Markdown heading: "## Phase 1: Setup", "### Phase 2.1: Title"
	if (/^#{2,3}\s+Phase\s+\d/i.test(phase)) return true;
	return false;
}

/**
 * Validate that the plan's phase checklist is fully checked off.
 *
 * Plan path resolution:
 * - If --plan is provided but file doesn't exist → PLAN_NOT_FOUND (fail-closed).
 * - If plan is auto-discovered via --run but can't be resolved → skip silently (fail-open).
 *
 * Phase lookup (once a plan IS resolved):
 * - If --phase is provided but not found in the parsed plan → PHASE_NOT_FOUND (fail-closed),
 *   regardless of how the plan was resolved. --phase is always explicit input.
 * - If --phase is a non-numeric semantic identifier (e.g., "plan", "review") → skip
 *   the gate entirely. Such values can never match a plan parser phase heading.
 */
function validatePhaseChecklist(params: ProtocolValidateParams): void {
	// Skip for non-numeric phase identifiers — they are semantic context
	// labels (e.g., "plan", "review") that don't map to plan file phases.
	if (params.phase && !isNumericPhaseRef(params.phase)) {
		return;
	}

	const explicitPlan = !!params.plan;
	let planPath: string | undefined = params.plan
		? resolve(params.plan)
		: undefined;

	// Auto-discover plan path from run context if --plan not provided
	if (!planPath && params.run) {
		try {
			const controlPlane = resolveControlPlaneRoot();
			if (controlPlane.mode !== "none") {
				const dbRelPath = join(controlPlane.stateDir, DB_FILENAME);
				const db = getDb(controlPlane.controlPlaneRoot, dbRelPath);
				try {
					runMigrations(db);
				} catch {
					// DB migration error — skip checklist gate gracefully
					return;
				}
				const ctxResult = resolveRunExecutionContext(db, params.run, {
					controlPlaneRoot: controlPlane.controlPlaneRoot,
				});
				if (ctxResult.ok) {
					planPath = ctxResult.context.effectivePlanPath;
				}
				// If ctxResult not ok, skip silently (fail-open for auto-discovery)
			}
		} catch {
			// Auto-discovery failed — skip silently
			return;
		}
	}

	// No plan path resolved — skip silently
	if (!planPath) return;

	// Check file exists
	if (!existsSync(planPath)) {
		if (explicitPlan) {
			outputError("PLAN_NOT_FOUND", `Plan file not found: ${params.plan}`);
		}
		// Auto-discovered path doesn't exist — skip silently
		return;
	}

	// Parse the plan
	let planContent: string;
	try {
		planContent = readFileSync(planPath, "utf-8");
	} catch {
		if (explicitPlan) {
			outputError("PLAN_NOT_FOUND", `Failed to read plan file: ${params.plan}`);
		}
		return;
	}

	const plan = parsePlan(planContent);

	// If no --phase provided, skip checklist gate (can't determine which phase)
	if (!params.phase) return;

	// Find the matching phase
	const phase = plan.phases.find(
		(p) =>
			p.title === params.phase ||
			p.heading === params.phase ||
			String(p.number) === params.phase ||
			`Phase ${p.number}` === params.phase ||
			`Phase ${p.number}: ${p.title}` === params.phase,
	);

	if (!phase) {
		// Fail-closed: --phase is always explicit input (no auto-discovery for
		// phase). Once a plan is resolved (by any means), a missing phase must
		// error so orchestrators don't silently skip validation.
		outputError(
			"PHASE_NOT_FOUND",
			`Phase '${params.phase}' not found in plan: ${planPath}`,
		);
	}

	// Check if phase is complete
	if (!phase.isComplete) {
		outputError(
			"PHASE_CHECKLIST_INCOMPLETE",
			`Phase ${params.phase} checklist is not complete. Mark all items [x] before returning result: complete.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function protocolValidate(
	params: ProtocolValidateParams,
): Promise<void> {
	const { role } = params;

	// -----------------------------------------------------------------------
	// Read and parse input
	// -----------------------------------------------------------------------
	const rawInput = await readInput(params.input);
	if (!rawInput) {
		outputError(
			"INVALID_ARGS",
			"No input provided. Pipe JSON to stdin or use --input <file>.",
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawInput);
	} catch {
		const strippedInput = stripOptionalJsonFence(rawInput);
		if (strippedInput !== rawInput) {
			try {
				parsed = JSON.parse(strippedInput);
			} catch {
				outputError(
					"INVALID_JSON",
					"Input is not valid JSON. Pass raw JSON or a single fenced JSON block.",
					{
						raw: rawInput.slice(0, 200),
					},
				);
			}
		} else {
			outputError(
				"INVALID_JSON",
				"Input is not valid JSON. Pass raw JSON or a single fenced JSON block.",
				{
					raw: rawInput.slice(0, 200),
				},
			);
		}
	}

	// Auto-detect and extract structured result
	const structured = extractResult(parsed);

	// -----------------------------------------------------------------------
	// Validate structured output (shared helper)
	// -----------------------------------------------------------------------
	const { value: validated, warnings } = validateStructuredOutputOrThrow(
		structured,
		role,
		{
			requireCommit: params.requireCommit,
			context: `protocol validate ${role}`,
		},
	);

	// Surface warnings to stderr (non-breaking; orchestrators read stdout)
	for (const w of warnings) {
		console.error(`Warning: ${w}`);
	}

	// -----------------------------------------------------------------------
	// Validate --record prerequisites BEFORE outputSuccess().
	//
	// validateRunId() calls outputError() on failure, which writes a JSON
	// envelope to stdout. If we called outputSuccess() first, stdout would
	// contain two JSON envelopes — breaking the single-envelope contract
	// and misleading orchestrators into treating a failed call as successful.
	// -----------------------------------------------------------------------
	let recordStepName: string | undefined;
	let resolvedPhase: string | undefined = params.phase;
	if (params.record) {
		if (!params.run) {
			outputError(
				"INVALID_ARGS",
				"--record requires --run. Provide --run <id> when using --record.",
			);
		}
		validateRunId(params.run);

		if (!params.step) {
			outputError(
				"INVALID_ARGS",
				"--record requires --step. Provide --step <name> when using --record.",
			);
		}
		recordStepName = params.step;

		// Phase enforcement: resolve from --phase and/or result_json.phase.
		// result_json is authoritative; --phase must match if both are present.
		const resultPhase =
			validated &&
			typeof validated === "object" &&
			!Array.isArray(validated) &&
			"phase" in validated
				? String((validated as Record<string, unknown>).phase)
				: undefined;

		if (params.phase && resultPhase) {
			if (params.phase !== resultPhase) {
				outputError(
					"PHASE_MISMATCH",
					`--phase is "${params.phase}" but result_json.phase is "${resultPhase}". ` +
						"These must match. Remove --phase to use result_json as authoritative, " +
						"or correct the phase value.",
				);
			}
			resolvedPhase = params.phase;
		} else if (params.phase) {
			resolvedPhase = params.phase;
		} else if (resultPhase) {
			resolvedPhase = resultPhase;
		} else {
			outputError(
				"PHASE_REQUIRED",
				"Phase is required when recording. Provide --phase or include " +
					'a "phase" field in the result JSON.',
			);
		}
	}

	// -----------------------------------------------------------------------
	// Checklist gate: verify phase completion in plan (author-only)
	//
	// Only fires when role === "author", result === "complete", and
	// phaseChecklistValidate is not explicitly disabled. Resolves the plan
	// path from --plan (fail-closed) or --run auto-discovery (fail-open).
	// -----------------------------------------------------------------------
	if (
		role === "author" &&
		validated &&
		typeof validated === "object" &&
		"result" in validated &&
		(validated as Record<string, unknown>).result === "complete" &&
		params.phaseChecklistValidate !== false
	) {
		validatePhaseChecklist(params);
	}

	// -----------------------------------------------------------------------
	// Output validated result
	// -----------------------------------------------------------------------
	outputSuccess({
		role,
		valid: true,
		result: validated,
	});

	// -----------------------------------------------------------------------
	// Combined validate + record (optional)
	//
	// Prerequisites are already validated above. The actual recording is a
	// side effect — errors go to stderr (never outputError, which would
	// write a second envelope to stdout).
	// -----------------------------------------------------------------------
	if (params.record && recordStepName) {
		try {
			await recordStepInternal({
				// params.run is guaranteed non-null here: prerequisite check above
				// calls outputError() (which exits) when --run is absent.
				run: params.run as string,
				stepName: recordStepName,
				result: JSON.stringify(validated),
				phase: resolvedPhase,
				iteration: params.iteration,
			});
		} catch (err) {
			// Recording is a side effect — primary envelope already written.
			// Warn on stderr, set non-zero exit via process.exitCode.
			if (err instanceof RecordError) {
				console.error(
					`Warning: failed to record step [${err.code}]: ${err.message}`,
				);
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`Warning: failed to record step: ${msg}`);
			}
			process.exitCode = 1;
		}
	}
}
