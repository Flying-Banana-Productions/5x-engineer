/**
 * Working-tree record layout: paths, JSONL codecs, and `run.json` parse/encode.
 *
 * On-disk JSONL omits `run_id` (directory-implied). `decodeJsonlFile(text, runId)`
 * reconstructs `RecordLine.runId`. Unknown keys on newer schema versions are
 * ignored on read and are not preserved through rewrite.
 */

import { join } from "node:path";
import { planSlugFromPath } from "../paths.js";
import { stripOrigin } from "./record-redact.js";
import {
	type RecordLine,
	type RecordOrigin,
	type RecordPerformer,
	type RecordPerformerKind,
	type RecordProvenance,
	type RecordRecorder,
	RecordStoreError,
	type RecordStream,
	type RunRecordSummary,
} from "./record-types.js";

export const STREAM_FILES: Record<RecordStream, string> = {
	steps: "steps.jsonl",
	decisions: "decisions.jsonl",
	budget: "budget.jsonl",
};

export const RECORD_STREAMS: RecordStream[] = ["steps", "decisions", "budget"];

const CONFLICT_MARKERS = ["<<<<<<<", "=======", ">>>>>>>"] as const;
const PERFORMER_KINDS = new Set<RecordPerformerKind>([
	"human",
	"agent",
	"system",
]);
const PROVENANCES = new Set<RecordProvenance>(["recorded", "backfilled"]);
const RUN_STATUSES = new Set<RunRecordSummary["status"]>([
	"active",
	"completed",
	"aborted",
]);

export function isRecordStream(value: string): value is RecordStream {
	return value === "steps" || value === "decisions" || value === "budget";
}

export function runRecordDir(
	recordsRoot: string,
	planSlug: string,
	runId: string,
): string {
	return join(recordsRoot, planSlug, runId);
}

export function runDirForSummary(
	recordsRoot: string,
	summary: Pick<RunRecordSummary, "id" | "plan_path">,
): string {
	return runRecordDir(
		recordsRoot,
		planSlugFromPath(summary.plan_path),
		summary.id,
	);
}

export function streamFileName(stream: RecordStream): string {
	return STREAM_FILES[stream];
}

function invalidJsonl(message: string): never {
	throw new RecordStoreError("INVALID_JSONL", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveIntVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function parseRecorder(value: unknown, label: string): RecordRecorder {
	if (!isPlainObject(value)) {
		invalidJsonl(`${label} must be an object`);
	}
	if (typeof value.installation_id !== "string" || !value.installation_id) {
		invalidJsonl(`${label} missing recorder.installation_id`);
	}
	const recorder: RecordRecorder = {
		installation_id: value.installation_id,
	};
	if (value.actor !== undefined) {
		if (typeof value.actor !== "string") {
			invalidJsonl(`${label} actor must be a string when set`);
		}
		recorder.actor = value.actor;
	}
	return recorder;
}

function parsePerformer(value: unknown, label: string): RecordPerformer {
	if (!isPlainObject(value)) {
		invalidJsonl(`${label} performer must be an object`);
	}
	if (
		typeof value.kind !== "string" ||
		!PERFORMER_KINDS.has(value.kind as RecordPerformerKind)
	) {
		invalidJsonl(`${label} performer.kind is invalid`);
	}
	const performer: RecordPerformer = {
		kind: value.kind as RecordPerformerKind,
	};
	if (value.role !== undefined) {
		if (typeof value.role !== "string") {
			invalidJsonl(`${label} performer.role must be a string when set`);
		}
		performer.role = value.role;
	}
	if (value.provider !== undefined) {
		if (typeof value.provider !== "string") {
			invalidJsonl(`${label} performer.provider must be a string when set`);
		}
		performer.provider = value.provider;
	}
	return performer;
}

function parseOrigin(value: unknown, label: string): RecordOrigin {
	if (!isPlainObject(value)) {
		invalidJsonl(`${label} origin must be an object`);
	}
	return {
		recorder: parseRecorder(value.recorder, `${label} origin`),
		performer: parsePerformer(value.performer, `${label} origin`),
	};
}

function parseOriginOrNull(value: unknown, label: string): RecordOrigin | null {
	if (value === null) return null;
	return parseOrigin(value, label);
}

function isConflictMarkerLine(line: string): boolean {
	const trimmed = line.trimStart();
	return CONFLICT_MARKERS.some((marker) => trimmed.startsWith(marker));
}

/**
 * Encode one JSONL object. Omits `run_id`. Strips forbidden origin keys.
 * Compact JSON (no pretty-print).
 */
export function encodeJsonlLine(line: RecordLine): string {
	const origin = stripOrigin(line.origin);
	const obj: Record<string, unknown> = {
		schema_version: line.schemaVersion,
		stream: line.stream,
		idempotency_key: line.idempotencyKey,
		created_at: line.createdAt,
		provenance: line.provenance,
		origin,
		payload: line.payload,
	};
	if (line.materializer !== undefined) {
		obj.materializer = stripOrigin(line.materializer);
	}
	return JSON.stringify(obj);
}

function parseJsonlObject(raw: unknown, runId: string): RecordLine {
	if (!isPlainObject(raw)) {
		invalidJsonl("JSONL line must be an object");
	}
	if ("run_id" in raw && raw.run_id !== runId) {
		invalidJsonl(
			`on-disk run_id ${String(raw.run_id)} does not match ${runId}`,
		);
	}
	if (!isPositiveIntVersion(raw.schema_version)) {
		invalidJsonl("missing or invalid schema_version");
	}
	if (typeof raw.stream !== "string" || !isRecordStream(raw.stream)) {
		invalidJsonl("missing or invalid stream");
	}
	if (typeof raw.idempotency_key !== "string" || !raw.idempotency_key) {
		invalidJsonl("missing idempotency_key");
	}
	if (typeof raw.created_at !== "string") {
		invalidJsonl("missing created_at");
	}
	if (!("payload" in raw)) {
		invalidJsonl("missing payload");
	}
	if (
		typeof raw.provenance !== "string" ||
		!PROVENANCES.has(raw.provenance as RecordProvenance)
	) {
		invalidJsonl("missing or invalid provenance");
	}
	const provenance = raw.provenance as RecordProvenance;
	if (!("origin" in raw)) {
		invalidJsonl("missing origin");
	}
	const origin = parseOriginOrNull(raw.origin, "line");
	if (provenance === "recorded") {
		if (origin === null) {
			invalidJsonl("recorded lines require a non-null origin");
		}
		if ("materializer" in raw && raw.materializer !== undefined) {
			invalidJsonl("recorded lines must not include materializer");
		}
	}
	const line: RecordLine = {
		runId,
		stream: raw.stream,
		idempotencyKey: raw.idempotency_key,
		payload: raw.payload,
		createdAt: raw.created_at,
		schemaVersion: raw.schema_version,
		provenance,
		origin,
	};
	if (raw.materializer !== undefined) {
		line.materializer = parseOrigin(raw.materializer, "line materializer");
	}
	return line;
}

/**
 * Decode a JSONL file body. Skips blank lines. Conflict markers throw.
 * First occurrence of an `idempotency_key` wins (origin/provenance included).
 * Reconstructs `runId` from the caller argument.
 */
export function decodeJsonlFile(text: string, runId: string): RecordLine[] {
	if (text.length === 0) return [];
	const lines: RecordLine[] = [];
	const seen = new Set<string>();
	const rawLines = text.split("\n");
	for (const rawLine of rawLines) {
		if (rawLine.trim() === "") continue;
		if (isConflictMarkerLine(rawLine)) {
			invalidJsonl("conflict-marker line in JSONL (corrupt merge)");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawLine) as unknown;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			invalidJsonl(`invalid JSON: ${message}`);
		}
		const line = parseJsonlObject(parsed, runId);
		if (seen.has(line.idempotencyKey)) continue;
		seen.add(line.idempotencyKey);
		lines.push(line);
	}
	return lines;
}

function parseNullableRecorder(
	value: unknown,
	label: string,
): RecordRecorder | null {
	if (value === null) return null;
	return parseRecorder(value, label);
}

export function parseRunJson(text: string): RunRecordSummary {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		invalidJsonl(`invalid run.json: ${message}`);
	}
	if (!isPlainObject(parsed)) {
		invalidJsonl("run.json must be an object");
	}
	if (!isPositiveIntVersion(parsed.format_version)) {
		invalidJsonl("missing or invalid format_version");
	}
	if (typeof parsed.id !== "string" || !parsed.id) {
		invalidJsonl("run.json missing id");
	}
	if (typeof parsed.plan_path !== "string") {
		invalidJsonl("run.json missing plan_path");
	}
	if (typeof parsed.created_at !== "string") {
		invalidJsonl("run.json missing created_at");
	}
	if (parsed.sealed_at !== null && typeof parsed.sealed_at !== "string") {
		invalidJsonl("run.json sealed_at must be a string or null");
	}
	if (
		typeof parsed.status !== "string" ||
		!RUN_STATUSES.has(parsed.status as RunRecordSummary["status"])
	) {
		invalidJsonl("run.json missing or invalid status");
	}
	if (!("creator" in parsed)) {
		invalidJsonl("run.json missing creator");
	}
	const summary: RunRecordSummary = {
		id: parsed.id,
		plan_path: parsed.plan_path,
		config_json: parsed.config_json ?? null,
		created_at: parsed.created_at,
		sealed_at: parsed.sealed_at as string | null,
		status: parsed.status as RunRecordSummary["status"],
		final_head_commit:
			parsed.final_head_commit === undefined ||
			parsed.final_head_commit === null
				? null
				: typeof parsed.final_head_commit === "string"
					? parsed.final_head_commit
					: invalidJsonl("run.json final_head_commit must be a string or null"),
		cli_version:
			typeof parsed.cli_version === "string" ? parsed.cli_version : "",
		format_version: parsed.format_version,
		creator: parseNullableRecorder(parsed.creator, "run.json creator"),
	};
	if ("sealer" in parsed) {
		summary.sealer = parseNullableRecorder(parsed.sealer, "run.json sealer");
	}
	if (parsed.materializer !== undefined) {
		summary.materializer = parseOrigin(
			parsed.materializer,
			"run.json materializer",
		);
	}
	if (parsed.backfilled === true) summary.backfilled = true;
	return summary;
}

function encodeRecorder(recorder: RecordRecorder | null): unknown {
	if (recorder === null) return null;
	const out: Record<string, unknown> = {
		installation_id: recorder.installation_id,
	};
	if (recorder.actor !== undefined) out.actor = recorder.actor;
	return out;
}

/** Pretty-print `run.json`. Does not preserve unknown keys. */
export function encodeRunJson(summary: RunRecordSummary): string {
	const doc: Record<string, unknown> = {
		id: summary.id,
		plan_path: summary.plan_path,
		config_json: summary.config_json,
		created_at: summary.created_at,
		sealed_at: summary.sealed_at,
		status: summary.status,
		final_head_commit: summary.final_head_commit,
		cli_version: summary.cli_version,
		format_version: summary.format_version,
		creator: encodeRecorder(summary.creator),
	};
	if (summary.sealer !== undefined) {
		doc.sealer = encodeRecorder(summary.sealer);
	}
	if (summary.materializer !== undefined) {
		doc.materializer = stripOrigin(summary.materializer);
	}
	if (summary.backfilled !== undefined) {
		doc.backfilled = summary.backfilled;
	}
	return `${JSON.stringify(doc, null, 2)}\n`;
}

export function encodeJsonlFile(lines: RecordLine[]): string {
	if (lines.length === 0) return "";
	return `${lines.map((line) => encodeJsonlLine(line)).join("\n")}\n`;
}
