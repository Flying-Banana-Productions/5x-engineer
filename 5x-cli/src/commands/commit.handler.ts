/**
 * Commit command handler — business logic for `5x commit`.
 *
 * Atomically stages files, creates a git commit, and records a `git:commit`
 * step in the run's step journal. No schema migration needed — commits are
 * stored as regular steps using the existing `result_json` column.
 *
 * Framework-independent: no CLI framework imports.
 */

import { outputError, outputSuccess } from "../output.js";
import { subprocess } from "../utils/subprocess.js";
import { type DbContext, resolveDbContext } from "./context.js";
import { resolveRunExecutionContext } from "./run-context.js";
import { recordStepInternal } from "./run-v1.handler.js";

// ---------------------------------------------------------------------------
// Param interface
// ---------------------------------------------------------------------------

export interface CommitParams {
	run: string;
	message: string;
	files?: string[];
	allFiles?: boolean;
	phase?: string;
	dryRun?: boolean;
	startDir?: string; // for testability; defaults to run context resolution
	dbContext?: DbContext; // for testability; bypasses singleton DB when provided
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

function formatCommitText(data: {
	hash: string;
	short_hash: string;
	message: string;
	files: string[];
}): void {
	console.log(
		`[${data.short_hash}] ${data.message} (${data.files.length} files)`,
	);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runCommit(params: CommitParams): Promise<void> {
	// 1. Resolve DB context (use injected context if provided — for testability)
	const { config, db, controlPlane } =
		params.dbContext ??
		(await resolveDbContext({
			startDir: params.startDir,
		}));

	const controlPlaneRoot = controlPlane?.controlPlaneRoot;
	if (!controlPlaneRoot) {
		outputError(
			"NO_CONTROL_PLANE",
			`No 5x control-plane DB found. Initialize with "5x init" first.`,
		);
	}

	// 2. Resolve run execution context (respects worktree mapping)
	const ctxResult = resolveRunExecutionContext(db, params.run, {
		controlPlaneRoot,
	});

	if (!ctxResult.ok) {
		outputError(ctxResult.error.code, ctxResult.error.message, {
			detail: ctxResult.error.detail,
		});
	}

	const ctx = ctxResult.context;

	// 3. Validate run is active
	if (ctx.run.status !== "active") {
		outputError(
			"RUN_NOT_ACTIVE",
			`Run ${params.run} is ${ctx.run.status}, not active. Only active runs can record commits.`,
		);
	}

	const workdir = ctx.effectiveWorkingDirectory;

	// 4. Dry-run mode
	if (params.dryRun) {
		let dryRunArgs: string[];
		if (params.allFiles) {
			dryRunArgs = ["add", "-A", "--dry-run"];
		} else {
			dryRunArgs = ["add", "--dry-run", "--", ...(params.files ?? [])];
		}

		const dryResult = await subprocess.execGit(dryRunArgs, workdir);

		// Fail if git add --dry-run returned a non-zero exit code (invalid
		// pathspecs, permission errors, etc.) — mirroring the real staging path.
		if (dryResult.exitCode !== 0) {
			outputError(
				"COMMIT_FAILED",
				`git add --dry-run failed: ${dryResult.stderr || dryResult.stdout}`,
			);
		}

		outputSuccess(
			{
				dry_run: true,
				git_add_output: dryResult.stdout || dryResult.stderr || "(no changes)",
				step_shape: {
					step_name: "git:commit",
					phase: params.phase ?? null,
					message: params.message,
				},
			},
			(data) => {
				console.log("Dry run — no changes made");
				console.log(`Message: ${data.step_shape.message}`);
				if (data.step_shape.phase) {
					console.log(`Phase: ${data.step_shape.phase}`);
				}
				console.log(data.git_add_output);
			},
		);
		return;
	}

	// 5. Stage files
	let stageArgs: string[];
	if (params.allFiles) {
		stageArgs = ["add", "-A"];
	} else {
		stageArgs = ["add", "--", ...(params.files ?? [])];
	}

	const stageResult = await subprocess.execGit(stageArgs, workdir);
	if (stageResult.exitCode !== 0) {
		outputError(
			"COMMIT_FAILED",
			`git add failed: ${stageResult.stderr || stageResult.stdout}`,
		);
	}

	// 6. Commit — fires hooks (pre-commit, commit-msg). Fail-early: no step
	//    recorded if commit fails.
	const commitResult = await subprocess.execGit(
		["commit", "-m", params.message],
		workdir,
	);

	if (commitResult.exitCode !== 0) {
		// Git reports some errors (like "nothing to commit") on stdout, not stderr
		const errorMessage = commitResult.stderr || commitResult.stdout;
		outputError("COMMIT_FAILED", errorMessage);
	}

	// 7. Read commit metadata
	const [hashResult, shortHashResult, filesResult] = await Promise.all([
		subprocess.execGit(["rev-parse", "HEAD"], workdir),
		subprocess.execGit(["rev-parse", "--short", "HEAD"], workdir),
		subprocess.execGit(
			["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
			workdir,
		),
	]);

	const hash = hashResult.stdout.trim();
	const short_hash = shortHashResult.stdout.trim();
	const files = filesResult.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	// 8. Record step in the run journal — use the same DB/control-plane context
	//    that was resolved at the top of this handler. Passing it explicitly
	//    prevents recordStepInternal from re-resolving via process cwd, which
	//    would target the wrong DB when called from a linked worktree.
	const stepResult = await recordStepInternal(
		{
			run: params.run,
			stepName: "git:commit",
			phase: params.phase,
			result: JSON.stringify({
				hash,
				short_hash,
				message: params.message,
				files,
			}),
		},
		{ db, config, controlPlane },
	);

	// 9. Output success
	outputSuccess(
		{
			hash,
			short_hash,
			message: params.message,
			files,
			run_id: params.run,
			step_id: stepResult.step_id,
		},
		formatCommitText,
	);
}
