/**
 * Default invocation-registry command context factory.
 *
 * Resolves one DB via `resolveDbContext` and closes both the SQLite
 * invocation store and `runExists` over it. Kept out of
 * `invoke-registry.handler.ts` so handlers never import `bun:sqlite`,
 * `getRunV1`, or `resolveDbContext`.
 */

import { createSqliteInvocationStore } from "../control-plane/index.js";
import { getRunV1 } from "../db/operations-v1.js";
import { resolveDbContext } from "./context.js";
import type { InvocationRegistryContext } from "./invoke-registry.handler.js";

export async function defaultResolveInvocationContext(opts?: {
	startDir?: string;
}): Promise<InvocationRegistryContext> {
	const { db } = await resolveDbContext({ startDir: opts?.startDir });
	return {
		store: createSqliteInvocationStore(db),
		runExists: (runId) => getRunV1(db, runId) !== null,
	};
}
