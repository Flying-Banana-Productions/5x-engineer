/**
 * Convert control-plane `config.paths.records` into a write/stage target
 * for the run's effective worktree.
 *
 * Control-plane config paths are absolute under the control-plane checkout.
 * Linked-worktree runs must write and commit records beside the code, so
 * the canonical repo-relative path is re-rooted under `effectiveWorkdir`.
 */

import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import {
	RECORDS_ROOT_OUTSIDE_REPO,
	recordsRootOutsideRepoMessage,
} from "../config.js";
import { RecordStoreError } from "../control-plane/record-types.js";
import { realpathExisting, relativePathUnder } from "../paths.js";

function isHostAbsolute(path: string): boolean {
	return isAbsolute(path) || win32.isAbsolute(path);
}

/** Durable plan identity: a POSIX path beneath the control-plane root. */
export function recordPlanPath(
	planPath: string,
	controlPlaneRoot: string,
): string {
	const rel = isHostAbsolute(planPath)
		? relativePathUnder(planPath, controlPlaneRoot)
		: planPath;
	if (rel === null || (isHostAbsolute(planPath) && !isAbsolute(planPath))) {
		throw new RecordStoreError(
			"RECORD_PLAN_PATH_INVALID",
			"Plan path is outside the control-plane root",
		);
	}
	const normalized = posix.normalize(rel.replace(/\\/g, "/"));
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		isHostAbsolute(normalized)
	) {
		throw new RecordStoreError(
			"RECORD_PLAN_PATH_INVALID",
			"Record plan path must be repo-relative and remain inside the repository",
		);
	}
	return normalized;
}

/** Legacy absolute records use an independently discovered plan, never a host-prefix guess. */
export function localRecordPlanPath(
	planPath: string,
	controlPlaneRoot: string,
	discoveredPlanPath?: string,
): string {
	if (isHostAbsolute(planPath)) {
		if (!discoveredPlanPath) {
			throw new RecordStoreError(
				"RECORD_PLAN_PATH_AMBIGUOUS",
				"Legacy absolute record requires an unambiguous local plan association",
			);
		}
		return resolve(
			controlPlaneRoot,
			recordPlanPath(discoveredPlanPath, controlPlaneRoot),
		);
	}
	return resolve(controlPlaneRoot, recordPlanPath(planPath, controlPlaneRoot));
}

export interface ResolvedRecordsRoot {
	/** POSIX path relative to the checkout / worktree root. */
	recordsRelPath: string;
	/** Absolute write/stage directory in the effective worktree. */
	recordsAbsPath: string;
}

function toPosixRel(rel: string): string {
	return rel.replace(/\\/g, "/");
}

function throwOutside(absPath: string): never {
	const err = new Error(recordsRootOutsideRepoMessage(absPath));
	(err as Error & { code?: string }).code = RECORDS_ROOT_OUTSIDE_REPO;
	throw err;
}

export function resolveRecordsRoot(opts: {
	recordsConfigAbs: string;
	controlPlaneRoot: string;
	effectiveWorkdir: string;
}): ResolvedRecordsRoot {
	const recordsConfigAbs = isAbsolute(opts.recordsConfigAbs)
		? opts.recordsConfigAbs
		: resolve(opts.controlPlaneRoot, opts.recordsConfigAbs);

	const rel = relativePathUnder(recordsConfigAbs, opts.controlPlaneRoot);
	if (rel === null) throwOutside(recordsConfigAbs);
	const recordsRelPath = toPosixRel(rel);

	const sameCheckout =
		realpathExisting(opts.effectiveWorkdir) ===
		realpathExisting(opts.controlPlaneRoot);

	if (sameCheckout) {
		return { recordsRelPath, recordsAbsPath: recordsConfigAbs };
	}

	const recordsAbsPath = recordsRelPath
		? join(opts.effectiveWorkdir, ...recordsRelPath.split("/").filter(Boolean))
		: opts.effectiveWorkdir;
	return { recordsRelPath, recordsAbsPath };
}
