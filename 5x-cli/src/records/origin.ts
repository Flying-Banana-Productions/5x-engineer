/**
 * Fallback performer resolution when `RunRecordParams.performer` is omitted.
 *
 * Invoke and protocol must pass `params.performer` explicitly so agent
 * role/provider is not lost. This helper never reads invocation state,
 * Git config, OS username, or hostname.
 */

import type { RecordPerformer } from "../control-plane/record-types.js";

const PERFORMER_KINDS = new Set(["human", "agent", "system"]);

const SYSTEM_CLI_STEPS = new Set(["git:commit", "run:complete", "run:abort"]);

function copyPerformer(performer: RecordPerformer): RecordPerformer {
	const out: RecordPerformer = { kind: performer.kind };
	if (performer.role !== undefined) out.role = performer.role;
	if (performer.provider !== undefined) out.provider = performer.provider;
	return out;
}

export function isRecordPerformerKind(
	value: string,
): value is RecordPerformer["kind"] {
	return PERFORMER_KINDS.has(value);
}

/**
 * Who performed a step when the caller did not supply `performer`.
 *
 * - explicit `performer` wins (copy; do not fill missing `provider`/`role`)
 * - `human:*` → `{ kind: "human", role: "operator" }`
 * - `git:commit` / `run:complete` / `run:abort` / `quality:*` → system/cli
 * - everything else → `{ kind: "system", role: "cli" }`
 */
export function resolveRecordPerformer(input: {
	stepName?: string;
	performer?: RecordPerformer;
}): RecordPerformer {
	if (input.performer) {
		if (!isRecordPerformerKind(input.performer.kind)) {
			throw new Error(
				`invalid performer.kind: ${String(input.performer.kind)}`,
			);
		}
		return copyPerformer(input.performer);
	}
	const stepName = input.stepName ?? "";
	if (stepName.startsWith("human:")) {
		return { kind: "human", role: "operator" };
	}
	if (SYSTEM_CLI_STEPS.has(stepName) || stepName.startsWith("quality:")) {
		return { kind: "system", role: "cli" };
	}
	return { kind: "system", role: "cli" };
}
