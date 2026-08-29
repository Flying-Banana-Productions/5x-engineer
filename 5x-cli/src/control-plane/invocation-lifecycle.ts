/**
 * Register/heartbeat/finalize around a single invoke. Adapters are not
 * called here — this is the invoke process's observation of its own lifetime.
 */

import type { InvocationStore } from "./invocation-store.js";
import type {
	InvocationRecord,
	RegisterInvocationInput,
} from "./invocation-types.js";

export const INVOCATION_HEARTBEAT_MIN_INTERVAL_MS = 5_000;
export const INVOCATION_STALE_MS = 15 * 60 * 1000;

function defaultIsCancellationError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"name" in err &&
		(err as { name: unknown }).name === "AgentCancellationError"
	);
}

export async function withInvocationLifecycle<T>(opts: {
	store: InvocationStore;
	input: RegisterInvocationInput;
	isCancellationError?: (err: unknown) => boolean;
	now?: () => number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
	fn: (ctx: {
		invocation: InvocationRecord;
		heartbeat: () => void;
	}) => Promise<T>;
}): Promise<T> {
	const invocation = opts.store.register(opts.input);
	const nowFn = opts.now ?? Date.now;
	const isCancellationError =
		opts.isCancellationError ?? defaultIsCancellationError;
	// First beat is allowed immediately (event hook optimization; interval
	// still starts after INVOCATION_HEARTBEAT_MIN_INTERVAL_MS).
	let lastBeat = -INVOCATION_HEARTBEAT_MIN_INTERVAL_MS;
	let stopped = false;
	const heartbeat = () => {
		if (stopped) return;
		const t = nowFn();
		if (t - lastBeat < INVOCATION_HEARTBEAT_MIN_INTERVAL_MS) return;
		lastBeat = t;
		opts.store.heartbeat(invocation.id);
	};
	const setIntervalFn = opts.setIntervalFn ?? setInterval;
	const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
	const timer = setIntervalFn(
		() => heartbeat(),
		INVOCATION_HEARTBEAT_MIN_INTERVAL_MS,
	);
	try {
		const result = await opts.fn({ invocation, heartbeat });
		opts.store.markTerminal(invocation.id, "completed");
		return result;
	} catch (err) {
		const cancelled = isCancellationError(err) === true;
		opts.store.markTerminal(invocation.id, cancelled ? "cancelled" : "failed");
		throw err;
	} finally {
		stopped = true;
		clearIntervalFn(timer);
		const current = opts.store.get(invocation.id);
		if (current?.status === "running") {
			opts.store.markTerminal(invocation.id, "failed");
		}
	}
}
