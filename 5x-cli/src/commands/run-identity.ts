/**
 * Ambient run-identity resolver.
 *
 * Discovers a run id from strict precedence. Does not map a known id onto
 * worktree/plan/workdir — that remains `resolveRunExecutionContext`.
 *
 * Precedence:
 *   1. `--run` (`explicitRun`)
 *   2. `FIVEX_RUN`
 *   3. unique active run mapped to this linked checkout
 *   4. compatible `.5x/current-run` pointer
 *   5. piped `run_id` (record / invoke only)
 *   6. required → `RUN_CONTEXT_REQUIRED`; optional → `source: "none"`
 */

import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { getPlan, listPlansByWorktreePath } from "../db/operations.js";
import { getActiveRunV1, getRunV1 } from "../db/operations-v1.js";
import { outputError } from "../output.js";
import { realpathExisting } from "../paths.js";
import { SAFE_RUN_ID } from "../run-id.js";
import {
	type ControlPlaneResult,
	resolveCheckoutRoot,
} from "./control-plane.js";
import {
	currentRunPath,
	readPointer as readPointerFile,
} from "./run-pointer.js";

export type AmbientRunSource =
	| "flag"
	| "environment"
	| "worktree"
	| "pointer"
	| "pipe"
	| "none";

export type AmbientRunErrorCode =
	| "RUN_CONTEXT_REQUIRED"
	| "RUN_CONTEXT_AMBIGUOUS"
	| "RUN_POINTER_INCOMPATIBLE"
	| "RUN_POINTER_STALE"
	| "RUN_POINTER_INVALID"
	| "RUN_ENV_INVALID";

export interface AmbientRunRequest {
	explicitRun?: string;
	/** Piped run_id already extracted by the caller. Ranked last. */
	pipeRunId?: string;
	required: boolean;
	startDir?: string;
	env?: NodeJS.Dict<string>;
	db: Database;
	controlPlane: ControlPlaneResult;
	/**
	 * Canonical checkout root. Tests inject this to stay off git.
	 * When omitted, derived via `resolveCheckoutRoot(startDir)`.
	 */
	checkoutRoot?: string;
	/** Override pointer read (tests). Missing → `null`; present → trimmed. */
	readPointer?: () => string | null;
}

export type AmbientRunResult =
	| {
			ok: true;
			runId: string;
			source: Exclude<AmbientRunSource, "none">;
	  }
	| {
			ok: true;
			runId: undefined;
			source: "none";
	  }
	| {
			ok: false;
			error: {
				code: AmbientRunErrorCode;
				message: string;
				detail?: {
					remediation?: string;
					candidates?: string[];
					path?: string;
					run_id?: string;
				};
			};
	  };

export const REQUIRED_REMEDIATION =
	"Pass --run <id>, set FIVEX_RUN, run from a uniquely mapped worktree, or write the run id to .5x/current-run.";

/** Commander `--run` help text for required-run commands. */
export const AMBIENT_RUN_OPTION_HELP =
	"Run ID (or ambient: FIVEX_RUN, unique worktree mapping, or .5x/current-run)";

/** Commander `--run` help text when `--record` makes identity required. */
export const AMBIENT_RUN_OPTION_HELP_WITH_RECORD =
	"Run ID (required with --record; otherwise ambient: FIVEX_RUN, unique worktree mapping, or .5x/current-run)";

export function outputAmbientError(
	result: Extract<AmbientRunResult, { ok: false }>,
): never {
	outputError(result.error.code, result.error.message, result.error.detail);
}

/** Resolve a required run id and surface ambient errors via `outputError`. */
export function requireAmbientRunId(
	req: Omit<AmbientRunRequest, "required">,
): string {
	const ambient = resolveAmbientRunId({ ...req, required: true });
	if (!ambient.ok) outputAmbientError(ambient);
	if (!ambient.runId) {
		outputError("RUN_CONTEXT_REQUIRED", "No run identity resolved.", {
			remediation: REQUIRED_REMEDIATION,
		});
	}
	return ambient.runId;
}

/**
 * True when the checkout toplevel is not the control-plane root
 * (git-linked worktree or externally attached checkout sharing one DB).
 */
export function isLinkedWorktreeCheckout(
	controlPlane: ControlPlaneResult,
	startDir?: string,
): boolean {
	const checkoutRoot = resolveCheckoutRoot(resolve(startDir ?? "."));
	return checkoutIsLinked(controlPlane, checkoutRoot);
}

function checkoutIsLinked(
	controlPlane: ControlPlaneResult,
	checkoutRoot: string | null,
): boolean {
	if (!checkoutRoot) return false;
	return (
		realpathExisting(checkoutRoot) !==
		realpathExisting(controlPlane.controlPlaneRoot)
	);
}

export function listActiveRunsForCheckout(
	db: Database,
	checkoutRoot: string,
): Array<{ runId: string; planPath: string; worktreePath: string }> {
	const plans = listPlansByWorktreePath(db, checkoutRoot);
	const seen = new Set<string>();
	const matches: Array<{
		runId: string;
		planPath: string;
		worktreePath: string;
	}> = [];
	for (const plan of plans) {
		if (plan.worktree_path === null) continue;
		const run = getActiveRunV1(db, plan.plan_path);
		if (!run || seen.has(run.id)) continue;
		seen.add(run.id);
		matches.push({
			runId: run.id,
			planPath: plan.plan_path,
			worktreePath: plan.worktree_path,
		});
	}
	return matches;
}

export function resolveAmbientRunId(req: AmbientRunRequest): AmbientRunResult {
	const checkoutRoot = resolveIdentityCheckoutRoot(req);
	const linked = checkoutIsLinked(req.controlPlane, checkoutRoot);

	// 1. --run
	const explicit = trimPresent(req.explicitRun);
	if (explicit !== undefined) {
		if (!SAFE_RUN_ID.test(explicit)) {
			return envInvalid(
				`--run must match ${SAFE_RUN_ID} (alphanumeric start, alphanumeric/underscore/hyphen, 1-64 chars), got: "${explicit}"`,
				explicit,
			);
		}
		return { ok: true, runId: explicit, source: "flag" };
	}

	// 2. FIVEX_RUN
	const envSource = req.env ?? process.env;
	if (typeof envSource.FIVEX_RUN === "string") {
		const envRun = envSource.FIVEX_RUN.trim();
		if (!SAFE_RUN_ID.test(envRun)) {
			return envInvalid(
				`FIVEX_RUN must match ${SAFE_RUN_ID} (alphanumeric start, alphanumeric/underscore/hyphen, 1-64 chars), got: "${envSource.FIVEX_RUN}"`,
				envSource.FIVEX_RUN,
			);
		}
		const row = getRunV1(req.db, envRun);
		if (!row) {
			return envInvalid(`FIVEX_RUN names unknown run "${envRun}".`, envRun);
		}
		return { ok: true, runId: envRun, source: "environment" };
	}

	// 3. Unique active mapping on a linked checkout
	if (linked && checkoutRoot) {
		const matches = listActiveRunsForCheckout(req.db, checkoutRoot);
		if (matches.length === 1) {
			const only = matches[0];
			if (only) {
				return { ok: true, runId: only.runId, source: "worktree" };
			}
		}
		if (matches.length > 1) {
			const candidates = matches.map((m) => m.runId);
			return {
				ok: false,
				error: {
					code: "RUN_CONTEXT_AMBIGUOUS",
					message: `Multiple active runs map to this checkout: ${candidates.join(", ")}.`,
					detail: {
						candidates,
						remediation:
							"Pass --run <id> or set FIVEX_RUN to select one of the candidate runs.",
					},
				},
			};
		}
	}

	// 4. Compatible focus pointer
	const pointerPath = currentRunPath(
		req.controlPlane.controlPlaneRoot,
		req.controlPlane.stateDir,
	);
	const pointerRaw =
		req.readPointer !== undefined
			? req.readPointer()
			: readPointerFile(pointerPath);
	if (pointerRaw !== null) {
		const pointerResult = resolvePointerRun(req, pointerRaw, pointerPath, {
			linked,
			checkoutRoot,
		});
		if (pointerResult !== undefined) return pointerResult;
	}

	// 5. Piped run_id (record / invoke)
	const pipeRun = trimPresent(req.pipeRunId);
	if (pipeRun !== undefined && SAFE_RUN_ID.test(pipeRun)) {
		return { ok: true, runId: pipeRun, source: "pipe" };
	}

	// 6. None
	if (req.required) {
		return {
			ok: false,
			error: {
				code: "RUN_CONTEXT_REQUIRED",
				message: "No run identity resolved.",
				detail: { remediation: REQUIRED_REMEDIATION },
			},
		};
	}
	return { ok: true, runId: undefined, source: "none" };
}

function resolveIdentityCheckoutRoot(req: AmbientRunRequest): string | null {
	if (req.checkoutRoot) return realpathExisting(req.checkoutRoot);
	return resolveCheckoutRoot(resolve(req.startDir ?? "."));
}

function trimPresent(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function envInvalid(message: string, runId: string): AmbientRunResult {
	return {
		ok: false,
		error: {
			code: "RUN_ENV_INVALID",
			message,
			detail: {
				run_id: runId,
				remediation:
					"Pass a valid --run <id> or set FIVEX_RUN to a known run id.",
			},
		},
	};
}

function resolvePointerRun(
	req: AmbientRunRequest,
	raw: string,
	pointerPath: string,
	opts: { linked: boolean; checkoutRoot: string | null },
): AmbientRunResult {
	const runId = raw.trim();
	if (!runId || !SAFE_RUN_ID.test(runId)) {
		return {
			ok: false,
			error: {
				code: "RUN_POINTER_INVALID",
				message: "The focus pointer file is empty or not a valid run id.",
				detail: {
					path: pointerPath,
					run_id: runId || undefined,
					remediation: REQUIRED_REMEDIATION,
				},
			},
		};
	}

	const run = getRunV1(req.db, runId);
	if (run?.status !== "active") {
		return {
			ok: false,
			error: {
				code: "RUN_POINTER_STALE",
				message: run
					? `The focus pointer names terminal run "${runId}" (status: ${run.status}).`
					: `The focus pointer names missing run "${runId}".`,
				detail: {
					path: pointerPath,
					run_id: runId,
					remediation: REQUIRED_REMEDIATION,
				},
			},
		};
	}

	if (opts.linked && opts.checkoutRoot) {
		const mapped = getPlan(req.db, run.plan_path)?.worktree_path ?? null;
		if (
			mapped !== null &&
			realpathExisting(mapped) !== realpathExisting(opts.checkoutRoot)
		) {
			return {
				ok: false,
				error: {
					code: "RUN_POINTER_INCOMPATIBLE",
					message: `The focus pointer names run "${runId}", which is mapped to a different checkout.`,
					detail: {
						path: pointerPath,
						run_id: runId,
						remediation:
							"Pass --run <id> or set FIVEX_RUN. A shared .5x/current-run cannot select a run mapped to another linked checkout.",
					},
				},
			};
		}
	}

	return { ok: true, runId, source: "pointer" };
}
