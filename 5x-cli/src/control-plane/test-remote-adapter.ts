/**
 * Synthetic remote cancellation adapter for tests.
 *
 * Handle refs are `job-<uuid>`, never a PID. Production `bin.ts` / provider
 * factory must not register this adapter.
 */

import { randomUUID } from "node:crypto";
import type {
	AdapterCancelResult,
	CancellationAdapter,
} from "./cancellation-adapter.js";
import type { OpaqueCancellationHandle } from "./invocation-types.js";

export interface TestRemoteAdapter extends CancellationAdapter {
	readonly name: "test-remote";
	cancelCalls: number;
	allocateJob(): { handle: OpaqueCancellationHandle; signal: AbortSignal };
}

class TestRemoteAdapterImpl implements TestRemoteAdapter {
	readonly name = "test-remote";
	cancelCalls = 0;
	private readonly jobs = new Map<string, AbortController>();

	allocateJob(): { handle: OpaqueCancellationHandle; signal: AbortSignal } {
		const ref = `job-${randomUUID()}`;
		const controller = new AbortController();
		this.jobs.set(ref, controller);
		return {
			handle: { adapter: this.name, ref },
			signal: controller.signal,
		};
	}

	async cancel(handle: OpaqueCancellationHandle): Promise<AdapterCancelResult> {
		this.cancelCalls++;
		if (handle.adapter !== this.name) {
			return { outcome: "failed", error: "unknown handle" };
		}
		const controller = this.jobs.get(handle.ref);
		if (!controller) {
			return { outcome: "failed", error: "unknown handle" };
		}
		controller.abort();
		return { outcome: "succeeded" };
	}
}

export function createTestRemoteAdapter(): TestRemoteAdapter {
	return new TestRemoteAdapterImpl();
}
