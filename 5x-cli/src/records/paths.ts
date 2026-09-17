/**
 * Convert control-plane `config.paths.records` into a write/stage target
 * for the run's effective worktree.
 *
 * Control-plane config paths are absolute under the control-plane checkout.
 * Linked-worktree runs must write and commit records beside the code, so
 * the canonical repo-relative path is re-rooted under `effectiveWorkdir`.
 */

import { isAbsolute, join, resolve } from "node:path";
import {
	RECORDS_ROOT_OUTSIDE_REPO,
	recordsRootOutsideRepoMessage,
} from "../config.js";
import { realpathExisting, relativePathUnder } from "../paths.js";

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
