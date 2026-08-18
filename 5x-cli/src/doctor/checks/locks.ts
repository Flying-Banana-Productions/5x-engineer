/**
 * Doctor check: plan lock inventory.
 *
 * Detect-only `run` via `listLocks`. `--fix` releases stale locks by plan path
 * and removes path-addressed corrupt files. Live locks are warn-only.
 */

import { listLocks, releaseLock, removeCorruptLock } from "../../lock.js";
import type {
	DoctorCheck,
	DoctorCheckContext,
	DoctorFinding,
	DoctorFixResult,
} from "../types.js";

export const LOCKS_CHECK_ID = "locks";

function asRecord(detail: unknown): Record<string, unknown> {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
		return {};
	}
	return detail as Record<string, unknown>;
}

function lockOpts(ctx: DoctorCheckContext) {
	return { stateDir: ctx.stateDir };
}

async function run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
	const entries = listLocks(ctx.projectRoot, lockOpts(ctx));
	if (entries.length === 0) {
		return [
			{
				check: LOCKS_CHECK_ID,
				status: "ok",
				code: "LOCKS_OK",
				message: "no plan locks",
				fixable: false,
			},
		];
	}

	const findings: DoctorFinding[] = [];
	for (const entry of entries) {
		if (entry.liveness === "corrupt") {
			findings.push({
				check: LOCKS_CHECK_ID,
				status: "fail",
				code: "LOCK_CORRUPT",
				message: `corrupt lock file ${entry.lockPath}`,
				remediation: "5x doctor --fix",
				fixable: true,
				detail: { lockPath: entry.lockPath },
			});
			continue;
		}

		const planPath = entry.info?.planPath ?? "";
		const pid = entry.info?.pid;
		if (entry.liveness === "stale") {
			findings.push({
				check: LOCKS_CHECK_ID,
				status: "fail",
				code: "LOCK_STALE",
				message: `stale lock on ${planPath}${pid !== undefined ? ` (pid ${pid})` : ""}`,
				remediation: `5x unlock ${planPath}`,
				fixable: planPath.length > 0,
				detail: { planPath, lockPath: entry.lockPath, pid },
			});
			continue;
		}

		findings.push({
			check: LOCKS_CHECK_ID,
			status: "warn",
			code: "LOCK_LIVE",
			message: `live lock on ${planPath}${pid !== undefined ? ` (pid ${pid})` : ""}`,
			remediation: `5x unlock ${planPath} --force`,
			fixable: false,
			detail: { planPath, lockPath: entry.lockPath, pid },
		});
	}

	return findings;
}

async function fix(
	finding: DoctorFinding,
	ctx: DoctorCheckContext,
): Promise<DoctorFixResult> {
	const detail = asRecord(finding.detail);
	const opts = lockOpts(ctx);

	if (finding.code === "LOCK_STALE") {
		const planPath = String(detail.planPath ?? "");
		if (!planPath) {
			return { attempted: false, message: "missing planPath" };
		}
		const result = releaseLock(ctx.projectRoot, planPath, opts);
		if (!result.released) {
			return { attempted: false, message: result.reason ?? "not_released" };
		}
		return {
			attempted: true,
			message: `released stale lock on ${planPath}`,
		};
	}

	if (finding.code === "LOCK_CORRUPT") {
		const lockPath = String(detail.lockPath ?? "");
		if (!lockPath) {
			return { attempted: false, message: "missing lockPath" };
		}
		const result = removeCorruptLock(ctx.projectRoot, lockPath, opts);
		if (!result.removed) {
			return { attempted: false, message: result.reason };
		}
		return {
			attempted: true,
			message: `removed corrupt lock ${lockPath}`,
		};
	}

	return { attempted: false, message: "live locks are not auto-removed" };
}

export const locksCheck: DoctorCheck = {
	id: LOCKS_CHECK_ID,
	run,
	fix,
};
