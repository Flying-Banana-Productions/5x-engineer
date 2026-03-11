/**
 * Protocol command handler — business logic for `5x protocol validate`.
 *
 * Framework-independent: no citty imports.
 *
 * Phase 1 (014-harness-native-subagent-orchestration):
 * Standalone structured-result validation so native subagent orchestration
 * can validate and record author/reviewer results without invoking a provider.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { outputError, outputSuccess } from "../output.js";
import {
	type AuthorStatus,
	assertAuthorStatus,
	assertReviewerVerdict,
	isStructuredOutputError,
	type ReviewerVerdict,
} from "../protocol.js";
import { validateRunId } from "../run-id.js";
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
		outputError("INVALID_JSON", "Input is not valid JSON", {
			raw: rawInput.slice(0, 200),
		});
	}

	// Auto-detect and extract structured result
	const structured = extractResult(parsed);

	// -----------------------------------------------------------------------
	// Validate structured output
	// -----------------------------------------------------------------------

	// Check for StructuredOutputError first
	if (isStructuredOutputError(structured)) {
		outputError(
			"INVALID_STRUCTURED_OUTPUT",
			"Input contains a structured output error",
			{ raw: structured },
		);
	}

	if (!structured || typeof structured !== "object") {
		outputError(
			"INVALID_STRUCTURED_OUTPUT",
			`Input is not a valid structured object for ${role}`,
			{ raw: structured ?? null },
		);
	}

	try {
		if (role === "author") {
			// --require-commit defaults to true for author
			const requireCommit = params.requireCommit !== false;
			assertAuthorStatus(
				structured as AuthorStatus,
				`protocol validate ${role}`,
				{
					requireCommit,
				},
			);
		} else {
			assertReviewerVerdict(
				structured as ReviewerVerdict,
				`protocol validate ${role}`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		outputError("INVALID_STRUCTURED_OUTPUT", message, { raw: structured });
	}

	// -----------------------------------------------------------------------
	// Output validated result
	// -----------------------------------------------------------------------
	outputSuccess({
		role,
		valid: true,
		result: structured,
	});

	// -----------------------------------------------------------------------
	// Combined validate + record (optional)
	// -----------------------------------------------------------------------
	if (params.record) {
		if (!params.run) {
			console.error("Warning: --record requires --run. Skipping recording.");
			process.exitCode = 1;
			return;
		}
		validateRunId(params.run);

		const stepName = params.step;
		if (!stepName) {
			console.error("Warning: --record requires --step. Skipping recording.");
			process.exitCode = 1;
			return;
		}

		try {
			await recordStepInternal({
				run: params.run,
				stepName,
				result: JSON.stringify(structured),
				phase: params.phase,
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
