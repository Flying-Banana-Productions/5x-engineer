/**
 * Diff command handler — business logic for git diff inspection.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Phase 3a (013-worktree-authoritative-execution-context):
 * When `--run` is provided, the handler resolves the run's mapped worktree
 * and runs `git diff` in that directory instead of the ambient project root.
 * Existing behavior is preserved when `--run` is omitted.
 */

import { join } from "node:path";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { outputError, outputSuccess } from "../output.js";
import { resolveProjectRoot } from "../project-root.js";
import { subprocess } from "../utils/subprocess.js";
import { DB_FILENAME, resolveControlPlaneRoot } from "./control-plane.js";
import { resolveRunExecutionContext } from "./run-context.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface DiffParams {
	since?: string;
	stat?: boolean;
	run?: string;
}

/** Parse `git diff --stat` summary line: " N files changed, M insertions(+), D deletions(-)" */
function parseStatSummary(statOutput: string): {
	files_changed: number;
	insertions: number;
	deletions: number;
} {
	const lines = statOutput.split("\n");
	const summaryLine = lines[lines.length - 1] ?? "";

	const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
	const insertionsMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
	const deletionsMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);

	return {
		files_changed: filesMatch
			? Number.parseInt(filesMatch[1] as string, 10)
			: 0,
		insertions: insertionsMatch
			? Number.parseInt(insertionsMatch[1] as string, 10)
			: 0,
		deletions: deletionsMatch
			? Number.parseInt(deletionsMatch[1] as string, 10)
			: 0,
	};
}

/** Get the list of changed file paths from a diff. */
function parseFileNames(nameOnlyOutput: string): string[] {
	return nameOnlyOutput
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runDiff(params: DiffParams): Promise<void> {
	// -----------------------------------------------------------------------
	// Phase 3a: When --run is provided, resolve mapped worktree and run
	// git diff in that directory.
	// -----------------------------------------------------------------------
	let projectRoot: string;

	if (params.run) {
		const controlPlane = resolveControlPlaneRoot();

		if (controlPlane.mode === "none") {
			// Phase 3 fix: --run was explicitly provided but no control-plane DB
			// exists. This is a hard error — silently falling through to cwd-based
			// diff would violate the run-scoped contract.
			outputError(
				"NO_CONTROL_PLANE",
				`--run was specified but no 5x control-plane DB was found. Initialize with "5x init" first.`,
			);
		}

		const dbRelPath = join(controlPlane.stateDir, DB_FILENAME);
		const db = getDb(controlPlane.controlPlaneRoot, dbRelPath);
		try {
			runMigrations(db);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Database upgrade required. Run "5x upgrade" to fix.\n\nDetails: ${msg}`,
			);
		}

		const ctxResult = resolveRunExecutionContext(db, params.run, {
			controlPlaneRoot: controlPlane.controlPlaneRoot,
		});

		if (!ctxResult.ok) {
			outputError(ctxResult.error.code, ctxResult.error.message, {
				detail: ctxResult.error.detail,
			});
		}

		projectRoot = ctxResult.context.effectiveWorkingDirectory;
	} else {
		projectRoot = resolveProjectRoot();
	}

	// Validate --since ref exists if provided
	const ref = params.since;
	if (ref) {
		const verifyResult = await subprocess.execGit(
			["rev-parse", "--verify", ref],
			projectRoot,
		);
		if (verifyResult.exitCode !== 0) {
			outputError("INVALID_REF", `Git ref not found: ${ref}`, { ref });
		}
	}

	// Build diff command
	// Without --since: show unstaged + staged changes against HEAD
	// With --since: show all changes since that ref
	const diffArgs = ref ? ["diff", ref] : ["diff", "HEAD"];
	const nameArgs = ref
		? ["diff", "--name-only", ref]
		: ["diff", "--name-only", "HEAD"];

	// Run diff and name-only in parallel
	const [diffResult, nameResult] = await Promise.all([
		subprocess.execGit(diffArgs, projectRoot),
		subprocess.execGit(nameArgs, projectRoot),
	]);

	if (diffResult.exitCode !== 0) {
		outputError("GIT_ERROR", `git diff failed: ${diffResult.stderr}`);
	}

	if (nameResult.exitCode !== 0) {
		outputError(
			"GIT_ERROR",
			`git diff --name-only failed: ${nameResult.stderr}`,
			{ command: "git diff --name-only" },
		);
	}

	const files = parseFileNames(nameResult.stdout);

	// Optionally get stat
	let stat:
		| { files_changed: number; insertions: number; deletions: number }
		| undefined;
	if (params.stat) {
		const statArgs = ref ? ["diff", "--stat", ref] : ["diff", "--stat", "HEAD"];
		const statResult = await subprocess.execGit(statArgs, projectRoot);
		if (statResult.exitCode !== 0) {
			outputError("GIT_ERROR", `git diff --stat failed: ${statResult.stderr}`, {
				command: "git diff --stat",
			});
		}
		stat = statResult.stdout
			? parseStatSummary(statResult.stdout)
			: { files_changed: 0, insertions: 0, deletions: 0 };
	}

	const data: Record<string, unknown> = {
		ref: ref ?? "HEAD",
		diff: diffResult.stdout,
		files,
	};

	if (stat !== undefined) {
		data.stat = stat;
	}

	// Include run ID in output when provided
	if (params.run) {
		data.run_id = params.run;
	}

	outputSuccess(data);
}
