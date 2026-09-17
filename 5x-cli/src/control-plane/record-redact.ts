/**
 * Writer-side redaction for step payloads and origin/recorder attribution.
 *
 * The store persists whatever it is given. Callers (Phase 4 `originFor` /
 * `redactedRecorder`) apply these helpers before append / `putRun`.
 */

import type {
	RecordOrigin,
	RecordPerformer,
	RecordRecorder,
	StepRecordPayload,
} from "./record-types.js";

export const FORBIDDEN_ORIGIN_KEYS = [
	"hostname",
	"hardware_id",
	"os_username",
	"username",
	"session_id",
	"log_path",
	"transcript",
	"git_user",
	"user_email",
] as const;

const NON_REDACTABLE_PAYLOAD_KEYS = new Set([
	"result_json",
	"step_name",
	"phase",
	"iteration",
	"head_commit",
]);

const UNCONDITIONAL_DROP_PAYLOAD_KEYS = ["session_id", "log_path"] as const;

function omitActor(redact: string[]): boolean {
	return redact.includes("origin.actor") || redact.includes("actor");
}

/** Delete forbidden identity keys from a widened object (in place). */
export function stripForbiddenOriginKeys<T extends Record<string, unknown>>(
	obj: T,
): T {
	for (const key of FORBIDDEN_ORIGIN_KEYS) {
		delete obj[key];
	}
	return obj;
}

function stripRecorderObject(recorder: RecordRecorder): RecordRecorder {
	const out: RecordRecorder = {
		installation_id: recorder.installation_id,
	};
	if (recorder.actor !== undefined) out.actor = recorder.actor;
	stripForbiddenOriginKeys(out as unknown as Record<string, unknown>);
	return out;
}

function stripPerformerObject(performer: RecordPerformer): RecordPerformer {
	const out: RecordPerformer = { kind: performer.kind };
	if (performer.role !== undefined) out.role = performer.role;
	if (performer.provider !== undefined) out.provider = performer.provider;
	stripForbiddenOriginKeys(out as unknown as Record<string, unknown>);
	return out;
}

/** Strip forbidden keys from a (possibly widened) origin. Null stays null. */
export function stripOrigin(origin: RecordOrigin | null): RecordOrigin | null {
	if (origin === null) return null;
	const widened = origin as RecordOrigin & Record<string, unknown>;
	const stripped: RecordOrigin = {
		recorder: stripRecorderObject(widened.recorder),
		performer: stripPerformerObject(widened.performer),
	};
	stripForbiddenOriginKeys(stripped as unknown as Record<string, unknown>);
	return stripped;
}

export function redactRecorder(
	recorder: RecordRecorder,
	redact: string[],
): RecordRecorder {
	const out = stripRecorderObject(recorder);
	if (omitActor(redact)) delete out.actor;
	return out;
}

export function redactOrigin(
	origin: RecordOrigin | null,
	redact: string[],
): RecordOrigin | null {
	if (origin === null) return null;
	const widened = origin as RecordOrigin & Record<string, unknown>;
	const stripped: RecordOrigin = {
		recorder: redactRecorder(widened.recorder, redact),
		performer: stripPerformerObject(widened.performer),
	};
	stripForbiddenOriginKeys(stripped as unknown as Record<string, unknown>);
	return stripped;
}

export function redactStepPayload(
	payload: StepRecordPayload,
	redact: string[],
): StepRecordPayload {
	const out = { ...payload } as StepRecordPayload & Record<string, unknown>;
	for (const key of UNCONDITIONAL_DROP_PAYLOAD_KEYS) {
		delete out[key];
	}
	for (const name of redact) {
		if (NON_REDACTABLE_PAYLOAD_KEYS.has(name)) continue;
		if (Object.hasOwn(out, name)) out[name] = null;
	}
	return out;
}
