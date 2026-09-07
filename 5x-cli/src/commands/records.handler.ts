/**
 * Records command handlers — index rebuild (Phase 6) and backfill (Phase 7).
 *
 * Framework-independent: no CLI framework imports and no `bun:sqlite`.
 * The DB comes from `resolveDbContext`; upserts live in `index-rebuild.ts`
 * and export lives in `backfill.ts`.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { outputError, outputSuccess } from "../output.js";
import {
	type BackfillResult,
	backfillRecords,
	RecordsBackfillError,
} from "../records/backfill.js";
import { loadOrCreateInstallationIdentity } from "../records/identity.js";
import {
	type IndexRebuildResult,
	RecordsIndexError,
	rebuildRecordsIndex,
} from "../records/index-rebuild.js";
import { resolvePlanProgress } from "../records/resolve.js";
import { resolveDbContext } from "./context.js";
import { createRecordAttribution } from "./record-context.js";

export interface RecordsIndexParams {
	plan?: string;
	startDir?: string;
}

export interface RecordsBackfillParams {
	plan?: string;
	target?: string;
	dryRun?: boolean;
	startDir?: string;
}

function formatRecordsIndexText(data: IndexRebuildResult): void {
	const plans = data.plans.length > 0 ? data.plans.join(", ") : "(none)";
	console.log(`plans: ${plans}`);
	console.log(`runs_upserted: ${data.runs_upserted}`);
	console.log(`steps_upserted: ${data.steps_upserted}`);
	console.log(`steps_skipped_newer_local: ${data.steps_skipped_newer_local}`);
}

function formatRecordsBackfillText(data: BackfillResult): void {
	console.log(`dry_run: ${data.dry_run ? "true" : "false"}`);
	const exporter = data.exported_by;
	console.log(
		`exported_by: ${exporter.recorder.installation_id} (${exporter.performer.role ?? exporter.performer.kind})`,
	);
	if (data.mappings.length === 0) {
		console.log("runs: (none)");
		return;
	}
	for (const mapping of data.mappings) {
		const wt = mapping.worktree ?? "(temp)";
		console.log(
			`${mapping.run_id} → ${mapping.target_branch}  worktree: ${wt}`,
		);
		console.log(`  files: ${mapping.files.join(", ") || "(none)"}`);
		const created = mapping.lines.filter((l) => l.created).length;
		const skipped = mapping.lines.filter((l) => !l.created).length;
		console.log(`  created: ${created}  skipped: ${skipped}`);
		if (mapping.disagreements.length === 0) {
			console.log("  disagreements: (none)");
		} else {
			for (const d of mapping.disagreements) {
				console.log(`  disagreement: ${d.key} (${d.reason})`);
			}
		}
	}
	if (!data.dry_run) {
		for (const commit of data.commits) {
			console.log(
				`commit ${commit.branch}: ${commit.created ? commit.message : "(none)"}`,
			);
		}
	}
}

export async function recordsIndex(
	params: RecordsIndexParams = {},
): Promise<void> {
	const { db, config, projectRoot } = await resolveDbContext({
		startDir: resolve(params.startDir ?? "."),
	});
	try {
		const result = await rebuildRecordsIndex({
			db,
			workdir: projectRoot,
			config,
			planSlug: params.plan,
			resolve: resolvePlanProgress,
		});
		outputSuccess(result, formatRecordsIndexText);
	} catch (err) {
		if (err instanceof RecordsIndexError) {
			outputError(err.code, err.message, err.detail);
		}
		throw err;
	}
}

export async function recordsBackfill(
	params: RecordsBackfillParams = {},
): Promise<void> {
	const { db, config, projectRoot } = await resolveDbContext({
		startDir: resolve(params.startDir ?? "."),
	});
	const identity = loadOrCreateInstallationIdentity({ homeDir: homedir() });
	const { originFor } = createRecordAttribution({
		identity,
		configActor: config.records.actor,
		envActor: process.env.FIVEX_RECORDS_ACTOR,
		redact: config.records.redact,
	});
	try {
		const result = await backfillRecords({
			db,
			config,
			workdir: projectRoot,
			planSlug: params.plan,
			target:
				params.target && params.target.length > 0 ? params.target : "auto",
			dryRun: Boolean(params.dryRun),
			originFor,
		});
		outputSuccess(result, formatRecordsBackfillText);
	} catch (err) {
		if (err instanceof RecordsBackfillError) {
			outputError(err.code, err.message, err.detail);
		}
		throw err;
	}
}
