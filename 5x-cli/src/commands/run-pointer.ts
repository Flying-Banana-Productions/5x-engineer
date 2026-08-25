/**
 * Local focus pointer for ambient run identity.
 *
 * A plain file at the control-plane state root (`current-run`) naming the
 * last `run init` id. No JSON, no lock. Completing a run unlinks the file
 * only when the trimmed contents still equal that run id (TOCTOU is
 * acceptable for a convenience file).
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { controlPlaneStatePath } from "./control-plane.js";

export const CURRENT_RUN_FILENAME = "current-run";

/**
 * Path to the focus pointer. Absolute `stateDir` is the state root;
 * relative `stateDir` joins under `controlPlaneRoot`.
 */
export function currentRunPath(
	controlPlaneRoot: string,
	stateDir: string,
): string {
	return controlPlaneStatePath(
		controlPlaneRoot,
		stateDir,
		CURRENT_RUN_FILENAME,
	);
}

/**
 * Read the pointer file. Missing → `null`. Present → trimmed contents
 * (may be `""`; `resolveAmbientRunId` classifies invalid values).
 */
export function readPointer(path: string): string | null {
	try {
		return readFileSync(path, "utf-8").trim();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Write `runId` plus a trailing newline, creating the parent directory. */
export function writePointer(path: string, runId: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${runId}\n`, "utf-8");
}

/**
 * Unlink the pointer only when its trimmed contents equal `runId`.
 * Missing file is a no-op. Returns whether the file was unlinked.
 */
export function clearPointerIfMatch(path: string, runId: string): boolean {
	const current = readPointer(path);
	if (current === null || current !== runId) return false;
	try {
		unlinkSync(path);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: unknown }).code === "ENOENT"
	);
}
