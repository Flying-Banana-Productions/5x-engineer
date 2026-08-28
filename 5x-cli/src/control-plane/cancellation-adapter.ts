/**
 * Process-local cancellation adapter registry.
 *
 * Production providers do not register adapters in this slice. Tests inject
 * a synthetic remote adapter whose handle is a job id, not a PID.
 */

import type { OpaqueCancellationHandle } from "./invocation-types.js";

export type AdapterCancelResult =
	| { outcome: "succeeded" }
	| { outcome: "failed"; error: string };

export interface CancellationAdapter {
	readonly name: string;
	cancel(handle: OpaqueCancellationHandle): Promise<AdapterCancelResult>;
}

const adapters = new Map<string, CancellationAdapter>();

export function registerCancellationAdapter(
	adapter: CancellationAdapter,
): void {
	adapters.set(adapter.name, adapter);
}

export function getCancellationAdapter(
	name: string,
): CancellationAdapter | undefined {
	return adapters.get(name);
}

/** Tests only — clear the process-local registry. */
export function _resetCancellationAdaptersForTest(): void {
	adapters.clear();
}
