/**
 * RecordStore types: run summaries, JSONL line envelopes, and append ops.
 *
 * Origin is a line-level envelope (recorder vs performer), distinct from
 * provenance and from Git attribution. Production writers construct origin
 * via `originFor` (Phase 4); this module only types the envelope.
 */

export type RecordStream = "steps" | "decisions" | "budget";
export type RecordProvenance = "recorded" | "backfilled";
export type RecordPerformerKind = "human" | "agent" | "system";

/** Writers emit this. Decoder compatibility is Phase 3.1. */
export const RECORD_LINE_SCHEMA_VERSION = 1 as const;
/** `run.json` document version. Distinct name from line `schema_version`. */
export const RUN_RECORD_FORMAT_VERSION = 1 as const;

export interface RecordRecorder {
	/** UUID v4 from the user-scope identity file. Never a hostname or OS username. */
	installation_id: string;
	/** Optional operator-chosen label. Omit rather than infer. */
	actor?: string;
}

export interface RecordPerformer {
	kind: RecordPerformerKind;
	/** When known: `author` | `reviewer` | `operator` | `cli` | `exporter`. */
	role?: string;
	/** When `kind === "agent"` and known: provider id (e.g. `opencode`, `cursor`). */
	provider?: string;
}

export interface RecordOrigin {
	recorder: RecordRecorder;
	performer: RecordPerformer;
}

export interface StepIdempotencyKey {
	runId: string;
	stepName: string;
	phase: string | null;
	iteration: number;
}

export interface DiffSummary {
	files_changed: number;
	insertions: number;
	deletions: number;
}

/** Payload stored on stream "steps". Never includes session_id, log_path, or transcript. Provenance lives on the envelope, not here. */
export interface StepRecordPayload {
	step_name: string;
	phase: string | null;
	iteration: number;
	result_json: unknown; // parsed JSON object/array/value, not a double-encoded string
	head_commit: string | null;
	patch_id: string | null;
	diff_summary: DiffSummary | null;
	duration_ms: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	cost_usd: number | null;
	model: string | null;
}

export interface RunRecordSummary {
	id: string;
	plan_path: string;
	config_json: unknown | null;
	created_at: string;
	sealed_at: string | null;
	status: "active" | "completed" | "aborted";
	final_head_commit: string | null;
	cli_version: string;
	/**
	 * Writers emit `RUN_RECORD_FORMAT_VERSION` (1). Decode accepts integer >= 1
	 * (read-only compatible view). `putRun` refuses `format_version > 1` mutation.
	 */
	format_version: number;
	/**
	 * Recorder at live init `putRun`.
	 * `null` when the original creator is unknown (backfill / pre-slice materialization).
	 * Seal must preserve this value, including `null`; never overwrite with the sealer or exporter.
	 */
	creator: RecordRecorder | null;
	/**
	 * Recorder at live seal `putRun`.
	 * Omit while unsealed.
	 * `null` when the run is terminal but the original sealer is unknown (backfilled terminal).
	 */
	sealer?: RecordRecorder | null;
	/**
	 * Who exported/materialized this summary when original attribution is unknown.
	 * Never copied into `creator` or `sealer`. Omit on live init/seal of a known-creator run.
	 */
	materializer?: RecordOrigin;
	/** Present on backfilled *unsealed* exports (`207` §2.7). Terminal backfills use `materializer` instead of this flag. */
	backfilled?: boolean;
}

export interface RecordLine {
	runId: string;
	stream: RecordStream;
	idempotencyKey: string;
	payload: unknown;
	createdAt: string;
	schemaVersion: number;
	provenance: RecordProvenance;
	/** Null only when original origin is unknown (backfill). Recorded lines require a non-null origin. */
	origin: RecordOrigin | null;
	/** Who exported/materialized a backfilled line. Never used as `origin`. Omit on recorded lines. */
	materializer?: RecordOrigin;
}

export type AppendOp = Omit<RecordLine, "createdAt" | "schemaVersion"> & {
	createdAt?: string;
	schemaVersion?: number;
};

/** Envelope fields 06 and this slice stamp on every live append. */
export function recordedEnvelope(
	origin: RecordOrigin,
): Pick<AppendOp, "schemaVersion" | "provenance" | "origin"> {
	return {
		schemaVersion: RECORD_LINE_SCHEMA_VERSION,
		provenance: "recorded",
		origin,
	};
}

export interface AppendResult {
	created: boolean;
	line: RecordLine;
}

export class RecordStoreError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "RecordStoreError";
		this.code = code;
	}
}

/** The only step-key encoder. Lookup via `getLine("steps", key)`. */
export function stepIdempotencyKey(k: StepIdempotencyKey): string {
	return `step:${k.runId}:${k.stepName}:${k.phase ?? ""}:${k.iteration}`;
}
