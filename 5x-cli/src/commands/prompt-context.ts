/**
 * Default PromptCommandContext factory.
 *
 * Resolves one DB via `resolveDbContext` and closes both the SQLite prompt
 * store and `runExists` over it. Kept out of `prompt.handler.ts` so handlers
 * never import `bun:sqlite`, `getRunV1`, or `resolveDbContext`.
 */

import { createSqlitePromptStore } from "../control-plane/index.js";
import { getRunV1 } from "../db/operations-v1.js";
import { resolveDbContext } from "./context.js";
import type { PromptCommandContext } from "./prompt.handler.js";

export async function defaultResolvePromptContext(opts?: {
	startDir?: string;
}): Promise<PromptCommandContext> {
	const { db } = await resolveDbContext({ startDir: opts?.startDir });
	return {
		store: createSqlitePromptStore(db),
		runExists: (runId) => getRunV1(db, runId) !== null,
	};
}
