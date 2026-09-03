/**
 * Doctor check: git-native run records vs SQLite index, txn journals, and
 * stale uncommitted record files.
 *
 * Detect opens the existing DB read-only when present. `--fix` re-indexes
 * once per plan slug (never deletes extras, never rewrites JSONL, never
 * deletes `.txn.*` on `RECORD_TXN_CORRUPT`).
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type FiveXConfig, loadConfig } from "../../config.js";
import {
	inspectTxnLock,
	isRunTxnCorrupt,
	runDirHasTxnArtifacts,
} from "../../control-plane/record-fs.js";
import { closeDb, getDb, openDbReadOnly } from "../../db/connection.js";
import { getRunV1, getSteps, type StepRow } from "../../db/operations-v1.js";
import {
	isAncestor,
	listRefTips,
	parsePorcelainZ,
	revParseCommit,
} from "../../git.js";
import { isPathUnder } from "../../paths.js";
import {
	collectRecordIndexSnapshot,
	listMappedWorktreePaths,
	rebuildRecordsIndex,
	sqliteStepKey,
	walkRecordRunDirs,
} from "../../records/index-rebuild.js";
import { resolveRecordsRoot } from "../../records/paths.js";
import { resolvePlanProgress } from "../../records/resolve.js";
import { subprocess } from "../../utils/subprocess.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../types.js";
import { LINGERING_RUN_AGE_MS } from "./runs.js";

export const RECORDS_CHECK_ID = "records";

function asRecord(detail: unknown): Record<string, unknown> {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		return {};
	}
	return detail as Record<string, unknown>;
}

function dbUnreadable(ctx: DoctorCheckContext, err: unknown): DoctorFinding {
	const message = err instanceof Error ? err.message : String(err);
	return {
		check: RECORDS_CHECK_ID,
		status: "fail",
		code: "DB_UNREADABLE",
		message: `cannot read database at ${ctx.dbPath}: ${message}`,
		fixable: false,
		detail: { dbPath: ctx.dbPath, error: message },
	};
}

async function loadRecordsConfig(
	projectRoot: string,
): Promise<FiveXConfig | null> {
	try {
		const { config } = await loadConfig(
			projectRoot,
			undefined,
			undefined,
			projectRoot,
		);
		return config;
	} catch {
		return null;
	}
}

function stepKeyOf(row: StepRow): string {
	return sqliteStepKey(row);
}

function recordLineKey(runId: string, payload: unknown): string | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const p = payload as {
		step_name?: unknown;
		iteration?: unknown;
		phase?: unknown;
	};
	if (typeof p.step_name !== "string" || typeof p.iteration !== "number") {
		return null;
	}
	return sqliteStepKey({
		id: 0,
		run_id: runId,
		step_name: p.step_name,
		phase: typeof p.phase === "string" ? p.phase : null,
		iteration: p.iteration,
		result_json: "",
		session_id: null,
		model: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		duration_ms: null,
		log_path: null,
		head_commit: null,
		created_at: "",
	});
}

function payloadHeadCommit(payload: unknown): string | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const head = (payload as { head_commit?: unknown }).head_commit;
	return typeof head === "string" && head.length > 0 ? head : null;
}

async function commitReachable(
	workdir: string,
	sha: string,
	tipCache: { tips?: string[] },
): Promise<boolean> {
	const obj = await revParseCommit(workdir, sha);
	if (!obj) return false;
	if (!tipCache.tips) {
		const listed = await listRefTips(workdir, ["refs/heads", "refs/remotes"]);
		const head = await revParseCommit(workdir, "HEAD");
		const tips = listed.map((t) => t.sha);
		if (head) tips.push(head);
		tipCache.tips = [...new Set(tips)];
	}
	for (const tip of tipCache.tips) {
		if (tip === obj) return true;
		if (await isAncestor(workdir, obj, tip)) return true;
	}
	return false;
}

async function collectUncommittedStale(
	checkout: string,
	recordsAbsPath: string,
	nowMs: number,
): Promise<string[]> {
	const status = await subprocess.execGit(
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		checkout,
	);
	if (status.exitCode !== 0) return [];
	const stale: string[] = [];
	for (const entry of parsePorcelainZ(status.stdout)) {
		for (const rel of entry.paths) {
			const abs = resolve(checkout, rel);
			if (!isPathUnder(abs, recordsAbsPath)) continue;
			if (!existsSync(abs)) continue;
			let mtimeMs: number;
			try {
				mtimeMs = statSync(abs).mtimeMs;
			} catch {
				continue;
			}
			if (nowMs - mtimeMs >= LINGERING_RUN_AGE_MS) stale.push(abs);
		}
	}
	return stale;
}

function extraRowFinding(row: StepRow): DoctorFinding {
	const key = stepKeyOf(row);
	return {
		check: RECORDS_CHECK_ID,
		status: "warn",
		code: "RECORD_INDEX_EXTRA_ROW",
		message: `SQLite step ${key} has no record line`,
		fixable: false,
		detail: { runId: row.run_id, stepKey: key },
	};
}

function indexOkFinding(): DoctorFinding {
	return {
		check: RECORDS_CHECK_ID,
		status: "ok",
		code: "RECORD_INDEX_OK",
		message: "run records match the SQLite index",
		fixable: false,
	};
}

export function createRecordsCheck(): DoctorCheck {
	const rebuilt = new Set<string>();

	async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
		const findings: DoctorFinding[] = [];
		const config = await loadRecordsConfig(ctx.projectRoot);
		const now = ctx.now ?? Date.now();
		const checkouts = new Set<string>([ctx.projectRoot]);

		let db: ReturnType<typeof openDbReadOnly> | undefined;
		try {
			if (existsSync(ctx.dbPath)) {
				db = openDbReadOnly(ctx.projectRoot, ctx.dbRelPath);
				for (const wt of listMappedWorktreePaths(db)) checkouts.add(wt);
			}
		} catch (err) {
			return [dbUnreadable(ctx, err)];
		}

		if (config) {
			for (const checkout of checkouts) {
				let recordsAbsPath: string;
				try {
					recordsAbsPath = resolveRecordsRoot({
						recordsConfigAbs: config.paths.records,
						controlPlaneRoot: ctx.projectRoot,
						effectiveWorkdir: checkout,
					}).recordsAbsPath;
				} catch {
					continue;
				}

				for (const { runId, runDir } of walkRecordRunDirs(recordsAbsPath)) {
					const lock = inspectTxnLock(runDir);
					if (lock === "live" || lock === "malformed") continue;
					if (!runDirHasTxnArtifacts(runDir) && lock === "absent") continue;
					if (!isRunTxnCorrupt(runDir)) continue;
					findings.push({
						check: RECORDS_CHECK_ID,
						status: "fail",
						code: "RECORD_TXN_CORRUPT",
						message: `corrupt record transaction in ${runDir}`,
						remediation:
							"Inspect leftover .txn.journal.json / .txn.commit / .old / .new; restore from git. Doctor --fix will not delete them.",
						fixable: false,
						detail: { runId, runDir },
					});
				}

				try {
					const stale = await collectUncommittedStale(
						checkout,
						recordsAbsPath,
						now,
					);
					for (const path of stale) {
						findings.push({
							check: RECORDS_CHECK_ID,
							status: "warn",
							code: "RECORD_UNCOMMITTED_STALE",
							message: `uncommitted record file older than 24h: ${path}`,
							fixable: false,
							detail: { path, checkout },
						});
					}
				} catch {
					// Not a git checkout — skip porcelain.
				}
			}
		}

		if (db && config) {
			try {
				const snapshot = await collectRecordIndexSnapshot({
					db,
					workdir: ctx.projectRoot,
					config,
				});
				const tipCache: { tips?: string[] } = {};
				const recordRunIds = new Set<string>();

				for (const rec of snapshot.runs) {
					recordRunIds.add(rec.summary.id);
					const sqliteRun = getRunV1(db, rec.summary.id);
					if (!sqliteRun) {
						findings.push({
							check: RECORDS_CHECK_ID,
							status: "fail",
							code: "RECORD_INDEX_MISSING_RUN",
							message: `run.json ${rec.summary.id} has no SQLite runs row`,
							remediation: "5x records index",
							fixable: true,
							detail: {
								runId: rec.summary.id,
								planSlug: rec.planSlug,
							},
						});
					}

					const sqliteSteps = sqliteRun ? getSteps(db, rec.summary.id) : [];
					const sqliteKeys = new Set(sqliteSteps.map(stepKeyOf));
					const recordKeys = new Set<string>();

					for (const line of rec.steps) {
						const key = recordLineKey(line.runId, line.payload);
						if (!key) continue;
						recordKeys.add(key);
						if (!sqliteKeys.has(key)) {
							findings.push({
								check: RECORDS_CHECK_ID,
								status: "fail",
								code: "RECORD_INDEX_MISSING_ROW",
								message: `record step ${key} has no SQLite row`,
								remediation: "5x records index",
								fixable: true,
								detail: {
									stepKey: key,
									runId: line.runId,
									planSlug: rec.planSlug,
								},
							});
						}

						const head = payloadHeadCommit(line.payload);
						if (head) {
							const reachable = await commitReachable(
								ctx.projectRoot,
								head,
								tipCache,
							);
							if (!reachable) {
								findings.push({
									check: RECORDS_CHECK_ID,
									status: "warn",
									code: "RECORD_HEAD_UNREACHABLE",
									message: `head_commit ${head} is not reachable from any known ref`,
									fixable: false,
									detail: {
										runId: rec.summary.id,
										head_commit: head,
									},
								});
							}
						}
					}

					for (const row of sqliteSteps) {
						if (recordKeys.has(stepKeyOf(row))) continue;
						findings.push(extraRowFinding(row));
					}
				}

				for (const row of db.query("SELECT id FROM runs").all() as Array<{
					id: string;
				}>) {
					if (recordRunIds.has(row.id)) continue;
					for (const step of getSteps(db, row.id)) {
						findings.push(extraRowFinding(step));
					}
				}
			} catch (err) {
				try {
					db.close();
				} catch {
					// already closed
				}
				return [...findings, dbUnreadable(ctx, err)];
			}
		}

		try {
			db?.close();
		} catch {
			// already closed
		}

		if (findings.length === 0) return [indexOkFinding()];
		return findings;
	}

	async function fix(
		finding: DoctorFinding,
		ctx: DoctorCheckContext,
	): Promise<DoctorFixResult> {
		if (
			finding.code !== "RECORD_INDEX_MISSING_ROW" &&
			finding.code !== "RECORD_INDEX_MISSING_RUN"
		) {
			return { attempted: false, message: "not a fixable records finding" };
		}
		const detail = asRecord(finding.detail);
		const planSlug =
			typeof detail.planSlug === "string" && detail.planSlug
				? detail.planSlug
				: "";
		const runId =
			typeof detail.runId === "string" && detail.runId ? detail.runId : "";
		const identity = planSlug || runId;
		if (!identity) {
			return { attempted: false, message: "missing planSlug/runId" };
		}
		if (rebuilt.has(identity) || (planSlug !== "" && rebuilt.has(planSlug))) {
			return { attempted: false, message: "already re-indexed this plan" };
		}
		if (!existsSync(ctx.dbPath)) {
			return { attempted: false, message: "database missing" };
		}
		const config = await loadRecordsConfig(ctx.projectRoot);
		if (!config) {
			return { attempted: false, message: "cannot load config" };
		}
		try {
			const db = getDb(ctx.projectRoot, ctx.dbRelPath);
			await rebuildRecordsIndex({
				db,
				workdir: ctx.projectRoot,
				config,
				planSlug: planSlug || undefined,
				resolve: resolvePlanProgress,
			});
			rebuilt.add(identity);
			if (planSlug) rebuilt.add(planSlug);
			return {
				attempted: true,
				message: planSlug
					? `re-indexed records for ${planSlug}`
					: `re-indexed records for run ${runId}`,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { attempted: false, message };
		} finally {
			closeDb();
		}
	}

	return {
		id: RECORDS_CHECK_ID,
		run,
		fix,
	};
}

export const recordsCheck: DoctorCheck = createRecordsCheck();
