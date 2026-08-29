/**
 * Invocation cancel/status actions.
 *
 * The only cancel mutation entry besides doctor abandon. Command handlers
 * and a future dashboard call these; this module must not import bun:sqlite
 * or ambient run resolvers.
 */

import { getCancellationAdapter } from "./cancellation-adapter.js";
import type { InvocationStore } from "./invocation-store.js";
import type {
	CancellationActor,
	CancellationOutcome,
	InvocationClientView,
} from "./invocation-types.js";
import { isCancellationActor } from "./invocation-types.js";
import { toClientInvocationView } from "./invocation-view.js";

export const CANCELLATION_UNSUPPORTED = "CANCELLATION_UNSUPPORTED";
export const INVOCATION_NOT_FOUND = "INVOCATION_NOT_FOUND";
export const INVOCATION_INVALID_ACTOR = "INVOCATION_INVALID_ACTOR";

export async function requestInvocationCancellation(opts: {
	store: InvocationStore;
	id: string;
	actor: CancellationActor;
	getAdapter?: typeof getCancellationAdapter;
}): Promise<
	| { ok: true; view: InvocationClientView; adapterCalled: boolean }
	| { ok: false; code: string; message: string; view?: InvocationClientView }
> {
	if (!isCancellationActor(opts.actor)) {
		return {
			ok: false,
			code: INVOCATION_INVALID_ACTOR,
			message: "invalid actor",
		};
	}
	const record = opts.store.get(opts.id);
	if (!record) {
		return {
			ok: false,
			code: INVOCATION_NOT_FOUND,
			message: `invocation ${opts.id} not found`,
		};
	}
	if (record.status !== "running") {
		// Already terminal: idempotent success even when the provider never
		// supported cancel (completed sample rows, doctor-abandoned, etc.).
		return {
			ok: true,
			view: toClientInvocationView(record),
			adapterCalled: false,
		};
	}
	if (!record.cancellationSupported) {
		return {
			ok: false,
			code: CANCELLATION_UNSUPPORTED,
			message: "cancellation is not supported for this invocation",
			view: toClientInvocationView(record),
		};
	}
	const cas = opts.store.markCancellationRequested(opts.id, opts.actor);
	if (!cas.ok) {
		return {
			ok: true,
			view: toClientInvocationView(cas.invocation),
			adapterCalled: false,
		};
	}
	const getAdapter = opts.getAdapter ?? getCancellationAdapter;
	const adapter = getAdapter(cas.invocation.handle.adapter);
	if (!adapter) {
		opts.store.recordCancellationOutcome(opts.id, "unsupported");
		const updated = opts.store.get(opts.id);
		return {
			ok: true,
			view: toClientInvocationView(updated ?? cas.invocation),
			adapterCalled: false,
		};
	}
	let outcome: CancellationOutcome;
	try {
		const result = await adapter.cancel(cas.invocation.handle);
		outcome = result.outcome === "succeeded" ? "succeeded" : "failed";
	} catch {
		outcome = "failed";
	}
	opts.store.recordCancellationOutcome(opts.id, outcome);
	const updated = opts.store.get(opts.id);
	return {
		ok: true,
		view: toClientInvocationView(updated ?? cas.invocation),
		adapterCalled: true,
	};
}

export function getInvocationView(
	store: InvocationStore,
	id: string,
): InvocationClientView | null {
	const record = store.get(id);
	return record ? toClientInvocationView(record) : null;
}

export function listInvocationViews(
	store: InvocationStore,
	filter: { runId: string },
): InvocationClientView[] {
	return store.list({ runId: filter.runId }).map(toClientInvocationView);
}
