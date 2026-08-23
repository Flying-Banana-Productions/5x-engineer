/**
 * Lock inspect / unlock handlers — business logic.
 *
 * Framework-independent: no CLI framework imports.
 * Accepts optional `startDir` for unit tests (same convention as initScaffold).
 */

import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import {
	forceReleaseLock,
	inspectLock,
	type LockInfo,
	type LockLiveness,
	listLocks,
	releaseLock,
} from "../lock.js";
import { outputError, outputSuccess } from "../output.js";
import { canonicalizePlanPath, resolvePlanArg } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";
import { resolveControlPlaneRoot } from "./control-plane.js";

export interface LockListParams {
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
}

export interface UnlockPlanParams {
	plan: string;
	force?: boolean;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
}

export interface LockListRow {
	plan_path: string | null;
	pid: number | null;
	started_at: string | null;
	liveness: LockLiveness;
	lock_path: string;
}

async function resolveLockContext(startDir?: string): Promise<{
	projectRoot: string;
	stateDir: string;
	plansDir: string;
}> {
	const cwd = resolve(startDir ?? ".");
	const controlPlane = resolveControlPlaneRoot(cwd);
	const projectRoot =
		controlPlane.mode !== "none"
			? controlPlane.controlPlaneRoot
			: resolveProjectRoot(cwd);
	const { config } = await loadConfig(
		projectRoot,
		undefined,
		undefined,
		projectRoot,
	);
	return {
		projectRoot,
		stateDir: controlPlane.stateDir,
		plansDir: config.paths.plans,
	};
}

function liveHolderDetail(
	planPath: string,
	lock: LockInfo,
): Record<string, unknown> {
	return {
		pid: lock.pid,
		started_at: lock.startedAt,
		holder: { pid: lock.pid, startedAt: lock.startedAt },
		stale: false,
		remediation: `If this process is hung, run \`5x unlock ${planPath} --force\`.`,
	};
}

function formatLockListText(data: { locks: LockListRow[] }): void {
	if (data.locks.length === 0) {
		console.log("(none)");
		return;
	}

	for (const lock of data.locks) {
		if (lock.liveness === "corrupt") {
			console.log(`corrupt  lock_path=${lock.lock_path}`);
			console.log("  → 5x doctor --fix");
			continue;
		}
		const pid = lock.pid ?? "?";
		const plan = lock.plan_path ?? "?";
		const since = lock.started_at ?? "?";
		console.log(`${lock.liveness}  pid=${pid}  plan=${plan}  since=${since}`);
		if (lock.liveness === "stale") {
			console.log(`  → 5x unlock ${plan}`);
		} else {
			console.log(`  → 5x unlock ${plan} --force`);
		}
	}
}

export async function lockList(params?: LockListParams): Promise<void> {
	const { projectRoot, stateDir } = await resolveLockContext(params?.startDir);
	const entries = listLocks(projectRoot, { stateDir });
	const locks: LockListRow[] = entries.map((entry) => ({
		plan_path: entry.info?.planPath ?? null,
		pid: entry.info?.pid ?? null,
		started_at: entry.info?.startedAt ?? null,
		liveness: entry.liveness,
		lock_path: entry.lockPath,
	}));
	outputSuccess({ locks }, formatLockListText);
}

export async function unlockPlan(params: UnlockPlanParams): Promise<void> {
	const { projectRoot, stateDir, plansDir } = await resolveLockContext(
		params.startDir,
	);
	const lockOpts = { stateDir };
	const planPath = canonicalizePlanPath(resolvePlanArg(params.plan, plansDir));
	const entry = inspectLock(projectRoot, planPath, lockOpts);

	if (!entry) {
		outputSuccess({ released: false, reason: "not_locked" });
		return;
	}

	if (entry.liveness === "live") {
		const info = entry.info;
		if (!params.force) {
			outputError(
				"PLAN_LOCKED",
				`Plan is locked by PID ${info?.pid ?? "unknown"}`,
				info ? liveHolderDetail(planPath, info) : { stale: false },
			);
		}
		forceReleaseLock(projectRoot, planPath, lockOpts);
		outputSuccess({
			released: true,
			forced: true,
			previous_holder: info
				? {
						pid: info.pid,
						startedAt: info.startedAt,
						planPath: info.planPath,
					}
				: null,
		});
		return;
	}

	const result = releaseLock(projectRoot, planPath, lockOpts);
	outputSuccess({
		released: result.released,
		reason: result.reason,
	});
}
