/**
 * Records command handlers — index rebuild (Phase 6).
 *
 * Framework-independent: no CLI framework imports and no `bun:sqlite`.
 * The DB comes from `resolveDbContext`; upserts live in `index-rebuild.ts`.
 */

import { resolve } from "node:path";
import { outputSuccess } from "../output.js";
import {
	type IndexRebuildResult,
	rebuildRecordsIndex,
} from "../records/index-rebuild.js";
import { resolvePlanProgress } from "../records/resolve.js";
import { resolveDbContext } from "./context.js";

export interface RecordsIndexParams {
	plan?: string;
	startDir?: string;
}

function formatRecordsIndexText(data: IndexRebuildResult): void {
	const plans = data.plans.length > 0 ? data.plans.join(", ") : "(none)";
	console.log(`plans: ${plans}`);
	console.log(`runs_upserted: ${data.runs_upserted}`);
	console.log(`steps_upserted: ${data.steps_upserted}`);
	console.log(`steps_skipped_newer_local: ${data.steps_skipped_newer_local}`);
}

export async function recordsIndex(
	params: RecordsIndexParams = {},
): Promise<void> {
	const { db, config, projectRoot } = await resolveDbContext({
		startDir: resolve(params.startDir ?? "."),
	});
	const result = await rebuildRecordsIndex({
		db,
		workdir: projectRoot,
		config,
		planSlug: params.plan,
		resolve: resolvePlanProgress,
	});
	outputSuccess(result, formatRecordsIndexText);
}
