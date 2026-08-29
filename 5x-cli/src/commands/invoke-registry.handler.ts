/**
 * Invocation status/cancel handlers.
 *
 * Framework-independent. Explicit `--id` / `--run` only — never ambient
 * run identity. This file must not import bun:sqlite, getRunV1,
 * resolveDbContext, run-identity.ts, or invoke-registry-context.ts.
 * Production adapters inject resolveContext; unit tests inject a memory
 * store and fake runExists.
 */

import { requestInvocationCancellation } from "../control-plane/invocation-actions.js";
import type { InvocationStore } from "../control-plane/invocation-store.js";
import {
	toClientInvocationView,
	toInvocationStatusEnvelope,
} from "../control-plane/invocation-view.js";
import { outputError, outputSuccess } from "../output.js";

export interface InvocationRegistryContext {
	store: InvocationStore;
	/** True iff a `runs` row exists. Production closes over getRunV1(db). */
	runExists: (runId: string) => boolean;
}

export interface InvocationRegistryHandlerDeps {
	store?: InvocationStore;
	runExists?: (runId: string) => boolean;
	resolveContext?: (opts?: {
		startDir?: string;
	}) => Promise<InvocationRegistryContext>;
	requestCancellation?: typeof requestInvocationCancellation;
}

export interface InvokeStatusParams {
	id?: string;
	run?: string;
	startDir?: string;
}

export interface InvokeCancelParams {
	id: string;
	startDir?: string;
}

async function resolveInvocationRegistryContext(
	params: { startDir?: string },
	deps: InvocationRegistryHandlerDeps,
): Promise<InvocationRegistryContext> {
	if (deps.store) {
		return {
			store: deps.store,
			runExists: deps.runExists ?? (() => false),
		};
	}
	if (!deps.resolveContext) {
		throw new Error(
			"invocation registry handler requires store or resolveContext",
		);
	}
	return deps.resolveContext({ startDir: params.startDir });
}

function requireIdOrRun(params: InvokeStatusParams): void {
	if (params.id === undefined && params.run === undefined) {
		outputError(
			"INVALID_ARGS",
			"status requires --id <invocation-id> and/or --run <run-id>",
		);
	}
}

/**
 * `5x invoke status --id` and/or `--run`. Combined flags intersect: the
 * invocation must belong to that run or the result is INVOCATION_NOT_FOUND.
 */
export async function invokeStatus(
	params: InvokeStatusParams,
	deps: InvocationRegistryHandlerDeps = {},
): Promise<void> {
	requireIdOrRun(params);
	const { store, runExists } = await resolveInvocationRegistryContext(
		params,
		deps,
	);
	if (params.run !== undefined) {
		if (!runExists(params.run)) {
			outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
		}
	}

	if (params.id !== undefined && params.run !== undefined) {
		const record = store.get(params.id);
		if (!record || record.runId !== params.run) {
			outputError(
				"INVOCATION_NOT_FOUND",
				`invocation ${params.id} not found for run ${params.run}`,
			);
		}
		outputSuccess({
			invocation: toInvocationStatusEnvelope(toClientInvocationView(record)),
		});
		return;
	}

	if (params.id !== undefined) {
		const record = store.get(params.id);
		if (!record) {
			outputError("INVOCATION_NOT_FOUND", `invocation ${params.id} not found`);
		}
		outputSuccess({
			invocation: toInvocationStatusEnvelope(toClientInvocationView(record)),
		});
		return;
	}

	const runId = params.run as string;
	const views = store
		.list({ runId })
		.map((row) => toInvocationStatusEnvelope(toClientInvocationView(row)));
	outputSuccess({ invocations: views });
}

/**
 * `5x invoke cancel <invocation-id>`. Always passes actor `"cli"`.
 */
export async function invokeCancel(
	params: InvokeCancelParams,
	deps: InvocationRegistryHandlerDeps = {},
): Promise<void> {
	const { store } = await resolveInvocationRegistryContext(params, deps);
	const request = deps.requestCancellation ?? requestInvocationCancellation;
	const result = await request({
		store,
		id: params.id,
		actor: "cli",
	});
	if (!result.ok) {
		outputError(result.code, result.message);
	}
	outputSuccess({
		...toInvocationStatusEnvelope(result.view),
		adapter_called: result.adapterCalled,
	});
}
