/**
 * Derived client state and public DTOs for invocation registry rows.
 *
 * `toClientInvocationView` never includes `handle` or `pid`.
 * `toInvocationStatusEnvelope` is the only JSON shape CLI/HTTP may emit.
 */

import type {
	ClientInvocationState,
	InvocationClientView,
	InvocationRecord,
	InvocationStatusEnvelope,
} from "./invocation-types.js";

export function toClientInvocationState(
	record: InvocationRecord,
): ClientInvocationState {
	if (record.status !== "running") return record.status;
	if (record.cancellationRequestedAt) return "cancellation-requested";
	if (!record.cancellationSupported) return "unsupported";
	return "running";
}

export function toClientInvocationView(
	record: InvocationRecord,
): InvocationClientView {
	return {
		id: record.id,
		runId: record.runId,
		sessionId: record.sessionId,
		role: record.role,
		providerName: record.providerName,
		templateName: record.templateName,
		status: record.status,
		clientState: toClientInvocationState(record),
		cancellation: {
			supported: record.cancellationSupported,
			requested: record.cancellationRequestedAt !== null,
			requestedBy: record.cancellationRequestedBy,
			outcome: record.cancellationOutcome ?? "none",
		},
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		terminalAt: record.terminalAt,
	};
}

export function toInvocationStatusEnvelope(
	view: InvocationClientView,
): InvocationStatusEnvelope {
	return {
		id: view.id,
		run_id: view.runId,
		session_id: view.sessionId,
		role: view.role,
		provider_name: view.providerName,
		template_name: view.templateName,
		status: view.status,
		client_state: view.clientState,
		cancellation: {
			supported: view.cancellation.supported,
			requested: view.cancellation.requested,
			requested_by: view.cancellation.requestedBy,
			outcome: view.cancellation.outcome,
		},
		created_at: view.createdAt,
		updated_at: view.updatedAt,
		terminal_at: view.terminalAt,
	};
}
