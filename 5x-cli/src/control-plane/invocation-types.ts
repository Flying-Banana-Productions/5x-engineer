/**
 * Invocation registry record types, client DTOs, and CAS result.
 *
 * Distinct from prompt types in `types.ts`. The stored handle is adapter-owned
 * opaque JSON (`{ adapter, ref }`); there is no schema-level pid.
 */

export type InvocationStatus =
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "abandoned";

export type CancellationActor = "cli" | "control-plane";

export type CancellationOutcome = "succeeded" | "failed" | "unsupported";

export type InvocationAbandonReason = "stale-metadata";

/** Adapter-owned. Never a schema-level pid. */
export interface OpaqueCancellationHandle {
	adapter: string;
	ref: string;
}

export interface InvocationRecord {
	id: string;
	runId: string;
	sessionId: string | null;
	role: "author" | "reviewer";
	providerName: string;
	templateName: string | null;
	handle: OpaqueCancellationHandle;
	cancellationSupported: boolean;
	status: InvocationStatus;
	createdAt: string;
	updatedAt: string;
	cancellationRequestedAt: string | null;
	cancellationRequestedBy: CancellationActor | null;
	cancellationOutcome: CancellationOutcome | null;
	cancellationOutcomeAt: string | null;
	terminalAt: string | null;
	abandonReason: InvocationAbandonReason | null;
}

export type ClientInvocationState =
	| "running"
	| "cancellation-requested"
	| "cancelled"
	| "completed"
	| "failed"
	| "abandoned"
	| "unsupported";

/** Public DTO: no handle, no pid. */
export interface InvocationClientView {
	id: string;
	runId: string;
	sessionId: string | null;
	role: "author" | "reviewer";
	providerName: string;
	templateName: string | null;
	status: InvocationStatus;
	clientState: ClientInvocationState;
	cancellation: {
		supported: boolean;
		requested: boolean;
		requestedBy: CancellationActor | null;
		outcome: CancellationOutcome | "none";
	};
	createdAt: string;
	updatedAt: string;
	terminalAt: string | null;
}

/** CLI/HTTP JSON DTO: snake_case keys. Do not stringify InvocationClientView. */
export interface InvocationStatusEnvelope {
	id: string;
	run_id: string;
	session_id: string | null;
	role: "author" | "reviewer";
	provider_name: string;
	template_name: string | null;
	status: InvocationStatus;
	client_state: ClientInvocationState;
	cancellation: {
		supported: boolean;
		requested: boolean;
		requested_by: CancellationActor | null;
		outcome: CancellationOutcome | "none";
	};
	created_at: string;
	updated_at: string;
	terminal_at: string | null;
}

export interface RegisterInvocationInput {
	runId: string;
	sessionId?: string | null;
	role: "author" | "reviewer";
	providerName: string;
	templateName?: string | null;
	handle: OpaqueCancellationHandle;
	cancellationSupported: boolean;
	id?: string; // tests only
}

export type InvocationCasResult =
	| { ok: true; invocation: InvocationRecord }
	| { ok: false; invocation: InvocationRecord };

export class InvocationStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "InvocationStoreError";
		this.code = code;
	}
}

export function isCancellationActor(
	value: unknown,
): value is CancellationActor {
	return value === "cli" || value === "control-plane";
}

/**
 * Parse an adapter-owned handle from a JSON string or object.
 * Only `adapter` and `ref` are retained. A `pid` key is rejected.
 */
export function parseOpaqueCancellationHandle(
	value: unknown,
): OpaqueCancellationHandle {
	let raw: unknown = value;
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			throw new InvocationStoreError(
				"INVOCATION_INVALID_HANDLE",
				"handle_json is not valid JSON",
			);
		}
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new InvocationStoreError(
			"INVOCATION_INVALID_HANDLE",
			"handle must be an object with adapter and ref",
		);
	}
	const record = raw as Record<string, unknown>;
	if ("pid" in record) {
		throw new InvocationStoreError(
			"INVOCATION_INVALID_HANDLE",
			"handle must not include pid",
		);
	}
	if (typeof record.adapter !== "string" || record.adapter.length === 0) {
		throw new InvocationStoreError(
			"INVOCATION_INVALID_HANDLE",
			"handle.adapter must be a non-empty string",
		);
	}
	if (typeof record.ref !== "string" || record.ref.length === 0) {
		throw new InvocationStoreError(
			"INVOCATION_INVALID_HANDLE",
			"handle.ref must be a non-empty string",
		);
	}
	return { adapter: record.adapter, ref: record.ref };
}
