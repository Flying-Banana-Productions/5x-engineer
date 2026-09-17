/**
 * Display helpers for run-record summary attribution.
 *
 * Creator/sealer stay unknown when null. The exporter is `exported_by`
 * (from summary `materializer`) and is never copied into creator/sealer.
 */

import type {
	RecordOrigin,
	RecordRecorder,
	RunRecordSummary,
} from "../control-plane/record-types.js";

export interface AttributionEnvelope {
	creator: RecordRecorder | null;
	sealer?: RecordRecorder | null;
	exported_by?: RecordOrigin;
}

export function envelopeAttribution(
	summary: Pick<RunRecordSummary, "creator" | "sealer" | "materializer">,
): AttributionEnvelope {
	const out: AttributionEnvelope = { creator: summary.creator };
	if (summary.sealer !== undefined) out.sealer = summary.sealer;
	if (summary.materializer) out.exported_by = summary.materializer;
	return out;
}

function recorderLabel(recorder: RecordRecorder | null | undefined): string {
	if (recorder == null) return "(unknown)";
	return recorder.actor ?? recorder.installation_id;
}

export function formatAttributionLines(data: AttributionEnvelope): string[] {
	const lines = [`creator: ${recorderLabel(data.creator)}`];
	if (data.sealer !== undefined) {
		lines.push(`sealer: ${recorderLabel(data.sealer)}`);
	}
	if (data.exported_by) {
		const id = data.exported_by.recorder.installation_id;
		const role =
			data.exported_by.performer.role ?? data.exported_by.performer.kind;
		lines.push(`exported_by: ${id} (${role})`);
	}
	return lines;
}
